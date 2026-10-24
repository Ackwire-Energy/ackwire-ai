import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { MachineRequest, RunnerFrame, ServerFrame } from "@agenteschat/adapters/machine-protocol";
import type { AccountManager } from "../../runner/accounts";
import { AGENT_USERS_FILE, type AgentUser } from "../../runner/agent-users";
import { writeConfig } from "../../runner/config";
import type { Dial, Socket, SocketHandlers } from "../../runner/connection";
import { RunnerDaemon } from "../../runner/daemon";
import { RunnerError } from "../../runner/errors";
import { type HandlerContext, handleRequest, type RequestScope } from "../../runner/handlers";
import { readLines } from "../../runner/lines";
import type { FetchLike } from "../../runner/push";
import {
  Supervisor,
  type SupervisorOptions,
  WORKER_TASKS_FILE,
  type WorkerProcess,
  type WorkerState,
  workerCommand,
  workerHome,
} from "../../runner/supervisor";
import { runWorker } from "../../runner/worker";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const supervisors: Supervisor[] = [];
const workerRuns: Promise<number>[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.close(2000);
  await Promise.all(workerRuns.splice(0));
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const ANA = { id: "a1b2c3d4-0000-4000-8000-000000000001", handle: "ana", name: "Ana" };
const BIA = { id: "b2c3d4e5-0000-4000-8000-000000000002", handle: "bia", name: "Bia" };
const USERS: AgentUser[] = [
  { id: ANA.id, user: "ag-a1b2c3d4", uid: 21000 },
  { id: BIA.id, user: "ag-b2c3d4e5", uid: 21001 },
];
const userOf = (agent: { id: string }) => {
  const u = USERS.find((x) => x.id === agent.id);
  if (!u) throw new RunnerError("bad_request", "No such agent");
  return u;
};

const STATE: WorkerState = {
  access: {
    folders: [
      { path: "/srv/ana", agents: [ANA.id] },
      { path: "/srv/shared", agents: [ANA.id, BIA.id] },
    ],
    tools: { claude: true, codex: false, commands: true, browser: true },
  },
  paused: { paused: false },
  limits: { maxConcurrentTasks: 3, taskMaxSeconds: 3600, brainIdleMinutes: 10, brainMaxProcesses: 3 },
};

const HELLO = {
  type: "hello",
  token: "",
  version: "0.10.0",
  protocol: 17,
  os: "linux",
  arch: "x64",
  hostname: "box",
  workspace: "/home/ag",
  exec: true,
};

type Got = Record<string, unknown> & { id: string };

/** A worker over in-memory pipes: what the supervisor sends lands in `got`; `send` answers as the worker would. */
class FakeWorker implements WorkerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly got: Record<string, unknown>[] = [];
  killed = false;
  readonly exited: Promise<unknown>;
  private exit: (code: unknown) => void = () => {};

  constructor(readonly user: AgentUser) {
    this.exited = new Promise((resolve) => {
      this.exit = resolve;
    });
    readLines(
      this.stdin,
      1 << 26,
      (line) => this.got.push(JSON.parse(line) as Record<string, unknown>),
      () => {},
    );
    // Like a real worker: its stdin closing ends it.
    this.stdin.on("end", () => this.exit(0));
  }

  send(frame: Record<string, unknown>) {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  hello() {
    this.send(HELLO);
  }

  of(type: string) {
    return this.got.filter((f) => f.type === type);
  }

  kill() {
    this.killed = true;
    this.exit(null);
  }

  /** It exits on its own. */
  crash(code = 1) {
    this.exit(code);
  }
}

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
  frame(f: ServerFrame) {
    this.handlers.onMessage(JSON.stringify(f));
  }
  of(type: string) {
    return this.sent.filter((f) => f.type === type);
  }
}

function newHome() {
  const home = tempDir("supervisor-");
  dirs.push(home);
  writeFileSync(path.join(home, AGENT_USERS_FILE), JSON.stringify(USERS));
  return home;
}

function setup(over: Partial<SupervisorOptions> = {}, home = newHome()) {
  const workers: FakeWorker[] = [];
  const up: Record<string, unknown>[] = [];
  const logs: string[] = [];
  let state = STATE;
  const sup = new Supervisor({
    home,
    user: userOf,
    start: (user) => {
      const w = new FakeWorker(user);
      workers.push(w);
      return w;
    },
    token: "agm_machine",
    server: "https://agentes.test",
    send: (frame) => {
      up.push(frame as unknown as Record<string, unknown>);
      return true;
    },
    state: () => state,
    log: (line) => logs.push(line),
    ...over,
  });
  supervisors.push(sup);
  const ctx: HandlerContext = {
    workspaceReal: home,
    exec: true,
    token: "agm_machine",
    systemMode: () => true,
    workers: sup,
    accounts: { list: async () => [] } as unknown as AccountManager,
    accessOps: {
      request: async (_agent, req) => ({ requestId: req.requestId, status: "pending" }),
      reduce: async () => ({ access: STATE.access }),
    },
  };
  const of = (agentId: string) => workers.filter((w) => w.user.id === agentId);
  const last = (agentId: string) => of(agentId).at(-1) as FakeWorker;
  return { home, sup, ctx, workers, up, logs, of, last, setState: (s: WorkerState) => (state = s) };
}

function scope() {
  const ac = new AbortController();
  const output: { stream: string; chunk: string }[] = [];
  const emitted: RunnerFrame[] = [];
  const s: RequestScope = {
    signal: ac.signal,
    output: (stream, chunk) => output.push({ stream, chunk }),
    emit: (frame) => emitted.push(frame),
  };
  return { ac, output, emitted, scope: s };
}

/** The n-th request a worker got. */
async function requestOn(w: FakeWorker, n = 1): Promise<Got> {
  await waitFor(() => w.of("request").length >= n);
  return w.of("request")[n - 1] as Got;
}

const exec = (agent: typeof ANA, command = "id -un"): Extract<MachineRequest, { op: "exec" }> => ({
  op: "exec",
  command,
  timeoutSeconds: 10,
  stream: true,
  agent,
});
const execDone = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const taskStart = (agent: typeof ANA, taskId: string) =>
  ({ op: "task.start", taskId, executor: "shell", command: "sleep 1", agent }) as MachineRequest;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the computer's own ops stay in the supervisor; an agent's go to its worker, started on its first request", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  // No task to watch: no worker at boot.
  expect(t.workers).toHaveLength(0);
  const s = scope();
  expect(await handleRequest(t.ctx, { op: "account", action: "list" } as MachineRequest, s.scope)).toEqual({
    accounts: [],
  });
  const ask = { op: "access.request", requestId: "req-00000001", path: "/srv/x", reason: "data", agent: ANA } as const;
  expect(await handleRequest(t.ctx, ask, s.scope)).toEqual({ requestId: "req-00000001", status: "pending" });
  expect(t.workers).toHaveLength(0);

  const run = handleRequest(t.ctx, exec(ANA), s.scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  expect(ana.user).toEqual(USERS[0] as AgentUser);
  ana.hello();
  const req = await requestOn(ana);
  // Its state (only its own folders) and the welcome come first; the request has the supervisor's own id.
  expect(ana.got.map((f) => f.type)).toEqual(["worker.state", "welcome", "request"]);
  expect(ana.got[0]).toEqual({ type: "worker.state", ...STATE });
  expect(req).toEqual({ ...exec(ANA), type: "request", id: req.id });
  ana.send({ type: "output", id: req.id, stream: "stdout", chunk: "ag-a1b2c3d4\n" });
  ana.send({ type: "result", id: req.id, ok: true, data: { ...execDone, stdout: "ag-a1b2c3d4\n" } });
  expect(await run).toEqual({ ...execDone, stdout: "ag-a1b2c3d4\n" });
  expect(s.output).toEqual([{ stream: "stdout", chunk: "ag-a1b2c3d4\n" }]);

  // Bia's first request starts Bia's worker; Ana's sees nothing of it.
  const read = handleRequest(t.ctx, { op: "read", path: "notes.md", maxBytes: 100, agent: BIA }, scope().scope);
  await waitFor(() => t.workers.length === 2);
  const bia = t.last(BIA.id);
  bia.hello();
  const r2 = await requestOn(bia);
  expect((bia.got[0] as unknown as WorkerState).access.folders).toEqual([
    { path: "/srv/shared", agents: [ANA.id, BIA.id] },
  ]);
  bia.send({ type: "result", id: r2.id, ok: false, error: { code: "not_found", message: "No such file" } });
  expect(await errorCode(() => read)).toBe("not_found");
  expect(ana.of("request")).toHaveLength(1);

  // The same worker serves the agent's next requests.
  const next = handleRequest(t.ctx, exec(ANA, "pwd"), scope().scope);
  const r3 = await requestOn(ana, 2);
  ana.send({ type: "result", id: r3.id, ok: true, data: execDone });
  await next;
  expect(t.workers).toHaveLength(2);

  // A request without its agent, or an op this runner doesn't know, goes nowhere.
  const anonymous = { op: "exec", command: "id", timeoutSeconds: 1, stream: false } as MachineRequest;
  expect(await errorCode(() => handleRequest(t.ctx, anonymous, scope().scope))).toBe("bad_request");
  const unknown = { op: "make.coffee", agent: ANA } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(t.ctx, unknown, scope().scope))).toBe("bad_request");
  expect(t.workers).toHaveLength(2);
  expect(ana.of("request")).toHaveLength(2);
});

test("a cancel reaches only the worker that runs that request", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const a = scope();
  const b = scope();
  const ra = handleRequest(t.ctx, exec(ANA, "sleep 100"), a.scope);
  const rb = handleRequest(t.ctx, exec(BIA, "sleep 100"), b.scope);
  await waitFor(() => t.workers.length === 2);
  for (const w of t.workers) w.hello();
  const ana = t.last(ANA.id);
  const bia = t.last(BIA.id);
  const qa = await requestOn(ana);
  const qb = await requestOn(bia);
  // The server canceled Bia's request.
  b.ac.abort();
  await waitFor(() => bia.of("cancel").length === 1);
  expect(bia.of("cancel")).toEqual([{ type: "cancel", id: qb.id }]);
  expect(ana.of("cancel")).toEqual([]);
  const canceled = { ...execDone, exitCode: null, canceled: { killed: true } };
  bia.send({ type: "result", id: qb.id, ok: true, data: canceled });
  expect(await rb).toEqual(canceled);
  ana.send({ type: "result", id: qa.id, ok: true, data: execDone });
  expect(await ra).toEqual(execDone);

  // Canceled while the agent's worker isn't up: it fails at once instead of waiting for it.
  ana.crash();
  await waitFor(() => t.logs.some((l) => l.startsWith("[ag-a1b2c3d4] stopped")));
  const c = scope();
  const pending = handleRequest(t.ctx, exec(ANA, "late"), c.scope);
  c.ac.abort();
  expect(await errorCode(() => pending)).toBe("internal");
});

test("frames from a worker go up only when they are its agent's", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const turn = scope();
  const brain = handleRequest(
    t.ctx,
    {
      op: "brain.turn",
      runId: "run-ana-0001",
      kind: "claude_code",
      session: { id: "sess-ana-0001", resume: false },
      cwd: "",
      agent: ANA,
    } as unknown as MachineRequest,
    turn.scope,
  );
  const start = handleRequest(t.ctx, taskStart(ANA, "task-ana-0001"), scope().scope);
  const listing = handleRequest(t.ctx, { op: "list", path: "", depth: 1, agent: BIA }, scope().scope);
  await waitFor(() => t.workers.length === 2);
  for (const w of t.workers) w.hello();
  const ana = t.last(ANA.id);
  const bia = t.last(BIA.id);
  const qTurn = await requestOn(ana, 1);
  const qStart = await requestOn(ana, 2);
  const qList = await requestOn(bia, 1);
  ana.send({
    type: "result",
    id: qStart.id,
    ok: true,
    data: { taskId: "task-ana-0001", pid: 4242, startedAt: "2026-10-24T10:00:00.000Z", cwd: "", command: "sleep 1" },
  });
  await start;

  const event = { type: "brain.event", runId: "run-ana-0001", event: { type: "text_delta", text: "Oi" } };
  const taskEvent = { type: "task.event", taskId: "task-ana-0001", kind: "line", line: "working" };
  const ended = { type: "browser.stream.ended", agentId: ANA.id, reason: "stopped" };
  // Bia's worker speaks for Ana: her turn, her task, her browser, her request's result, the computer's pause.
  bia.send(event);
  bia.send(taskEvent);
  bia.send({ type: "task.done", taskId: "task-ana-0001", exitCode: 0, seconds: 1 });
  bia.send(ended);
  bia.send({ type: "runner.state", paused: { paused: true, until: null } });
  bia.send({ type: "accounts.changed", accounts: [] });
  bia.send({
    type: "result",
    id: qTurn.id,
    ok: true,
    data: { runId: "run-ana-0001", final: { type: "done", text: "x" } },
  });
  bia.send({ type: "output", id: qTurn.id, stream: "stdout", chunk: "forged" });
  bia.send({ type: "result", id: qList.id, ok: true, data: { entries: [] } });
  expect(await listing).toEqual({ entries: [] });
  // Ana's own.
  ana.send(event);
  ana.send(taskEvent);
  ana.send(ended);
  const call = {
    type: "mcp.call",
    callId: "call-0001",
    taskId: "task-ana-0001",
    tool: "report",
    args: { summary: "x" },
  };
  ana.send({ ...call, token: "agr_ana-token-0000000000" });
  await waitFor(() => t.up.length === 3);
  expect(t.up).toEqual([taskEvent, ended, { ...call, token: "agr_ana-token-0000000000" }]);
  // Without the run's token the server would take the task id's word: refused here, nothing goes up.
  bia.send({ ...call, callId: "call-0009" });
  await waitFor(() => bia.of("mcp.result").length === 1);
  expect(bia.of("mcp.result")[0]).toMatchObject({ callId: "call-0009", ok: false, error: { code: "not_allowed" } });
  expect(t.up).toHaveLength(3);
  // A turn's events go out with its request (the server's id), and only Ana's.
  await waitFor(() => turn.emitted.length === 1);
  expect(turn.emitted).toEqual([event as RunnerFrame]);

  // The answer to a call goes back to the worker that made it; another worker can't take its call id.
  bia.send({ type: "mcp.list", callId: "call-0001", taskId: "run-bia-0001", token: "agr_bia-token-0000000000" });
  t.sup.mcp.result({ type: "mcp.result", callId: "call-0001", ok: true, text: "noted" });
  await waitFor(() => ana.of("mcp.result").length === 1);
  expect(ana.of("mcp.result")).toEqual([{ type: "mcp.result", callId: "call-0001", ok: true, text: "noted" }]);
  expect(bia.of("mcp.result").map((f) => f.callId)).toEqual(["call-0009"]);
  expect(t.up).toHaveLength(3);

  ana.send({ type: "brain.done", runId: "run-ana-0001" });
  const final = { type: "done", text: "Oi" };
  ana.send({ type: "result", id: qTurn.id, ok: true, data: { runId: "run-ana-0001", final } });
  expect(await brain).toEqual({ runId: "run-ana-0001", final });
  expect(turn.emitted).toEqual([event as RunnerFrame, { type: "brain.done", runId: "run-ana-0001" }]);
  // That turn is over: a late event of it goes nowhere.
  ana.send(event);
  await sleep(20);
  expect(turn.emitted).toHaveLength(2);
});

test("hello lists every worker's tasks until the server acknowledges them, across a restart of the supervisor", async () => {
  const home = newHome();
  const t = setup({}, home);
  t.sup.boot();
  t.sup.attach();
  const startOn = async (agent: typeof ANA, taskId: string, n: number, ok = true) => {
    const run = handleRequest(t.ctx, taskStart(agent, taskId), scope().scope);
    await waitFor(() => t.of(agent.id).length === 1);
    const w = t.last(agent.id);
    if (n === 1) w.hello();
    const q = await requestOn(w, n);
    w.send(
      ok
        ? { type: "result", id: q.id, ok: true, data: { taskId, pid: 1, startedAt: "now", cwd: "", command: "x" } }
        : { type: "result", id: q.id, ok: false, error: { code: "no_slot", message: "busy" } },
    );
    return errorCode(() => run);
  };
  expect(await startOn(ANA, "task-ana-0001", 1)).toBe("ok");
  expect(await startOn(BIA, "task-bia-0001", 1)).toBe("ok");
  // Refused by the worker: that task never started.
  expect(await startOn(ANA, "task-ana-0002", 2, false)).toBe("no_slot");
  const listed = (s: Supervisor) => s.list().map((x) => [x.taskId, x.agentId, x.status]);
  expect(listed(t.sup)).toEqual([
    ["task-ana-0001", ANA.id, "running"],
    ["task-bia-0001", BIA.id, "running"],
  ]);
  expect(t.sup.list()[0]?.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  // A task id that is another agent's can't be started for someone else.
  expect(await errorCode(() => handleRequest(t.ctx, taskStart(ANA, "task-bia-0001"), scope().scope))).toBe(
    "bad_request",
  );

  // The supervisor restarts: the tasks are still listed, and their workers start at boot to watch them.
  await t.sup.close(100);
  const t2 = setup({}, home);
  expect(listed(t2.sup)).toEqual(listed(t.sup));
  t2.sup.boot();
  expect(t2.workers.map((w) => w.user.id).sort()).toEqual([ANA.id, BIA.id].sort());

  // An ack waits until the task's worker can be told (it sends `task.done` again, and the server acknowledges again).
  t2.sup.attach();
  t2.sup.ack("task-ana-0001");
  expect(listed(t2.sup)).toHaveLength(2);
  for (const w of t2.workers) w.hello();
  await waitFor(() => t2.workers.every((w) => w.of("welcome").length === 1));
  t2.sup.ack("task-ana-0001");
  await waitFor(() => t2.last(ANA.id).of("task.ack").length === 1);
  expect(t2.last(BIA.id).of("task.ack")).toEqual([]);
  expect(listed(t2.sup)).toEqual([["task-bia-0001", BIA.id, "running"]]);
  const file = JSON.parse(readFileSync(path.join(home, WORKER_TASKS_FILE), "utf8")) as Record<string, unknown>;
  expect(Object.keys(file)).toEqual(["task-bia-0001"]);
  expect(statSync(path.join(home, WORKER_TASKS_FILE)).mode & 0o777).toBe(0o600);
});

test("a worker that stops fails what it ran and starts again with a backoff", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const first = handleRequest(t.ctx, exec(ANA, "sleep 100"), scope().scope);
  await waitFor(() => t.workers.length === 1);
  t.last(ANA.id).hello();
  await requestOn(t.last(ANA.id));
  t.last(ANA.id).crash(1);
  expect(await errorCode(() => first)).toBe("internal");
  await waitFor(() => t.logs.some((l) => l === "[ag-a1b2c3d4] stopped (exit 1)"));
  // Nothing waits for it and it has no task to watch: it stays stopped.
  await sleep(50);
  expect(t.workers).toHaveLength(1);
  // The next request starts it again, once the backoff is over (it had only just started).
  const at = Date.now();
  const again = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 2, 3000);
  expect(Date.now() - at).toBeGreaterThanOrEqual(600);
  t.last(ANA.id).hello();
  const q = await requestOn(t.last(ANA.id));
  t.last(ANA.id).send({ type: "result", id: q.id, ok: true, data: execDone });
  expect(await again).toEqual(execDone);

  // A worker with a task to watch comes back by itself.
  const start = handleRequest(t.ctx, taskStart(BIA, "task-bia-0001"), scope().scope);
  await waitFor(() => t.of(BIA.id).length === 1);
  t.last(BIA.id).hello();
  const qs = await requestOn(t.last(BIA.id));
  t.last(BIA.id).send({
    type: "result",
    id: qs.id,
    ok: true,
    data: { taskId: "task-bia-0001", pid: 1, startedAt: "now", cwd: "", command: "x" },
  });
  await start;
  t.last(BIA.id).crash(137);
  await waitFor(() => t.of(BIA.id).length === 2, 3000);
  // Whatever its stopped process still says is ignored: the new one hasn't said hello, so it hears nothing.
  t.of(BIA.id)[0]?.send({ ...HELLO });
  await sleep(20);
  expect(t.last(BIA.id).got).toEqual([]);
});

test("worker sessions follow the server's: they end when it drops and are welcomed when it is back", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA, "sleep 100"), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  await requestOn(ana);
  const handoff: Extract<ServerFrame, { type: "browser.handoff" }> = {
    type: "browser.handoff",
    agentId: ANA.id,
    handoff: { status: "active", controller: "Maria" },
  };
  t.sup.handoff(handoff);
  await waitFor(() => ana.of("browser.handoff").length === 1);

  // The server's socket drops: so does the worker's session, and what it ran fails.
  t.sup.detach();
  expect(await errorCode(() => run)).toBe("internal");
  expect(ana.of("worker.close")).toHaveLength(1);
  // Its next session says hello: it gets its state, but no welcome while the server is away.
  const before = ana.got.length;
  ana.hello();
  await waitFor(() => ana.got.length > before);
  await sleep(20);
  expect(ana.got.slice(before).map((f) => f.type)).toEqual(["worker.state"]);

  // Bia's turn opens while her worker isn't running: her worker gets it when it says hello.
  t.sup.attach();
  await waitFor(() => ana.of("welcome").length === 2);
  t.sup.handoff({ ...handoff, agentId: BIA.id });
  const bread = handleRequest(t.ctx, { op: "read", path: "x", maxBytes: 1, agent: BIA }, scope().scope);
  await waitFor(() => t.of(BIA.id).length === 1);
  const bia = t.last(BIA.id);
  bia.hello();
  await requestOn(bia);
  expect(bia.got.map((f) => f.type)).toEqual(["worker.state", "welcome", "browser.handoff", "request"]);
  bia.send({ type: "result", id: (bia.of("request")[0] as Got).id, ok: true, data: { base64: null, size: 0 } });
  await bread;
  // Ana's turn was said before the drop: forgotten, not replayed.
  expect(ana.of("browser.handoff")).toHaveLength(1);

  // The computer's settings change: each worker hears it once.
  t.setState({ ...STATE, paused: { paused: true, until: null } });
  t.sup.stateChanged();
  t.sup.stateChanged();
  await waitFor(() => ana.of("worker.state").length === 3);
  await sleep(20);
  expect(ana.of("worker.state")).toHaveLength(3);
  expect(ana.of("worker.state")[2]).toMatchObject({ paused: { paused: true, until: null } });
});

test("push: the worker's bytes go out from here with the machine token, only to the server it is paired with", async () => {
  const puts: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    puts.push({ url, init });
    return new Response('{"ok":true}', { status: 200 });
  };
  // The server's own computer: paired on its local address, while the server names its public one.
  const t = setup({ fetch, server: "http://127.0.0.1:3000" });
  t.sup.boot();
  t.sup.attach();
  const uploadId = "11111111-1111-4111-8111-111111111111";
  const req: MachineRequest = {
    op: "push",
    path: "report.pdf",
    url: "https://agentes.test/api/machines/uploads/1",
    uploadId,
    maxBytes: 4_000_000,
    agent: ANA,
  };
  const push = handleRequest(t.ctx, req, scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  const bytes = Buffer.alloc(2_500_000, 7);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (let at = 0; at < bytes.length; at += 1024 * 1024) {
    ana.send({ type: "upload.chunk", uploadId, data: bytes.subarray(at, at + 1024 * 1024).toString("base64") });
  }
  const end = { type: "upload.end", uploadId, contentType: "application/pdf", name: "report.pdf", sha256 };
  ana.send({ ...end, url: "https://evil.test/steal" });
  await waitFor(() => ana.of("upload.reply").length === 1);
  expect(ana.of("upload.reply")).toEqual([{ type: "upload.reply", uploadId, status: 200, body: '{"ok":true}' }]);
  expect(puts).toHaveLength(1);
  expect(puts[0]?.url).toBe("http://127.0.0.1:3000/api/machines/uploads/1");
  expect(puts[0]?.init.method).toBe("PUT");
  expect(puts[0]?.init.headers).toEqual({
    authorization: "Bearer agm_machine",
    "content-type": "application/pdf",
    "x-agentes-file-name": "report.pdf",
    "x-agentes-sha256": sha256,
    "x-agentes-upload-id": uploadId,
  });
  expect(Buffer.from(puts[0]?.init.body as Uint8Array).equals(bytes)).toBe(true);
  // Once per push; bytes nobody asked for get an answer and go nowhere.
  ana.send(end);
  ana.send({ ...end, uploadId: "22222222-2222-4222-8222-222222222222" });
  await waitFor(() => ana.of("upload.reply").length === 2);
  expect(ana.of("upload.reply")[1]).toMatchObject({ error: "No upload is waiting for these bytes" });
  expect(puts).toHaveLength(1);
  const sent = { name: "report.pdf", size: bytes.length, sha256, contentType: "application/pdf" };
  ana.send({ type: "result", id: q.id, ok: true, data: sent });
  expect(await push).toEqual(sent);

  // More than the request allows: refused here, nothing goes out.
  const small = handleRequest(t.ctx, { ...req, maxBytes: 10 }, scope().scope);
  const q2 = await requestOn(ana, 2);
  ana.send({ type: "upload.chunk", uploadId, data: Buffer.alloc(20).toString("base64") });
  ana.send(end);
  await waitFor(() => ana.of("upload.reply").length === 3);
  expect(ana.of("upload.reply")[2]).toMatchObject({ status: 413 });
  expect(puts).toHaveLength(1);
  ana.send({ type: "result", id: q2.id, ok: false, error: { code: "upload_failed", message: "too large" } });
  expect(await errorCode(() => small)).toBe("upload_failed");

  // A URL that isn't http(s): the token goes nowhere.
  const odd = handleRequest(t.ctx, { ...req, url: "file:///etc/passwd" }, scope().scope);
  const q3 = await requestOn(ana, 3);
  ana.send({ type: "upload.chunk", uploadId, data: Buffer.from("x").toString("base64") });
  ana.send(end);
  await waitFor(() => ana.of("upload.reply").length === 4);
  expect(ana.of("upload.reply")[3]).toEqual({
    type: "upload.reply",
    uploadId,
    error: "The upload URL must be http(s)",
  });
  expect(puts).toHaveLength(1);
  ana.send({ type: "result", id: q3.id, ok: false, error: { code: "upload_failed", message: "no" } });
  expect(await errorCode(() => odd)).toBe("upload_failed");
});

/** A real worker (`runWorker`) on the other end of in-memory pipes; `at`: the homes of an earlier supervisor (a restart). */
function realWorkers(over: Partial<SupervisorOptions> = {}, at?: { home: string; agentHome: string; ownHome: string }) {
  const agentHome = at?.agentHome ?? tempDir("agent-home-");
  const ownHome = at?.ownHome ?? tempDir("worker-home-");
  if (!at) dirs.push(agentHome, ownHome);
  const started: PassThrough[] = [];
  const t = setup(
    {
      start: (user) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        started.push(stdin);
        const done = runWorker({
          agentId: user.id,
          home: ownHome,
          dir: agentHome,
          input: stdin,
          output: stdout,
          log: () => {},
          self: { command: [process.execPath, "/nonexistent/agentes-runner.mjs"], compiled: false },
        });
        workerRuns.push(done);
        return { stdin, stdout, exited: done, kill: () => stdin.end() };
      },
      ...over,
    },
    at?.home,
  );
  return { ...t, agentHome, ownHome, started };
}

test.if(posix)(
  "a real worker: its agent's folder, what the computer allows, uploads through the supervisor, new sessions",
  async () => {
    const puts: { url: string; init: RequestInit }[] = [];
    const t = realWorkers({
      fetch: async (url, init) => {
        puts.push({ url, init });
        return new Response("{}", { status: 200 });
      },
    });
    t.sup.boot();
    t.sup.attach();
    const pwd = (await handleRequest(t.ctx, { ...exec(ANA, "pwd"), stream: false }, scope().scope)) as {
      exitCode: number;
      stdout: string;
    };
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.trim()).toBe(path.join(realpathSync(t.agentHome), "ana-a1b2c3d4"));
    // Its state lives in its own home, not in the agent's.
    expect(statSync(path.join(t.ownHome, "tasks")).isDirectory()).toBe(true);

    const write = { op: "write", path: "out/report.txt", base64: Buffer.from("olá").toString("base64"), agent: ANA };
    expect(await handleRequest(t.ctx, write as MachineRequest, scope().scope)).toEqual({ size: 4 });
    const uploadId = "33333333-3333-4333-8333-333333333333";
    const url = "https://agentes.test/api/machines/uploads/3";
    const push = { op: "push", path: "out/report.txt", url, uploadId, maxBytes: 1000, agent: ANA } as MachineRequest;
    expect(await handleRequest(t.ctx, push, scope().scope)).toMatchObject({ name: "report.txt", size: 4 });
    expect(puts.map((p) => [p.url, (p.init.headers as Record<string, string>).authorization])).toEqual([
      [url, "Bearer agm_machine"],
    ]);
    expect(Buffer.from(puts[0]?.init.body as Uint8Array).toString()).toBe("olá");

    // Commands turned off on the computer: the worker refuses them (its state comes before the next request).
    const off = { ...STATE.access.tools, commands: false };
    t.setState({ ...STATE, access: { ...STATE.access, tools: off } });
    t.sup.stateChanged();
    expect(await errorCode(() => handleRequest(t.ctx, exec(ANA, "pwd"), scope().scope))).toBe("exec_disabled");
    t.setState(STATE);
    t.sup.stateChanged();

    // The server's socket drops and comes back: the worker says hello again and serves requests.
    t.sup.detach();
    t.sup.attach();
    const again = (await handleRequest(t.ctx, { ...exec(ANA, "echo back"), stream: false }, scope().scope)) as {
      stdout: string;
    };
    expect(again.stdout).toBe("back\n");
    expect(t.started).toHaveLength(1);
  },
);

test.if(posix)(
  "a real task keeps running through a restart of the supervisor, and the next worker reports its end",
  async () => {
    const t = realWorkers();
    t.sup.boot();
    t.sup.attach();
    const taskId = "task-ana-0001";
    const start = { op: "task.start", taskId, executor: "shell", command: "sleep 0.6; echo finished", agent: ANA };
    expect(await handleRequest(t.ctx, start as MachineRequest, scope().scope)).toMatchObject({ taskId });
    // The supervisor stops (a restart): its worker exits with it, the task goes on.
    await t.sup.close(2000);
    const t2 = realWorkers({}, t);
    expect(t2.sup.list()).toMatchObject([{ taskId, agentId: ANA.id, status: "running" }]);
    t2.sup.boot();
    expect(t2.started).toHaveLength(1);
    t2.sup.attach();
    await waitFor(() => t2.up.some((f) => f.type === "task.done"), 8000);
    expect(t2.up.filter((f) => f.type === "task.done")).toMatchObject([
      { taskId, exitCode: 0, result: "finished", lastLine: "finished" },
    ]);
    t2.sup.ack(taskId);
    expect(t2.sup.list()).toEqual([]);
  },
  15_000,
);

test.if(posix)(
  "a worker alone: hello first, its own agent's requests only, a new session on worker.close",
  async () => {
    const agentHome = tempDir("agent-home-");
    const ownHome = tempDir("worker-home-");
    dirs.push(agentHome, ownHome);
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Got[] = [];
    readLines(
      output,
      1 << 26,
      (line) => frames.push(JSON.parse(line) as Got),
      () => {},
    );
    const done = runWorker({ agentId: ANA.id, home: ownHome, dir: agentHome, input, output, log: () => {} });
    const send = (f: object) => input.write(`${JSON.stringify(f)}\n`);
    const result = async (id: string) => {
      await waitFor(() => frames.some((f) => f.type === "result" && f.id === id));
      return frames.find((f) => f.type === "result" && f.id === id) as Got;
    };
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ type: "hello", token: "", exec: false, workspace: realpathSync(agentHome) });
    send({ type: "welcome", machineId: ANA.id, name: "ag-a1b2c3d4", heartbeatMs: 25_000 });
    // Nothing is allowed until the supervisor says what the computer allows.
    send({ type: "request", id: "1", ...exec(ANA, "pwd") });
    expect(await result("1")).toMatchObject({ ok: false, error: { code: "exec_disabled" } });
    send({ type: "worker.state", ...STATE });
    send({ type: "request", id: "2", ...exec(ANA, "echo hi") });
    expect(await result("2")).toMatchObject({ ok: true, data: { exitCode: 0, stdout: "hi\n" } });
    expect(frames.some((f) => f.type === "output" && f.id === "2")).toBe(true);
    // Another agent's request never runs here.
    send({ type: "request", id: "3", ...exec(BIA, "echo nope") });
    expect(await result("3")).toMatchObject({ ok: false, error: { code: "not_allowed" } });

    // worker.close ends the session; the worker dials again and says hello.
    send({ type: "worker.close" });
    await waitFor(() => frames.filter((f) => f.type === "hello").length === 2, 3000);
    input.end();
    expect(await done).toBe(0);
  },
);

test.if(posix)(
  "a system-mode runner: hello lists its workers' tasks, agents' requests go to their workers, pause stops new work first",
  async () => {
    const home = newHome();
    const ws = tempDir("root-ws-");
    dirs.push(ws);
    writeConfig(
      {
        server: "https://agentes.test",
        machineId: "m1",
        name: "box",
        token: "agm_machine_token_never_shown_123456",
        workspace: ws,
        exec: true,
        mode: "system",
        agentUidRange: [21000, 21099],
        access: { folders: [], tools: { claude: false, codex: false, commands: true } },
      },
      home,
    );
    const startedAt = new Date().toISOString();
    writeFileSync(
      path.join(home, WORKER_TASKS_FILE),
      JSON.stringify({ "task-ana-0001": { agentId: ANA.id, startedAt } }),
    );
    const workers: FakeWorker[] = [];
    const sockets: FakeSocket[] = [];
    const dial: Dial = (_url, handlers) => {
      const s = new FakeSocket(handlers);
      sockets.push(s);
      return s;
    };
    const daemon = new RunnerDaemon({
      home,
      mode: "start",
      log: () => {},
      watch: false,
      executors: () => ({}),
      self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
      caffeinate: false,
      dial,
      workers: {
        user: userOf,
        start: (user) => {
          const w = new FakeWorker(user);
          workers.push(w);
          return w;
        },
      },
    });
    daemon.start();
    try {
      // Ana's worker starts at boot: it has a task to watch.
      await waitFor(() => workers.length === 1);
      const ana = workers[0] as FakeWorker;
      expect(ana.user.id).toBe(ANA.id);
      await waitFor(() => sockets.length === 1);
      const s = sockets[0] as FakeSocket;
      s.handlers.onOpen();
      await waitFor(() => s.of("hello").length === 1);
      expect(s.of("hello")[0]?.tasks).toEqual([
        { taskId: "task-ana-0001", agentId: ANA.id, status: "running", startedAt },
      ]);
      // Each agent works as its own user, and hello says so: who may drive an agent's desktop follows it.
      expect(s.of("hello")[0]?.mode).toBe("system");
      s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
      ana.hello();
      await waitFor(() => ana.of("welcome").length === 1);
      expect(ana.of("worker.state")[0]).toMatchObject({
        access: { tools: { commands: true } },
        paused: { paused: false },
      });

      s.frame({ type: "request", id: "r1", ...exec(ANA, "id -un") });
      const q = await requestOn(ana);
      ana.send({ type: "result", id: q.id, ok: true, data: { ...execDone, stdout: "ag-a1b2c3d4\n" } });
      await waitFor(() => s.sent.some((f) => f.id === "r1"));
      expect(s.sent.find((f) => f.id === "r1")).toEqual({
        type: "result",
        id: "r1",
        ok: true,
        data: { ...execDone, stdout: "ag-a1b2c3d4\n" },
      });
      // The desktops are this root process's own (the data sockets need the machine token): no worker hears of them.
      s.frame({ type: "request", id: "d1", op: "desktop.session.status", agent: ANA });
      await waitFor(() => s.sent.some((f) => f.id === "d1"));
      expect(s.sent.find((f) => f.id === "d1")).toMatchObject({ ok: true, data: { running: false, streams: 0 } });
      expect(ana.of("request")).toHaveLength(1);
      // Its task's end goes up; the server's ack comes back down to it.
      ana.send({ type: "task.done", taskId: "task-ana-0001", exitCode: 0, seconds: 3 });
      await waitFor(() => s.of("task.done").length === 1);
      s.frame({ type: "task.ack", taskId: "task-ana-0001" });
      await waitFor(() => ana.of("task.ack").length === 1);

      // Paused: new work is refused here, before any worker hears of it; the workers learn the pause too.
      daemon.pause(null);
      await waitFor(() => ana.of("worker.state").length === 2);
      s.frame({ type: "request", id: "r2", ...exec(ANA, "id -un") });
      await waitFor(() => s.sent.some((f) => f.id === "r2"));
      expect(s.sent.find((f) => f.id === "r2")).toMatchObject({ ok: false, error: { code: "paused" } });
      expect(ana.of("request")).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  },
);

test("the launch line: the agent's launcher, then this runner's worker with the agent's own home outside its folder", () => {
  const ana = USERS[0] as AgentUser;
  const runner = ["/opt/agentes-runner/bin/bun", "/opt/agentes-runner/agentes-runner.mjs"];
  const home = "/var/lib/agentes-runner-agents/ag-a1b2c3d4";
  const cmd = workerCommand(ana, runner, home, true);
  expect(cmd.argv).toEqual([
    "/usr/bin/systemd-run",
    "--quiet",
    "--scope",
    "--collect",
    "--slice=agents-21000.slice",
    "--",
    "/usr/sbin/runuser",
    "-u",
    "ag-a1b2c3d4",
    "--",
    ...runner,
    "worker",
    "--agent",
    ANA.id,
    "--dir",
    "/home/ag-a1b2c3d4",
    "--home",
    home,
  ]);
  expect(cmd.cwd).toBe("/home/ag-a1b2c3d4");
  // Only the launcher's environment: never the root runner's own (its token, its home).
  expect(Object.keys(cmd.env).sort()).toEqual(["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "USER"]);
  expect(workerCommand(ana, runner, home, false).argv.slice(0, 4)).toEqual([
    "/usr/sbin/runuser",
    "-u",
    "ag-a1b2c3d4",
    "--",
  ]);
});

test.if(posix)("a worker's home: its agent's own, in a folder nobody else can list", () => {
  const base = path.join(tempDir("worker-homes-"), "agents");
  dirs.push(path.dirname(base));
  const me: AgentUser = { id: ANA.id, user: "ag-a1b2c3d4", uid: process.getuid?.() ?? 0 };
  const dir = workerHome(base, me);
  expect(dir).toBe(path.join(base, "ag-a1b2c3d4"));
  expect(statSync(base).mode & 0o777).toBe(0o711);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(dir).uid).toBe(me.uid);
  expect(workerHome(base, me)).toBe(dir);
});

test("lines: split across chunks, UTF-8 kept whole, and a line too long is skipped without being held", async () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  let tooLong = 0;
  readLines(
    stream,
    10,
    (l) => lines.push(l),
    () => tooLong++,
  );
  const olá = Buffer.from("olá\n");
  stream.write(olá.subarray(0, 3));
  stream.write(olá.subarray(3));
  stream.write("a\nb");
  stream.write("c\n");
  stream.write("x".repeat(8));
  stream.write("y".repeat(8));
  stream.write("zzz\nafter\n");
  stream.write(`${"q".repeat(11)}\nend\n`);
  await waitFor(() => lines.length === 5);
  expect(lines).toEqual(["olá", "a", "bc", "after", "end"]);
  expect(tooLong).toBe(2);
});
