import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  parseRunnerFrame,
  parseServerFrame,
  type RunnerFrame,
  TASKS_PROTOCOL,
} from "@agenteschat/adapters/machine-protocol";
import { handleRequest } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import {
  claudeSessionFile,
  executorCommand,
  parseOutputLine,
  TaskManager,
  type TaskManagerOptions,
} from "../../runner/tasks";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const managers: TaskManager[] = [];
/** Process groups left behind on purpose (an "interrupted" task): killed after each test. */
const groups: number[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };
const id = (n: number) => `0193aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;

function setup(over: Partial<TaskManagerOptions> = {}) {
  const ws = tempDir("ws-");
  const home = tempDir("home-");
  dirs.push(ws, home);
  const frames: RunnerFrame[] = [];
  const make = (extra: Partial<TaskManagerOptions> = {}) => {
    const m = new TaskManager({
      root: path.join(home, "tasks"),
      workspaceReal: ws,
      agentFolder: (agent) => agentWorkspace(ws, agent),
      watchMs: 20,
      eventEveryMs: 0,
      claudeHome: path.join(home, "claude"),
      caffeinate: false,
      ...over,
      ...extra,
    });
    managers.push(m);
    return m;
  };
  const tasks = make();
  const done = (taskId: string) =>
    frames.find((f): f is Extract<RunnerFrame, { type: "task.done" }> => f.type === "task.done" && f.taskId === taskId);
  return { ws, home, tasks, frames, make, done, send: (f: RunnerFrame) => frames.push(f) };
}

test("protocol 4: task frames and ops parse; malformed pieces are cut or dropped", () => {
  expect(TASKS_PROTOCOL).toBe(4);
  const event = parseRunnerFrame(
    JSON.stringify({ type: "task.event", taskId: "t1", kind: "line", line: "x".repeat(900), files: ["a.ts", 3] }),
  );
  expect(event).toEqual({ type: "task.event", taskId: "t1", kind: "line", line: "x".repeat(500), files: ["a.ts"] });
  expect(parseRunnerFrame(JSON.stringify({ type: "task.event", taskId: "t1", kind: "weird" }))).toBeNull();
  expect(
    parseRunnerFrame(
      JSON.stringify({ type: "task.done", taskId: "t1", exitCode: 0, seconds: 12.4, result: "ok", interrupted: true }),
    ),
  ).toEqual({
    type: "task.done",
    taskId: "t1",
    exitCode: 0,
    signal: null,
    seconds: 12,
    result: "ok",
    interrupted: true,
  });
  expect(parseRunnerFrame(JSON.stringify({ type: "task.done", taskId: "t1", exitCode: "no" }))).toMatchObject({
    exitCode: null,
    seconds: 0,
  });
  const hello = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "0.4.0",
      protocol: 4,
      tasks: [
        { taskId: "t1", agentId: "a1", status: "running", pid: 42, startedAt: "2026-10-16T10:00:00.000Z" },
        { taskId: "t2", agentId: "a1", status: "bogus", startedAt: "x" },
      ],
    }),
  );
  expect(hello).toMatchObject({ type: "hello", tasks: [{ taskId: "t1", status: "running", pid: 42 }] });
  expect(parseServerFrame(JSON.stringify({ type: "task.ack", taskId: "t1" }))).toEqual({
    type: "task.ack",
    taskId: "t1",
  });
  expect(parseServerFrame(JSON.stringify({ type: "task.ack" }))).toBeNull();
  for (const op of ["task.start", "task.status", "task.cancel"]) {
    expect(parseServerFrame(JSON.stringify({ type: "request", id: "r", op }))).not.toBeNull();
  }
  expect(parseServerFrame(JSON.stringify({ type: "request", id: "r", op: "task.nope" }))).toBeNull();
});

test("executor commands: Claude Code with stream-json and its session; prompts never on the command line", () => {
  expect(executorCommand("claude", { session: "s-1234567890" })).toBe(
    "claude -p --output-format stream-json --verbose --permission-mode acceptEdits --session-id s-1234567890",
  );
  expect(executorCommand("claude", { session: "s-1234567890", resume: true })).toContain("--resume s-1234567890");
  expect(executorCommand("shell", { command: " make test " })).toBe("make test");
  expect(executorCommand("codex", {})).toBe("codex exec --json --full-auto -");
  expect(() => executorCommand("shell", {})).toThrow("needs a command");
  expect(claudeSessionFile("/h/.claude", "/Users/me/agentes/dev-0193aaaa", "abc")).toBe(
    "/h/.claude/projects/-Users-me-agentes-dev-0193aaaa/abc.jsonl",
  );
});

test("Claude Code's stream-json becomes a human line, edited files and the final result", () => {
  const cwd = "/w/dev";
  const tool = (name: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  expect(parseOutputLine(tool("Edit", { file_path: "/w/dev/src/app.ts" }), "claude", cwd)).toEqual({
    line: "Editing src/app.ts",
    files: ["src/app.ts"],
  });
  expect(parseOutputLine(tool("Bash", { command: "npm  test" }), "claude", cwd).line).toBe("Running: npm test");
  expect(parseOutputLine(tool("Read", { file_path: "/w/dev/a.md" }), "claude", cwd)).toEqual({ line: "Reading a.md" });
  expect(
    parseOutputLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Now the tests.\nMore" }] } }),
      "claude",
      cwd,
    ),
  ).toEqual({ line: "Now the tests." });
  expect(
    parseOutputLine(JSON.stringify({ type: "result", result: "Built it.\nDetails", session_id: "S1" }), "claude", cwd),
  ).toEqual({ result: "Built it.\nDetails", session: "S1", line: "Built it." });
  expect(parseOutputLine(JSON.stringify({ type: "system", session_id: "S1" }), "claude", cwd)).toEqual({
    session: "S1",
  });
  expect(parseOutputLine("plain words", "claude", cwd)).toEqual({ line: "plain words" });
  expect(parseOutputLine("{not json", "shell", cwd)).toEqual({ line: "{not json" });
});

test.skipIf(!posix)(
  "a shell task runs detached: events, task.done once, re-sent until acknowledged",
  async () => {
    const { tasks, frames, send, done, home } = setup();
    await tasks.init();
    tasks.attach(send);
    const started = await tasks.start(AGENT, {
      taskId: id(1),
      executor: "shell",
      command: "echo one; sleep 0.3; echo two; echo warn >&2; exit 3",
    });
    expect(started).toMatchObject({
      taskId: id(1),
      cwd: "",
      command: "echo one; sleep 0.3; echo two; echo warn >&2; exit 3",
    });
    expect(started.pid).toBeGreaterThan(0);
    expect(tasks.list()).toMatchObject([{ taskId: id(1), status: "running", agentId: AGENT.id }]);
    await waitFor(() => Boolean(done(id(1))), 8000);
    const d = done(id(1));
    expect(d).toMatchObject({ exitCode: 3, signal: null, lastLine: expect.any(String) });
    expect(d?.result).toContain("two");
    expect(d?.result).toContain("warn");
    expect(frames.some((f) => f.type === "task.event" && f.kind === "line")).toBe(true);
    // Output and the exit live in the task's folder; the journal says it ended.
    const dir = path.join(home, "tasks", id(1));
    expect(readFileSync(path.join(dir, "stdout.log"), "utf8")).toBe("one\ntwo\n");
    expect(JSON.parse(readFileSync(path.join(dir, "exit.json"), "utf8"))).toMatchObject({ exitCode: 3 });
    const journal = JSON.parse(readFileSync(path.join(home, "tasks", "journal.json"), "utf8"));
    expect(journal.tasks[0]).toMatchObject({ taskId: id(1), status: "done", delivered: false });
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(1);

    // A reconnect sends it again until the server says it has it.
    tasks.attach(send);
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(2);
    tasks.ack(id(1));
    tasks.attach(send);
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(2);
    expect(tasks.list()).toEqual([]);
    expect(tasks.status(AGENT).tasks).toMatchObject([{ taskId: id(1), status: "done", exitCode: 3 }]);
  },
  15_000,
);

test.skipIf(!posix)(
  "a task outlives the runner: a new runner picks it up from the journal",
  async () => {
    const { tasks, frames, send, done, make } = setup();
    await tasks.init();
    await tasks.start(AGENT, { taskId: id(2), executor: "shell", command: "sleep 0.6; echo finished" });
    // The runner stops (an update): watching ends, the task goes on.
    tasks.close();
    const next = make();
    await next.init();
    expect(next.list()).toMatchObject([{ taskId: id(2), status: "running" }]);
    next.attach(send);
    await waitFor(() => Boolean(done(id(2))), 8000);
    expect(done(id(2))).toMatchObject({ exitCode: 0, result: "finished", lastLine: "finished" });
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(1);
  },
  15_000,
);

test.skipIf(!posix)(
  "finished while no runner watched: reported on the next start",
  async () => {
    const { tasks, send, done, make } = setup();
    await tasks.init();
    await tasks.start(AGENT, { taskId: id(3), executor: "shell", command: "echo quick" });
    tasks.close();
    await new Promise((r) => setTimeout(r, 700));
    const next = make();
    await next.init();
    next.attach(send);
    await waitFor(() => Boolean(done(id(3))), 8000);
    expect(done(id(3))).toMatchObject({ exitCode: 0, result: "quick" });
  },
  15_000,
);

test.skipIf(!posix)(
  "cancel stops the whole process group; slots refuse a task beyond the limit",
  async () => {
    const { tasks, send, done } = setup({ maxConcurrent: 1 });
    await tasks.init();
    tasks.attach(send);
    await tasks.start(AGENT, { taskId: id(4), executor: "shell", command: "sleep 30" });
    expect(await errorCode(() => tasks.start(AGENT, { taskId: id(5), executor: "shell", command: "true" }))).toBe(
      "no_slot",
    );
    expect(tasks.cancel(AGENT, id(4))).toEqual({ canceled: true });
    await waitFor(() => Boolean(done(id(4))), 8000);
    expect(done(id(4))).toMatchObject({ canceled: true, exitCode: null, signal: "SIGTERM" });
    expect(tasks.cancel(AGENT, id(4))).toEqual({ canceled: false });
    expect(await errorCode(() => tasks.cancel(AGENT, id(99)))).toBe("not_found");
    // Another agent can't see or cancel it.
    expect(tasks.status({ id: "0193bbbb-0000-7000-8000-000000000000", handle: "x" }).tasks).toEqual([]);
  },
  15_000,
);

test.skipIf(!posix)(
  "the time limit kills a task that runs too long",
  async () => {
    const { tasks, send, done } = setup();
    await tasks.init();
    tasks.attach(send);
    await tasks.start(AGENT, { taskId: id(6), executor: "shell", command: "sleep 30", maxSeconds: 1 });
    await waitFor(() => Boolean(done(id(6))), 10_000);
    expect(done(id(6))).toMatchObject({ timedOut: true, exitCode: null });
  },
  15_000,
);

test.skipIf(!posix)(
  "a task whose wrapper vanished without an exit is interrupted (the machine went down)",
  async () => {
    const { tasks, send, done, home } = setup();
    await tasks.init();
    tasks.attach(send);
    const { pid } = await tasks.start(AGENT, { taskId: id(7), executor: "shell", command: "sleep 30" });
    const childPid = path.join(home, "tasks", id(7), "child.pid");
    await waitFor(() => existsSync(childPid) && readFileSync(childPid, "utf8").trim() !== "");
    groups.push(Number(readFileSync(childPid, "utf8")));
    process.kill(pid, "SIGKILL");
    await waitFor(() => Boolean(done(id(7))), 8000);
    expect(done(id(7))).toMatchObject({ interrupted: true, exitCode: null });
    expect(tasks.list()).toMatchObject([{ taskId: id(7), status: "interrupted" }]);
  },
  15_000,
);

test.skipIf(!posix)(
  "Claude Code: the prompt goes through stdin, its session is resumed when it exists, secrets are redacted",
  async () => {
    const bin = tempDir("bin-");
    dirs.push(bin);
    writeFileSync(
      path.join(bin, "claude"),
      [
        "#!/bin/sh",
        'here="$(pwd)"',
        'cat > "$here/prompt-seen.txt"',
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"S-1"}'`,
        `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"'"$here"'/app/main.ts"}}]}}'`,
        `printf '%s\\n' '{"type":"result","result":"Built it with tok_SECRET123 in place.","session_id":"S-1"}'`,
      ].join("\n"),
    );
    chmodSync(path.join(bin, "claude"), 0o755);
    const { tasks, send, done, ws, home, frames } = setup({
      secrets: async () => ({
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
        redact: (s) => s.replaceAll("tok_SECRET123", "[secret:TOKEN]"),
      }),
    });
    await tasks.init();
    tasks.attach(send);
    const session = "0193cccc-0000-7000-8000-000000000001";
    const first = await tasks.start(AGENT, {
      taskId: id(8),
      executor: "claude",
      prompt: 'Build the app; it\'s "quoted" & $weird',
      session,
    });
    // Claude Code keeps sessions under ~/.claude/projects; with none there, it starts this one.
    expect(first.command).toContain(`--session-id ${session}`);
    await waitFor(() => Boolean(done(id(8))), 8000);
    const folder = await agentWorkspace(ws, AGENT);
    expect(readFileSync(path.join(folder, "prompt-seen.txt"), "utf8")).toBe('Build the app; it\'s "quoted" & $weird');
    expect(done(id(8))).toMatchObject({
      exitCode: 0,
      result: "Built it with [secret:TOKEN] in place.",
      files: ["app/main.ts"],
      session,
    });
    expect(JSON.stringify(frames)).not.toContain("tok_SECRET123");

    // The session exists in that folder now: the next task resumes it.
    const file = claudeSessionFile(path.join(home, "claude"), folder, session);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
    const second = await tasks.start(AGENT, { taskId: id(9), executor: "claude", prompt: "go on", session });
    expect(second.command).toContain(`--resume ${session}`);
    await waitFor(() => Boolean(done(id(9))), 8000);
  },
  20_000,
);

const hasGit = spawnSync("git", ["--version"]).status === 0;

test.skipIf(!posix || !hasGit)(
  "a branch puts the task in its own git worktree",
  async () => {
    const { tasks, send, done, ws } = setup();
    await tasks.init();
    tasks.attach(send);
    const folder = await agentWorkspace(ws, AGENT);
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: folder, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(path.join(folder, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const r = await tasks.start(AGENT, {
      taskId: id(10),
      executor: "shell",
      command: "git branch --show-current",
      branch: "feat/x",
    });
    expect(r).toMatchObject({ cwd: `.worktrees/${id(10)}`, branch: "feat/x" });
    await waitFor(() => Boolean(done(id(10))), 8000);
    expect(done(id(10))?.result).toBe("feat/x");
    expect(git("status", "--porcelain").stdout).toBe("");
    expect(
      await errorCode(() => tasks.start(AGENT, { taskId: id(11), executor: "shell", command: "true", branch: "-bad" })),
    ).toBe("bad_request");
  },
  15_000,
);

test("handlers: task ops need the task manager, and commands allowed", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const scope = { signal: new AbortController().signal, output: () => {} };
  const req = { op: "task.start", taskId: id(12), executor: "shell", command: "true", agent: AGENT } as const;
  expect(await errorCode(() => handleRequest({ workspaceReal: ws, exec: true, token: "agm_x" }, req, scope))).toBe(
    "bad_request",
  );
  const { tasks } = setup();
  await tasks.init();
  expect(
    await errorCode(() => handleRequest({ workspaceReal: ws, exec: false, token: "agm_x", tasks }, req, scope)),
  ).toBe("exec_disabled");
});

test.skipIf(process.platform !== "darwin")(
  "macOS: sleep is held while a task runs and released after",
  async () => {
    const { tasks, send, done } = setup({ caffeinate: true });
    await tasks.init();
    tasks.attach(send);
    await tasks.start(AGENT, { taskId: id(13), executor: "shell", command: "sleep 0.3" });
    expect(tasks.holdingSleep).toBe(true);
    await waitFor(() => Boolean(done(id(13))), 8000);
    expect(tasks.holdingSleep).toBe(false);
  },
  15_000,
);
