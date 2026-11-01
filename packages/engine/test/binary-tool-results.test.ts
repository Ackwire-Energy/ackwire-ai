import { afterEach, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { drainOutbox, grantScopes, postPersonMessage, type ToolDefinition, type ToolOutput } from "../src";
import { pgSafeText } from "../src/format";
import { addRunStep } from "../src/runs";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

/** A run in #general whose model calls `dump_file` once (it returns `output`), then answers. */
async function runWithTool(output: ToolOutput) {
  let turn = 0;
  const dump: ToolDefinition = {
    name: "dump_file",
    description: "Dumps a file.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    scope: "issues:read",
    execute: async () => output,
  };
  f = await setup({
    toolSources: [{ name: "dump", tools: async () => [dump] }],
    reply: () =>
      ++turn === 1 ? { chunks: [], toolUses: [{ name: "dump_file", input: {} }] } : { chunks: ["Pronto."] },
  });
  const fx = f;
  await grantScopes(fx.db, fx.org.id, fx.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "@dev mostra o arquivo",
  });
  await drainOutbox(fx.db, fx.handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, fx.agent.id));
  if (!run) throw new Error("no run");
  const steps = await fx.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run.id))
    .orderBy(asc(schema.agentRunSteps.seq));
  const jobs = await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  return { fx, run, steps, jobs };
}

test("Postgres-safe text: NUL and lone surrogates go, pairs (emoji) stay", () => {
  expect(pgSafeText("a\u0000b\ud800c\udc00d🐝")).toBe("abcd🐝");
});

test("a step holding NUL and lone surrogates is saved without them", async () => {
  const { fx, run } = await runWithTool({ content: "ok" });
  await addRunStep(fx.db, run, "tool_result", { content: "JFIF\u0000\u0010x\ud800y", nested: [{ raw: "a\u0000b" }] });
  const [last] = await fx.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run.id))
    .orderBy(asc(schema.agentRunSteps.seq))
    .then((rows) => rows.slice(-1));
  expect(last?.data).toEqual({ content: "JFIF\u0010xy", nested: [{ raw: "ab" }] });
});

test("a tool result with NUL bytes (a binary printed as text) is saved, the model gets it clean, and the run answers", async () => {
  const { fx, run, steps } = await runWithTool({
    content: "shot.jpg (9 bytes):\nÿØ\u0000\u0010JFIF\u0000\ud800",
    data: { raw: "a\u0000b" },
  });
  expect(run.status).toBe("done");
  const result = steps.find((s) => s.kind === "tool_result");
  expect(result?.data.content).toBe("shot.jpg (9 bytes):\nÿØ\u0010JFIF");
  expect(result?.data.data).toEqual({ raw: "ab" });
  expect(JSON.stringify(fx.provider.calls[1]?.request.messages)).not.toContain("\\u0000");
});

test("a value the database refuses fails the run once and says so, not retried into a 'server restart'", async () => {
  // Keys aren't cleaned (only strings are): a NUL in one still makes the step's insert fail.
  const { run, jobs } = await runWithTool({ content: "ok", data: { "a\u0000": 1 } });
  expect(run.status).toBe("failed");
  expect(run.error).toStartWith("Stopped after an error: ");
  expect(run.error).not.toContain("restart");
  expect(jobs.map((j) => ({ status: j.status, attempts: j.attempts }))).toEqual([{ status: "done", attempts: 1 }]);
});
