// A fake `claude` for brain tests: speaks stream-json in and out like
// `claude -p --input-format stream-json --output-format stream-json`.
// Each start appends its argv and $CLAUDE_CONFIG_DIR to $FAKE_CLAUDE_LOG (one JSON line).
// Prompts drive it: "CRASH" exits mid-turn once (marker file in the log's
// folder), "SLOW" answers after 300 ms, "TOOL" calls one of our tools and one
// of its own, "LIMIT" hits the plan limit, "AUTH" fails to authenticate;
// "STEER…" and "BGSELF" below (live steering, background tasks).
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? null;
  appendFileSync(log, `${JSON.stringify({ pid: process.pid, args, configDir })}\n`);
}
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
// $FAKE_CLAUDE_VERSION: the version its init line says (logs only).
const version = process.env.FAKE_CLAUDE_VERSION;
// $FAKE_CLAUDE_CAPS: its init `capabilities`, comma-separated (unset: none, an old CLI that can't be steered).
// With msg_lifecycle_v1 each line with a `uuid` says `command_lifecycle` queued → started (read) → completed.
const caps = process.env.FAKE_CLAUDE_CAPS ? process.env.FAKE_CLAUDE_CAPS.split(",") : null;
const lifecycle = caps?.includes("msg_lifecycle_v1") === true;
// $FAKE_CLAUDE_NO_RESULT_UUIDS: results never list what they read (only the lifecycle says it).
const resultUuids = !process.env.FAKE_CLAUDE_NO_RESULT_UUIDS;
const lifecycleOf = (uuid, state) => {
  if (lifecycle && uuid) out({ type: "command_lifecycle", command_uuid: uuid, state });
};
// Claude Code says `init` as each turn starts.
const init = () =>
  out({
    type: "system",
    subtype: "init",
    model: flag("--model") ?? "claude-sonnet",
    ...(version ? { claude_code_version: version } : {}),
    ...(caps ? { capabilities: caps } : {}),
  });
init();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turns = 0;
// Lines wait here: a turn may read the ones sent while it runs ("STEER"), the rest start the next turns.
const queue = [];
let wake = null;
let closed = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  queue.push(line);
  try {
    lifecycleOf(JSON.parse(line).uuid, "queued");
  } catch {}
  wake?.();
});
rl.on("close", () => {
  closed = true;
  wake?.();
});
const waitForLine = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  }).finally(() => {
    wake = null;
  });
(async () => {
  for (;;) {
    const line = queue.shift();
    if (line !== undefined) await answer(line);
    else if (closed) process.exit(0);
    else await waitForLine(60_000);
  }
})();

async function answer(line) {
  const msg = JSON.parse(line);
  const prompt = String(msg.message?.content ?? "");
  const read = msg.uuid ? [msg.uuid] : [];
  lifecycleOf(msg.uuid, "started");
  if (turns > 0) init();
  let steered = "";
  let moved = false;
  turns++;
  // "STEER": a tool runs, then the messages sent meanwhile are read at its boundary (same turn).
  // "STEERLATE": the turn ends before reading them (they start the next turn).
  // "STEERDROP": they vanish unread and nothing waits (a CLI that lost them).
  // "STEERBG": the tool runs as task bg1; a "now" message moves it to the background and is read at once;
  // after the result the task ends and the CLI runs a turn of its own ("background finished").
  // "STEERBGHANG": the moved task never ends.
  if (prompt.includes("STEER")) {
    const bg = prompt.includes("STEERBG");
    if (bg) {
      out({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: { command: "make" } }] },
        parent_tool_use_id: null,
      });
      out({ type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "s1", is_backgrounded: false });
    }
    if (queue.length === 0) await waitForLine(3000);
    if (prompt.includes("STEERDROP")) queue.length = 0;
    else if (!prompt.includes("STEERLATE")) {
      moved = bg && queue.some((l) => JSON.parse(l).priority === "now");
      if (!bg) {
        out({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: { command: "make" } }] },
          parent_tool_use_id: null,
        });
      }
      if (moved) out({ type: "system", subtype: "task_updated", task_id: "bg1", patch: { is_backgrounded: true } });
      out({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "s1", content: moved ? "moved to the background" : "built" }],
        },
        parent_tool_use_id: null,
      });
      while (queue.length) {
        const m = JSON.parse(queue.shift());
        if (m.uuid) read.push(m.uuid);
        lifecycleOf(m.uuid, "started");
        steered += ` +${m.priority ?? "-"}/${m.origin?.kind ?? "-"}: ${m.message?.content ?? ""}`;
      }
      // Read before the turn ends (the lifecycle says so first).
      await sleep(50);
    }
  }
  // "BGSELF": the model starts a task in the background itself; it ends after the turn, and the CLI
  // runs a turn of its own then, nobody asking ("stray").
  if (prompt.includes("BGSELF")) {
    out({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "serve" } }] },
      parent_tool_use_id: null,
    });
    out({ type: "system", subtype: "task_started", task_id: "self1", tool_use_id: "b1", is_backgrounded: true });
    out({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "running in the background" }] },
      parent_tool_use_id: null,
    });
  }
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
    result: `echo ${turns}: ${prompt}${steered}`,
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 7 },
    modelUsage: { [flag("--model") ?? "claude-sonnet"]: { inputTokens: 10, outputTokens: 7 } },
    ...(read.length && resultUuids ? { user_message_uuid: read.at(-1), user_message_uuids: read } : {}),
    ...(version ? { queued_turn_count: queue.length } : {}),
  });
  for (const uuid of read) lifecycleOf(uuid, "completed");
  if (moved && prompt.includes("STEERBGHANG")) await sleep(60_000);
  else if (moved) await turnOfItsOwn("bg1", "background finished");
  if (prompt.includes("BGSELF")) await turnOfItsOwn("self1", "stray", 1500);
}

/** A background task ends: its notice starts a turn nobody sent (it answers `text`, `ms` later). */
async function turnOfItsOwn(taskId, text, ms = 0) {
  await sleep(100);
  out({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "completed" } });
  out({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed" });
  init();
  out({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
  });
  out({ type: "assistant", message: { content: [{ type: "text", text }] }, parent_tool_use_id: null });
  await sleep(ms);
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage: { input_tokens: 3, output_tokens: 2 },
    ...(version ? { queued_turn_count: queue.length } : {}),
  });
}
