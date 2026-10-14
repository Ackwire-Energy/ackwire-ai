import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addRunStep,
  canTransition,
  InvalidRunTransitionError,
  RUN_TRANSITIONS,
  type RunStatus,
  transitionRun,
} from "../src";
import { type Fixture, setup } from "./fixtures";

describe("state machine", () => {
  test("allowed transitions", () => {
    const all = Object.keys(RUN_TRANSITIONS) as RunStatus[];
    const edges = all.flatMap((from) => all.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`));
    expect(edges.sort()).toEqual(
      [
        "queued->running",
        "queued->failed",
        "running->waiting_approval",
        "running->done",
        "running->failed",
        "waiting_approval->running",
        "waiting_approval->failed",
      ].sort(),
    );
  });
});

describe("transitionRun", () => {
  let f: Fixture;
  let runId: string;
  beforeEach(async () => {
    f = await setup();
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
      })
      .returning();
    runId = run?.id ?? "";
  });
  afterEach(() => f.close());

  test("walks the happy path with an approval pause, stamping times", async () => {
    const running = await transitionRun(f.db, runId, "queued", "running");
    expect(running?.startedAt).toBeInstanceOf(Date);
    await transitionRun(f.db, runId, "running", "waiting_approval");
    const resumed = await transitionRun(f.db, runId, "waiting_approval", "running");
    expect(resumed?.startedAt?.getTime()).toBe(running?.startedAt?.getTime() ?? 0);
    const done = await transitionRun(f.db, runId, "running", "done");
    expect(done?.status).toBe("done");
    expect(done?.finishedAt).toBeInstanceOf(Date);
  });

  test("compare-and-set: a stale `from` changes nothing", async () => {
    await transitionRun(f.db, runId, "queued", "running");
    expect(await transitionRun(f.db, runId, "queued", "running")).toBeNull();
  });

  test("illegal transitions throw before touching the database", async () => {
    await expect(transitionRun(f.db, runId, "queued", "done")).rejects.toBeInstanceOf(InvalidRunTransitionError);
    await expect(transitionRun(f.db, runId, "done", "running")).rejects.toBeInstanceOf(InvalidRunTransitionError);
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    expect(row?.status).toBe("queued");
  });

  test("steps are numbered in order", async () => {
    const run = { id: runId, orgId: f.org.id };
    await addRunStep(f.db, run, "context", { a: 1 });
    await addRunStep(f.db, run, "model_call", { b: 2 });
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, runId));
    expect(steps.map((s) => [s.seq, s.kind])).toEqual([
      [1, "context"],
      [2, "model_call"],
    ]);
  });
});
