import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BRAIN_PROTOCOL,
  type BrainTurnRequest,
  MACHINE_PROTOCOL_VERSION,
  parseExecutors,
  parseRunnerFrame,
  parseServerFrame,
  type RunnerFrame,
  type WireBrainEvent,
} from "@agenteschat/adapters/machine-protocol";
import {
  BrainManager,
  type BrainManagerOptions,
  ClaudeStreamParser,
  carryClaudeSession,
  claudeBrainArgs,
  fallbackModelFor,
  userMessageLine,
} from "../../runner/brain";
import { claudeAuth } from "../../runner/executors";
import { handleRequest } from "../../runner/handlers";
import { type IpcReply, McpBridge, McpToolCache } from "../../runner/mcp";
import { agentWorkspace } from "../../runner/paths";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const managers: BrainManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };
const SESSION = (n: number) => `0193aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;
const RUN = (n: number) => `0193bbbb-0000-7000-8000-${String(n).padStart(12, "0")}`;
const FAKE = path.join(import.meta.dir, "fake-claude.mjs");

const line = (o: unknown) => JSON.stringify(o);

// ── Protocol ─────────────────────────────────────────────────────────────────

test("protocol 8: brain.turn requests and brain frames parse; bad events are dropped, long ones cut", () => {
  expect(BRAIN_PROTOCOL).toBe(8);
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BRAIN_PROTOCOL);
  expect(parseServerFrame(line({ type: "request", id: "r1", op: "brain.turn", runId: RUN(1) }))).toMatchObject({
    op: "brain.turn",
  });
  expect(
    parseRunnerFrame(line({ type: "brain.event", runId: RUN(1), event: { type: "text_delta", text: "hi" } })),
  ).toEqual({ type: "brain.event", runId: RUN(1), event: { type: "text_delta", text: "hi" } });
  expect(parseRunnerFrame(line({ type: "brain.event", runId: RUN(1), event: { type: "weird" } }))).toBeNull();
  expect(parseRunnerFrame(line({ type: "brain.done", runId: RUN(1) }))).toEqual({ type: "brain.done", runId: RUN(1) });
  const tool = parseRunnerFrame(
    line({
      type: "brain.event",
      runId: RUN(1),
      event: {
        type: "tool_call",
        id: "t1",
        name: "x",
        input: { q: "y".repeat(9000) },
        executed: { content: "z".repeat(9000), isError: true },
      },
    }),
  ) as Extract<RunnerFrame, { type: "brain.event" }>;
  const ev = tool.event as Extract<WireBrainEvent, { type: "tool_call" }>;
  expect(ev.executed?.content).toHaveLength(4000);
  expect(ev.executed?.isError).toBe(true);
  expect(ev.input).toHaveProperty("truncated");
  expect(
    parseRunnerFrame(
      line({ type: "brain.event", runId: RUN(1), event: { type: "usage", input: 3.4, output: -1, source: "x" } }),
    ),
  ).toMatchObject({ event: { type: "usage", input: 3, output: 0, source: "plan" } });
});

test("hello: Claude Code's login state travels (never anything else from auth status)", () => {
  expect(
    parseExecutors({ claude: { version: "2.1", loggedIn: false, authMethod: "claude.ai", plan: "max", email: "a@b" } }),
  ).toEqual({ claude: { version: "2.1", loggedIn: false, authMethod: "claude.ai", plan: "max" } });
  const run = (_c: string, args: string[]) =>
    args[0] === "auth"
      ? {
          status: 0,
          stdout: line({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", email: "me@x.com" }),
        }
      : { status: 0, stdout: "2.1.300" };
  expect(claudeAuth(run)).toEqual({ loggedIn: true, authMethod: "claude.ai", plan: "team" });
  expect(claudeAuth(() => ({ status: 1, stdout: line({ loggedIn: false }) }))).toEqual({ loggedIn: false });
  expect(claudeAuth(() => ({ status: null, stdout: "", error: new Error("ENOENT") }))).toEqual({});
});

// ── Parsing Claude Code's stream ─────────────────────────────────────────────

test("parser: partial deltas, our tool calls with results, usage, and the final answer with the session", () => {
  const p = new ClaudeStreamParser();
  p.beginTurn();
  const delta = (text: string, parent: string | null = null) =>
    p.push(
      line({
        type: "stream_event",
        session_id: SESSION(1),
        parent_tool_use_id: parent,
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      }),
    );
  expect(delta("Hel").events).toEqual([{ type: "text_delta", text: "Hel" }]);
  expect(delta("sub", "toolu_1").events).toEqual([]);
  // The full assistant message after its deltas adds no text again.
  expect(
    p.push(
      line({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Hello" }] } }),
    ).events,
  ).toEqual([]);
  p.push(
    line({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "mcp__agentes__search_context", input: { query: "q" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      },
    }),
  );
  const results = p.push(
    line({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "found" }], is_error: true },
          { type: "tool_result", tool_use_id: "t2", content: "a.txt" },
        ],
      },
    }),
  );
  // Only our bridge's tools are the engine's to record; Claude Code's own stay on the machine.
  expect(results.events).toEqual([
    {
      type: "tool_call",
      id: "t1",
      name: "search_context",
      input: { query: "q" },
      executed: { content: "found", isError: true },
    },
  ]);
  const end = p.push(
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hello",
      session_id: SESSION(1),
      usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 },
      modelUsage: { "claude-opus-5-5": {} },
    }),
  );
  expect(end.events).toEqual([{ type: "usage", input: 35, output: 7, source: "plan", model: "claude-opus-5-5" }]);
  expect(end.final).toEqual({ type: "done", text: "Hello", session: { id: SESSION(1) } });
  expect(p.session).toBe(SESSION(1));
});

test("parser: without partial messages the assistant text comes whole", () => {
  const p = new ClaudeStreamParser();
  p.beginTurn();
  expect(
    p.push(line({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Hi" }] } }))
      .events,
  ).toEqual([{ type: "text_delta", text: "Hi" }]);
  expect(p.push("not json").events).toEqual([]);
});

test("parser: a plan limit is a limit event with its reset time, then plan_limit; a login failure is not_logged_in", () => {
  const p = new ClaudeStreamParser();
  p.beginTurn();
  expect(p.push(line({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } })).events).toEqual([]);
  expect(
    p.push(line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1900000000 } })).events,
  ).toEqual([{ type: "limit", resetsAt: new Date(1900000000 * 1000).toISOString() }]);
  const end = p.push(line({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit" }));
  expect(end.events).toEqual([]);
  expect(end.final).toMatchObject({ type: "error", code: "plan_limit", retryable: true });

  p.beginTurn();
  const legacy = p.push(line({ type: "result", is_error: true, result: "Claude AI usage limit reached|1900000000" }));
  expect(legacy.events).toEqual([{ type: "limit", resetsAt: new Date(1900000000 * 1000).toISOString() }]);

  p.beginTurn();
  expect(
    p.push(line({ type: "result", is_error: true, result: "Invalid API key · Please run /login" })).final,
  ).toMatchObject({ code: "not_logged_in", retryable: true });
  p.beginTurn();
  expect(
    p.push(line({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] })).final,
  ).toMatchObject({ code: "claude_failed", message: "boom", retryable: false });
});

test("command line: stream-json both ways, opus falls back to sonnet, strict MCP unless opted out, our prompt tool", () => {
  const base = {
    session: SESSION(1),
    resume: false,
    systemFile: "/b/system.txt",
    mcpConfigFile: "/b/mcp.json",
    settingsFile: "/b/settings.json",
    strictMcp: true,
    promptTool: true,
    permissionMode: "acceptEdits" as const,
  };
  const args = claudeBrainArgs({ ...base, model: "opus" });
  for (const a of [
    "-p",
    "--include-partial-messages",
    "--verbose",
    "--strict-mcp-config",
    "--append-system-prompt-file",
    "--permission-prompt-tool",
  ]) {
    expect(args).toContain(a);
  }
  expect(args.join(" ")).toContain("--input-format stream-json --output-format stream-json");
  expect(args.join(" ")).toContain("--model opus --fallback-model sonnet");
  expect(args.slice(-2)).toEqual(["--session-id", SESSION(1)]);
  const resumed = claudeBrainArgs({ ...base, resume: true, strictMcp: false, model: "sonnet; rm -rf /" });
  expect(resumed).not.toContain("--strict-mcp-config");
  expect(resumed).not.toContain("--model");
  expect(resumed.slice(-2)).toEqual(["--resume", SESSION(1)]);
  expect(fallbackModelFor("claude-opus-5-5")).toBe("sonnet");
  expect(fallbackModelFor("sonnet")).toBeUndefined();
  expect(JSON.parse(userMessageLine("oi"))).toEqual({
    type: "user",
    message: { role: "user", content: "oi" },
    parent_tool_use_id: null,
    session_id: "",
  });
});

// ── The manager with a fake Claude Code ──────────────────────────────────────

function setup(over: Partial<BrainManagerOptions> = {}) {
  const ws = tempDir("brain-ws-");
  const home = tempDir("brain-home-");
  dirs.push(ws, home);
  const logFile = path.join(home, "spawns.log");
  process.env.FAKE_CLAUDE_LOG = logFile;
  const m = new BrainManager({
    root: path.join(home, "brains"),
    claudeCommand: [process.execPath, FAKE],
    claudeHome: path.join(home, "no-claude-home"),
    mcp: { socketPath: path.join(home, "mcp.sock"), command: ["node", "runner.mjs"] },
    deltaMs: 5,
    ...over,
  });
  managers.push(m);
  const spawns = () => {
    try {
      return readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { pid: number; args: string[] });
    } catch {
      return [];
    }
  };
  // One lookup shared by every turn: turns started together reach the manager in the order they started.
  let folderOnce: Promise<string> | null = null;
  const turn = async (n: number, prompt: string, extra: Partial<BrainTurnRequest> = {}, signal?: AbortSignal) => {
    folderOnce ??= agentWorkspace(ws, AGENT);
    const folder = await folderOnce;
    const events: WireBrainEvent[] = [];
    const final = await m.turn(
      {
        runId: RUN(n),
        kind: "claude_code",
        session: { id: SESSION(1), resume: false },
        cwd: "",
        system: "You are dev.",
        prompt,
        mcp: { token: `agr_${"t".repeat(24)}${n}` },
        ...extra,
      },
      { agent: AGENT, folder, emit: (e) => events.push(e), ...(signal ? { signal } : {}) },
    );
    return { final, events };
  };
  return { m, home, ws, spawns, turn };
}

test.if(posix)(
  "one process per thread: two turns reuse it, events stream, the final answer repeats as the last event",
  async () => {
    const { m, spawns, turn } = setup();
    const a = await turn(1, "first");
    expect(a.final).toEqual({ type: "done", text: "echo 1: first", session: { id: SESSION(1) } });
    expect(a.events.at(-1)).toEqual(a.final);
    expect(
      a.events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("Hello world");
    expect(a.events).toContainEqual({ type: "usage", input: 16, output: 7, source: "plan", model: "claude-sonnet" });
    const b = await turn(2, "second");
    expect(b.final).toMatchObject({ type: "done", text: "echo 2: second" });
    expect(spawns()).toHaveLength(1);
    expect(m.size).toBe(1);
    const args = spawns()[0]?.args ?? [];
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(-2)).toEqual(["--session-id", SESSION(1)]);
  },
);

test.if(posix)("our tool calls arrive executed; the bridge relays them for the run that is thinking now", async () => {
  const { m, spawns, turn } = setup();
  const pending = turn(1, "SLOW TOOL");
  await waitFor(() => spawns().length === 1);
  const args = spawns()[0]?.args ?? [];
  const config = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1] as string, "utf8")) as {
    mcpServers: { agentes: { args: string[] } };
  };
  const bridgeId = config.mcpServers.agentes.args.at(-1) as string;
  expect(m.mcpTask(bridgeId)).toMatchObject({ running: true, runId: RUN(1), serverToken: `agr_${"t".repeat(24)}1` });
  const { events } = await pending;
  expect(events.filter((e) => e.type === "tool_call")).toEqual([
    { type: "tool_call", id: "t1", name: "search_context", input: { query: "x" }, executed: { content: "found it" } },
  ]);
  expect(m.mcpTask(bridgeId)).toMatchObject({ running: false });
  expect(m.mcpTask(bridgeId)?.runId).toBeUndefined();
});

test.if(posix)(
  "two turns on one process: each turn's calls carry its own run and token; between turns the list waits quietly",
  async () => {
    const { m, spawns, turn } = setup();
    const logs: string[] = [];
    const bridge = new McpBridge({
      socketPath: "unused",
      task: (id) => m.mcpTask(id),
      log: (l) => logs.push(l),
      callTimeoutMs: 2000,
    });
    const frames: RunnerFrame[] = [];
    bridge.attach((f) => {
      frames.push(f);
      if (f.type === "mcp.call") bridge.result({ type: "mcp.result", callId: f.callId, ok: true, text: "ok" });
    });
    const bridgeInfo = () => {
      const args = spawns()[0]?.args ?? [];
      const config = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1] as string, "utf8")) as {
        mcpServers: { agentes: { args: string[]; env: { AGENTES_MCP_TOKEN: string } } };
      };
      return {
        id: config.mcpServers.agentes.args.at(-1) as string,
        token: config.mcpServers.agentes.env.AGENTES_MCP_TOKEN,
      };
    };
    const callDuring = async (n: number) => {
      const pending = turn(n, "SLOW");
      await waitFor(() => spawns().length === 1 && m.mcpTask(bridgeInfo().id)?.runId === RUN(n));
      const { id, token } = bridgeInfo();
      const reply = await bridge.handle({ taskId: id, token, tool: "search_context", args: { query: "x" } });
      await pending;
      return reply;
    };
    expect(await callDuring(1)).toEqual({ ok: true, text: "ok" });
    // Between turns: the MCP server's background refresh is answered quietly, nothing relayed.
    const { id, token } = bridgeInfo();
    const idle = await bridge.handle({ taskId: id, token, tool: "", args: {}, kind: "list" });
    expect(idle).toMatchObject({ ok: false, idle: true });
    expect(await callDuring(2)).toEqual({ ok: true, text: "ok" });
    const calls = frames.filter((f) => f.type === "mcp.call") as Extract<RunnerFrame, { type: "mcp.call" }>[];
    expect(calls.map((c) => [c.taskId, c.token])).toEqual([
      [RUN(1), `agr_${"t".repeat(24)}1`],
      [RUN(2), `agr_${"t".repeat(24)}2`],
    ]);
    expect(frames.filter((f) => f.type === "mcp.list")).toHaveLength(0);
    expect(spawns()).toHaveLength(1);
    expect(logs.filter((l) => l.includes("refused"))).toEqual([]);
    await bridge.close();
  },
);

test("the MCP process's tool cache: an idle answer between turns makes the next turn ask again", async () => {
  let n = 0;
  const replies: IpcReply[] = [
    { ok: true, text: "", tools: [{ name: "a", description: "", inputSchema: { type: "object" } }] },
    { ok: false, error: "No turn", idle: true },
    { ok: true, text: "", tools: [{ name: "b", description: "", inputSchema: { type: "object" } }] },
  ];
  const cache = new McpToolCache(async () => replies[n++] as IpcReply, { ttlMs: 60_000 });
  expect((await cache.get()).map((t) => t.name)).toEqual(["a"]);
  // Fresh: answered from the cache.
  expect((await cache.get()).map((t) => t.name)).toEqual(["a"]);
  expect(await cache.refresh()).toBe(false);
  // The next turn's first look asks the server again (for that turn's run).
  expect((await cache.get()).map((t) => t.name)).toEqual(["b"]);
});

test.if(posix)("idle processes close after the idle time", async () => {
  const { m, turn } = setup({ idleMs: 80 });
  await turn(1, "hi");
  const proc = m.process(AGENT.id, SESSION(1));
  expect(m.size).toBe(1);
  await waitFor(() => m.size === 0 && proc?.exited === true, 4000);
});

test.if(posix)("at most N processes: the least recently used idle one is closed for a new thread", async () => {
  const { m, ws } = setup({ maxProcesses: 2 });
  const s = (n: number) => ({ session: { id: SESSION(n), resume: false } });
  // Each turn on its own session (SESSION(1..3)).
  for (const n of [1, 2, 3]) {
    await m.turn(
      { runId: RUN(n), kind: "claude_code", ...s(n), cwd: "", system: "", prompt: `t${n}`, mcp: { token: "t" } },
      { agent: AGENT, folder: await agentWorkspace(ws, AGENT), emit: () => {} },
    );
  }
  expect(m.size).toBe(2);
  expect(m.process(AGENT.id, SESSION(1))).toBeUndefined();
  expect(m.process(AGENT.id, SESSION(3))).toBeDefined();
});

test.if(posix)("a process that dies mid-turn: the same turn runs again one-shot, resuming the session", async () => {
  const { m, spawns, turn } = setup();
  const r = await turn(1, "CRASH please");
  expect(r.final).toMatchObject({ type: "done", text: "echo 1: CRASH please" });
  const all = spawns();
  expect(all).toHaveLength(2);
  expect(all[1]?.args.slice(-2)).toEqual(["--resume", SESSION(1)]);
  expect(m.size).toBe(0);
  // The next turn starts a persistent process again, resumed.
  await turn(2, "again");
  expect(spawns()[2]?.args.slice(-2)).toEqual(["--resume", SESSION(1)]);
  expect(m.size).toBe(1);
});

test.if(posix)("a process that crashes while idle is started again (resumed) on the next turn", async () => {
  const { m, spawns, turn } = setup();
  await turn(1, "hi");
  const proc = m.process(AGENT.id, SESSION(1));
  proc?.child.kill("SIGKILL");
  await waitFor(() => m.size === 0);
  const r = await turn(2, "back");
  expect(r.final).toMatchObject({ type: "done" });
  expect(spawns()).toHaveLength(2);
  expect(spawns()[1]?.args.slice(-2)).toEqual(["--resume", SESSION(1)]);
});

test.if(posix)("turns of one session queue: the second starts after the first ends", async () => {
  const { spawns, turn } = setup();
  const order: string[] = [];
  const a = turn(1, "SLOW one").then((r) => order.push((r.final as { text: string }).text));
  const b = turn(2, "two").then((r) => order.push((r.final as { text: string }).text));
  await Promise.all([a, b]);
  expect(order).toEqual(["echo 1: SLOW one", "echo 2: two"]);
  expect(spawns()).toHaveLength(1);
});

test.if(posix)("keepAlive false: one-shot, the process ends with the turn", async () => {
  const { m, turn } = setup();
  const r = await turn(1, "once", { keepAlive: false });
  expect(r.final).toMatchObject({ type: "done", text: "echo 1: once" });
  expect(m.size).toBe(0);
});

test.if(posix)("plan limit and login failures end the turn with retryable errors", async () => {
  const { turn } = setup();
  const lim = await turn(1, "LIMIT");
  expect(lim.events[0]).toMatchObject({ type: "limit", resetsAt: new Date(1900000000 * 1000).toISOString() });
  expect(lim.final).toMatchObject({ type: "error", code: "plan_limit", retryable: true });
  const auth = await turn(2, "AUTH");
  expect(auth.final).toMatchObject({ type: "error", code: "not_logged_in", retryable: true });
});

test.if(posix)("a wrong session flag on a one-shot start is retried once with the other one", async () => {
  process.env.FAKE_CLAUDE_NO_SESSION = "1";
  try {
    const { spawns, turn } = setup();
    const r = await turn(1, "hi", { keepAlive: false, session: { id: SESSION(1), resume: true } });
    expect(r.final).toMatchObject({ type: "done" });
    expect(spawns().map((s) => s.args.at(-2))).toEqual(["--resume", "--session-id"]);
  } finally {
    delete process.env.FAKE_CLAUDE_NO_SESSION;
  }
});

test.if(posix)("no Claude Code, a canceled turn, and bad requests", async () => {
  const missing = setup({ claudeCommand: ["/nonexistent/claude-xyz"] });
  expect((await missing.turn(1, "hi")).final).toMatchObject({ code: "cli_missing", retryable: true });
  const { turn } = setup();
  const ac = new AbortController();
  const p = turn(2, "SLOW wait", {}, ac.signal);
  setTimeout(() => ac.abort(), 50);
  expect((await p).final).toMatchObject({ code: "canceled", retryable: false });
  expect((await turn(3, "x", { session: { id: "not-a-uuid", resume: false } })).final).toMatchObject({
    code: "bad_request",
  });
  expect((await turn(4, "x", { kind: "codex" })).final).toMatchObject({ code: "unsupported" });
});

test.if(posix)(
  "handler: brain.turn streams brain.event frames, then brain.done, and answers the final event",
  async () => {
    const { m, ws } = setup();
    const frames: RunnerFrame[] = [];
    const ctx = { workspaceReal: ws, exec: true, token: "agm_x", brains: m };
    const reply = (await handleRequest(
      ctx,
      {
        op: "brain.turn",
        agent: AGENT,
        runId: RUN(9),
        kind: "claude_code",
        session: { id: SESSION(1), resume: false },
        cwd: "",
        system: "s",
        prompt: "hello",
        mcp: { token: "t" },
      },
      { signal: new AbortController().signal, output: () => {}, emit: (f) => frames.push(f) },
    )) as { runId: string; final: WireBrainEvent };
    expect(reply).toEqual({
      runId: RUN(9),
      final: { type: "done", text: "echo 1: hello", session: { id: SESSION(1) } },
    });
    expect(frames.at(-1)).toEqual({ type: "brain.done", runId: RUN(9) });
    expect(frames.at(-2)).toEqual({ type: "brain.event", runId: RUN(9), event: reply.final });
    expect(frames.some((f) => f.type === "brain.event" && f.event.type === "text_delta")).toBe(true);
    // Commands off: refused before anything starts.
    await expect(
      handleRequest(
        { ...ctx, exec: false },
        {
          op: "brain.turn",
          agent: AGENT,
          runId: RUN(10),
          kind: "claude_code",
          session: { id: SESSION(1), resume: false },
          cwd: "",
          system: "",
          prompt: "x",
          mcp: { token: "t" },
        },
        { signal: new AbortController().signal, output: () => {} },
      ),
    ).rejects.toThrow(/turned off/);
  },
);

test.if(posix)("a turn in one of its checkouts keeps the agent's whole folder (--add-dir)", async () => {
  const { spawns, turn, ws } = setup();
  const folder = await agentWorkspace(ws, AGENT);
  mkdirSync(path.join(folder, "repos", "acme", "app"), { recursive: true });
  const r = await turn(1, "hi", { cwd: "repos/acme/app" });
  expect(r.final).toMatchObject({ type: "done" });
  const args = spawns()[0]?.args ?? [];
  expect(args[args.indexOf("--add-dir") + 1]).toBe(folder);
});

test("a conversation that moves to a checkout keeps its Claude Code session (the newest copy)", () => {
  const home = tempDir("claude-home-");
  dirs.push(home);
  const session = "11111111-2222-4333-8444-555555555555";
  const project = (cwd: string) => path.join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project("/w/dev"), { recursive: true });
  writeFileSync(path.join(project("/w/dev"), `${session}.jsonl`), "old\nnew\n");
  carryClaudeSession(home, "/w/dev/repos/acme/app", session);
  const moved = path.join(project("/w/dev/repos/acme/app"), `${session}.jsonl`);
  expect(readFileSync(moved, "utf8")).toBe("old\nnew\n");
  // Back in the folder after more turns in the checkout: the newer one goes back.
  writeFileSync(moved, "old\nnew\nmore\n");
  utimesSync(path.join(project("/w/dev"), `${session}.jsonl`), new Date(1000), new Date(1000));
  carryClaudeSession(home, "/w/dev", session);
  expect(readFileSync(path.join(project("/w/dev"), `${session}.jsonl`), "utf8")).toBe("old\nnew\nmore\n");
  // No projects folder: nothing happens.
  carryClaudeSession(path.join(home, "nope"), "/w", session);
});
