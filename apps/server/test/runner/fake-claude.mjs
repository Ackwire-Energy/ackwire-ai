// A fake `claude` for brain tests: speaks stream-json in and out like
// `claude -p --input-format stream-json --output-format stream-json`.
// Each start appends its argv to $FAKE_CLAUDE_LOG (one JSON line).
// Prompts drive it: "CRASH" exits mid-turn once (marker file in the log's
// folder), "SLOW" answers after 300 ms, "TOOL" calls one of our tools and one
// of its own, "LIMIT" hits the plan limit, "AUTH" fails to authenticate.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, args })}\n`);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const session = flag("--resume") ?? flag("--session-id") ?? "none";
if (flag("--resume") && process.env.FAKE_CLAUDE_NO_SESSION) {
  process.stderr.write(`No conversation found with session ID: ${session}\n`);
  process.exit(1);
}
const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: session })}\n`);
out({ type: "system", subtype: "init", model: flag("--model") ?? "claude-sonnet" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turns = 0;
let chain = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  chain = chain.then(() => answer(line));
});
rl.on("close", () => {
  chain.then(() => process.exit(0));
});

async function answer(line) {
  const msg = JSON.parse(line);
  const prompt = String(msg.message?.content ?? "");
  turns++;
  const marker = log ? path.join(path.dirname(log), "crashed") : "";
  if (prompt.includes("CRASH") && marker && !existsSync(marker)) {
    writeFileSync(marker, "");
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } },
      parent_tool_use_id: null,
    });
    await sleep(20);
    process.exit(3);
  }
  if (prompt.includes("SLOW")) await sleep(300);
  if (prompt.includes("LIMIT")) {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1900000000 } });
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your limit",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return;
  }
  if (prompt.includes("AUTH")) {
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return;
  }
  for (const text of ["Hello ", "world"]) {
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
    });
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] }, parent_tool_use_id: null });
  if (prompt.includes("TOOL")) {
    out({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "mcp__agentes__search_context", input: { query: "x" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      },
      parent_tool_use_id: null,
    });
    out({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "found it" }] },
          { type: "tool_result", tool_use_id: "t2", content: "a.txt" },
        ],
      },
      parent_tool_use_id: null,
    });
  }
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `echo ${turns}: ${prompt}`,
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 7 },
    modelUsage: { [flag("--model") ?? "claude-sonnet"]: { inputTokens: 10, outputTokens: 7 } },
  });
}
