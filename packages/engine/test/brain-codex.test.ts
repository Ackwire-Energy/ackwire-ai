import { expect, test } from "bun:test";
import { type BrainTurnRequest, CodexBrain, type ComputerBrainLink, codexVersionOk } from "../src/brains/codex";
import { computerPrompt } from "../src/brains/prompt";
import type { BrainEvent, BrainTurn } from "../src/brains/types";

const SESSION = "0193aaaa-0000-7000-8000-00000000c0de";

function turn(over: Partial<BrainTurn> = {}): BrainTurn {
  return {
    runId: "0193aaaa-0000-7000-8000-000000000001",
    orgId: "org",
    agentId: "agent",
    channelId: "channel",
    threadRootId: null,
    system: "You are Dev.",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "run the tests" },
    ],
    tools: [],
    trigger: "run the tests",
    session: { id: SESSION, resume: false, machineId: "m1", cwd: "app" },
    ...over,
  };
}

function link(opts: {
  version?: string | null;
  online?: boolean;
  events?: BrainEvent[];
  fail?: Error;
}): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: opts.online ?? true,
        execAllowed: true,
        executors: opts.version === null ? {} : { codex: { version: opts.version ?? "codex-cli 0.163.0" } },
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
      if (opts.fail) throw opts.fail;
    },
  };
}

const io = () => ({
  signal: new AbortController().signal,
  executeTool: async () => {
    throw new Error("computer brains don't execute tools in the engine");
  },
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("version gate: 0.163.0 and newer only", () => {
  expect(codexVersionOk("codex-cli 0.163.0")).toBe(true);
  expect(codexVersionOk("codex-cli 0.164.2")).toBe(true);
  expect(codexVersionOk("codex-cli 1.0.0")).toBe(true);
  expect(codexVersionOk("codex-cli 0.162.9")).toBe(false);
  expect(codexVersionOk("codex")).toBe(false);
  expect(codexVersionOk(undefined)).toBe(false);
});

test("a first turn sends the context and the conversation; events pass through; done carries our session", async () => {
  const l = link({
    events: [
      { type: "tool_call", id: "i1", name: "shell", input: { command: "npm test" }, executed: { content: "ok" } },
      { type: "usage", input: 100, output: 5, source: "plan" },
      { type: "text_delta", text: "Tests pass." },
      { type: "done", text: "Tests pass.", session: { id: "whatever" } },
    ],
  });
  const brain = new CodexBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    agent: async () => ({ id: "agent", handle: "dev" }),
  });
  expect(brain.kind).toBe("codex");
  const events = await collect(brain.run(turn({ model: "gpt-5.5" }), io()));
  expect(events.map((e) => e.type)).toEqual(["tool_call", "usage", "text_delta", "done"]);
  expect(events[3]).toEqual({ type: "done", text: "Tests pass.", session: { id: SESSION } });
  expect(l.sent[0]).toMatchObject({
    kind: "codex",
    session: { id: SESSION, resume: false },
    cwd: "app",
    model: "gpt-5.5",
    system: "You are Dev.",
    mcp: { token: "tok" },
    agent: { id: "agent", handle: "dev" },
  });
  expect(l.sent[0]?.prompt).toBe(
    "The conversation so far:\n\nUser: hi\n\nYou: hello\n\nNow answer this:\n\nrun the tests",
  );
});

test("a resumed turn sends only what came after the brain's last reply", () => {
  const t = turn({
    session: { id: SESSION, resume: true, machineId: "m1", cwd: "" },
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "also check lint" },
      { role: "user", content: "run the tests" },
    ],
  });
  expect(computerPrompt(t)).toBe(
    "New messages since your last reply:\n\nUser: also check lint\n\nNow answer this:\n\nrun the tests",
  );
  expect(computerPrompt({ ...t, messages: t.messages.filter((m) => m.content !== "also check lint") })).toBe(
    "run the tests",
  );
});

test("refuses before sending: offline, no Codex, Codex too old, no session", async () => {
  const run = async (l: ComputerBrainLink, t = turn()) =>
    collect(new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) }).run(t, io()));
  const offline = link({ online: false });
  expect(await run(offline)).toMatchObject([{ type: "error", code: "machine_offline", retryable: true }]);
  expect(await run(link({ version: null }))).toMatchObject([{ type: "error", code: "codex_missing" }]);
  const old = link({ version: "codex-cli 0.162.0" });
  const refused = await run(old);
  expect(refused).toMatchObject([{ type: "error", code: "codex_too_old" }]);
  expect((refused[0] as { message: string }).message).toContain("0.163.0");
  expect(old.sent).toHaveLength(0);
  expect(await run(link({}), turn({ session: undefined }))).toMatchObject([{ type: "error", code: "no_session" }]);
});

test("the turn always ends once: a runner failure is an error, a silent end is done with the streamed text", async () => {
  const brain = (l: ComputerBrainLink) => new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) });
  const failed = await collect(brain(link({ fail: new Error("socket closed") })).run(turn(), io()));
  expect(failed).toMatchObject([{ type: "error", code: "runner_failed", message: "socket closed" }]);
  const silent = await collect(brain(link({ events: [{ type: "text_delta", text: "Hi" }] })).run(turn(), io()));
  expect(silent.at(-1)).toEqual({ type: "done", text: "Hi", session: { id: SESSION } });
  const errored = await collect(
    brain(
      link({
        events: [
          { type: "limit" },
          { type: "error", code: "plan_limit", message: "You’ve hit your usage limit." },
          { type: "done", text: "ignored" },
        ],
      }),
    ).run(turn(), io()),
  );
  expect(errored.map((e) => e.type)).toEqual(["limit", "error"]);
});
