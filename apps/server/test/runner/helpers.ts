import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StreamControl } from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "../../runner/errors";
import { vncAuthResponse } from "../../runner/rfb";
import type { DataListener, DataSocket } from "../../runner/streams";

/** A fresh temp folder (real path, so macOS /var → /private/var doesn't matter). */
export function tempDir(prefix = "runner-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function removeDirs(dirs: string[]) {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** The RunnerError code a promise or function fails with (or "ok"). */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return err instanceof RunnerError ? err.code : `other: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A stream's data socket in memory, the person's side in the test's hands:
 * what the runner sent, how it closed, how much it "holds" queued.
 */
export function memoryDataSocket() {
  let listener: DataListener | null = null;
  const mem = {
    sent: [] as (string | Buffer)[],
    closed: null as { code?: number; reason?: string } | null,
    buffered: 0,
    socket: {
      send: (data) => {
        mem.sent.push(typeof data === "string" ? data : Buffer.from(data));
      },
      close: (code, reason) => {
        if (mem.closed) return;
        mem.closed = { code, reason };
        listener?.closed();
      },
      get bufferedAmount() {
        return mem.buffered;
      },
      listen: (on) => {
        listener = on;
      },
    } as DataSocket,
    /** Every binary frame the runner sent, joined. */
    bytes: () => Buffer.concat(mem.sent.filter((f): f is Buffer => typeof f !== "string")),
    texts: () => mem.sent.filter((f): f is string => typeof f === "string"),
    /** The person sends bytes (a string as latin1). */
    send: (data: string | Uint8Array) => listener?.bytes(typeof data === "string" ? Buffer.from(data, "latin1") : data),
    control: (frame: StreamControl) => listener?.control?.(frame),
    /** The person (or the server) closes it. */
    end: () => {
      if (mem.closed) return;
      mem.closed = {};
      listener?.closed();
    },
  };
  return mem;
}

/** The two passwords of a desktop that `fakeXvnc` takes. */
export const VNC_PASSWORDS = { full: "Full2345", view: "View2345" };

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** One connection to `fakeXvnc`. */
export interface VncLogin {
  socket: net.Socket;
  password: "full" | "view" | null;
  /** ClientInit's shared flag. */
  shared?: number;
  /** What came after ClientInit. */
  got: Buffer;
}

/**
 * An Xvnc on a Unix socket in `dir`: RFB 3.8, VncAuth with `VNC_PASSWORDS`,
 * then a ServerInit of 1280×800 "Dev". A PointerEvent moves the desktop's
 * pointer only from a full login, as Xvnc does.
 */
export async function fakeXvnc(dir: string) {
  const socketPath = path.join(dir, "vnc.sock");
  const logins: VncLogin[] = [];
  const desktop = { pointer: [640, 400] as [number, number] };
  const server = net.createServer((socket) => {
    const login: VncLogin = { socket, password: null, got: Buffer.alloc(0) };
    logins.push(login);
    const challenge = randomBytes(16);
    let buf = Buffer.alloc(0);
    let step: "version" | "type" | "auth" | "init" | "messages" = "version";
    const take = (n: number) => {
      if (buf.length < n) return null;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };
    socket.on("error", () => undefined);
    socket.write("RFB 003.008\n");
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (step === "version") {
          if (!take(12)) return;
          socket.write(Uint8Array.of(1, 2));
          step = "type";
        } else if (step === "type") {
          if (!take(1)) return;
          socket.write(challenge);
          step = "auth";
        } else if (step === "auth") {
          const answer = take(16);
          if (!answer) return;
          const is = (password: string) => answer.equals(vncAuthResponse(password, challenge));
          login.password = is(VNC_PASSWORDS.full) ? "full" : is(VNC_PASSWORDS.view) ? "view" : null;
          if (!login.password) return void socket.end(Buffer.concat([u32(1), u32(12), Buffer.from("bad password")]));
          socket.write(u32(0));
          step = "init";
        } else if (step === "init") {
          const init = take(1);
          if (!init) return;
          login.shared = init[0];
          const pixelFormat = Buffer.alloc(16);
          socket.write(Buffer.concat([Buffer.from([5, 0, 3, 32]), pixelFormat, u32(3), Buffer.from("Dev")]));
          step = "messages";
        } else {
          login.got = Buffer.concat([login.got, buf]);
          if (buf[0] === 5 && buf.length >= 6 && login.password === "full") {
            desktop.pointer = [buf.readUInt16BE(2), buf.readUInt16BE(4)];
          }
          buf = Buffer.alloc(0);
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const close = () => {
    for (const l of logins) l.socket.destroy();
    server.close();
  };
  return { socketPath, logins, desktop, close };
}

/** An agent's desktop as `openDesktopStream` sees it: running on that socket, counting its viewers. */
export function desktopOn(socketPath: string, over: { running?: boolean } = {}) {
  const holds = { taken: 0, released: 0 };
  const desktops = {
    status: () => ({ running: over.running ?? true, streams: holds.taken - holds.released }),
    session: () => ({ display: 20, socket: socketPath, xauthority: "", home: "", passwords: VNC_PASSWORDS }),
    hold: () => {
      holds.taken++;
      let held = true;
      return () => {
        if (held) holds.released++;
        held = false;
      };
    },
  };
  return { desktops, holds };
}
