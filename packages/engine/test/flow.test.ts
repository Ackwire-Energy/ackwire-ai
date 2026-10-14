import { afterEach, expect, test } from "bun:test";
import type { RealtimeEvent } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import { ProviderError, systemText } from "@agenteschat/providers";
import { createAgent, drainOutbox, listMessages, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body, threadId });

test("vertical slice: @mention → outbox → run → streamed reply → persisted message + usage", async () => {
  f = await setup({
    reply: () => ({ chunks: ["Sure, ", "I'll check ", "the build."], usage: { inputTokens: 500, outputTokens: 30 } }),
  });
  const events: RealtimeEvent[] = f.listen(f.general.id);

  // 1. A person posts a message mentioning the agent. Message and outbox event are one transaction.
  const question = await post(f, "@dev can you look at the failing build?");
  expect((await f.db.select().from(schema.outbox)).map((j) => [j.kind, j.status])).toEqual([
    ["message.posted", "pending"],
  ]);

  // 2–7. Workers claim the event, create the run, build context, call the gateway, stream, persist.
  await drainOutbox(f.db, f.handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run).toMatchObject({
    status: "done",
    agentId: f.agent.id,
    triggerMessageId: question.id,
    threadRootId: question.id,
    hop: 1,
  });

  // The model saw org context, agent instructions and the conversation.
  const request = f.provider.calls[0]?.request;
  expect(systemText(request?.system ?? "")).toContain("Acme builds rockets.");
  expect(systemText(request?.system ?? "")).toContain("Answer briefly.");
  expect(request?.messages.at(-1)).toEqual({ role: "user", content: "[ana]: @dev can you look at the failing build?" });

  // Deltas went out through PubSub to channel subscribers, in order, then the final message.
  expect(events.map((e) => e.type)).toEqual([
    "message.created",
    "agent.run",
    "agent.delta",
    "agent.delta",
    "agent.delta",
    "message.created",
    "agent.run",
  ]);
  const deltas = events.filter((e) => e.type === "agent.delta");
  expect(deltas.map((e) => e.text).join("")).toBe("Sure, I'll check the build.");
  expect(deltas.map((e) => e.seq)).toEqual([0, 1, 2]);
  expect(events.at(-1)).toMatchObject({ type: "agent.run", status: "done", runId: run?.id });

  // The reply is persisted in the thread of the question, authored by the agent.
  const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
  expect(thread.map((m) => [m.author.type, m.body])).toEqual([
    ["person", "@dev can you look at the failing build?"],
    ["agent", "Sure, I'll check the build."],
  ]);
  expect(thread[1]?.agentRunId).toBe(run?.id ?? "");
  expect(run?.replyMessageId).toBe(thread[1]?.id ?? "");

  // Usage is recorded with org and agent, linked to the run.
  const usage = await f.db.select().from(schema.usageRecords);
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run?.id,
    inputTokens: 500,
    outputTokens: 30,
  });

  // Steps trail, and every outbox row is done.
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""))
    .orderBy(asc(schema.agentRunSteps.seq));
  expect(steps.map((s) => s.kind)).toEqual(["context", "model_call", "message"]);
  expect((await f.db.select().from(schema.outbox)).every((j) => j.status === "done")).toBe(true);
});

test("agents mentioning each other stop at the per-thread hop limit", async () => {
  f = await setup({
    reply: (req) => ({ chunks: [systemText(req.system).includes("@dev)") ? "@qa over to you" : "@dev back to you"] }),
  });
  const qa = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "QA", handle: "qa", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });

  const root = await post(f, "@dev start the ping-pong");
  await drainOutbox(f.db, f.handlers);

  const replies = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: root.id })).slice(1);
  expect(replies.map((m) => m.body)).toEqual(["@qa over to you", "@dev back to you", "@qa over to you"]); // maxHops = 3
  expect(f.provider.calls).toHaveLength(3);
  const runs = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.hop));
  expect(runs.map((r) => [r.hop, r.status])).toEqual([
    [1, "done"],
    [2, "done"],
    [3, "done"],
  ]);

  // A person posting in the thread resets the counter.
  await post(f, "@dev one more", root.id);
  await drainOutbox(f.db, f.handlers);
  expect(f.provider.calls.length).toBeGreaterThan(3);
});

test("transient provider failures retry the job; the run completes on a later attempt", async () => {
  f = await setup({ reply: (_req, n) => (n === 1 ? new ProviderError("overloaded", true, 529) : { chunks: ["ok"] }) });
  await post(f, "@dev hi");
  await drainOutbox(f.db, f.handlers);
  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("running"); // waiting for the retry's backoff

  const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  expect([job?.status, job?.attempts]).toEqual(["pending", 1]);
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await drainOutbox(f.db, f.handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(1);
});

test("an agent over budget fails the run without calling the model", async () => {
  f = await setup({ budgetNanoUsd: 0 });
  const events = f.listen(f.general.id);
  await post(f, "@dev hi");
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect([run?.status, run?.error]).toEqual(["failed", "budget_exceeded"]);
  expect(f.provider.calls).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: "agent.run", status: "failed", error: "budget_exceeded" });
  // The job itself succeeded: a failed run is a handled outcome, not a retry.
  expect((await f.db.select().from(schema.outbox)).every((j) => j.status === "done")).toBe(true);
});

test("a model refusal fails the run but still records usage", async () => {
  f = await setup({
    reply: () => ({ chunks: [], stopReason: "refusal", usage: { inputTokens: 10, outputTokens: 0 } }),
  });
  await post(f, "@dev hi");
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect([run?.status, run?.error]).toEqual(["failed", "model_refused"]);
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(1);
});
