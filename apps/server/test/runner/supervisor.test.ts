import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AgentScope, MachineRequest, RunnerFrame, ServerFrame } from "@agenteschat/adapters/machine-protocol";
import { sealSecret, secretAad } from "@agenteschat/adapters/secret-box";
import type { AccountManager } from "../../runner/accounts";
import { AGENT_USERS_FILE, type AgentUser } from "../../runner/agent-users";
import { BrowserManager } from "../../runner/browser";
import { writeConfig } from "../../runner/config";
import type { Dial, Socket, SocketHandlers } from "../../runner/connection";
import { RunnerDaemon } from "../../runner/daemon";
import { RunnerError } from "../../runner/errors";
import { type HandlerContext, handleRequest, type RequestScope } from "../../runner/handlers";
import { readLines } from "../../runner/lines";
import type { FetchLike } from "../../runner/push";
import { agentSecrets } from "../../runner/secrets";
import { RelayCount } from "../../runner/streams";
import {
  BROWSER_LEASE_MS,
  retireLegacyPending,
  Supervisor,
  type SupervisorOptions,
  WORKER_TASKS_FILE,
  type WorkerDesktop,
  type WorkerProcess,
  type WorkerState,
  workerCommand,
  workerHome,
} from "../../runner/supervisor";
import { runWorker, WorkerLink } from "../../runner/worker";
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
const browserOpen = (
  agent: typeof ANA,
  desktop: boolean,
  command = "open",
  args = ["https://shop.example/cart"],
): Extract<MachineRequest, { op: "browser.act" }> => ({
  op: "browser.act",
  command,
  args,
  timeoutSeconds: 30,
  agent,
  ...(desktop ? { desktop } : {}),
});
const BROWSER_REFUSED = "No browser command of this agent on its desktop is running";

test("system boot guards ports and prepares every persisted UID before restoring a worker", () => {
  const home = newHome();
  writeFileSync(
    path.join(home, WORKER_TASKS_FILE),
    JSON.stringify({
      "task-ana-0001": { agentId: ANA.id, startedAt: new Date().toISOString() },
    }),
  );
  const order: string[] = [];
  const t = setup(
    {
      guard: { start: () => order.push("guard"), stop: () => {} },
      prepareExisting: (users) => {
        expect(users.map((u) => u.uid)).toEqual([21000, 21001]);
        order.push("policy");
      },
      start: (user) => {
        order.push("worker");
        return new FakeWorker(user);
      },
    },
    home,
  );
  t.sup.boot();
  expect(order).toEqual(["guard", "policy", "worker"]);
});

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

test("a brain turn's account goes to its agent's user before the turn reaches the worker; root marks what it refused", async () => {
  const lends: [string, string, number][] = [];
  const refused: string[] = [];
  const t = setup({
    lend: async (kind, id, uid) => {
      lends.push([kind, id, uid]);
    },
  });
  t.ctx.accounts = {
    refused: async (_kind: string, id: string) => {
      refused.push(id);
    },
    invalidate: () => {},
    refresh: async () => [],
  } as unknown as AccountManager;
  t.sup.boot();
  t.sup.attach();
  const ACCOUNT = "0193ffff-0000-7000-8000-000000000001";
  const turn = (account?: string) =>
    ({
      op: "brain.turn",
      kind: "claude_code",
      runId: "run-00000001",
      session: { id: "0193aaaa-0000-7000-8000-000000000001", resume: false },
      prompt: "hi",
      ...(account ? { account } : {}),
      agent: BIA,
    }) as MachineRequest;
  const run = handleRequest(t.ctx, turn(ACCOUNT), scope().scope);
  await waitFor(() => t.workers.length === 1);
  expect(lends).toEqual([["claude_code", ACCOUNT, 21001]]);
  const bia = t.last(BIA.id);
  bia.hello();
  const q = await requestOn(bia);
  const final = { type: "error", code: "not_logged_in", message: "Invalid API key", retryable: true };
  bia.send({ type: "result", id: q.id, ok: true, data: { runId: "run-00000001", final } });
  expect(await run).toEqual({ runId: "run-00000001", final });
  await waitFor(() => refused.length === 1);
  expect(refused).toEqual([ACCOUNT]);
  // Without an account nothing is lent.
  const plain = handleRequest(t.ctx, turn(), scope().scope);
  const q2 = await requestOn(bia, 2);
  bia.send({
    type: "result",
    id: q2.id,
    ok: true,
    data: { runId: "run-00000001", final: { type: "done", text: "ok" } },
  });
  await plain;
  expect(lends).toHaveLength(1);
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

test("the agents' browsers' traffic: each worker's count summed until taken, between sessions too; nonsense dropped", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const runs = [handleRequest(t.ctx, exec(ANA), scope().scope), handleRequest(t.ctx, exec(BIA), scope().scope)];
  await waitFor(() => t.workers.length === 2);
  const ana = t.last(ANA.id);
  const bia = t.last(BIA.id);
  // Before its session's hello: its Chrome may have run meanwhile.
  ana.send({ type: "browser.traffic", up: 100, down: 2000 });
  ana.hello();
  bia.hello();
  bia.send({ type: "browser.traffic", up: 5, down: 70 });
  for (const bad of [
    { up: 1e12 + 1, down: 1 },
    { up: 1, down: -1 },
    { up: 1.5, down: 1 },
    { up: "100", down: 1 },
    { up: 1 },
  ]) {
    ana.send({ type: "browser.traffic", ...bad });
  }
  // Frames are read in order: once this one counts, the ones before it were seen.
  ana.send({ type: "browser.traffic", up: 1e12, down: 0 });
  const total = { up: 0, down: 0 };
  await waitFor(() => {
    const got = t.sup.takeTraffic();
    total.up += got.up;
    total.down += got.down;
    return total.up >= 1e12;
  });
  expect(total).toEqual({ up: 1e12 + 105, down: 2070 });
  expect(t.sup.takeTraffic()).toEqual({ up: 0, down: 0 });
  // Nothing of it goes to the server: root says it on its own pong.
  expect(t.up.filter((f) => f.type === "browser.traffic")).toEqual([]);
  for (const w of [ana, bia]) {
    const req = await requestOn(w);
    w.send({ type: "result", id: req.id, ok: true, data: execDone });
  }
  await Promise.all(runs);
});

test("scope.enter: root moves only its agent's own process, into the agent's slice for its kind, and answers once it is there", async () => {
  const proc = tempDir("proc-");
  dirs.push(proc);
  /** A process as /proc shows it: its uids (real, effective, saved, filesystem) and its cgroup. */
  const pidAt = (pid: number, uids: number[], cgroup: string) => {
    mkdirSync(path.join(proc, String(pid)), { recursive: true });
    writeFileSync(
      path.join(proc, String(pid), "status"),
      `Name:\tchrome\nUid:\t${uids.join("\t")}\nGid:\t1\t1\t1\t1\n`,
    );
    writeFileSync(path.join(proc, String(pid), "cgroup"), `0::${cgroup}\n`);
  };
  const asked: string[][] = [];
  let systemd: "moves" | "refuses" | "never" = "moves";
  let clock = Date.UTC(2026, 9, 27, 12);
  const t = setup({
    proc,
    now: () => clock,
    busctl: async (args) => {
      asked.push(args);
      if (systemd === "refuses") return { code: 1, output: "Unit agentes-browser-21000-4242.scope already exists." };
      const [pid, slice, unit] = [args[13], args[16], args[7]];
      if (systemd === "moves") {
        setTimeout(
          () =>
            writeFileSync(
              path.join(proc, String(pid), "cgroup"),
              `0::/agents.slice/agents-21000.slice/${slice}/${unit}\n`,
            ),
          60,
        );
      }
      return { code: 0, output: 'o "/org/freedesktop/systemd1/job/1234"' };
    },
  });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const answer = async (frame: Record<string, unknown>) => {
    const before = ana.of("scope.entered").length;
    ana.send({ type: "scope.enter", ...frame });
    await waitFor(() => ana.of("scope.entered").length > before, 4000);
    return ana.of("scope.entered").at(-1);
  };

  pidAt(4242, [21000, 21000, 21000, 21000], "/agents.slice/agents-21000.slice/run-r1.scope");
  expect(await answer({ enterId: "e1", pid: 4242, kind: "browser" })).toEqual({ type: "scope.entered", enterId: "e1" });
  expect(asked).toEqual([
    [
      "call",
      "--timeout=5",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "StartTransientUnit",
      "ssa(sv)a(sa(sv))",
      "agentes-browser-21000-4242.scope",
      "fail",
      "3",
      "PIDs",
      "au",
      "1",
      "4242",
      "Slice",
      "s",
      "agents-21000-browser.slice",
      "CollectMode",
      "s",
      "inactive-or-failed",
      "0",
    ],
  ]);
  expect(readFileSync(path.join(proc, "4242", "cgroup"), "utf8")).toBe(
    "0::/agents.slice/agents-21000.slice/agents-21000-browser.slice/agentes-browser-21000-4242.scope\n",
  );

  // Never another agent's process, one outside the agent's slice, one that only seems the agent's, or a made-up kind.
  pidAt(4243, [21001, 21001, 21001, 21001], "/agents.slice/agents-21001.slice/run-r2.scope");
  pidAt(4244, [21000, 21000, 21000, 21000], "/agents.slice/agents-21001.slice/run-r3.scope");
  pidAt(4245, [21000, 0, 21000, 21000], "/agents.slice/agents-21000.slice/run-r4.scope");
  pidAt(4246, [21000, 21000, 21000, 21000], "/system.slice/agentes-runner.service");
  for (const [frame, error] of [
    [{ pid: 4243, kind: "cli" }, "That isn't this agent's process"],
    [{ pid: 4245, kind: "cli" }, "That isn't this agent's process"],
    [{ pid: 4244, kind: "cli" }, "That process isn't in this agent's slice"],
    [{ pid: 4246, kind: "cli" }, "That process isn't in this agent's slice"],
    [{ pid: 4999, kind: "cli" }, "That isn't this agent's process"],
    [{ pid: 4242, kind: "desktop" }, "The kind is browser or cli"],
    [{ pid: "4242", kind: "cli" }, "That isn't a process id"],
    [{ pid: 1, kind: "cli" }, "That isn't a process id"],
  ] as const) {
    expect(await answer({ enterId: "e2", ...frame })).toEqual({ type: "scope.entered", enterId: "e2", error });
  }
  expect(asked).toHaveLength(1);

  // systemd refusing, or a move that never shows: said so, and the process starts where it is.
  pidAt(4250, [21000, 21000, 21000, 21000], "/agents.slice/agents-21000.slice/run-r5.scope");
  systemd = "refuses";
  expect(await answer({ enterId: "e3", pid: 4250, kind: "cli" })).toEqual({
    type: "scope.entered",
    enterId: "e3",
    error: "systemd didn't move it",
  });
  expect(t.logs.some((l) => l.includes("couldn't move a process into agents-21000-cli.slice"))).toBe(true);
  systemd = "never";
  expect(await answer({ enterId: "e4", pid: 4250, kind: "cli" })).toEqual({
    type: "scope.entered",
    enterId: "e4",
    error: "It didn't show in its slice in time",
  });

  // 30 a minute: the 31st waits for the next minute. These already show in their slice.
  const used = 8; // every ask above that named a process of a kind counted, refused or not
  for (let i = used; i < 30; i++) {
    pidAt(5000 + i, [21000, 21000, 21000, 21000], "/agents.slice/agents-21000.slice/agents-21000-cli.slice/x.scope");
    expect(await answer({ enterId: `r${i}`, pid: 5000 + i, kind: "cli" })).toEqual({
      type: "scope.entered",
      enterId: `r${i}`,
    });
  }
  expect(await answer({ enterId: "over", pid: 5000 + used, kind: "cli" })).toEqual({
    type: "scope.entered",
    enterId: "over",
    error: "Too many processes moved this minute",
  });
  clock += 61_000;
  expect(await answer({ enterId: "again", pid: 5000 + used, kind: "cli" })).toEqual({
    type: "scope.entered",
    enterId: "again",
  });

  const req = await requestOn(ana);
  ana.send({ type: "result", id: req.id, ok: true, data: execDone });
  await run;
});

test("root counts the live view of its agents' browsers it relays: frames up, people's input down", async () => {
  const relayed = new RelayCount();
  const t = setup({ relayed });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const frame = {
    type: "browser.frame",
    agentId: ANA.id,
    seq: 1,
    data: "A".repeat(4000),
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  };
  ana.send(frame);
  // Another agent's frame never goes up, so it isn't counted either.
  ana.send({ ...frame, agentId: BIA.id });
  await waitFor(() => t.up.some((f) => f.type === "browser.frame"));
  expect(relayed.browserView.up).toBe(Buffer.byteLength(JSON.stringify(frame)));
  const input = handleRequest(
    t.ctx,
    { op: "browser.input", agent: ANA, events: [{ type: "text", text: "olá" }] } as unknown as MachineRequest,
    scope().scope,
  );
  const sent = await requestOn(ana, 2);
  expect(relayed.browserView.down).toBe(Buffer.byteLength(`${JSON.stringify(sent)}\n`));
  expect([relayed.desktop, relayed.terminal]).toEqual([
    { up: 0, down: 0 },
    { up: 0, down: 0 },
  ]);
  ana.send({ type: "result", id: sent.id, ok: true, data: { ok: true } });
  const req = await requestOn(ana, 1);
  ana.send({ type: "result", id: req.id, ok: true, data: execDone });
  await Promise.all([run, input]);
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

test("a worker gets its agent's desktop from root only while it serves a request the server sent that uses it", async () => {
  const asked: [AgentScope, string][] = [];
  const desktop: WorkerDesktop = {
    display: 21,
    width: 1280,
    height: 800,
    startedAt: new Date(1000).toISOString(),
    started: true,
    xauthority: "/home/ag-a1b2c3d4/.agentes/desktop/Xauthority",
    home: "/home/ag-a1b2c3d4",
  };
  const t = setup({
    desktop: async (agent, use) => {
      asked.push([agent, use]);
      return desktop;
    },
  });
  t.sup.boot();
  t.sup.attach();
  const answers = (w: FakeWorker) => w.of("desktop.ensured");
  const refused = (ensureId: string, message = "No desktop use request of this agent is running") => ({
    type: "desktop.ensured",
    ensureId,
    error: { code: "not_allowed", message },
  });

  // During another request, the agent's own code (as the worker's user) asking gets nothing.
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  ana.send({ type: "desktop.ensure", ensureId: "1", use: "desktop" });
  ana.send({ type: "desktop.ensure", ensureId: "1b", use: "browser" });
  await waitFor(() => answers(ana).length === 2);
  expect(answers(ana)[1]).toEqual(refused("1b", BROWSER_REFUSED));
  expect(answers(ana)[0]).toEqual(refused("1"));
  ana.send({ type: "result", id: q.id, ok: true, data: execDone });
  await run;

  // Desktop use is the worker's: the request goes to it, and while it runs root starts the desktop for it.
  const look = handleRequest(t.ctx, { op: "desktop.look", agent: ANA }, scope().scope);
  const q2 = await requestOn(ana, 2);
  expect(q2).toEqual({ op: "desktop.look", agent: ANA, type: "request", id: q2.id });
  ana.send({ type: "desktop.ensure", ensureId: "2", use: "desktop" });
  await waitFor(() => answers(ana).length === 3);
  expect(answers(ana)[2]).toEqual({ type: "desktop.ensured", ensureId: "2", desktop });
  expect(asked).toEqual([[ANA, "desktop"]]);

  // Another agent's worker asking meanwhile gets nothing: the request isn't its own.
  const read = handleRequest(t.ctx, { op: "read", path: "a.md", maxBytes: 10, agent: BIA }, scope().scope);
  await waitFor(() => t.workers.length === 2);
  const bia = t.last(BIA.id);
  bia.hello();
  const q3 = await requestOn(bia);
  bia.send({ type: "desktop.ensure", ensureId: "1", use: "desktop" });
  await waitFor(() => answers(bia).length === 1);
  expect(answers(bia)[0]).toEqual(refused("1"));
  expect(asked).toHaveLength(1);
  bia.send({ type: "result", id: q3.id, ok: false, error: { code: "not_found", message: "No such file" } });
  await errorCode(() => read);

  const reply = {
    snapshot: "",
    refs: {},
    address: "desktop://thunar/main",
    title: "",
    screen: { width: 1280, height: 800 },
  };
  ana.send({ type: "result", id: q2.id, ok: true, data: reply });
  expect(await look).toEqual(reply);

  // Its Chrome on its desktop: only during a browser command the server put there, and only for that.
  const plain = handleRequest(t.ctx, browserOpen(ANA, false), scope().scope);
  const q5 = await requestOn(ana, 3);
  ana.send({ type: "desktop.ensure", ensureId: "3", use: "browser" });
  await waitFor(() => answers(ana).length === 4);
  expect(answers(ana)[3]).toEqual(refused("3", BROWSER_REFUSED));
  ana.send({ type: "result", id: q5.id, ok: true, data: { success: true, data: null } });
  await plain;
  const there = handleRequest(t.ctx, browserOpen(ANA, true), scope().scope);
  const q6 = await requestOn(ana, 4);
  ana.send({ type: "desktop.ensure", ensureId: "4", use: "desktop" });
  ana.send({ type: "desktop.ensure", ensureId: "5", use: "browser" });
  await waitFor(() => answers(ana).length === 6);
  expect(answers(ana)[4]).toEqual(refused("4"));
  expect(answers(ana)[5]).toEqual({ type: "desktop.ensured", ensureId: "5", desktop });
  expect(asked).toEqual([
    [ANA, "desktop"],
    [ANA, "browser"],
  ]);
  ana.send({ type: "result", id: q6.id, ok: true, data: { success: true, data: null } });
  await there;
  // Root says why it couldn't, in the machine protocol's words.
  const t2 = setup({
    desktop: async () => {
      throw new RunnerError("desktop_unavailable", "Install the agents' desktops");
    },
  });
  t2.sup.boot();
  t2.sup.attach();
  const look2 = handleRequest(t2.ctx, { op: "desktop.look", agent: ANA }, scope().scope);
  await waitFor(() => t2.workers.length === 1);
  const ana2 = t2.last(ANA.id);
  ana2.hello();
  const q4 = await requestOn(ana2);
  ana2.send({ type: "desktop.ensure", ensureId: "9", use: "desktop" });
  await waitFor(() => answers(ana2).length === 1);
  expect(answers(ana2)[0]).toEqual({
    type: "desktop.ensured",
    ensureId: "9",
    error: { code: "desktop_unavailable", message: "Install the agents' desktops" },
  });
  ana2.send({ type: "result", id: q4.id, ok: false, error: { code: "desktop_unavailable", message: "no" } });
  expect(await errorCode(() => look2)).toBe("desktop_unavailable");
});

test("a worker's word that its Chrome is in use on the desktop holds a while; it learns who watches that desktop", async () => {
  const clock = { now: 1_000_000 };
  const viewers: Record<string, number> = {};
  const t = setup({ now: () => clock.now, desktopViewers: (agentId) => viewers[agentId] ?? 0 });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  // Before its hello nothing it says counts.
  ana.send({ type: "browser.desktop" });
  ana.hello();
  await requestOn(ana);
  expect(t.sup.onDesktopInUse(ANA.id)).toBe(false);
  ana.send({ type: "browser.desktop" });
  await waitFor(() => t.sup.onDesktopInUse(ANA.id));
  expect(t.sup.onDesktopInUse(BIA.id)).toBe(false);
  clock.now += BROWSER_LEASE_MS - 1;
  expect(t.sup.onDesktopInUse(ANA.id)).toBe(true);
  clock.now += 1;
  expect(t.sup.onDesktopInUse(ANA.id)).toBe(false);

  // Someone opens its desktop: only its own worker hears of it.
  viewers[ANA.id] = 2;
  viewers[BIA.id] = 1;
  t.sup.stateChanged();
  await waitFor(() => ana.of("worker.state").length === 2);
  expect(ana.of("worker.state")[1]).toEqual({ type: "worker.state", ...STATE, desktopViewers: 2 });
  viewers[ANA.id] = 0;
  t.sup.stateChanged();
  await waitFor(() => ana.of("worker.state").length === 3);
  expect(ana.of("worker.state")[2]).toEqual({ type: "worker.state", ...STATE });

  // A worker that stops takes its word with it.
  ana.send({ type: "browser.desktop" });
  await waitFor(() => t.sup.onDesktopInUse(ANA.id));
  ana.crash();
  expect(await errorCode(() => run)).toBe("internal");
  expect(t.sup.onDesktopInUse(ANA.id)).toBe(false);
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
  "a real worker drives its agent's desktop through its helper, as its own user, with the desktop root started",
  async () => {
    const dir = tempDir("worker-desktop-");
    dirs.push(dir);
    const agentHome = path.join(dir, "agent");
    const ownHome = path.join(dir, "worker");
    mkdirSync(agentHome, { recursive: true });
    const logFile = path.join(dir, "helper.log");
    const stateFile = path.join(dir, "state.json");
    const snapshot = JSON.parse(
      readFileSync(path.join(import.meta.dir, "fixtures", "desktop", "menu.json"), "utf8"),
    ) as unknown;
    writeFileSync(stateFile, JSON.stringify({ snapshot }));
    const uid = process.getuid?.() ?? 1000;
    const asked: AgentScope[] = [];
    const xauthority = path.join(dir, "Xauthority");
    const t = setup({
      start: (user) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const done = runWorker({
          agentId: user.id,
          home: ownHome,
          dir: agentHome,
          input: stdin,
          output: stdout,
          log: () => {},
          self: { command: [process.execPath, "/nonexistent/agentes-runner.mjs"], compiled: false },
          desktop: {
            system: { platform: "linux", uid, which: (c) => `/usr/bin/${c}` },
            command: [process.execPath, path.join(import.meta.dir, "fake-desktop-helper.mjs"), logFile, stateFile],
          },
        });
        workerRuns.push(done);
        return { stdin, stdout, exited: done, kill: () => stdin.end() };
      },
      desktop: async (agent) => {
        asked.push(agent);
        return {
          display: 21,
          width: 1280,
          height: 800,
          startedAt: new Date(1000).toISOString(),
          started: asked.length === 1,
          xauthority,
          home: agentHome,
        };
      },
    });
    const on = { ...STATE, access: { ...STATE.access, tools: { ...STATE.access.tools, desktop: true } } };
    t.setState(on);
    t.sup.boot();
    t.sup.attach();
    const look = (await handleRequest(t.ctx, { op: "desktop.look", agent: ANA }, scope().scope)) as {
      snapshot: string;
      address: string;
    };
    expect(look.address).toBe("desktop://thunar/main");
    expect(look.snapshot).toContain('- menu "Applications"');
    expect(asked).toEqual([ANA]);
    const started = (
      JSON.parse(readFileSync(logFile, "utf8").split("\n")[0] as string) as {
        start: { env: Record<string, string>; cwd: string };
      }
    ).start;
    expect([started.env.DISPLAY, started.env.XAUTHORITY, started.env.HOME]).toEqual([":21", xauthority, agentHome]);
    expect(realpathSync(started.cwd)).toBe(realpathSync(agentHome));

    // The desktop switch off: the worker refuses before asking root for anything.
    t.setState(STATE);
    t.sup.stateChanged();
    expect(await errorCode(() => handleRequest(t.ctx, { op: "desktop.look", agent: ANA }, scope().scope))).toBe(
      "not_allowed",
    );
    expect(asked).toHaveLength(1);
  },
);

test.if(posix)(
  "a real worker runs its agent's Chrome headed on the desktop root started for it, and root keeps that desktop",
  async () => {
    const dir = tempDir("worker-browser-");
    dirs.push(dir);
    const agentHome = path.join(dir, "agent");
    mkdirSync(agentHome, { recursive: true });
    process.env.FAKE_AB_LOG = path.join(dir, "ab.log");
    process.env.FAKE_AB_STATE = path.join(dir, "ab-state.json");
    const chromes: { args: string[]; env?: Record<string, string>; killed: boolean }[] = [];
    const asked: [string, string][] = [];
    let viewers = 0;
    let refusal: string | null = null;
    const xauthority = path.join(dir, "Xauthority");
    const clock = { now: 1_000_000 };
    const t = setup({
      start: (user) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const done = runWorker({
          agentId: user.id,
          home: path.join(dir, "worker"),
          dir: agentHome,
          input: stdin,
          output: stdout,
          log: () => {},
          self: { command: [process.execPath, "/nonexistent/agentes-runner.mjs"], compiled: false },
          browser: {
            command: [process.execPath, path.join(import.meta.dir, "fake-agent-browser.mjs")],
            chrome: () => "/fake/browsers/chrome-155.0.8059.84/chrome-linux64/chrome",
            isOurChrome: async () => false,
            async startChrome(_exe, args, _profile, env) {
              const c = { args, env, killed: false };
              chromes.push(c);
              let quit = () => {};
              const exited = new Promise<void>((resolve) => {
                quit = resolve;
              });
              const kill = () => {
                c.killed = true;
                quit();
              };
              return { pid: 50_000 + chromes.length, port: 9400 + chromes.length, exited, kill };
            },
            // Its debugging endpoint lists the page of its window: a click on Browser waits for that.
            fetch: (async () =>
              new Response(
                JSON.stringify([{ id: "P1", type: "page", url: "about:blank" }]),
              )) as unknown as typeof fetch,
            windowDrawMs: 0,
          },
        });
        workerRuns.push(done);
        return { stdin, stdout, exited: done, kill: () => stdin.end() };
      },
      desktop: async (agent, use) => {
        asked.push([agent.id, use]);
        if (refusal) throw new RunnerError("not_allowed", refusal);
        const startedAt = new Date(1000).toISOString();
        return { display: 21, width: 1280, height: 900, startedAt, started: true, xauthority, home: agentHome };
      },
      desktopViewers: () => viewers,
      now: () => clock.now,
    });
    t.setState({ ...STATE, access: { ...STATE.access, tools: { ...STATE.access.tools, desktop: true } } });
    t.sup.boot();
    t.sup.attach();
    const act = (command: string, desktop: boolean) =>
      handleRequest(t.ctx, browserOpen(ANA, desktop, command, ["@e1"]), scope().scope);
    const headed = (c?: { args: string[] }) => !!c && !c.args.includes("--headless=new");

    // Where the server didn't put it on the desktop: headless, and root is never asked.
    expect(await handleRequest(t.ctx, browserOpen(ANA, false), scope().scope)).toMatchObject({ success: true });
    expect(asked).toEqual([]);
    expect(headed(chromes[0])).toBe(false);
    // The next command the server puts there moves it: as this worker's user, on root's display, same page.
    expect(await act("click", true)).toMatchObject({ success: true });
    expect(asked).toEqual([[ANA.id, "browser"]]);
    expect(chromes).toHaveLength(2);
    expect(chromes[0]?.killed).toBe(true);
    expect(headed(chromes[1])).toBe(true);
    expect(chromes[1]?.args).toContain("--start-maximized");
    expect(chromes[1]?.args.at(-1)).toBe("https://shop.example/cart");
    expect(chromes[1]?.env).toMatchObject({ DISPLAY: ":21", XAUTHORITY: xauthority });
    // In use there: root doesn't stop that desktop as idle.
    await waitFor(() => t.sup.onDesktopInUse(ANA.id));

    // Someone on that desktop: the worker hears it before its next request, and never moves Chrome off under them.
    viewers = 1;
    t.sup.stateChanged();
    expect(await act("click", false)).toMatchObject({ success: true });
    expect(chromes).toHaveLength(2);
    viewers = 0;
    t.sup.stateChanged();
    expect(await act("click", false)).toMatchObject({ success: true });
    expect(chromes).toHaveLength(3);
    expect(headed(chromes[2])).toBe(false);
    // Off the desktop, the worker stops saying so and root's word runs out.
    clock.now += BROWSER_LEASE_MS;
    expect(t.sup.onDesktopInUse(ANA.id)).toBe(false);

    // Root refuses (a switch off there): the browser goes on headless, and isn't moved at every command.
    refusal = "The browser on the agent's desktop needs this computer's desktop and browser switches on";
    expect(await act("click", true)).toMatchObject({ success: true });
    expect(await act("click", true)).toMatchObject({ success: true });
    expect(asked).toHaveLength(2);
    expect(chromes).toHaveLength(3);

    // Browser clicked on that desktop: the worker asks root for it at once, and its Chrome moves there.
    refusal = null;
    await t.sup.showBrowser(ANA, () => {});
    expect(asked).toEqual([
      [ANA.id, "browser"],
      [ANA.id, "browser"],
      [ANA.id, "browser"],
    ]);
    expect(chromes).toHaveLength(4);
    expect(headed(chromes[3])).toBe(true);
    expect(chromes[3]?.env).toMatchObject({ DISPLAY: ":21", XAUTHORITY: xauthority });
    expect(chromes[3]?.args).toContain("--class=agentes-browser");
    // Root can't lend it the desktop: the click says so, in root's words, and the agent's Chrome stays as it was.
    await act("click", false);
    expect(chromes).toHaveLength(5);
    refusal = "The browser on the agent's desktop needs this computer's desktop and browser switches on";
    const failed = await t.sup
      .showBrowser(ANA, () => {})
      .then(
        () => null,
        (err: unknown) => err as RunnerError,
      );
    expect([failed?.code, failed?.message]).toEqual(["not_allowed", refusal]);
    expect(chromes).toHaveLength(5);
    expect(chromes[4]?.killed).toBe(false);
  },
);

test("Browser clicked on an agent's desktop: its worker, started for it, answers; root lends it the desktop meanwhile", async () => {
  const asked: [AgentScope, string][] = [];
  const desktop: WorkerDesktop = {
    display: 21,
    width: 1280,
    height: 900,
    startedAt: new Date(1000).toISOString(),
    started: false,
    xauthority: "/home/ag-a1b2c3d4/.agentes/desktop/Xauthority",
    home: "/home/ag-a1b2c3d4",
  };
  const t = setup({
    desktop: async (agent, use) => {
      asked.push([agent, use]);
      return desktop;
    },
  });
  t.sup.boot();
  let installing = 0;
  const shown = t.sup.showBrowser(ANA, () => void installing++);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  await waitFor(() => ana.of("browser.show").length === 1);
  expect(ana.of("browser.show")[0]).toEqual({ type: "browser.show", showId: expect.any(String), agent: ANA });
  const show = ana.of("browser.show")[0] as { showId: string };
  // While it answers, root lends it the agent's desktop, for its Chrome only.
  ana.send({ type: "desktop.ensure", ensureId: "1", use: "desktop" });
  ana.send({ type: "desktop.ensure", ensureId: "2", use: "browser" });
  await waitFor(() => ana.of("desktop.ensured").length === 2);
  expect(ana.of("desktop.ensured")[0]).toMatchObject({ error: { code: "not_allowed" } });
  expect(ana.of("desktop.ensured")[1]).toEqual({ type: "desktop.ensured", ensureId: "2", desktop });
  expect(asked).toEqual([[ANA, "browser"]]);
  ana.send({ type: "browser.showing", showId: show.showId });
  await waitFor(() => installing === 1);
  // Another click's id settles nothing.
  ana.send({ type: "browser.shown", showId: "nope" });
  ana.send({ type: "browser.shown", showId: show.showId });
  await shown;
  // Done: the agent's own code asking afterwards gets nothing.
  ana.send({ type: "desktop.ensure", ensureId: "3", use: "browser" });
  await waitFor(() => ana.of("desktop.ensured").length === 3);
  expect(ana.of("desktop.ensured")[2]).toMatchObject({ error: { code: "not_allowed", message: BROWSER_REFUSED } });

  // The server's connection drops meanwhile: the worker's session ends with it, the click it answers goes on, and
  // root lends it the desktop before its next session too (desktop use, the last session's, it doesn't).
  t.sup.attach();
  const across = t.sup.showBrowser(ANA, () => {});
  await waitFor(() => ana.of("browser.show").length === 2);
  t.sup.detach();
  ana.send({ type: "desktop.ensure", ensureId: "4", use: "browser" });
  ana.send({ type: "desktop.ensure", ensureId: "5", use: "desktop" });
  await waitFor(() => ana.of("desktop.ensured").length === 5);
  const ensured = (ensureId: string) => ana.of("desktop.ensured").find((f) => f.ensureId === ensureId);
  expect(ensured("4")).toEqual({ type: "desktop.ensured", ensureId: "4", desktop });
  expect(ensured("5")).toMatchObject({ error: { code: "not_allowed" } });
  ana.send({ type: "browser.shown", showId: (ana.of("browser.show")[1] as { showId: string }).showId });
  await across;
  ana.hello();

  // Why not, in the worker's words.
  const failed = t.sup.showBrowser(ANA, () => {});
  await waitFor(() => ana.of("browser.show").length === 3);
  const third = ana.of("browser.show")[2] as { showId: string };
  ana.send({
    type: "browser.shown",
    showId: third.showId,
    error: { code: "browser_unavailable", message: "Couldn't install a browser for the agent" },
  });
  const why = await failed.then(
    () => null,
    (err: unknown) => err as RunnerError,
  );
  expect([why?.code, why?.message]).toEqual(["browser_unavailable", "Couldn't install a browser for the agent"]);
  // A worker that stops fails the click it was answering.
  const lost = t.sup.showBrowser(ANA, () => {});
  await waitFor(() => ana.of("browser.show").length === 4);
  ana.crash();
  expect(await errorCode(() => lost)).toBe("internal");
});

test("a click its worker never answers (the agent's own code stopped it) fails in time, and root lends nothing more", async () => {
  const desktop: WorkerDesktop = {
    display: 21,
    width: 1280,
    height: 900,
    startedAt: new Date(1000).toISOString(),
    started: false,
    xauthority: "/home/ag-a1b2c3d4/.agentes/desktop/Xauthority",
    home: "/home/ag-a1b2c3d4",
  };
  const t = setup({ desktop: async () => desktop, showMs: 50 });
  t.sup.boot();
  const shown = t.sup.showBrowser(ANA, () => {});
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const failed = await shown.then(
    () => null,
    (err: unknown) => err as RunnerError,
  );
  expect([failed?.code, failed?.message]).toEqual(["internal", "The agent's worker didn't answer in time"]);
  ana.send({ type: "desktop.ensure", ensureId: "1", use: "browser" });
  await waitFor(() => ana.of("desktop.ensured").length === 1);
  expect(ana.of("desktop.ensured")[0]).toMatchObject({ error: { code: "not_allowed", message: BROWSER_REFUSED } });
  // Its answer, late, settles nothing.
  ana.send({ type: "browser.shown", showId: (ana.of("browser.show")[0] as { showId: string }).showId });
});

test("a worker's ask for its desktop that root never answers gives up, and frees what waits behind it", async () => {
  const toRoot = new PassThrough();
  const link = new WorkerLink(new PassThrough(), toRoot, 50);
  const asked: string[] = [];
  readLines(
    toRoot,
    1 << 20,
    (line) => asked.push(line),
    () => {},
  );
  const failed = await link.desktop("browser").then(
    () => null,
    (err: unknown) => err as RunnerError,
  );
  expect([failed?.code, failed?.message]).toEqual(["internal", "The agent's desktop didn't start in time"]);
  expect(asked.map((l) => JSON.parse(l))).toEqual([{ type: "desktop.ensure", ensureId: "1", use: "browser" }]);
});

test("a worker's ask to move a process settles on root's answer, whatever it says, and its own traffic goes to root", async () => {
  const fromRoot = new PassThrough();
  const toRoot = new PassThrough();
  const link = new WorkerLink(fromRoot, toRoot);
  const asked: Record<string, unknown>[] = [];
  readLines(
    toRoot,
    1 << 20,
    (line) => asked.push(JSON.parse(line)),
    () => {},
  );
  let settled = false;
  const moved = link.enterScope(4242, "browser").then(() => {
    settled = true;
  });
  await waitFor(() => asked.length === 1);
  expect(asked[0]).toEqual({ type: "scope.enter", enterId: "1", pid: 4242, kind: "browser" });
  // Another ask's answer settles nothing here.
  fromRoot.write(`${JSON.stringify({ type: "scope.entered", enterId: "9" })}\n`);
  await Bun.sleep(20);
  expect(settled).toBe(false);
  fromRoot.write(`${JSON.stringify({ type: "scope.entered", enterId: "1", error: "systemd didn't move it" })}\n`);
  await moved;
  // Nothing to say when nothing moved.
  link.traffic({ up: 0, down: 0 });
  link.traffic({ up: 120, down: 34_000 });
  await waitFor(() => asked.length === 2);
  expect(asked[1]).toEqual({ type: "browser.traffic", up: 120, down: 34_000 });
});

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
        access: { folders: [], tools: { claude: false, codex: false, commands: true, desktop: true } },
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
      // Root starts the agent's desktop for its worker behind the switches each use needs: its Chrome there the
      // browser's (off here), desktop use the commands' (on: past it, this test computer runs no desktops).
      s.frame({ type: "request", id: "b1", ...browserOpen(ANA, true) });
      const b1 = await requestOn(ana, 2);
      ana.send({ type: "desktop.ensure", ensureId: "1", use: "browser" });
      await waitFor(() => ana.of("desktop.ensured").length === 1);
      expect(ana.of("desktop.ensured")[0]).toMatchObject({
        error: { code: "not_allowed", message: expect.stringContaining("desktop and browser switches") },
      });
      ana.send({ type: "result", id: b1.id, ok: true, data: { success: true, data: null } });
      s.frame({ type: "request", id: "l1", op: "desktop.look", agent: ANA });
      const l1 = await requestOn(ana, 3);
      ana.send({ type: "desktop.ensure", ensureId: "2", use: "desktop" });
      await waitFor(() => ana.of("desktop.ensured").length === 2);
      expect(ana.of("desktop.ensured")[1]?.error).not.toMatchObject({ code: "not_allowed" });
      ana.send({ type: "result", id: l1.id, ok: false, error: { code: "desktop_unavailable", message: "no" } });
      await waitFor(() => s.sent.some((f) => f.id === "l1"));
      // Its task's end goes up; the server's ack comes back down to it.
      ana.send({ type: "task.done", taskId: "task-ana-0001", exitCode: 0, seconds: 3 });
      await waitFor(() => s.of("task.done").length === 1);
      s.frame({ type: "task.ack", taskId: "task-ana-0001" });
      await waitFor(() => ana.of("task.ack").length === 1);

      // The agents on this computer, from the server: the desktops of any other agent stop (they stay on otherwise).
      const kept: string[][] = [];
      daemon.desktops.stopAll = async (keep = new Set()) => void kept.push([...keep]);
      s.frame({ type: "agents", agents: [ANA] });
      await waitFor(() => kept.length === 1);
      expect(kept).toEqual([[ANA.id]]);

      // Browser clicked on the agent's desktop needs the browser switch, off here: no worker hears of it.
      expect(await errorCode(() => daemon.openBrowser(ANA, () => {}))).toBe("not_allowed");
      expect(ana.of("browser.show")).toHaveLength(0);

      // Paused: new work is refused here, before any worker hears of it; the workers learn the pause too.
      daemon.pause(null);
      await waitFor(() => ana.of("worker.state").length === 2);
      s.frame({ type: "request", id: "r2", ...exec(ANA, "id -un") });
      await waitFor(() => s.sent.some((f) => f.id === "r2"));
      expect(s.sent.find((f) => f.id === "r2")).toMatchObject({ ok: false, error: { code: "paused" } });
      expect(ana.of("request")).toHaveLength(3);
    } finally {
      await daemon.stop();
    }
  },
);

test.if(posix)(
  "a system-mode runner: Browser clicked on an agent's desktop goes to that agent's worker, unless the computer is paused",
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
        access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: true, desktop: true } },
      },
      home,
    );
    const workers: FakeWorker[] = [];
    const sockets: FakeSocket[] = [];
    const daemon = new RunnerDaemon({
      home,
      mode: "start",
      log: () => {},
      watch: false,
      executors: () => ({}),
      self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
      caffeinate: false,
      dial: (_url, handlers) => {
        const s = new FakeSocket(handlers);
        sockets.push(s);
        return s;
      },
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
      await waitFor(() => sockets.length === 1);
      let installing = 0;
      const shown = daemon.openBrowser(ANA, () => void installing++);
      await waitFor(() => workers.length === 1);
      const ana = workers[0] as FakeWorker;
      ana.hello();
      await waitFor(() => ana.of("browser.show").length === 1);
      const show = ana.of("browser.show")[0] as { showId: string };
      ana.send({ type: "browser.showing", showId: show.showId });
      ana.send({ type: "browser.shown", showId: show.showId });
      await shown;
      expect(installing).toBe(1);
      daemon.pause(null);
      expect(await errorCode(() => daemon.openBrowser(ANA, () => {}))).toBe("paused");
      expect(ana.of("browser.show")).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  },
);

test.if(posix)(
  "a single-user runner: Browser clicked on an agent's desktop opens that agent's own browser here, unless paused",
  async () => {
    const home = newHome();
    const ws = tempDir("single-ws-");
    dirs.push(ws);
    writeConfig(
      {
        server: "https://agentes.test",
        machineId: "m1",
        name: "box",
        token: "agm_machine_token_never_shown_123456",
        workspace: ws,
        exec: true,
        access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: true, desktop: true } },
      },
      home,
    );
    const shown: [AgentScope, string][] = [];
    const show = spyOn(BrowserManager.prototype, "show").mockImplementation(async (agent, folder, installing) => {
      shown.push([agent, folder]);
      installing();
    });
    const sockets: FakeSocket[] = [];
    const daemon = new RunnerDaemon({
      home,
      mode: "start",
      log: () => {},
      watch: false,
      executors: () => ({}),
      self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
      caffeinate: false,
      dial: (_url, handlers) => {
        const s = new FakeSocket(handlers);
        sockets.push(s);
        return s;
      },
    });
    daemon.start();
    try {
      await waitFor(() => sockets.length === 1);
      let installing = 0;
      await daemon.openBrowser(ANA, () => void installing++);
      // This runner's own BrowserManager, on the agent's folder in the workspace: no worker in between.
      expect(shown).toEqual([[ANA, path.join(realpathSync(ws), "ana-a1b2c3d4")]]);
      expect(installing).toBe(1);
      daemon.pause(null);
      expect(await errorCode(() => daemon.openBrowser(ANA, () => {}))).toBe("paused");
      expect(shown).toHaveLength(1);
    } finally {
      show.mockRestore();
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

test.if(posix)(
  "system broker keeps pending material out of the worker and installs only after activation",
  async () => {
    const t = realWorkers();
    t.sup.boot();
    t.sup.attach();
    const requestId = "broker-0001-aaaa";
    const name = "BROKER_TEST_KEY";
    const target = { kind: "env" as const };
    const value = "broker-secret-value";
    const key = await t.sup.secret({ op: "secret", agent: ANA, action: "keypair", requestId }, scope().scope);
    const aad = secretAad({ requestId, orgId: "org-1", name, target });
    const box = await sealSecret(key.publicKey as string, value, aad);
    expect(
      await t.sup.secret(
        { op: "secret", agent: ANA, action: "deliver", requestId, name, target, aad, box },
        scope().scope,
      ),
    ).toEqual({ size: value.length });
    expect(existsSync(path.join(t.home, "secret-broker", "a1b2c3d4", "keys", requestId))).toBe(true);
    expect(existsSync(path.join(t.ownHome, "secrets", "a1b2c3d4", "keys", requestId))).toBe(false);
    expect(await agentSecrets(path.join(t.ownHome, "secrets"), ANA)).toBeNull();
    const order = `2026-10-29T00:00:00.000Z|${requestId}`;
    expect(
      await t.sup.secret({ op: "secret", agent: ANA, action: "activate", requestId, order }, scope().scope),
    ).toEqual({ size: value.length });
    expect((await agentSecrets(path.join(t.ownHome, "secrets"), ANA))?.env[name]).toBe(value);
    expect(await agentSecrets(path.join(t.ownHome, "secrets"), BIA)).toBeNull();
    expect(existsSync(path.join(t.home, "secret-broker", "a1b2c3d4", "keys", requestId))).toBe(false);

    const declined = "broker-0002-bbbb";
    const declinedKey = await t.sup.secret(
      { op: "secret", agent: ANA, action: "keypair", requestId: declined },
      scope().scope,
    );
    const declinedAad = secretAad({ requestId: declined, orgId: "org-1", name: "OTHER_KEY", target });
    const declinedBox = await sealSecret(declinedKey.publicKey as string, "never-installed", declinedAad);
    await t.sup.secret(
      {
        op: "secret",
        agent: ANA,
        action: "deliver",
        requestId: declined,
        name: "OTHER_KEY",
        target,
        aad: declinedAad,
        box: declinedBox,
      },
      scope().scope,
    );
    // A failed DB transaction or a decline sends discard rather than activate.
    await t.sup.secret({ op: "secret", agent: ANA, action: "discard", requestId: declined }, scope().scope);
    expect((await agentSecrets(path.join(t.ownHome, "secrets"), ANA))?.env.OTHER_KEY).toBeUndefined();
    await t.sup.secret({ op: "secret", agent: ANA, action: "remove", name, throughOrder: order }, scope().scope);
    expect((await agentSecrets(path.join(t.ownHome, "secrets"), ANA))?.env[name]).toBeUndefined();
    expect((await agentSecrets(path.join(t.home, "secret-broker"), ANA))?.env[name]).toBeUndefined();
    expect(
      await errorCode(() => t.sup.secret({ op: "secret", agent: ANA, action: "remove", name }, scope().scope)),
    ).toBe("bad_request");
  },
);

test.if(posix && process.platform === "linux" && process.getuid?.() === 0)(
  "upgrade retires old pending keys and boxes without following agent symlinks or losing active values",
  async () => {
    const base = path.join(tempDir("legacy-worker-homes-"), "agents");
    dirs.push(path.dirname(base));
    const me: AgentUser = { id: ANA.id, user: "ag-a1b2c3d4", uid: 0 };
    const home = workerHome(base, me);
    const own = path.join(home, "secrets", "a1b2c3d4");
    mkdirSync(path.join(own, "keys"), { recursive: true });
    mkdirSync(path.join(own, "staged"), { recursive: true });
    writeFileSync(path.join(own, "keys", "legacy-0001"), "old-private-key");
    writeFileSync(path.join(own, "staged", "legacy-0001"), "old-sealed-box");
    writeFileSync(path.join(own, "store.json"), '{"secrets":[]}');
    const outside = path.join(base, "sentinel");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep"), "untouched");
    linkSync(path.join(outside, "keep"), path.join(own, "keys", "linked"));
    retireLegacyPending(base, home, me);
    expect(existsSync(path.join(own, "keys"))).toBe(false);
    expect(existsSync(path.join(own, "staged"))).toBe(false);
    expect(readFileSync(path.join(own, "store.json"), "utf8")).toBe('{"secrets":[]}');
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("untouched");
    const broker = setup();
    expect(
      await errorCode(() =>
        broker.sup.secret(
          {
            op: "secret",
            agent: ANA,
            action: "activate",
            requestId: "legacy-0001",
            order: "2026-10-29T00:00:00.000Z|legacy-0001",
          },
          scope().scope,
        ),
      ),
    ).toBe("not_found");
    symlinkSync(outside, path.join(own, "keys"));
    expect(() => retireLegacyPending(base, home, me)).toThrow();
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("untouched");
    mkdirSync(path.join(own, "keys"));
    writeFileSync(path.join(own, "keys", "replanted"), "old-key");
    expect(() =>
      retireLegacyPending(base, home, me, (name) => {
        if (name !== "keys") return;
        mkdirSync(path.join(own, "keys"));
        writeFileSync(path.join(own, "keys", "replanted"), "old-key");
      }),
    ).toThrow("recreated");
  },
);

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
