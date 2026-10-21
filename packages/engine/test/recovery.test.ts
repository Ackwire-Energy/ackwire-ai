import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  activeRunsIn,
  addRunStep,
  drainLocalRuns,
  drainOutbox,
  INTERRUPTED_BY_RESTART,
  listMessages,
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

/** A tool that simulates SIGTERM while it runs (the server drains: 0 s to finish). */
function shutdownDuringTool(): ToolSource {
  let first = true;
  return {
    name: "deploy-sim",
    tools: async () => [
      {
        name: "long_task",
        description: "A long task",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          if (first) {
            first = false;
            void drainLocalRuns(0, { graceMs: 0 });
          }
          return { content: "task ok" };
        },
      },
    ],
  };
}

async function interruptedRun() {
  f = await setup({
    toolSources: [shutdownDuringTool()],
    reply: (_req: ModelRequest, call: number) =>
      call === 1
        ? { chunks: ["Trabalhando nisso."], toolUses: [{ name: "long_task", input: {} }] }
        : { chunks: ["Pronto."] },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz a tarefa longa",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  return { run };
}

const jobOf = async (runId: string) =>
  (await f.db.select().from(schema.outbox)).find(
    (j) => j.kind === "agent_run.execute" && (j.payload as { runId?: string }).runId === runId,
  );

describe("server restarts", () => {
  test("SIGTERM mid-run: the run is checkpointed and handed back, not lost or failed", async () => {
    const { run } = await interruptedRun();
    expect(run.status).toBe("running");
    expect(f.provider.calls).toHaveLength(1);
    const job = await jobOf(run.id);
    expect(job).toMatchObject({ status: "pending" });
    expect(job?.lastError).toContain("interrupted by a server shutdown");
    expect(await activeRunsIn(f.db, f.org.id, f.general.id)).toEqual([
      expect.objectContaining({ runId: run.id, status: "running", agentId: f.agent.id }),
    ]);
  });

  test("on boot, an orphan (dead worker still holding the lease) is resumed and finishes", async () => {
    const { run } = await interruptedRun();
    // As if the old process held the job when it died: lease still valid, no heartbeat for minutes.
    const job = await jobOf(run.id);
    await f.db
      .update(schema.outbox)
      .set({ status: "processing", lockedUntil: new Date(Date.now() + 600_000), lockedBy: "dead-worker" })
      .where(eq(schema.outbox.id, job?.id ?? ""));
    await f.db
      .update(schema.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.agentRuns.id, run.id));

    expect(await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).toEqual({
      resumed: [run.id],
      failed: [],
      requeued: [],
    });
    // A second sweep right away leaves it alone (fresh heartbeat, job pending).
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(after?.status).toBe("done");
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Pronto.");
    expect(await activeRunsIn(f.db, f.org.id, f.general.id)).toEqual([]);
  });

  test("an orphan cut in the middle of a tool call fails with the notice, keeps its text, and the app hears it", async () => {
    const { run } = await interruptedRun();
    const job = await jobOf(run.id);
    await f.db
      .update(schema.outbox)
      .set({ status: "processing", lockedUntil: new Date(Date.now() + 600_000), lockedBy: "dead-worker" })
      .where(eq(schema.outbox.id, job?.id ?? ""));
    await f.db
      .update(schema.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.agentRuns.id, run.id));
    // A tool started and never reported back (it may have had effects): unsafe to repeat.
    await addRunStep(f.db, run, "tool_call", { toolUseId: "toolu_cut", name: "long_task", input: {} });
    const events = f.listen(f.general.id);

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([run.id]);
    const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(after).toMatchObject({ status: "failed", error: INTERRUPTED_BY_RESTART });
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toContain(INTERRUPTED_BY_RESTART);
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ status: "failed", runId: run.id });
    expect((await jobOf(run.id))?.status).toBe("failed");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
  });
});
