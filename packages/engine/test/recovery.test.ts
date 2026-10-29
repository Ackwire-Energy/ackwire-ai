import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  activeRunsIn,
  addRunStep,
  claimJobs,
  decideApproval,
  drainLocalRuns,
  drainOutbox,
  INTERRUPTED_BY_RESTART,
  listMessages,
  type OutboxJob,
  postPersonMessage,
  recoverStaleRuns,
  type ToolSource,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/**
 * The tools of a run the server stops under. `long_task` starts the shutdown while it runs (the server drains:
 * 0 s to finish), then ends ok, or with an error when asked to (`fail`, a command the shutdown killed).
 */
function deployTools() {
  const ran = { long_task: 0, other_task: 0 };
  const object = (properties: Record<string, unknown> = {}) => ({
    type: "object" as const,
    properties,
    additionalProperties: false,
  });
  const source: ToolSource = {
    name: "deploy-sim",
    tools: async () => [
      {
        name: "long_task",
        description: "A long task",
        scope: "",
        inputSchema: object({ fail: { type: "boolean" } }),
        async execute(input) {
          ran.long_task++;
          if (ran.long_task === 1) void drainLocalRuns(0, { graceMs: 0 });
          return (input as { fail?: boolean }).fail ? { content: "killed", isError: true } : { content: "task ok" };
        },
      },
      {
        name: "other_task",
        description: "Another task",
        scope: "",
        inputSchema: object(),
        async execute() {
          ran.other_task++;
          return { content: "other ok" };
        },
      },
      {
        name: "deploy_app",
        description: "Deploy the app",
        scope: "",
        sensitive: true,
        inputSchema: { type: "object", properties: { env: { type: "string" } } },
        describe: () => ({ title: "Deploy to production" }),
        execute: async () => ({ content: "deployed" }),
      },
    ],
  };
  return { source, ran };
}

/**
 * A run whose server shuts down during its first step (`toolUses`, `long_task` by default). One outbox batch
 * only: the job it hands back is not taken again here. `next`: the model's answer on later calls.
 */
async function interruptedRun(options: { toolUses?: FakeReply["toolUses"]; next?: () => FakeReply | undefined } = {}) {
  const tools = deployTools();
  f = await setup({
    toolSources: [tools.source],
    reply: (_req, call) =>
      call === 1
        ? { chunks: ["Trabalhando nisso."], toolUses: options.toolUses ?? [{ name: "long_task", input: {} }] }
        : (options.next?.() ?? { chunks: ["Pronto."] }),
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz a tarefa longa",
  });
  await drainOutbox(f.db, f.handlers, { maxBatches: 1 });
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  return { run, ran: tools.ran };
}

const jobOf = async (runId: string) =>
  (await f.db.select().from(schema.outbox)).find(
    (j) => j.kind === "agent_run.execute" && (j.payload as { runId?: string }).runId === runId,
  );

const runRow = async (runId: string) =>
  (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];

/** As if the old process held the run's job when it died: lease still valid, no heartbeat for minutes. */
async function orphan(runId: string) {
  const job = await jobOf(runId);
  await f.db
    .update(schema.outbox)
    .set({ status: "processing", lockedUntil: new Date(Date.now() + 600_000), lockedBy: "dead-worker" })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await f.db
    .update(schema.agentRuns)
    .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(schema.agentRuns.id, runId));
}

/** The tool results a model call was sent (`call` counts from 1), in order. */
const resultsSent = (call: number) =>
  (f.provider.calls[call - 1]?.request.messages ?? []).flatMap((m) =>
    Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === "tool_result" ? [b] : [])) : [],
  );

describe("server restarts", () => {
  test("SIGTERM mid-tool: the step is saved and the run handed back at once, without spending an attempt", async () => {
    const { run } = await interruptedRun();
    expect(run.status).toBe("running");
    expect(f.provider.calls).toHaveLength(1);
    const job = await jobOf(run.id);
    expect(job).toMatchObject({ status: "pending", attempts: 0, lockedBy: null });
    expect(job?.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(job?.lastError).toContain("interrupted by a server shutdown");
    const saved = run.transcript as { messages: { role: string; content: unknown }[] };
    expect(saved.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", content: "task ok" }],
    });
    expect(await activeRunsIn(f.db, f.org.id, f.general.id)).toEqual([
      expect.objectContaining({ runId: run.id, status: "running", agentId: f.agent.id }),
    ]);
  });

  test("the next instance goes on with what the tool returned: the tool ran once", async () => {
    const { run, ran } = await interruptedRun();
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(f.provider.calls).toHaveLength(2);
    expect(resultsSent(2)).toEqual([expect.objectContaining({ content: "task ok" })]);
    expect(ran.long_task).toBe(1);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Pronto.");
  });

  test("a call the shutdown cut short may have done part of its work; one it kept from starting never ran", async () => {
    const { run, ran } = await interruptedRun({
      toolUses: [
        { name: "long_task", input: { fail: true } },
        { name: "other_task", input: {} },
      ],
    });
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    const [cut, notRun] = resultsSent(2);
    expect(cut?.isError).toBe(true);
    expect(cut?.content).toContain("Interrupted by a server restart while it ran: it may have done part of its work");
    expect(cut?.content).toEndWith("killed");
    expect(notRun).toMatchObject({ isError: true });
    expect(notRun?.content).toContain("Interrupted by a server restart before it ran: nothing was done");
    expect(ran).toEqual({ long_task: 1, other_task: 0 });
  });

  test("a step cut after asking for an approval posts its card and waits, as it would without the restart", async () => {
    const { run, ran } = await interruptedRun({
      toolUses: [
        { name: "deploy_app", input: { env: "prod", why: "O deploy de ontem quebrou o login de todos os clientes." } },
        { name: "long_task", input: {} },
      ],
    });
    expect((await runRow(run.id))?.status).toBe("waiting_approval");
    // Nothing to hand back: the job ended with the step.
    expect((await jobOf(run.id))?.status).toBe("done");
    const [approval] = await f.db.select().from(schema.approvals);
    expect(approval).toMatchObject({ status: "pending", runId: run.id });
    expect(approval?.messageId).not.toBeNull();

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(resultsSent(2).map((r) => r.content)).toEqual(["deployed", "task ok"]);
    expect(ran.long_task).toBe(1);
  });

  test("a run picked up again with an old beat isn't recovered from under its worker", async () => {
    let swept: Awaited<ReturnType<typeof recoverStaleRuns>> | undefined;
    const { run } = await interruptedRun({
      // While the next instance's worker runs it, a recovery sweep comes by.
      next: () => ({
        chunks: ["Pronto."],
        hold: recoverStaleRuns({ db: f.db, pubsub: f.pubsub }).then((r) => {
          swept = r;
        }),
      }),
    });
    // Handed back a while ago: its last beat is minutes old when a worker takes it again.
    await f.db
      .update(schema.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.agentRuns.id, run.id));
    await drainOutbox(f.db, f.handlers);
    expect(swept).toEqual({ resumed: [], failed: [], requeued: [] });
    expect((await runRow(run.id))?.status).toBe("done");
    expect(f.provider.calls).toHaveLength(2);
  });

  test("a worker whose job a sweep took back before it started leaves the run to the next one", async () => {
    const { run } = await interruptedRun();
    const claimed = await claimJobs(f.db, { workerId: "slow" });
    const job = claimed.find((j) => j.kind === "agent_run.execute") as OutboxJob;
    // Before the slow worker starts it, a sweep sees the run's old beat and hands its job on.
    await f.db
      .update(schema.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.agentRuns.id, run.id));
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([run.id]);
    const owned = async () =>
      (
        await f.db
          .select()
          .from(schema.outbox)
          .where(and(eq(schema.outbox.id, job.id), eq(schema.outbox.lockedBy, "slow")))
      ).length > 0;
    await f.handlers["agent_run.execute"]?.(job, { finalAttempt: false, owned });
    expect(f.provider.calls).toHaveLength(1);
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(f.provider.calls).toHaveLength(2);
  });

  test("on boot, an orphan (dead worker still holding the lease) is resumed and finishes", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    expect(await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).toEqual({
      resumed: [run.id],
      failed: [],
      requeued: [],
    });
    // A second sweep right away leaves it alone (fresh heartbeat, job pending).
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Pronto.");
    expect(await activeRunsIn(f.db, f.org.id, f.general.id)).toEqual([]);
  });

  test("a dead worker's run whose job lease ran out is left to the sweep: a tool cut in half never runs again", async () => {
    const { run, ran } = await interruptedRun();
    await orphan(run.id);
    // It died in the middle of a tool, longer ago than its job's lease.
    await addRunStep(f.db, run, "tool_call", { toolUseId: "toolu_cut", name: "long_task", input: {} });
    await f.db
      .update(schema.outbox)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.outbox.id, (await jobOf(run.id))?.id ?? ""));
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
    expect((await jobOf(run.id))?.status).toBe("processing");

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([run.id]);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
    expect(ran.long_task).toBe(1);
  });

  test("two sweeps at once (two instances booting) resume an orphan once", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    const [a, b] = await Promise.all([
      recoverStaleRuns({ db: f.db, pubsub: f.pubsub }),
      recoverStaleRuns({ db: f.db, pubsub: f.pubsub }),
    ]);
    expect([...a.resumed, ...b.resumed]).toEqual([run.id]);
    const jobs = (await f.db.select().from(schema.outbox)).filter(
      (j) => j.kind === "agent_run.execute" && j.status === "pending",
    );
    expect(jobs).toHaveLength(1);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(2);
  });

  test("an orphan whose job was on its last attempt goes on in a new job; the old one ends", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    const old = await jobOf(run.id);
    await f.db
      .update(schema.outbox)
      .set({ attempts: old?.maxAttempts ?? 4 })
      .where(eq(schema.outbox.id, old?.id ?? ""));
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([run.id]);
    const jobs = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "agent_run.execute");
    expect(jobs.map((j) => j.status).sort()).toEqual(["failed", "pending"]);
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
  });

  test("an orphan cut in the middle of a tool call fails with the notice, keeps its text, and the app hears it", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    // A tool started and never reported back (it may have had effects): unsafe to repeat. It had asked for an
    // approval in that step, whose card was never posted.
    await addRunStep(f.db, run, "tool_call", { toolUseId: "toolu_cut", name: "long_task", input: {} });
    await f.db.insert(schema.approvals).values({
      orgId: f.org.id,
      runId: run.id,
      agentId: f.agent.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      toolUseId: "toolu_cut_deploy",
      tool: "deploy_app",
      scope: "",
      params: { env: "prod" },
      actionHash: "hash",
      title: "Deploy to production",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const events = f.listen(f.general.id);

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([run.id]);
    expect(await runRow(run.id)).toMatchObject({ status: "failed", error: INTERRUPTED_BY_RESTART });
    expect(INTERRUPTED_BY_RESTART).toBe("Interrupted by a server restart");
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toContain(INTERRUPTED_BY_RESTART);
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ status: "failed", runId: run.id });
    expect((await jobOf(run.id))?.status).toBe("failed");
    expect((await f.db.select().from(schema.approvals))[0]?.status).toBe("canceled");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
  });
});
