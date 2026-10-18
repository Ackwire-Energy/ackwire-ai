import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { MACHINE_PROTOCOL_VERSION, type RunnerInfo, type ServerFrame } from "@agenteschat/adapters/machine-protocol";
import { connectUrl } from "../../runner/config";
import {
  backoffDelay,
  type ConnectionOptions,
  type Dial,
  RunnerConnection,
  type Socket,
  type SocketHandlers,
} from "../../runner/connection";
import { RunnerError } from "../../runner/errors";
import { RequestRunner } from "../../runner/handlers";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

class FakeSocket implements Socket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly handlers: SocketHandlers) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.handlers.onClose(1000, ""));
  }
  /** The server sends a frame. */
  frame(f: ServerFrame) {
    this.handlers.onMessage(JSON.stringify(f));
  }
}

function setup(over: Partial<ConnectionOptions> = {}) {
  const ws = tempDir();
  dirs.push(ws);
  const sockets: FakeSocket[] = [];
  const dial: Dial = (_url, handlers) => {
    const s = new FakeSocket(handlers);
    sockets.push(s);
    return s;
  };
  const info: RunnerInfo = {
    version: "0.1.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "box",
    workspace: ws,
    exec: false,
  };
  const lines: string[] = [];
  const connection = new RunnerConnection({
    url: "wss://agentes.test/api/machines/connect",
    token: "agm_token",
    info,
    context: { workspaceReal: ws, exec: false, token: "agm_token" },
    dial,
    random: () => 0,
    log: (l) => lines.push(l),
    ...over,
  });
  return { ws, sockets, connection, lines };
}

const sock = (sockets: FakeSocket[], i: number) => sockets[i] as FakeSocket;

test("the connect URL comes from the server URL", () => {
  expect(connectUrl("https://agentes.chat")).toBe("wss://agentes.chat/api/machines/connect");
  expect(connectUrl("http://localhost:3000")).toBe("ws://localhost:3000/api/machines/connect");
});

test("backoff: 1 s doubling to 60 s, with jitter", () => {
  expect(backoffDelay(0, () => 0.5)).toBe(1000);
  expect(backoffDelay(1, () => 0.5)).toBe(2000);
  expect(backoffDelay(3, () => 0)).toBe(6400);
  expect(backoffDelay(20, () => 1)).toBe(60_000);
  expect(backoffDelay(0, () => 0)).toBe(800);
});

test("hello first, ping → pong, request → result, refused → stops with exit 2", async () => {
  const { ws, sockets, connection, lines } = setup();
  writeFileSync(path.join(ws, "hello.txt"), "hi there");
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  await waitFor(() => s.sent.length === 1);
  expect(s.sent[0]).toEqual({
    type: "hello",
    token: "agm_token",
    version: "0.1.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "box",
    workspace: ws,
    exec: false,
  });

  s.frame({ type: "welcome", machineId: "m1", name: "My box", heartbeatMs: 25_000 });
  expect(lines).toContain("connected as My box");

  s.frame({ type: "ping", at: 42 });
  expect(s.sent[1]).toEqual({ type: "pong", at: 42 });

  s.frame({ type: "request", id: "r1", op: "read", path: "hello.txt", maxBytes: 1000 });
  await waitFor(() => s.sent.some((f) => f.id === "r1"));
  expect(s.sent.find((f) => f.id === "r1")).toEqual({
    type: "result",
    id: "r1",
    ok: true,
    data: { base64: Buffer.from("hi there").toString("base64"), size: 8 },
  });
  expect(lines).toContain("read hello.txt");

  s.frame({ type: "request", id: "r2", op: "exec", command: "echo hi", timeoutSeconds: 5, stream: false });
  await waitFor(() => s.sent.some((f) => f.id === "r2"));
  expect(s.sent.find((f) => f.id === "r2")).toMatchObject({ ok: false, error: { code: "exec_disabled" } });

  s.frame({ type: "refused", reason: "revoked", message: "This computer was removed" });
  expect(await done).toEqual({ exitCode: 2, reason: "revoked", message: "This computer was removed" });
  expect(s.closed).toBe(true);
  expect(sockets.length).toBe(1);
});

test("tasks: hello carries the journal, each welcome re-sends unacknowledged task.done, task.ack marks it", async () => {
  const done = { taskId: "t1", exitCode: 0, seconds: 3 };
  let delivered = false;
  const acks: string[] = [];
  const attached: ((f: unknown) => void)[] = [];
  const { sockets, connection } = setup({
    tasks: {
      list: () => [{ taskId: "t1", agentId: "a1", status: "done", startedAt: "2026-10-16T10:00:00.000Z" }],
      attach: (send) => {
        attached.push(send as (f: unknown) => void);
        if (!delivered) send({ type: "task.done", ...done });
      },
      detach: () => {},
      ack: (taskId) => {
        acks.push(taskId);
        delivered = true;
      },
    },
  });
  const run = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  await waitFor(() => s.sent.length === 1);
  expect(s.sent[0]).toMatchObject({ type: "hello", tasks: [{ taskId: "t1", status: "done" }] });
  s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  expect(s.sent[1]).toEqual({ type: "task.done", taskId: "t1", exitCode: 0, seconds: 3 });
  s.frame({ type: "task.ack", taskId: "t1" });
  expect(acks).toEqual(["t1"]);
  expect(attached).toHaveLength(1);
  connection.stop();
  await run;
});

test("refused: outdated exits 3, replaced exits 0", async () => {
  for (const [reason, exitCode] of [
    ["outdated", 3],
    ["replaced", 0],
    ["invalid_token", 2],
  ] as const) {
    const { sockets, connection } = setup();
    const done = connection.run();
    await waitFor(() => sockets.length === 1);
    sock(sockets, 0).handlers.onOpen();
    sock(sockets, 0).frame({ type: "refused", reason, message: reason });
    expect((await done).exitCode).toBe(exitCode);
  }
});

test("reconnects when the socket closes, and when no ping arrives for two heartbeats", async () => {
  const { sockets, connection, lines } = setup();
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 30 });
  // No ping: the watchdog closes it after 60 ms, then backoff (0.8 s with random 0) dials again.
  await waitFor(() => sockets.length === 2, 4000);
  expect(first.closed).toBe(true);
  expect(lines).toContain("no ping from the server; reconnecting");

  const second = sock(sockets, 1);
  second.handlers.onOpen();
  await waitFor(() => second.sent.length === 1);
  expect(second.sent[0]?.type).toBe("hello");
  // The server drops it: dial again.
  second.handlers.onClose(1006, "");
  await waitFor(() => sockets.length === 3, 4000);

  connection.stop();
  expect((await done).reason).toBe("stopped");
}, 15_000);

test("reconnect(): drops the welcomed socket and dials again without backoff; while backing off, dials now", async () => {
  const { sockets, connection, lines } = setup({ random: () => 0.99 });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  connection.reconnect();
  await waitFor(() => sockets.length === 2, 300);
  expect(first.closed).toBe(true);
  expect(lines).toContain("reconnecting now (asked by the app)");

  // The server drops it before welcome: a backoff starts; reconnect() cuts it short.
  sock(sockets, 1).handlers.onClose(1006, "");
  await waitFor(() => lines.some((l) => l.startsWith("disconnected; reconnecting in")));
  connection.reconnect();
  await waitFor(() => sockets.length === 3, 300);

  connection.stop();
  expect((await done).reason).toBe("stopped");
});

test("requests run concurrently up to 8; beyond that the runner answers busy; cancel aborts", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: Record<string, unknown>[] = [];
  const release: (() => void)[] = [];
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x" },
    (f) => sent.push(f as unknown as Record<string, unknown>),
    () => {},
    (_ctx, _req, scope) =>
      new Promise((resolve, reject) => {
        release.push(() => resolve({ done: true }));
        scope.signal.addEventListener("abort", () => reject(new RunnerError("internal", "Canceled")));
      }),
  );
  const started = Array.from({ length: 8 }, (_, i) => runner.start(`r${i}`, { op: "list", path: "", depth: 1 }));
  expect(runner.size).toBe(8);
  await runner.start("r8", { op: "list", path: "", depth: 1 });
  expect(sent).toEqual([{ type: "result", id: "r8", ok: false, error: { code: "internal", message: "busy" } }]);

  runner.cancel("r0");
  await started[0];
  expect(sent[1]).toEqual({ type: "result", id: "r0", ok: false, error: { code: "internal", message: "Canceled" } });

  release[1]?.();
  await started[1];
  expect(sent[2]).toEqual({ type: "result", id: "r1", ok: true, data: { done: true } });

  runner.close();
  await Promise.all(started);
  expect(sent.length).toBe(3);
  expect(runner.size).toBe(0);
});
