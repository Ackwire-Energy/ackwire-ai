import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  MISSION_MCP_TOOLS,
  MISSION_PROTOCOL,
  MISSION_RULES_NO_GIT,
  PERMISSION_PROMPT_TOOL,
  parseRunnerFrame,
  parseServerFrame,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import {
  claudeMcpConfig,
  claudePermissionSettings,
  cleanRules,
  handleMcpMessage,
  ipcCall,
  McpBridge,
  type McpTaskInfo,
  missionExecutorArgs,
  missionFolderRules,
  runMcpServer,
} from "../../runner/mcp";
import { agentWorkspace } from "../../runner/paths";
import { TaskManager } from "../../runner/tasks";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const TASK = "0193aaaa-0000-7000-8000-000000000042";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };

test("protocol 5: mcp.call and mcp.result parse; oversized arguments are dropped", () => {
  expect(MISSION_PROTOCOL).toBe(5);
  expect(
    parseRunnerFrame(
      JSON.stringify({ type: "mcp.call", callId: "c1", taskId: TASK, tool: "report", args: { summary: "x" } }),
    ),
  ).toEqual({ type: "mcp.call", callId: "c1", taskId: TASK, tool: "report", args: { summary: "x" } });
  expect(
    parseRunnerFrame(
      JSON.stringify({ type: "mcp.call", callId: "c1", taskId: TASK, tool: "report", args: { s: "x".repeat(70_000) } }),
    ),
  ).toBeNull();
  expect(parseServerFrame(JSON.stringify({ type: "mcp.result", callId: "c1", ok: true, text: "done" }))).toMatchObject({
    type: "mcp.result",
    ok: true,
  });
  expect(parseServerFrame(JSON.stringify({ type: "mcp.result", ok: true }))).toBeNull();
});

test("MCP JSON-RPC: initialize, notifications, tools/list, tools/call and errors", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    return tool === "report" ? { ok: true as const, text: "Reported." } : { ok: false as const, error: "Nope" };
  };
  const init = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    call,
  );
  expect(init).toMatchObject({
    id: 1,
    result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "agentes" } },
  });
  expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, call)).toBeNull();
  const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, call)) as {
    result: { tools: { name: string }[] };
  };
  expect(list.result.tools.map((t) => t.name)).toEqual(MISSION_MCP_TOOLS.map((t) => t.name));
  expect(list.result.tools.map((t) => t.name)).toContain("update_plan");
  expect(
    await handleMcpMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report", arguments: { summary: "hi" } } },
      call,
    ),
  ).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "Reported." }], isError: false } });
  expect(
    await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_context" } }, call),
  ).toMatchObject({ result: { content: [{ text: "Nope" }], isError: true } });
  expect(calls).toEqual([
    ["report", { summary: "hi" }],
    ["get_context", {}],
  ]);
  expect(
    await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf" } }, call),
  ).toMatchObject({ error: { code: -32602 } });
  expect(await handleMcpMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" }, call)).toMatchObject({
    error: { code: -32601 },
  });
  expect(await handleMcpMessage({ id: 7, method: "ping" }, call)).toMatchObject({ error: { code: -32600 } });
  expect(await handleMcpMessage({ jsonrpc: "2.0", id: 8, method: "ping" }, call)).toEqual({
    jsonrpc: "2.0",
    id: 8,
    result: {},
  });
});

function bridge(task: McpTaskInfo | null, socketPath = "unused") {
  const frames: RunnerFrame[] = [];
  const b = new McpBridge({ socketPath, task: (id) => (id === TASK ? task : null), callTimeoutMs: 2000 });
  closers.push(() => b.close());
  return { b, frames };
}

test("the bridge checks the task's token, needs a connection, relays the call and its answer", async () => {
  const { b, frames } = bridge({ token: "secret-token-1", missionId: "m1", running: true });
  const req = { taskId: TASK, token: "secret-token-1", tool: "report", args: { summary: "hi" } };
  expect(await b.handle({ ...req, token: "wrong-token-00" })).toMatchObject({
    ok: false,
    error: expect.stringContaining("Not allowed"),
  });
  expect(await b.handle({ ...req, taskId: "0193aaaa-0000-7000-8000-000000000099" })).toMatchObject({ ok: false });
  expect(await b.handle({ ...req, tool: "rm_rf" })).toMatchObject({ ok: false, error: "Unknown tool rm_rf" });
  b.attach((f) => frames.push(f));
  const pending = b.handle(req);
  await waitFor(() => frames.length === 1);
  const sent = frames[0] as Extract<RunnerFrame, { type: "mcp.call" }>;
  expect(sent).toMatchObject({ type: "mcp.call", taskId: TASK, tool: "report", args: { summary: "hi" } });
  b.result({ type: "mcp.result", callId: sent.callId, ok: true, text: "Reported in the thread." });
  expect(await pending).toEqual({ ok: true, text: "Reported in the thread." });
  // A dropped connection fails the calls in flight.
  const second = b.handle(req);
  await waitFor(() => frames.length === 2);
  b.detach();
  expect(await second).toMatchObject({ ok: false });
});

test("while the connection is down (a runner restart, a reconnect) a call waits and is relayed after it comes back", async () => {
  const { b, frames } = bridge({ token: "secret-token-1", missionId: "m1", running: true });
  const req = { taskId: TASK, token: "secret-token-1", tool: "report", args: { summary: "hi" } };
  const early = b.handle(req);
  await new Promise((r) => setTimeout(r, 20));
  expect(frames).toHaveLength(0);
  b.attach((f) => frames.push(f));
  await waitFor(() => frames.length === 1);
  const sent = frames[0] as Extract<RunnerFrame, { type: "mcp.call" }>;
  b.result({ type: "mcp.result", callId: sent.callId, ok: true, text: "Reported in the thread." });
  expect(await early).toEqual({ ok: true, text: "Reported in the thread." });
  // A permission prompt in flight when the link drops is sent again on the next connection (never denied for it).
  const prompt = b.handle({ ...req, tool: "permission_prompt", args: { tool_name: "Bash", input: { command: "ls" } } });
  await waitFor(() => frames.length === 2);
  b.detach();
  const resent: RunnerFrame[] = [];
  b.attach((f) => resent.push(f));
  await waitFor(() => resent.length === 1);
  const again = resent[0] as Extract<RunnerFrame, { type: "mcp.call" }>;
  expect(again.tool).toBe("permission_prompt");
  b.result({ type: "mcp.result", callId: again.callId, ok: true, text: '{"behavior":"allow"}' });
  expect(await prompt).toEqual({ ok: true, text: '{"behavior":"allow"}' });
});

test("a call that waited out its timeout without a connection says so (transient)", async () => {
  const frames: RunnerFrame[] = [];
  const b = new McpBridge({
    socketPath: "unused",
    task: (id) => (id === TASK ? { token: "secret-token-1", missionId: "m1", running: true } : null),
    callTimeoutMs: 30,
  });
  closers.push(() => b.close());
  const out = await b.handle({ taskId: TASK, token: "secret-token-1", tool: "report", args: {} });
  expect(out).toMatchObject({ ok: false, transient: true, error: expect.stringContaining("not connected") });
  expect(frames).toHaveLength(0);
});

test("an ended task has no tools any more", async () => {
  const { b } = bridge({ token: "secret-token-1", missionId: "m1", running: false });
  b.attach(() => {});
  expect(await b.handle({ taskId: TASK, token: "secret-token-1", tool: "report", args: {} })).toEqual({
    ok: false,
    error: "This task has ended.",
  });
});

test.skipIf(!posix)("stdio MCP server → local socket → bridge → server, end to end (no executor)", async () => {
  const home = tempDir("mcp-");
  dirs.push(home);
  const socketPath = path.join(home, "mcp.sock");
  const { b, frames } = bridge({ token: "tok-123456789", missionId: "m1", running: true }, socketPath);
  await b.listen();
  b.attach((f) => {
    frames.push(f);
    if (f.type === "mcp.call")
      queueMicrotask(() => b.result({ type: "mcp.result", callId: f.callId, ok: true, text: `ran ${f.tool}` }));
  });
  expect(await ipcCall(socketPath, { taskId: TASK, token: "bad", tool: "report", args: {} })).toMatchObject({
    ok: false,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
  const server = runMcpServer({ taskId: TASK, socketPath, token: "tok-123456789", input, output });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write("not json\n");
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_plan", arguments: { items: [] } } })}\n`,
  );
  input.end();
  expect(await server).toBe(0);
  const parsed = lines.map(
    (l) => JSON.parse(l) as { id: unknown; result?: { content?: { text: string }[] }; error?: unknown },
  );
  expect(parsed.find((m) => m.id === 1)?.result).toMatchObject({ serverInfo: { name: "agentes" } });
  expect(parsed.find((m) => m.id === null)?.error).toMatchObject({ code: -32700 });
  expect(parsed.find((m) => m.id === 2)?.result?.content?.[0]?.text).toBe("ran update_plan");
  expect(frames.filter((f) => f.type === "mcp.call")).toHaveLength(1);
});

test("executor arguments: Claude Code gets our MCP config, our tools allowed and the rules; quoting is safe", () => {
  expect(cleanRules("Don't merge! Use `x` & 100% $HOME")).toBe("Don t merge Use x 100 HOME");
  const args = missionExecutorArgs(
    "claude",
    {
      configFile: "/tmp/a b/mcp.json",
      command: ["/usr/bin/node", "/opt/runner.mjs"],
      taskId: TASK,
      socketPath: "/s",
      rules: "Read .agentes/ first.",
    },
    "darwin",
  );
  expect(args).toEqual([
    "--mcp-config",
    "'/tmp/a b/mcp.json'",
    "--allowedTools",
    "mcp__agentes",
    "--append-system-prompt",
    "'Read .agentes/ first.'",
  ]);
  const win = missionExecutorArgs(
    "claude",
    {
      configFile: "C:\\Users\\A B\\mcp.json",
      command: ["node", "r.mjs"],
      taskId: TASK,
      socketPath: "\\\\.\\pipe\\x",
      rules: "Rules.",
    },
    "win32",
  );
  expect(win[1]).toBe('"C:\\Users\\A B\\mcp.json"');
  const codex = missionExecutorArgs(
    "codex",
    { configFile: "", command: ["/usr/bin/node", "/opt/runner.mjs"], taskId: TASK, socketPath: "/s", rules: "" },
    "linux",
  );
  expect(codex.join(" ")).toContain(
    `mcp_servers.agenteschat_agentes.args=["/opt/runner.mjs","mcp","--task","${TASK}"]`,
  );
  expect(
    claudeMcpConfig({ command: ["/usr/bin/node", "/opt/r.mjs"], taskId: TASK, socketPath: "/s", token: "t" }),
  ).toEqual({
    mcpServers: {
      agentes: {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/opt/r.mjs", "mcp", "--task", TASK],
        env: { AGENTES_MCP_TOKEN: "t", AGENTES_MCP_SOCKET: "/s" },
      },
    },
  });
});

test.skipIf(!posix)(
  "a mission task gets a token, an MCP config (mode 600) and the flags; other tasks don't",
  async () => {
    const ws = tempDir("ws-");
    const home = tempDir("home-");
    dirs.push(ws, home);
    const tasks = new TaskManager({
      root: path.join(home, "tasks"),
      workspaceReal: ws,
      agentFolder: (agent) => agentWorkspace(ws, agent),
      watchMs: 20,
      eventEveryMs: 0,
      claudeHome: path.join(home, "claude"),
      caffeinate: false,
      mcp: { socketPath: path.join(home, "mcp.sock"), command: [process.execPath, "/opt/agentes-runner.mjs"] },
    });
    closers.push(() => tasks.close());
    await tasks.init();
    const started = await tasks.start(AGENT, {
      taskId: TASK,
      executor: "claude",
      prompt: "Plan it",
      session: "0193aaaa-0000-7000-8000-0000000000aa",
      mission: { id: "0193aaaa-0000-7000-8000-0000000000bb", rules: "Read .agentes/ first." },
    });
    expect(started.command).toContain("--mcp-config");
    expect(started.command).toContain("--allowedTools mcp__agentes");
    // The workspace isn't a git repository: the rules for a folder without git replace the given ones.
    expect(started.command).toContain(`--append-system-prompt '${cleanRules(MISSION_RULES_NO_GIT)}'`);
    expect(started.command).not.toContain("Read .agentes/ first.");
    const info = tasks.mcpTask(TASK);
    expect(info).toMatchObject({ missionId: "0193aaaa-0000-7000-8000-0000000000bb", running: true });
    const config = JSON.parse(readFileSync(path.join(home, "tasks", TASK, "mcp.json"), "utf8"));
    expect(config.mcpServers.agentes.env.AGENTES_MCP_TOKEN).toBe(info?.token);
    expect(config.mcpServers.agentes.args).toEqual(["/opt/agentes-runner.mjs", "mcp", "--task", TASK]);
    // Where it runs, so plain reads there need no card.
    const cwd = config.mcpServers.agentes.env.AGENTES_MCP_CWD as string;
    expect(path.isAbsolute(cwd)).toBe(true);
    expect(String(config.mcpServers.agentes.env.AGENTES_MCP_FOLDERS).split(path.delimiter)).toContain(cwd);
    expect(existsSync(path.join(home, "tasks", TASK, "mcp-token"))).toBe(true);
    // The token never leaves the machine (not in the journal's view sent to the server).
    expect(JSON.stringify(tasks.list())).not.toContain(info?.token ?? "none");
    const plain = "0193aaaa-0000-7000-8000-000000000043";
    const other = await tasks.start(AGENT, { taskId: plain, executor: "shell", command: "true" });
    expect(other.command).toBe("true");
    expect(tasks.mcpTask(plain)).toBeNull();
  },
);

test("the permission prompt tool Claude Code is told to use is one our server advertises (work turns), under the server name of the MCP config", async () => {
  const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, async () => ({
    ok: true as const,
    text: "",
  }))) as { result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] } };
  const names = list.result.tools.map((t) => t.name);
  expect(names).toContain("permission_prompt");
  expect(names).toContain("complete_mission");
  const prompt = list.result.tools.find((t) => t.name === "permission_prompt");
  expect(Object.keys(prompt?.inputSchema.properties ?? {})).toEqual(
    expect.arrayContaining(["tool_name", "input", "tool_use_id"]),
  );
  const args = missionExecutorArgs(
    "claude",
    {
      configFile: "/c/mcp.json",
      command: ["node", "r.mjs"],
      taskId: TASK,
      socketPath: "/s",
      rules: "",
      promptTool: true,
    },
    "darwin",
  );
  const given = args[args.indexOf("--permission-prompt-tool") + 1] ?? "";
  expect(given).toBe(PERMISSION_PROMPT_TOOL);
  const config = claudeMcpConfig({ command: ["node", "r.mjs"], taskId: TASK, socketPath: "/s", token: "t" }) as {
    mcpServers: Record<string, unknown>;
  };
  const [server] = Object.keys(config.mcpServers);
  expect(given).toBe(`mcp__${server}__permission_prompt`);
  expect(names.map((n) => `mcp__${server}__${n}`)).toContain(given);
  // Plan turns don't get the prompt tool (only reads there).
  const plan = missionExecutorArgs(
    "claude",
    { configFile: "/c/mcp.json", command: ["node", "r.mjs"], taskId: TASK, socketPath: "/s", rules: "" },
    "darwin",
  );
  expect(plan).not.toContain("--permission-prompt-tool");
});

test("an item away from the mission folder may use it (--add-dir, Read/Edit/Write there only); the main session needs nothing", () => {
  const folder = "/Users/ana/agentes/app";
  expect(missionFolderRules(folder, ["Read", "Edit", "Write"])).toEqual([
    "Read(//Users/ana/agentes/app/**)",
    "Edit(//Users/ana/agentes/app/**)",
    "Write(//Users/ana/agentes/app/**)",
  ]);
  // Never a relative, wildcard or parent path.
  expect(missionFolderRules("app", ["Read"])).toEqual([]);
  expect(missionFolderRules("/Users/*", ["Read"])).toEqual([]);
  expect(missionFolderRules("/Users/ana/../bob", ["Read"])).toEqual([]);
  const work = claudePermissionSettings("work", "agentes/abcd1234/", [], folder);
  expect(work.permissions.allow).toContain("Edit(//Users/ana/agentes/app/**)");
  // Nothing broader: no bare Edit/Write, and the deny list stays.
  expect(work.permissions.allow).not.toContain("Edit");
  expect(work.permissions.allow).not.toContain("Write");
  expect(work.permissions.deny.length).toBeGreaterThan(0);
  const plan = claudePermissionSettings("plan", "agentes/abcd1234/", [], folder);
  expect(plan.permissions.allow).toContain("Read(//Users/ana/agentes/app/**)");
  expect(plan.permissions.allow.some((r) => r.startsWith("Edit("))).toBe(false);
  expect(claudePermissionSettings("work", "agentes/abcd1234/").permissions.allow.some((r) => r.includes("//"))).toBe(
    false,
  );
  const args = missionExecutorArgs(
    "claude",
    {
      configFile: "/tmp/mcp.json",
      command: ["agentes-runner"],
      taskId: TASK,
      socketPath: "/tmp/mcp.sock",
      rules: "",
      promptTool: true,
      addDirs: [folder],
    },
    "darwin",
  );
  expect(args.join(" ")).toContain(`--add-dir ${folder}`);
  expect(
    missionExecutorArgs(
      "claude",
      { configFile: "/tmp/mcp.json", command: ["x"], taskId: TASK, socketPath: "/tmp/s", rules: "" },
      "darwin",
    ),
  ).not.toContain("--add-dir");
});
