import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters";
import {
  type CodexBrainEvent,
  CodexEventMapper,
  CodexThreads,
  codexBridgeOverrides,
  codexContextOverride,
  codexEffort,
  codexProfileOf,
  codexThreadKey,
  codexThreadsFile,
  codexTurnArgs,
  codexVersionOk,
  handleCodexBrainTurn,
  runCodexTurn,
} from "../../runner/brain-codex";
import { handleRequest } from "../../runner/handlers";
import { CODEX_MCP_SERVER } from "../../runner/mcp";
import { agentWorkspace } from "../../runner/paths";
import type { Spawn } from "../../runner/scope-gate";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const RUN = "0193aaaa-0000-7000-8000-0000000000a1";
const SESSION = "0193cccc-0000-7000-8000-000000000001";
const THREAD = "01a1463b-6712-7b53-9f12-2499fb614d2d";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };

/** A real codex-cli 0.163.0 first turn, then a resumed one with a command and an edit. */
const TURN1 = [
  `{"type":"thread.started","thread_id":"${THREAD}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17806,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
];
const TURN2 = [
  `{"type":"thread.started","thread_id":"${THREAD}"}`,
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll check the folder now."}}',
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"npm test\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"npm test\\"","aggregated_output":"2 passed\\n","exit_code":0,"status":"completed"}}`,
  '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"CWD/src/main.ts","kind":"update"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"agenteschat_agentes","tool":"search","arguments":{},"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Done: tests pass."}}',
  '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":4}}',
];

test("version gate: 0.163.0 and newer", () => {
  expect(codexVersionOk("codex-cli 0.163.0")).toBe(true);
  expect(codexVersionOk("codex-cli 0.170.1")).toBe(true);
  expect(codexVersionOk("codex-cli 0.99.0")).toBe(false);
  expect(codexVersionOk(undefined)).toBe(false);
});

test("command line: first turn with instructions, resume by id without them, options before resume", () => {
  const first = codexTurnArgs({
    cwd: "/w/my app",
    lastFile: "/r/last.txt",
    runId: RUN,
    model: "gpt-5.5",
    instructions: 'Be "brief".\nUse tools.',
    mcp: { command: ["/usr/bin/bun", "/r/runner.js"] },
  });
  expect(first.slice(0, 7)).toEqual([
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    "/w/my app",
    "--sandbox",
    "workspace-write",
  ]);
  // ADR 0053 §3: never the network (exec can't ask, so the sandbox is the limit).
  expect(first.join(" ")).not.toContain("network_access");
  expect(first).toContain(`developer_instructions=${JSON.stringify('Be "brief".\nUse tools.')}`);
  expect(first.slice(-5)).toEqual(["-m", "gpt-5.5", "-o", "/r/last.txt", "-"]);
  expect(first).not.toContain("resume");
  expect(first).not.toContain("--full-auto");

  const resumed = codexTurnArgs({ cwd: "/w/app", lastFile: "/l.txt", runId: RUN, instructions: "x", thread: THREAD });
  expect(resumed.slice(-5)).toEqual(["-o", "/l.txt", "resume", THREAD, "-"]);
  expect(resumed.some((a) => a.startsWith("developer_instructions="))).toBe(false);

  // A plan turn: a read-only sandbox (its writable roots don't apply).
  const plan = codexTurnArgs({
    cwd: "/w/app",
    lastFile: "/l.txt",
    runId: RUN,
    profile: "plan",
    writableRoots: ["/w/shared"],
  });
  expect(plan.slice(5, 7)).toEqual(["--sandbox", "read-only"]);
  expect(plan.join(" ")).not.toContain("writable_roots");
  expect(plan.join(" ")).not.toContain("network_access");
  expect(codexProfileOf({ permissions: { mode: "plan" } })).toBe("plan");
  expect(codexProfileOf({})).toBe("work");
});

test("MCP bridge overrides: stdio by run with the token through env_vars, or HTTP with a bearer from the env", () => {
  const key = `mcp_servers.${CODEX_MCP_SERVER}`;
  expect(codexBridgeOverrides({ runId: RUN, command: ["/usr/bin/bun", "/r/runner.js"] })).toEqual([
    `${key}.command="/usr/bin/bun"`,
    `${key}.args=["/r/runner.js","mcp","--run","${RUN}"]`,
    `${key}.env_vars=["AGENTES_MCP_TOKEN","AGENTES_MCP_SOCKET","AGENTES_RUNNER_HOME"]`,
    `${key}.default_tools_approval_mode="approve"`,
    `${key}.startup_timeout_sec=60`,
    `${key}.tool_timeout_sec=300`,
    `${key}.required=true`,
  ]);
  const http = codexBridgeOverrides({ runId: RUN, url: "https://agentes.chat/mcp/run" });
  expect(http.slice(0, 2)).toEqual([
    `${key}.url="https://agentes.chat/mcp/run"`,
    `${key}.bearer_token_env_var="AGENTES_MCP_TOKEN"`,
  ]);
  expect(http).toContain(`${key}.default_tools_approval_mode="approve"`);
  // The token itself is never on the command line (only the name of the env var that holds it).
  expect(JSON.stringify(http)).not.toContain("agr_");
});

test("events: commands and edits are executed tool calls, our bridge's calls aren't repeated, the last message wins", () => {
  const m = new CodexEventMapper({ cwd: "/w/app", model: "gpt-5.5", redact: (s) => s.replaceAll("2 passed", "[ok]") });
  const out = TURN2.map((l) => l.replace("CWD", "/w/app")).flatMap((l) => m.line(l));
  expect(m.thread).toBe(THREAD);
  expect(out).toEqual([
    {
      type: "tool_call",
      id: "item_1",
      name: "shell",
      input: { command: "npm test" },
      executed: { content: "[ok]\n" },
    },
    {
      type: "tool_call",
      id: "item_2",
      name: "file_change",
      input: { changes: [{ path: "src/main.ts", kind: "update" }] },
      executed: { content: "Changed src/main.ts (update)" },
    },
    { type: "usage", input: 200, output: 30, source: "plan", model: "gpt-5.5" },
  ]);
  expect(m.finish({ exitCode: 0, sessionId: SESSION })).toEqual([
    { type: "text_delta", text: "Done: tests pass." },
    { type: "done", text: "Done: tests pass.", session: { id: SESSION } },
  ]);
  // A failing or declined command is an error result.
  expect(
    new CodexEventMapper({ cwd: "/w" }).line(
      '{"type":"item.completed","item":{"id":"c","type":"command_execution","command":"git push","aggregated_output":"","exit_code":null,"status":"declined"}}',
    ),
  ).toMatchObject([{ executed: { content: "Not allowed by Codex's sandbox.", isError: true } }]);
});

test("turn end: failed turns, usage limits, a stream error with a bad exit, last.txt as the fallback answer", () => {
  const failed = new CodexEventMapper();
  failed.line('{"type":"turn.failed","error":{"message":"model overloaded"}}');
  expect(failed.finish({ exitCode: 1, sessionId: SESSION })).toEqual([
    { type: "error", code: "codex_failed", message: "model overloaded" },
  ]);
  const limited = new CodexEventMapper();
  limited.line('{"type":"error","message":"Reconnecting... 1/5"}');
  limited.line('{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again later."}}');
  expect(limited.finish({ exitCode: 1, sessionId: SESSION })).toMatchObject([
    { type: "limit" },
    { type: "error", code: "plan_limit" },
  ]);
  // An `error` event alone doesn't end a completed turn.
  const retried = new CodexEventMapper();
  retried.line('{"type":"error","message":"Reconnecting... 1/5"}');
  retried.line('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}');
  expect(retried.finish({ exitCode: 0, lastFile: "from file\n", sessionId: SESSION })).toEqual([
    { type: "text_delta", text: "from file" },
    { type: "done", text: "from file", session: { id: SESSION } },
  ]);
  const crashed = new CodexEventMapper();
  crashed.line('{"type":"error","message":"stream disconnected"}');
  expect(crashed.finish({ exitCode: 1, sessionId: SESSION })).toEqual([
    { type: "error", code: "codex_failed", message: "stream disconnected", retryable: true },
  ]);
});

test("threads survive a restart (file in the runner home)", () => {
  const home = tempDir("brain-home-");
  dirs.push(home);
  const file = codexThreadsFile(home);
  new CodexThreads(file).set(SESSION, THREAD);
  expect(new CodexThreads(file).get(SESSION)).toBe(THREAD);
  expect(new CodexThreads(file).get("other-session")).toBeUndefined();
});

/** A fake `codex`: records argv, stdin and the token it got, prints a real turn (the resumed one when asked). */
function fakeCodex(dir: string) {
  const bin = path.join(dir, "codex");
  const t1 = TURN1.join("\n");
  const t2 = TURN2.join("\n");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'n=$(ls "$FAKE_DIR" | grep -c "^args-")',
      'for a in "$@"; do printf "%s\\n" "$a"; done > "$FAKE_DIR/args-$n"',
      'cat > "$FAKE_DIR/prompt-$n"',
      'printf "%s" "$AGENTES_MCP_TOKEN" > "$FAKE_DIR/token-$n"',
      'case " $* " in',
      `  *" resume "*) cat <<'EOF'\n${t2.replaceAll("CWD", "/x")}\nEOF\n;;`,
      `  *) cat <<'EOF'\n${t1}\nEOF\n;;`,
      "esac",
      'echo "some MCP server failed to start" >&2',
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

test.skipIf(!posix)(
  "a fake codex: first turn starts a thread with the instructions, the next resumes it by id; secrets redacted",
  async () => {
    const root = tempDir("brain-codex-");
    dirs.push(root);
    const fake = path.join(root, "fake");
    const ws = path.join(root, "ws");
    const home = path.join(root, "home");
    for (const d of [fake, ws, home]) mkdirSync(d, { recursive: true });
    const bin = fakeCodex(fake);
    const folder = await agentWorkspace(ws, AGENT);
    mkdirSync(path.join(folder, "app"), { recursive: true });
    const events: CodexBrainEvent[] = [];
    const ctx = {
      folder,
      exec: true,
      runnerHome: home,
      mcp: { socketPath: path.join(home, "mcp.sock"), command: ["/usr/bin/env", "/r/runner.js"] },
      codexVersion: () => "codex-cli 0.163.0",
      bin,
    };
    const req = {
      runId: RUN,
      kind: "codex" as const,
      session: { id: SESSION, resume: false },
      cwd: "app",
      system: "You are Dev.",
      prompt: 'Say pong; it\'s "quoted" & $weird',
      mcp: { token: "tok_per_run" },
      agent: AGENT,
    };
    const signal = new AbortController().signal;
    // Codex inherits the runner's env: FAKE_DIR tells the fake where to record.
    process.env.FAKE_DIR = fake;
    try {
      await handleCodexBrainTurn(ctx, req, { signal, emit: (e) => events.push(e) });
      expect(events).toEqual([
        { type: "usage", input: 17806, output: 5, source: "plan", cacheRead: 6912 },
        { type: "text_delta", text: "pong" },
        { type: "done", text: "pong", session: { id: SESSION } },
      ]);
      const args1 = readFileSync(path.join(fake, "args-0"), "utf8").trim().split("\n");
      expect(args1).toContain(path.join(folder, "app"));
      expect(args1).toContain('developer_instructions="You are Dev."');
      expect(args1).toContain(`mcp_servers.${CODEX_MCP_SERVER}.args=["/r/runner.js","mcp","--run","${RUN}"]`);
      expect(args1).not.toContain("resume");
      expect(args1.at(-1)).toBe("-");
      expect(args1.join(" ")).not.toContain("tok_per_run");
      expect(readFileSync(path.join(fake, "prompt-0"), "utf8")).toBe(req.prompt);
      expect(readFileSync(path.join(fake, "token-0"), "utf8")).toBe("tok_per_run");
      expect(new CodexThreads(codexThreadsFile(home)).get(SESSION)).toBe(THREAD);
      // The turn's scratch folder is gone.
      expect(existsSync(path.join(home, "brain", "turns", RUN))).toBe(false);

      events.length = 0;
      await handleCodexBrainTurn(
        ctx,
        { ...req, runId: RUN.replace(/1$/, "2"), session: { id: SESSION, resume: true }, prompt: "run the tests" },
        { signal, emit: (e) => events.push(e) },
      );
      const args2 = readFileSync(path.join(fake, "args-1"), "utf8").trim().split("\n");
      expect(args2.slice(-3)).toEqual(["resume", THREAD, "-"]);
      expect(args2.some((a) => a.startsWith("developer_instructions="))).toBe(false);
      expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_call", "usage", "text_delta", "done"]);
      expect(events.at(-1)).toEqual({ type: "done", text: "Done: tests pass.", session: { id: SESSION } });
    } finally {
      delete process.env.FAKE_DIR;
    }
  },
  15_000,
);

test.skipIf(!posix)("refuses an old or missing Codex without starting it; bad requests fail", async () => {
  const root = tempDir("brain-codex-");
  dirs.push(root);
  const bin = path.join(root, "codex");
  writeFileSync(bin, `#!/bin/sh\ntouch "${root}/started"\n`);
  chmodSync(bin, 0o755);
  const events: CodexBrainEvent[] = [];
  const opts = {
    threads: new CodexThreads(path.join(root, "threads.json")),
    workDir: path.join(root, "turn"),
    emit: (e: CodexBrainEvent) => events.push(e),
    signal: new AbortController().signal,
    bin,
  };
  const input = { runId: RUN, sessionId: SESSION, cwd: root, system: "", prompt: "hi", mcp: { token: "t" } };
  await runCodexTurn(input, { ...opts, codexVersion: () => "codex-cli 0.162.0" });
  expect(events).toMatchObject([{ type: "error", code: "codex_too_old" }]);
  expect((events[0] as { message: string }).message).toContain("0.163.0");
  await runCodexTurn(input, { ...opts, codexVersion: () => undefined });
  expect(events[1]).toMatchObject({ type: "error", code: "codex_missing" });
  expect(existsSync(path.join(root, "started"))).toBe(false);
  // A codex that exits without a turn is an error, not an empty answer.
  await runCodexTurn(input, { ...opts, codexVersion: () => "codex-cli 0.163.0" });
  expect(existsSync(path.join(root, "started"))).toBe(true);
  expect(events[2]).toMatchObject({ type: "error", code: "codex_failed" });

  const ctx = { folder: root, exec: true, runnerHome: root, codexVersion: () => "codex-cli 0.163.0", bin };
  const req = {
    runId: RUN,
    kind: "codex" as const,
    session: { id: SESSION, resume: false },
    system: "",
    prompt: "hi",
    mcp: { token: "t" },
    agent: AGENT,
  };
  const scope = { signal: new AbortController().signal, emit: () => {} };
  expect(await errorCode(() => handleCodexBrainTurn({ ...ctx, exec: false }, req, scope))).toBe("exec_disabled");
  expect(await errorCode(() => handleCodexBrainTurn(ctx, { ...req, agent: undefined }, scope))).toBe("bad_request");
  expect(await errorCode(() => handleCodexBrainTurn(ctx, { ...req, mcp: { token: "" } }, scope))).toBe("bad_request");
  expect(await errorCode(() => handleCodexBrainTurn(ctx, { ...req, cwd: "nope" }, scope))).toBe("not_found");
});

// ── Accounts and effort (protocol 13, ADR 0041) ──────────────────────────────

const ACCOUNT = "0193ffff-0000-7000-8000-000000000002";

test("effort: model_reasoning_effort, with xhigh and max as high; nothing for an unknown level", () => {
  expect(["low", "medium", "high", "xhigh", "max"].map((e) => codexEffort(e as never))).toEqual([
    "low",
    "medium",
    "high",
    "high",
    "high",
  ]);
  const args = (effort?: string) =>
    codexTurnArgs({ cwd: "/w", lastFile: "/l.txt", runId: RUN, model: "gpt-5.5", effort: effort as never });
  const max = args("max");
  expect(max[max.indexOf('model_reasoning_effort="high"') - 1]).toBe("-c");
  expect(args("low")).toContain('model_reasoning_effort="low"');
  expect(args("turbo").some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
  expect(args().some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
  // Before resume and the stdin dash, like every option.
  expect(args("medium").slice(-1)).toEqual(["-"]);
});

test("context limit (protocol 28): model_auto_compact_token_limit, nothing for a value out of range", () => {
  const args = (contextTokens?: unknown) =>
    codexTurnArgs({ cwd: "/w", lastFile: "/l.txt", runId: RUN, contextTokens: contextTokens as never });
  const limited = args(400_000);
  expect(limited[limited.indexOf("model_auto_compact_token_limit=400000") - 1]).toBe("-c");
  expect(limited.slice(-1)).toEqual(["-"]);
  for (const bad of [undefined, 10, 400_000.5, "400000", 50_000_000]) {
    expect(args(bad).some((a) => a.startsWith("model_auto_compact_token_limit"))).toBe(false);
  }
  expect(codexContextOverride(1_000_000)).toEqual(["-c", "model_auto_compact_token_limit=1000000"]);
});

test("a not-logged-in Codex is not_logged_in (the server marks the account signed out)", () => {
  const m = new CodexEventMapper({ cwd: "/w" });
  m.event({ type: "turn.failed", error: { message: "Not logged in. Run `codex login`." } });
  expect(m.finish({ exitCode: 1, sessionId: SESSION })).toEqual([
    { type: "error", code: "not_logged_in", message: "Not logged in. Run `codex login`.", retryable: true },
  ]);
});

test.skipIf(!posix)(
  "an account turn runs with CODEX_HOME at the account's folder and keeps its own thread; a missing one fails",
  async () => {
    const root = tempDir("brain-codex-");
    dirs.push(root);
    const fake = path.join(root, "fake");
    const ws = path.join(root, "ws");
    const home = path.join(root, "home");
    const accountDir = path.join(root, "account");
    for (const d of [fake, ws, home, accountDir]) mkdirSync(d, { recursive: true });
    const bin = path.join(fake, "codex");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `printf "%s" "$CODEX_HOME" > "${fake}/home"`,
        `for a in "$@"; do printf "%s\\n" "$a"; done > "${fake}/args"`,
        "cat > /dev/null",
        `cat <<'EOF'\n${TURN1.join("\n")}\nEOF`,
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    const ctx = {
      folder: await agentWorkspace(ws, AGENT),
      exec: true,
      runnerHome: home,
      codexVersion: () => "codex-cli 0.163.0",
      bin,
      accounts: { accountDir: (kind: string, id: string) => (kind === "codex" && id === ACCOUNT ? accountDir : null) },
    };
    const req = {
      runId: RUN,
      kind: "codex" as const,
      session: { id: SESSION, resume: false },
      system: "You are Dev.",
      prompt: "hi",
      mcp: { token: "tok" },
      agent: AGENT,
      account: ACCOUNT,
      effort: "xhigh" as const,
    };
    const events: CodexBrainEvent[] = [];
    await handleCodexBrainTurn(ctx, req, { signal: new AbortController().signal, emit: (e) => events.push(e) });
    expect(events.at(-1)).toMatchObject({ type: "done", text: "pong" });
    expect(readFileSync(path.join(fake, "home"), "utf8")).toBe(accountDir);
    expect(readFileSync(path.join(fake, "args"), "utf8").split("\n")).toContain('model_reasoning_effort="high"');
    // The thread is this account's: the machine's own sign-in won't resume it.
    const threads = new CodexThreads(codexThreadsFile(home));
    expect(threads.get(codexThreadKey(SESSION, ACCOUNT))).toBe(THREAD);
    expect(threads.get(SESSION)).toBeUndefined();

    events.length = 0;
    rmSync(path.join(fake, "home"), { force: true });
    await handleCodexBrainTurn(
      { ...ctx, accounts: { accountDir: () => null } },
      { ...req, runId: RUN.replace(/1$/, "3") },
      { signal: new AbortController().signal, emit: (e) => events.push(e) },
    );
    expect(events).toMatchObject([{ type: "error", code: "account_missing", retryable: false }]);
    expect(existsSync(path.join(fake, "home"))).toBe(false);
  },
  15_000,
);

test.skipIf(!posix)(
  "a turn the handler dispatches starts in the checkout of the agent's own folder, never a folder nested in it",
  async () => {
    const root = tempDir("brain-codex-");
    dirs.push(root);
    const fake = path.join(root, "fake");
    const ws = path.join(root, "ws");
    const home = path.join(root, "home");
    for (const d of [fake, ws, home]) mkdirSync(d, { recursive: true });
    const bin = fakeCodex(fake);
    const folder = await agentWorkspace(ws, AGENT);
    // Where `prepareAgentCode` starts a turn: a checkout `git.sync` keeps in the agent's folder.
    mkdirSync(path.join(folder, "repos", "acme", "app"), { recursive: true });
    const req = {
      op: "brain.turn",
      runId: RUN,
      kind: "codex",
      session: { id: SESSION, resume: false },
      cwd: "repos/acme/app",
      system: "",
      prompt: "oi",
      mcp: { token: "tok" },
      agent: AGENT,
    } as MachineRequest;
    const ctx = {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      // Never the computer's own codex: the fake answers whatever the runner finds on the PATH.
      codex: { runnerHome: home, runs: new Map(), spawn: ((_, args, options) => spawn(bin, args, options)) as Spawn },
    };
    process.env.FAKE_DIR = fake;
    try {
      const reply = (await handleRequest(ctx, req, { signal: new AbortController().signal, output: () => {} })) as {
        final: CodexBrainEvent;
      };
      expect(reply.final.type === "error" ? reply.final.code : "done").not.toBe("not_found");
      expect(existsSync(path.join(folder, path.basename(folder)))).toBe(false);
    } finally {
      delete process.env.FAKE_DIR;
    }
  },
  15_000,
);
