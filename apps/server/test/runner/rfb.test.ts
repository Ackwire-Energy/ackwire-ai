import { afterEach, expect, test } from "bun:test";
import type net from "node:net";
import path from "node:path";
import { type AgentScope, STREAM_CLOSE } from "@agenteschat/adapters/machine-protocol";
import { connectVnc, openDesktopStream, serveNone, vncAuthResponse } from "../../runner/rfb";
import {
  desktopOn,
  errorCode,
  fakeXvnc as fakeXvncIn,
  memoryDataSocket,
  VNC_PASSWORDS as PASSWORDS,
  removeDirs,
  tempDir,
  waitFor,
} from "./helpers";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  removeDirs(dirs);
});

async function fakeXvnc() {
  const dir = tempDir("rfb-");
  dirs.push(dir);
  const x = await fakeXvncIn(dir);
  closers.push(x.close);
  return x;
}

const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev", name: "Dev" };
const VERSION = "RFB 003.008\n";

/** The viewer's side of the handshake (as noVNC does it): version, None, ClientInit; returns the ServerInit. */
async function viewerHandshake(data: ReturnType<typeof memoryDataSocket>, shared = 0) {
  await waitFor(() => data.bytes().length >= 12);
  expect(data.bytes().toString("latin1")).toBe(VERSION);
  data.send(VERSION);
  await waitFor(() => data.bytes().length >= 14);
  expect([...data.bytes().subarray(12)]).toEqual([1, 1]);
  data.send(Uint8Array.of(1));
  await waitFor(() => data.bytes().length >= 18);
  expect([...data.bytes().subarray(14)]).toEqual([0, 0, 0, 0]);
  data.send(Uint8Array.of(shared));
  await waitFor(() => data.bytes().length >= 18 + 27);
  return data.bytes().subarray(18);
}

test("VncAuth: DES-ECB of the challenge, the password as the key with each byte's bits reversed", () => {
  const challenge = Uint8Array.from({ length: 16 }, (_, i) => i);
  expect(vncAuthResponse("password", challenge).toString("hex")).toBe("b866924125c8eebb9debc1db61c538e2");
  // A password is 8 bytes at most: what follows never counts.
  expect(vncAuthResponse("password-and-more", challenge)).toEqual(vncAuthResponse("password", challenge));
});

test("connectVnc logs in with the password it is given; a wrong one is refused with the desktop's reason", async () => {
  const x = await fakeXvnc();
  const full = await connectVnc(x.socketPath, PASSWORDS.full);
  const view = await connectVnc(x.socketPath, PASSWORDS.view);
  expect(x.logins.map((l) => l.password)).toEqual(["full", "view"]);
  expect(full.leftover.length).toBe(0);
  full.socket.destroy();
  view.socket.destroy();
  await expect(connectVnc(x.socketPath, "Wrong234")).rejects.toThrow("refused the runner's password: bad password");
  expect(await errorCode(() => connectVnc(path.join(path.dirname(x.socketPath), "gone.sock"), "x"))).toBe(
    "desktop_off",
  );
});

test("a watcher: RFB 3.8 with security None, its ClientInit passed on as shared, the view-only login; its pointer is ignored", async () => {
  const x = await fakeXvnc();
  const { desktops, holds } = desktopOn(x.socketPath);
  const data = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => data.socket);
  expect(holds).toEqual({ taken: 1, released: 0 });
  const init = await viewerHandshake(data, 0);
  expect(init.readUInt16BE(0)).toBe(1280);
  expect(init.readUInt16BE(2)).toBe(800);
  expect(init.subarray(24).toString()).toBe("Dev");
  expect(x.logins[0]).toMatchObject({ password: "view", shared: 1 });

  data.send(Uint8Array.of(5, 0, 0, 100, 0, 120));
  await waitFor(() => (x.logins[0]?.got.length ?? 0) >= 6);
  expect(x.desktop.pointer).toEqual([640, 400]);
});

test("the person in control logs in with the full password; bytes go both ways as they are", async () => {
  const x = await fakeXvnc();
  const { desktops } = desktopOn(x.socketPath);
  const data = memoryDataSocket();
  await openDesktopStream(desktops, dev, "control", async () => data.socket);
  await viewerHandshake(data, 1);
  expect(x.logins[0]).toMatchObject({ password: "full", shared: 1 });

  data.send(Uint8Array.of(5, 0, 0, 100, 0, 120));
  await waitFor(() => x.desktop.pointer[0] === 100);
  expect(x.desktop.pointer).toEqual([100, 120]);
  const before = data.bytes().length;
  x.logins[0]?.socket.write(Uint8Array.of(0, 0, 0, 1, 9, 9));
  await waitFor(() => data.bytes().length === before + 6);
  expect([...data.bytes().subarray(before)]).toEqual([0, 0, 0, 1, 9, 9]);
});

test("either side closing ends the stream: the desktop's end closes the data socket with 1011, the viewer's the desktop's connection", async () => {
  const x = await fakeXvnc();
  const { desktops, holds } = desktopOn(x.socketPath);
  const first = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => first.socket);
  await viewerHandshake(first);
  x.logins[0]?.socket.destroy();
  await waitFor(() => first.closed !== null);
  expect(first.closed?.code).toBe(STREAM_CLOSE.internal);
  await waitFor(() => holds.released === 1);

  const second = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => second.socket);
  await viewerHandshake(second);
  const closed = new Promise<void>((resolve) => x.logins[1]?.socket.once("close", () => resolve()));
  second.end();
  await closed;
  await waitFor(() => holds.released === 2);
});

test("a viewer that speaks anything but RFB 3.8 is closed (1000: no retry)", async () => {
  const x = await fakeXvnc();
  const { desktops } = desktopOn(x.socketPath);
  const data = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => data.socket);
  await waitFor(() => data.bytes().length >= 12);
  data.send("RFB 003.003\n");
  await waitFor(() => data.closed !== null);
  expect(data.closed).toEqual({ code: STREAM_CLOSE.normal, reason: "RFB 3.8 only" });
});

test("reading from the desktop pauses while the data socket holds more than its limit, and goes on once it drained", async () => {
  const x = await fakeXvnc();
  const vnc = await connectVnc(x.socketPath, PASSWORDS.view);
  const data = memoryDataSocket();
  void serveNone(data.socket, vnc, 100);
  await viewerHandshake(data);
  const desktopSide = x.logins[0]?.socket as net.Socket;
  const sent = () => data.bytes().length;
  const start = sent();
  data.buffered = 1000;
  desktopSide.write(Uint8Array.of(1, 1, 1));
  await waitFor(() => sent() === start + 3);
  desktopSide.write(Uint8Array.of(2, 2));
  await Bun.sleep(100);
  expect(sent()).toBe(start + 3);
  data.buffered = 0;
  await waitFor(() => sent() === start + 5);
  expect([...data.bytes().subarray(start)]).toEqual([1, 1, 1, 2, 2]);
});

test("refused: a desktop that isn't running, one with as many viewers as it takes; a failed dial lets go of the desktop", async () => {
  const x = await fakeXvnc();
  const off = desktopOn(x.socketPath, { running: false });
  expect(
    await errorCode(() => openDesktopStream(off.desktops, dev, "watch", async () => memoryDataSocket().socket)),
  ).toBe("desktop_off");
  const on = desktopOn(x.socketPath);
  for (let i = 0; i < 4; i++) await openDesktopStream(on.desktops, dev, "watch", async () => memoryDataSocket().socket);
  expect(
    await errorCode(() => openDesktopStream(on.desktops, dev, "watch", async () => memoryDataSocket().socket)),
  ).toBe("too_many_streams");

  const lone = desktopOn(x.socketPath);
  const failing = openDesktopStream(lone.desktops, dev, "control", async () => {
    throw new Error("no data socket");
  });
  await expect(failing).rejects.toThrow("no data socket");
  expect(lone.holds).toEqual({ taken: 1, released: 1 });
  const last = x.logins.at(-1)?.socket as net.Socket;
  await waitFor(() => last.destroyed);
});
