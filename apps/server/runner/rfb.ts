import { createCipheriv } from "node:crypto";
import net from "node:net";
import { type AgentScope, STREAM_CLOSE, STREAM_LIMITS } from "@agenteschat/adapters/machine-protocol";
import type { DesktopSessions } from "./desktop-session";
import { errnoCode, RunnerError } from "./errors";
import type { DataSocket } from "./streams";

/**
 * A person's view of an agent's desktop on the computer (ADR 0058 §3): the
 * runner logs in to the agent's Xvnc over its Unix socket with the view-only
 * password for a watcher and the full one for the person in control (Xvnc
 * itself then ignores a watcher's input), and offers the viewer security type
 * None, since the server and the data socket already said who they are.
 * Past the two handshakes the bytes are copied as they come, never parsed.
 */

/** As bytes: on a data socket, a text frame is a control frame, never RFB. */
const VERSION = Buffer.from("RFB 003.008\n", "latin1");
const SECURITY_NONE = 1;
const SECURITY_VNC_AUTH = 2;
/** Each handshake (the desktop's, then the viewer's) ends within this. */
const HANDSHAKE_MS = 10_000;
/** How often a desktop paused for a full data socket looks whether it drained. */
const DRAIN_POLL_MS = 20;

const reverseBits = (b: number) => {
  let r = 0;
  for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1);
  return r;
};

/**
 * VncAuth's answer: the challenge DES-ECB encrypted with the password (8
 * bytes, zero padded) as the key, each key byte's bits reversed.
 */
export function vncAuthResponse(password: string, challenge: Uint8Array): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  const des = createCipheriv("des-ecb", key.map(reverseBits), null).setAutoPadding(false);
  return Buffer.concat([des.update(challenge), des.final()]);
}

/**
 * Exact byte counts out of chunks as they come (the handshakes). Once the
 * source failed, what it sent before is still read; a read past it fails.
 */
class ByteReader {
  private buf = Buffer.alloc(0);
  private waiting: { n: number; resolve(b: Buffer): void; reject(e: Error): void } | null = null;
  private error: Error | null = null;

  push(chunk: Uint8Array) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.pump();
  }

  fail(error: Error) {
    this.error ??= error;
    const w = this.waiting;
    this.waiting = null;
    w?.reject(this.error);
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiting = { n, resolve, reject };
      this.pump();
      if (this.waiting && this.error) {
        this.waiting = null;
        reject(this.error);
      }
    });
  }

  /** What came past the last read. */
  rest(): Buffer {
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }

  private pump() {
    const w = this.waiting;
    if (!w || this.buf.length < w.n) return;
    this.waiting = null;
    const out = this.buf.subarray(0, w.n);
    this.buf = this.buf.subarray(w.n);
    w.resolve(out);
  }
}

/** RFB 3.8's reason after a refusal (a length, then the text); empty when it doesn't come. */
const reasonOf = async (bytes: ByteReader) => {
  try {
    const n = (await bytes.read(4)).readUInt32BE(0);
    return (await bytes.read(Math.min(n, 500))).toString("utf8");
  } catch {
    return "";
  }
};

/** A logged-in connection to the agent's Xvnc, waiting for ClientInit (paused; `leftover`: what it sent past the handshake). */
export interface VncConnection {
  socket: net.Socket;
  leftover: Buffer;
}

/** Logs in to the desktop's Xvnc on its Unix socket (RFB 3.8, VncAuth with `password`). */
export async function connectVnc(socketPath: string, password: string): Promise<VncConnection> {
  const socket = net.connect({ path: socketPath });
  const bytes = new ByteReader();
  const onData = (chunk: Buffer) => bytes.push(chunk);
  const onError = (err: Error) => bytes.fail(err);
  const onClose = () => bytes.fail(new RunnerError("internal", "The desktop closed the connection"));
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  // Whoever takes the socket over handles its close; a late error must not throw meanwhile.
  socket.on("error", () => undefined);
  const timer = setTimeout(
    () => bytes.fail(new RunnerError("internal", "The desktop didn't answer in time")),
    HANDSHAKE_MS,
  );
  try {
    if (!(await bytes.read(12)).toString("latin1").startsWith("RFB 003.")) {
      throw new RunnerError("internal", "The desktop doesn't speak RFB");
    }
    socket.write(VERSION);
    const count = (await bytes.read(1))[0] ?? 0;
    if (count === 0) throw new RunnerError("internal", `The desktop refused the connection: ${await reasonOf(bytes)}`);
    if (!(await bytes.read(count)).includes(SECURITY_VNC_AUTH)) {
      throw new RunnerError("internal", "The desktop doesn't offer VNC authentication");
    }
    socket.write(Uint8Array.of(SECURITY_VNC_AUTH));
    socket.write(vncAuthResponse(password, await bytes.read(16)));
    if ((await bytes.read(4)).readUInt32BE(0) !== 0) {
      throw new RunnerError("internal", `The desktop refused the runner's password: ${await reasonOf(bytes)}`);
    }
  } catch (err) {
    socket.destroy();
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      throw new RunnerError("desktop_off", "The agent's desktop isn't running");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  socket.pause();
  socket.off("data", onData);
  socket.off("error", onError);
  socket.off("close", onClose);
  return { socket, leftover: bytes.rest() };
}

/**
 * Logs in as a viewer of its own (`desktop-check`): ClientInit as shared,
 * then the desktop's size and name from its ServerInit. The socket stays
 * open for more messages.
 */
export async function vncInit(vnc: VncConnection): Promise<{ width: number; height: number; name: string }> {
  const bytes = new ByteReader();
  bytes.push(vnc.leftover);
  const onData = (chunk: Buffer) => bytes.push(chunk);
  vnc.socket.on("data", onData);
  vnc.socket.resume();
  vnc.socket.write(Uint8Array.of(1));
  const timer = setTimeout(() => bytes.fail(new RunnerError("internal", "No ServerInit in time")), HANDSHAKE_MS);
  try {
    const head = await bytes.read(24);
    const name = (await bytes.read(Math.min(head.readUInt32BE(20), 500))).toString("utf8");
    return { width: head.readUInt16BE(0), height: head.readUInt16BE(2), name };
  } finally {
    clearTimeout(timer);
    vnc.socket.off("data", onData);
  }
}

/**
 * The viewer's side of a desktop stream: RFB 3.8 with security type None, the
 * viewer's ClientInit passed on as shared (one viewer never disconnects the
 * others), then bytes both ways until either side closes, which closes the
 * other. Reading from the desktop pauses while the data socket holds more
 * than `bufferedMax`. The data socket closes with 1011 when the desktop went
 * away (the viewer retries and learns whether it runs), 1000 when the viewer
 * broke the handshake. Settles once the stream ended.
 */
export function serveNone(
  data: DataSocket,
  vnc: VncConnection,
  bufferedMax: number = STREAM_LIMITS.runnerBufferedMax,
): Promise<void> {
  const { socket } = vnc;
  return new Promise((resolve) => {
    const viewer = new ByteReader();
    let piping = false;
    let ended = false;
    let drain: ReturnType<typeof setInterval> | undefined;
    const end = (code?: number, reason?: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearInterval(drain);
      viewer.fail(new Error("the stream ended"));
      socket.destroy();
      if (code !== undefined) data.close(code, reason);
      resolve();
    };
    const timer = setTimeout(() => end(STREAM_CLOSE.normal, "no RFB handshake from the viewer in time"), HANDSHAKE_MS);
    data.listen({
      bytes: (chunk) => {
        if (piping) socket.write(chunk);
        else viewer.push(chunk);
      },
      closed: () => end(),
    });
    socket.on("close", () => end(STREAM_CLOSE.internal, "the desktop closed"));
    if (socket.destroyed) return end(STREAM_CLOSE.internal, "the desktop closed");

    const fromDesktop = (chunk: Buffer) => {
      data.send(chunk);
      if (drain || data.bufferedAmount <= bufferedMax) return;
      socket.pause();
      drain = setInterval(() => {
        if (data.bufferedAmount > bufferedMax / 4) return;
        clearInterval(drain);
        drain = undefined;
        socket.resume();
      }, DRAIN_POLL_MS);
    };

    const handshake = async () => {
      data.send(VERSION);
      if (!(await viewer.read(12)).equals(VERSION)) return end(STREAM_CLOSE.normal, "RFB 3.8 only");
      data.send(Uint8Array.of(1, SECURITY_NONE));
      if ((await viewer.read(1))[0] !== SECURITY_NONE) return end(STREAM_CLOSE.normal, "security type None only");
      data.send(Uint8Array.of(0, 0, 0, 0));
      // ClientInit: the viewer's own shared flag is not passed on.
      await viewer.read(1);
      clearTimeout(timer);
      socket.write(Uint8Array.of(1));
      piping = true;
      const early = viewer.rest();
      if (early.length > 0) socket.write(early);
      if (vnc.leftover.length > 0) data.send(vnc.leftover);
      socket.on("data", fromDesktop);
      socket.resume();
    };
    handshake().catch(() => end());
  });
}

/**
 * `stream.open` of a desktop: the agent's running desktop logged in with the
 * password of the stream's mode, then its data socket; resolves once both are
 * up, and the bytes go on flowing. The desktop counts the stream as a viewer
 * (it isn't idle) until it ends.
 */
export async function openDesktopStream(
  desktops: Pick<DesktopSessions, "status" | "session" | "hold">,
  agent: AgentScope,
  mode: "watch" | "control",
  dial: () => Promise<DataSocket>,
): Promise<void> {
  const status = desktops.status(agent);
  const session = status.running ? desktops.session(agent.id) : null;
  if (!session) throw new RunnerError("desktop_off", "The agent's desktop isn't running");
  if (status.streams >= STREAM_LIMITS.viewersPerDesktop) {
    throw new RunnerError("too_many_streams", "The agent's desktop already has as many viewers as it takes");
  }
  const release = desktops.hold(agent.id) ?? (() => undefined);
  try {
    const vnc = await connectVnc(session.socket, mode === "control" ? session.passwords.full : session.passwords.view);
    let data: DataSocket;
    try {
      data = await dial();
    } catch (err) {
      vnc.socket.destroy();
      throw err;
    }
    void serveNone(data, vnc).finally(release);
  } catch (err) {
    release();
    throw err;
  }
}
