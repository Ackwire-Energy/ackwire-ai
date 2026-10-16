import { expect, test } from "bun:test";
import {
  allowedBy,
  PERMISSION_PROMPT_TOOL,
  PERMISSION_TIMEOUT_MESSAGE,
  parseRunnerFrame,
  ruleMatches,
  rulesFor,
} from "@agenteschat/adapters/machine-protocol";
import {
  claudePermissionSettings,
  DENY_RULES,
  handleMcpMessage,
  type IpcReply,
  missionExecutorArgs,
  permissionPrompt,
} from "../../runner/mcp";
import { claudeDenials, parseOutputLine } from "../../runner/tasks";

const TASK = "0193aaaa-0000-7000-8000-000000000001";
const bash = (command: string) => ({ tool_name: "Bash", input: { command } });

/** A fake server: answers each `permission_prompt` call with the next reply. */
function server(replies: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  const call = async (_tool: string, args: Record<string, unknown>): Promise<IpcReply> => {
    calls.push(args);
    const next = replies.shift();
    return next instanceof Error ? { ok: false, error: next.message } : { ok: true, text: JSON.stringify(next) };
  };
  return { calls, call };
}

const instant = { sleep: async () => {}, pollMs: 1 };

test("rules: deny matches any part of a command, allow needs every part; Aprovar sempre keeps the first word or two", () => {
  expect(ruleMatches("Bash(git merge *)", "Bash", { command: "git status && git merge main" })).toBe(true);
  expect(DENY_RULES.some((r) => ruleMatches(r, "Bash", { command: "git -C /w push origin main" }))).toBe(true);
  expect(DENY_RULES.some((r) => ruleMatches(r, "Bash", { command: "git push origin agentes/x/nav" }))).toBe(false);
  expect(allowedBy(["Bash(swift *)"], "Bash", { command: "swift build" })).toBe(true);
  expect(allowedBy(["Bash(swift *)"], "Bash", { command: "swift build && rm -rf out" })).toBe(false);
  expect(allowedBy(["Bash(ls *)"], "Bash", { command: "ls" })).toBe(true);
  expect(allowedBy(["WebFetch(domain:example.com)"], "WebFetch", { url: "https://example.com/a" })).toBe(true);
  expect(rulesFor("Bash", { command: "swift build -c release" })).toEqual(["Bash(swift build *)"]);
  expect(rulesFor("Bash", { command: "sips -Z 800 a.png | head -3" })).toEqual(["Bash(sips *)", "Bash(head *)"]);
  expect(rulesFor("Bash", { command: "git init" })).toEqual(["Bash(git init *)"]);
  expect(rulesFor("WebFetch", { url: "https://docs.example.com/x" })).toEqual(["WebFetch(domain:docs.example.com)"]);
});

test("the prompt tool: a deny-list command is refused at once, never asked", async () => {
  const s = server([]);
  const out = await permissionPrompt(bash("git push origin main"), s.call, instant);
  expect(out.behavior).toBe("deny");
  expect(s.calls).toHaveLength(0);
});

test("the prompt tool: pending, then allowed (the input comes back as is)", async () => {
  const s = server([
    { status: "pending", request_id: "r1" },
    { status: "pending", request_id: "r1" },
    { behavior: "allow" },
  ]);
  const out = await permissionPrompt(bash("swift build"), s.call, instant);
  expect(out).toEqual({ behavior: "allow", updatedInput: { command: "swift build" } });
  expect(s.calls[0]).toMatchObject({ tool_name: "Bash", input: { command: "swift build" } });
  expect(s.calls.slice(1)).toEqual([{ request_id: "r1" }, { request_id: "r1" }]);
});

test("the prompt tool: a person says no; nobody answers in time; the server is unreachable", async () => {
  const no = server([
    { status: "pending", request_id: "r1" },
    { behavior: "deny", message: "A person said no." },
  ]);
  expect(await permissionPrompt(bash("brew install x"), no.call, instant)).toEqual({
    behavior: "deny",
    message: "A person said no.",
  });
  let now = 0;
  const slow = server(Array.from({ length: 50 }, () => ({ status: "pending", request_id: "r2" })));
  const timedOut = await permissionPrompt(bash("brew install y"), slow.call, {
    waitMs: 10_000,
    pollMs: 4000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  expect(timedOut).toEqual({ behavior: "deny", message: PERMISSION_TIMEOUT_MESSAGE });
  expect(slow.calls.length).toBe(4);
  const down = server([new Error("The computer is not connected")]);
  expect((await permissionPrompt(bash("brew install z"), down.call, instant)).behavior).toBe("deny");
});

test("over MCP: permission_prompt always answers JSON text Claude Code understands", async () => {
  const s = server([{ behavior: "allow" }]);
  const res = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "permission_prompt", arguments: bash("swift build") },
    },
    s.call,
  )) as { result: { content: { text: string }[]; isError?: boolean } };
  expect(res.result.isError).toBeUndefined();
  expect(JSON.parse(res.result.content[0]?.text ?? "")).toEqual({
    behavior: "allow",
    updatedInput: { command: "swift build" },
  });
});

test("work turns: the prompt tool flag and the mission's allowed commands in the settings (deny list kept)", () => {
  const args = missionExecutorArgs(
    "claude",
    { configFile: "/m.json", command: ["node"], taskId: TASK, socketPath: "/s", rules: "", promptTool: true },
    "linux",
  );
  expect(args.join(" ")).toContain(`--permission-prompt-tool ${PERMISSION_PROMPT_TOOL}`);
  const plain = missionExecutorArgs(
    "claude",
    { configFile: "/m.json", command: ["node"], taskId: TASK, socketPath: "/s", rules: "" },
    "linux",
  );
  expect(plain.join(" ")).not.toContain("--permission-prompt-tool");
  const work = claudePermissionSettings("work", "agentes/x/", ["Bash(swift *)", "Bash", "Bash(a) && rm"]).permissions;
  expect(work.allow).toContain("Bash(swift *)");
  expect(work.allow).not.toContain("Bash");
  expect(work.deny).toContain("Bash(git merge *)");
  const plan = claudePermissionSettings("plan", "agentes/x/", ["Bash(swift *)"]).permissions;
  expect(plan.allow).not.toContain("Bash(swift *)");
});

test("refused commands: Claude Code's permission_denials and Codex's declined commands; task.done carries them", () => {
  expect(
    claudeDenials([
      { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "git init /w" } },
      { tool_name: "mcp__agentes__report", tool_input: {} },
      { tool_name: "WebFetch", tool_input: { url: "https://x.dev" } },
    ]),
  ).toEqual([
    { tool: "Bash", command: "git init /w" },
    { tool: "WebFetch", command: "WebFetch https://x.dev" },
  ]);
  const result = parseOutputLine(
    JSON.stringify({
      type: "result",
      result: "Blocked",
      session_id: "s",
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "ls ~/.claude/skills" } }],
    }),
    "claude",
    "/w",
  );
  expect(result.denials).toEqual([{ tool: "Bash", command: "ls ~/.claude/skills" }]);
  const codex = parseOutputLine(
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "bash -lc 'swift build'", status: "declined" },
    }),
    "codex",
    "/w",
  );
  expect(codex.denials).toEqual([{ tool: "Bash", command: "swift build" }]);
  const frame = parseRunnerFrame(
    JSON.stringify({
      type: "task.done",
      taskId: TASK,
      exitCode: 0,
      seconds: 3,
      denials: [{ tool: "Bash", command: "swift build" }, { tool: "Bash", command: "swift build" }, { nope: 1 }],
    }),
  );
  expect(frame).toMatchObject({ type: "task.done", denials: [{ tool: "Bash", command: "swift build" }] });
});
