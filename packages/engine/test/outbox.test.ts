import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  claimJobs,
  clearOldOutboxPayloads,
  completeJob,
  createOutboxPump,
  DEFAULT_LEASE_MS,
  drainOutbox,
  enqueue,
  failJob,
  LANE_SLOW_FOR_MS,
  laneAlarm,
  laneLimits,
  MissingCredentialError,
  PermanentJobError,
  processOutbox,
  RUN_MEMORY_BYTES,
  releaseJobs,
  renewLease,
  resizeLanes,
  retryDelayMs,
} from "../src";

let db: Database;
let close: () => Promise<void>;
let orgId: string;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  const [org] = await db.insert(schema.organizations).values({ name: "Acme" }).returning();
  orgId = org?.id ?? "";
});
afterEach(() => close());

const job = (kind = "test.job", extra: Partial<Parameters<typeof enqueue>[1]> = {}) => ({
  orgId,
  kind,
  payload: { n: 1 },
  ...extra,
});
const rows = () => db.select().from(schema.outbox);
const at = (ms: number) => new Date(Date.now() + ms);

test("a job enqueued in a rolled-back transaction never exists", async () => {
  await db
    .transaction(async (tx) => {
      await enqueue(tx, job());
      throw new Error("rollback");
    })
    .catch(() => {});
  expect(await rows()).toHaveLength(0);
});

test("dedupe keys make enqueue idempotent", async () => {
  await enqueue(db, job("k", { dedupeKey: "same" }));
  await enqueue(db, job("k", { dedupeKey: "same" }));
  expect(await rows()).toHaveLength(1);
});

test("claimed jobs are leased: a second worker gets nothing until the lease expires", async () => {
  await enqueue(db, job());
  const a = await claimJobs(db, { workerId: "a" });
  expect(a).toHaveLength(1);
  expect(a[0]?.status).toBe("processing");
  expect(a[0]?.attempts).toBe(1);
  expect(await claimJobs(db, { workerId: "b" })).toHaveLength(0);
  const b = await claimJobs(db, { workerId: "b", now: at(DEFAULT_LEASE_MS + 1000) });
  expect(b.map((j) => [j.lockedBy, j.attempts])).toEqual([["b", 2]]);
  // Worker a finishing late doesn't overwrite b's ownership.
  expect(await completeJob(db, a[0] as NonNullable<(typeof a)[0]>)).toBe(false);
  expect(await completeJob(db, b[0] as NonNullable<(typeof b)[0]>)).toBe(true);
});

test("a running job's lease is renewed: a handler that outlives the lease is not re-claimed", async () => {
  await enqueue(db, job("long"));
  let stolen: unknown[] | undefined;
  await processOutbox(
    db,
    {
      long: async () => {
        await Bun.sleep(450);
        // Past the original 300ms lease: without renewal worker b would take the job over here.
        stolen = await claimJobs(db, { workerId: "b", leaseMs: 300 });
        await Bun.sleep(250);
      },
    },
    { workerId: "a", leaseMs: 300 },
  );
  expect(stolen).toEqual([]);
  const [row] = await rows();
  expect([row?.status, row?.lockedBy, row?.attempts]).toEqual(["done", "a", 1]);
});

test("a claim is fenced by its attempt too: the same worker's later claim of the job isn't its earlier one's", async () => {
  await enqueue(db, job());
  const [early] = await claimJobs(db, { workerId: "w" });
  // Its lease ran out (no renewal got through while the database was away) and the same worker claimed it again.
  const [later] = await claimJobs(db, { workerId: "w", now: at(DEFAULT_LEASE_MS + 1000) });
  expect(later?.id).toBe(early?.id ?? "");
  const stale = early as NonNullable<typeof early>;
  expect(await renewLease(db, stale)).toBe(false);
  expect(await completeJob(db, stale)).toBe(false);
  await failJob(db, stale, new Error("late"), { retryable: true });
  await failJob(db, stale, Object.assign(new Error("stopping"), { handback: true }), { retryable: true });
  expect((await rows())[0]).toMatchObject({ status: "processing", lockedBy: "w", attempts: 2, lastError: null });
  expect(await completeJob(db, later as NonNullable<typeof later>)).toBe(true);
});

test("a handler's `owned` is about its own claim, not its worker's", async () => {
  await enqueue(db, job("k"));
  const owned: { first?: boolean; second?: boolean } = {};
  const goOn = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const first = processOutbox(
    db,
    {
      k: async (_job, ctx) => {
        await goOn.promise;
        owned.first = await ctx.owned?.();
        answered.resolve();
      },
    },
    { workerId: "w" },
  );
  while ((await rows())[0]?.status !== "processing") await Bun.sleep(5);
  // Its lease runs out and the same worker claims the job again while the first handler still runs.
  await db.update(schema.outbox).set({ lockedUntil: at(-1000) });
  await processOutbox(
    db,
    {
      k: async (_job, ctx) => {
        owned.second = await ctx.owned?.();
        goOn.resolve();
        await answered.promise;
      },
    },
    { workerId: "w" },
  );
  await first;
  expect(owned).toEqual({ first: false, second: true });
  expect((await rows())[0]).toMatchObject({ status: "done", attempts: 2 });
});

test("renewLease does not extend a job another worker took over", async () => {
  await enqueue(db, job());
  const [a] = await claimJobs(db, { workerId: "a" });
  const [b] = await claimJobs(db, { workerId: "b", now: at(DEFAULT_LEASE_MS + 1000) });
  const owned = a as NonNullable<typeof a>;
  expect(await renewLease(db, owned, DEFAULT_LEASE_MS, at(DEFAULT_LEASE_MS * 5))).toBe(false);
  expect((await rows())[0]?.lockedUntil?.getTime()).toBe(b?.lockedUntil?.getTime());
  expect(await renewLease(db, b as NonNullable<typeof b>)).toBe(true);
});

test("future jobs wait for their time", async () => {
  await enqueue(db, job("k", { runAt: at(60_000) }));
  expect(await claimJobs(db, { workerId: "w" })).toHaveLength(0);
  expect(await claimJobs(db, { workerId: "w", now: at(61_000) })).toHaveLength(1);
});

test("failures retry with backoff, then fail after max attempts", async () => {
  await enqueue(db, job("k", { maxAttempts: 2 }));
  const [first] = await claimJobs(db, { workerId: "w" });
  const now = new Date();
  expect(await failJob(db, first as NonNullable<typeof first>, new Error("e1"), { retryable: true, now })).toBe(
    "retry",
  );
  let [row] = await rows();
  expect(row?.status).toBe("pending");
  expect(row?.nextAttemptAt.getTime()).toBe(now.getTime() + retryDelayMs(1));
  const [second] = await claimJobs(db, { workerId: "w", now: at(retryDelayMs(1) + 1000) });
  expect(await failJob(db, second as NonNullable<typeof second>, new Error("e2"), { retryable: true })).toBe("failed");
  [row] = await rows();
  expect([row?.status, row?.lastError]).toEqual(["failed", "e2"]);
});

test("a handback (its worker is shutting down) is due again at once and spends no attempt", async () => {
  await enqueue(db, job("run"));
  const outcomes: string[] = [];
  await processOutbox(
    db,
    {
      run: async () => {
        throw Object.assign(new Error("stopped by a shutdown"), { handback: true });
      },
    },
    { workerId: "w", onError: (_j, _e, outcome) => outcomes.push(outcome) },
  );
  expect(outcomes).toEqual(["retry"]);
  expect((await rows())[0]).toMatchObject({
    status: "pending",
    attempts: 0,
    lockedBy: null,
    lastError: "stopped by a shutdown",
  });
  expect(await claimJobs(db, { workerId: "next" })).toHaveLength(1);
});

test("a stopping worker hands its running jobs back: due at once for the next one, the attempt not spent", async () => {
  await enqueue(db, job("a"));
  await enqueue(db, job("b"));
  expect(await claimJobs(db, { workerId: "stopping" })).toHaveLength(2);
  await enqueue(db, job("c"));
  expect(await claimJobs(db, { workerId: "other" })).toHaveLength(1);

  expect(await releaseJobs(db, "stopping")).toBe(2);
  const next = await claimJobs(db, { workerId: "next" });
  expect(next.map((j) => [j.kind, j.attempts]).sort()).toEqual([
    ["a", 1],
    ["b", 1],
  ]);
  // Another worker's job stays with it.
  expect((await rows()).find((r) => r.kind === "c")).toMatchObject({ status: "processing", lockedBy: "other" });
});

test("a job whose failure can't be recorded (the database went away) doesn't reject the pump", async () => {
  await enqueue(db, job("flaky"));
  const update = db.update;
  const outcomes: string[] = [];
  const pump = createOutboxPump(
    db,
    {
      flaky: async () => {
        // The database goes away mid-job: recording the failure fails too.
        db.update = (() => {
          throw new Error("connection refused");
        }) as unknown as typeof db.update;
        throw new Error("connection refused");
      },
    },
    { workerId: "w", onError: (_j, _e, outcome) => outcomes.push(outcome) },
  );
  try {
    expect(await pump.pump()).toBe(1);
    await pump.idle();
  } finally {
    db.update = update;
  }
  expect(outcomes).toEqual(["retry"]);
  // Still leased to the worker: it comes back when the lease ends.
  expect((await rows())[0]).toMatchObject({ status: "processing", lockedBy: "w" });
});

test("a lease that expires after the final attempt marks the job failed, and says so as a failed job", async () => {
  await enqueue(db, job("k", { maxAttempts: 1 }));
  await claimJobs(db, { workerId: "dead" });
  const told: string[] = [];
  const onError = (j: { kind: string }, error: unknown, outcome: string) =>
    told.push(`${j.kind} ${outcome}: ${(error as Error).message}`);
  expect(await claimJobs(db, { workerId: "w", now: at(DEFAULT_LEASE_MS + 1000), onError })).toHaveLength(0);
  expect((await rows())[0]?.status).toBe("failed");
  // Its worker died or hung on it: nothing else would ever tell.
  expect(told).toEqual(["k failed: lease expired on the final attempt"]);
});

test("processOutbox runs handlers and records outcomes", async () => {
  const seen: unknown[] = [];
  await enqueue(db, job("ok"));
  await enqueue(db, job("permanent"));
  await enqueue(db, job("flaky"));
  await enqueue(db, job("unknown.kind"));
  const errors: string[] = [];
  const n = await processOutbox(
    db,
    {
      ok: async (j) => {
        seen.push(j.payload);
      },
      permanent: async () => {
        throw new PermanentJobError("bad input");
      },
      flaky: async () => {
        throw Object.assign(new Error("rate limited"), { retryable: true });
      },
    },
    { workerId: "w", onError: (j, _e, outcome) => errors.push(`${j.kind}:${outcome}`) },
  );
  expect(n).toBe(4);
  expect(seen).toEqual([{ n: 1 }]);
  expect(errors.sort()).toEqual(["flaky:retry", "permanent:failed", "unknown.kind:failed"]);
  const byKind = Object.fromEntries((await rows()).map((r) => [r.kind, r.status]));
  expect(byKind).toEqual({ ok: "done", permanent: "failed", flaky: "pending", "unknown.kind": "failed" });
});

test("a job that hits a missing provider key fails at once instead of retrying 8 times", async () => {
  await enqueue(db, job("reflect"));
  const outcomes: string[] = [];
  await processOutbox(
    db,
    {
      reflect: async () => {
        throw new MissingCredentialError("Add an API key for Anthropic in the workspace settings");
      },
    },
    { workerId: "w", onError: (_j, _e, outcome) => outcomes.push(outcome) },
  );
  expect(outcomes).toEqual(["failed"]);
  const [row] = await rows();
  expect([row?.status, row?.attempts, row?.maxAttempts]).toEqual(["failed", 1, 8]);
});

test("createOutboxPump: a slow job doesn't hold back jobs claimed after it, and slots stay capped", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => {
    release = r;
  });
  const done: string[] = [];
  let freed = 0;
  const pump = createOutboxPump(
    db,
    {
      slow: () => slow.then(() => void done.push("slow")),
      fast: async () => void done.push("fast"),
    },
    { workerId: "w", maxInFlight: 2, onSlotFree: () => freed++ },
  );
  await enqueue(db, job("slow"));
  expect(await pump.pump()).toBe(1);
  await enqueue(db, job("fast"));
  await enqueue(db, job("fast"));
  // One slot left while the slow job runs.
  expect(await pump.pump()).toBe(1);
  while (pump.inFlight() > 1) await Bun.sleep(1);
  expect(await pump.pump()).toBe(1);
  while (pump.inFlight() > 1) await Bun.sleep(1);
  expect(done).toEqual(["fast", "fast"]);
  release();
  await pump.idle();
  expect(done).toEqual(["fast", "fast", "slow"]);
  expect(freed).toBe(3);
  expect((await rows()).every((r) => r.status === "done")).toBe(true);
});

test("createOutboxPump: routines hold at most half of the slots, so other work always finds one", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const started: string[] = [];
  const waits: { kind: unknown; background: unknown }[] = [];
  const pump = createOutboxPump(
    db,
    {
      "routine.run": () => {
        started.push("routine");
        return held;
      },
      "message.posted": async () => void started.push("message"),
    },
    {
      workerId: "w",
      maxInFlight: 4,
      onTiming: (name, _ms, attrs) => {
        if (name === "queue_wait_ms") waits.push({ kind: attrs.kind, background: attrs.background });
      },
    },
  );
  for (let i = 0; i < 5; i++) await enqueue(db, job("routine.run"));
  expect(await pump.pump()).toBe(2);
  // Two free slots left, but no more routines while two run.
  expect(await pump.pump()).toBe(0);
  await enqueue(db, job("message.posted"));
  expect(await pump.pump()).toBe(1);
  while (pump.inFlight() > 2) await Bun.sleep(1);
  expect(started.filter((s) => s === "routine")).toHaveLength(2);
  expect(started).toContain("message");
  expect(waits).toEqual([
    { kind: "routine.run", background: true },
    { kind: "routine.run", background: true },
    { kind: "message.posted", background: false },
  ]);
  release();
  await pump.idle();
  // The slots free up: the next routines go.
  expect(await pump.pump()).toBe(2);
  await pump.idle();
  expect(await pump.pump()).toBe(1);
  await pump.idle();
  expect((await rows()).every((r) => r.status === "done")).toBe(true);
});

test("createOutboxPump: long jobs hold at most the slots quick jobs keep for themselves, so a quick job finds one", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const done: string[] = [];
  const pump = createOutboxPump(
    db,
    { "agent_run.execute": () => held, "message.posted": async () => void done.push("message") },
    { workerId: "w", maxInFlight: 4, quickSlots: 1 },
  );
  for (let i = 0; i < 5; i++) await enqueue(db, job("agent_run.execute"));
  expect(await pump.pump()).toBe(3);
  // Every long slot is busy; the one left is the quick lane's.
  expect(await pump.pump()).toBe(0);
  await enqueue(db, job("message.posted"));
  expect(await pump.pump()).toBe(1);
  while (pump.inFlight() > 3) await Bun.sleep(1);
  expect(done).toEqual(["message"]);
  release();
  await pump.idle();
  expect(await pump.pump()).toBe(2);
  await pump.idle();
  expect((await rows()).every((r) => r.status === "done")).toBe(true);
});

test("createOutboxPump: routines hold at most half of the long slots; a person's run and quick jobs find theirs", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const pump = createOutboxPump(
    db,
    { "routine.run": () => held, "agent_run.execute": () => held, "message.posted": () => held },
    { workerId: "w", maxInFlight: 6, quickSlots: 2 },
  );
  for (let i = 0; i < 5; i++) await enqueue(db, job("routine.run"));
  expect(await pump.pump()).toBe(2);
  expect(await pump.pump()).toBe(0);
  for (let i = 0; i < 3; i++) await enqueue(db, job("agent_run.execute"));
  expect(await pump.pump()).toBe(2);
  for (let i = 0; i < 3; i++) await enqueue(db, job("message.posted"));
  expect(await pump.pump()).toBe(2);
  const running = (await rows()).filter((r) => r.status === "processing").map((r) => r.kind);
  expect(running.sort()).toEqual([
    "agent_run.execute",
    "agent_run.execute",
    "message.posted",
    "message.posted",
    "routine.run",
    "routine.run",
  ]);
  release();
  await pump.idle();
});

test("createOutboxPump under load: 400 routines and 60 agent runs, quick jobs still go at once, every lane within its cap", async () => {
  const live = { all: 0, long: 0, background: 0, runs: 0 };
  type Lane = keyof typeof live;
  const peak = { ...live };
  let finished = 0;
  const work = (counted: Lane[], ms: number) => async () => {
    for (const lane of counted) peak[lane] = Math.max(peak[lane], ++live[lane]);
    await Bun.sleep(ms);
    for (const lane of counted) live[lane]--;
    finished++;
  };
  const quickWaits: number[] = [];
  const pump = createOutboxPump(
    db,
    {
      "routine.run": work(["all", "long", "background"], 50),
      "agent_run.execute": work(["all", "long", "runs"], 1_000),
      "message.posted": async (j) => {
        quickWaits.push(Date.now() - Number(j.payload.at));
        await work(["all"], 1)();
      },
    },
    { workerId: "w", maxInFlight: 48, quickSlots: 12 },
  );
  await db
    .insert(schema.outbox)
    .values([
      ...Array.from({ length: 400 }, () => ({ orgId, kind: "routine.run", payload: {} })),
      ...Array.from({ length: 60 }, () => ({ orgId, kind: "agent_run.execute", payload: {} })),
    ]);
  const quick = 100;
  const feed = (async () => {
    for (let i = 0; i < quick; i++) {
      await enqueue(db, job("message.posted", { payload: { at: Date.now() } }));
      await Bun.sleep(20);
    }
  })();
  const deadline = Date.now() + 25_000;
  while (finished < 460 + quick && Date.now() < deadline) {
    await pump.pump();
    await Bun.sleep(5);
  }
  await feed;
  await pump.idle();
  expect(finished).toBe(460 + quick);
  // The long lane is 48 - 12 slots, background work half of it; the agent runs filled it while routines waited.
  expect(peak).toMatchObject({ long: 36, background: 18, runs: 36 });
  expect(peak.all).toBeLessThanOrEqual(48);
  // A quick job waiting behind one agent run would wait about a second.
  expect(Math.max(...quickWaits)).toBeLessThan(500);
}, 30_000);

test("resizeLanes: a lane that waits doubles within its limit and the total, quick first; an idle one halves back", () => {
  const base = { quick: 12, long: 36 };
  const limits = { lanes: { quick: 80, long: 500 }, total: 580 };
  const calm = { waitMs: 0, peak: 0 };
  const waiting = { waitMs: 3_000, peak: 0 };
  expect(resizeLanes(base, base, limits, { quick: waiting, long: waiting })).toEqual({ quick: 24, long: 72 });
  expect(resizeLanes({ quick: 48, long: 288 }, base, limits, { quick: waiting, long: waiting })).toEqual({
    quick: 80,
    long: 500,
  });
  // The total binds: the quick lane takes its share of the room first.
  const tight = { lanes: limits.lanes, total: 100 };
  expect(resizeLanes({ quick: 12, long: 80 }, base, tight, { quick: waiting, long: waiting })).toEqual({
    quick: 20,
    long: 80,
  });
  // A busy processor: nothing grows.
  expect(resizeLanes(base, base, limits, { quick: waiting, long: waiting }, 500)).toEqual(base);
  // Waiting for nothing and half used at most: half, never below the base; a lane still using more keeps it.
  expect(resizeLanes({ quick: 24, long: 288 }, base, limits, { quick: calm, long: calm })).toEqual({
    quick: 12,
    long: 144,
  });
  expect(resizeLanes(base, base, limits, { quick: calm, long: calm })).toEqual(base);
  expect(resizeLanes({ quick: 12, long: 288 }, base, limits, { quick: calm, long: { waitMs: 0, peak: 200 } })).toEqual({
    quick: 12,
    long: 288,
  });
});

test("laneLimits: runs as far as half the memory holds them, quick jobs 4 per connection, a cap over both", () => {
  const base = { quick: 12, long: 36 };
  const gb = 1024 ** 3;
  const host = { memoryBytes: 4 * gb, rssBytes: 0.5 * gb, dbConnections: 20 };
  const runs = Math.floor((2 * gb - 0.5 * gb) / RUN_MEMORY_BYTES);
  expect(laneLimits(base, host)).toEqual({ lanes: { quick: 80, long: runs }, total: 80 + runs });
  expect(laneLimits(base, host, 200).total).toBe(200);
  // A small box never goes below where the slots start.
  expect(laneLimits(base, { memoryBytes: gb / 2, rssBytes: gb / 2, dbConnections: 2 })).toEqual({
    lanes: base,
    total: 48,
  });
});

test("createOutboxPump.tune: jobs left waiting grow their lane up to its limit; once idle, it halves back", async () => {
  const limits = { lanes: { quick: 8, long: 24 }, total: 32 };
  const pump = createOutboxPump(db, {}, { workerId: "w", maxInFlight: 8, quickSlots: 2, limits });
  await enqueue(db, job("message.posted", { runAt: at(-60_000) }));
  await enqueue(db, job("agent_run.execute", { runAt: at(-60_000) }));
  const sizes = async () => {
    const t = await pump.tune();
    return [t.quick, t.long];
  };
  expect(await sizes()).toEqual([4, 12]);
  expect(await sizes()).toEqual([8, 24]);
  expect(await sizes()).toEqual([8, 24]);
  await db.delete(schema.outbox);
  expect(await sizes()).toEqual([4, 12]);
  expect(await sizes()).toEqual([2, 6]);
  expect(await sizes()).toEqual([2, 6]);
});

test("laneAlarm: tells once a lane stayed slow 5 minutes, then at most every hour, recovered or not", () => {
  const told = laneAlarm();
  const minute = 60_000;
  const step = (slow: boolean, m: number) => told(slow, m * minute);
  expect([step(true, 0), step(true, 4), step(true, 5), step(true, 6)]).toEqual([false, false, true, false]);
  // It recovers and is slow again soon: not told within the hour.
  expect([step(false, 7), step(true, 8), step(true, 13), step(true, 64)]).toEqual([false, false, false, false]);
  expect(step(true, 65)).toBe(true);
  expect(LANE_SLOW_FOR_MS).toBe(5 * minute);
});

test("createOutboxPump.tune: names each lane its jobs keep waiting in", async () => {
  const pump = createOutboxPump(db, {}, { workerId: "w", maxInFlight: 4, quickSlots: 1 });
  const start = Date.now();
  await enqueue(db, job("message.posted", { runAt: at(-10_000) }));
  await enqueue(db, job("routine.run", { runAt: at(-600_000) }));
  const told: string[] = [];
  for (let ms = 0; ms <= LANE_SLOW_FOR_MS; ms += 30_000)
    told.push(...(await pump.tune({ now: new Date(start + ms) })).slow);
  // Quick jobs waited over 5 s and routines over 5 minutes; no agent run waited.
  expect(told.sort()).toEqual(["background", "quick"]);
});

test("workspaces take turns: one workspace's burst queues only that workspace", async () => {
  const [other] = await db.insert(schema.organizations).values({ name: "Globex" }).returning();
  const busyOrg = orgId;
  const otherOrg = other?.id ?? "";
  for (let i = 0; i < 20; i++) await enqueue(db, { orgId: busyOrg, kind: "routine.run", payload: { i } });
  for (let i = 0; i < 3; i++) await enqueue(db, { orgId: otherOrg, kind: "routine.run", payload: { i } });
  const first = await claimJobs(db, { workerId: "w", batchSize: 4 });
  expect(first.filter((j) => j.orgId === otherOrg)).toHaveLength(2);
  // The busy workspace holds 2 now: the other one's last job goes before its 18 left.
  const second = await claimJobs(db, { workerId: "w", batchSize: 2 });
  expect(second.map((j) => j.orgId).sort()).toEqual([busyOrg, otherOrg].sort());
  // Alone, a workspace takes every slot.
  const rest = await claimJobs(db, { workerId: "w", batchSize: 50 });
  expect(rest).toHaveLength(17);
  expect(rest.every((j) => j.orgId === busyOrg)).toBe(true);
});

test("two workers on one database never claim the same job, and workspaces take turns across both", async () => {
  const [other] = await db.insert(schema.organizations).values({ name: "Globex" }).returning();
  const orgs = [orgId, other?.id ?? ""];
  for (const org of orgs)
    for (let i = 0; i < 30; i++) await enqueue(db, { orgId: org, kind: "agent_run.execute", payload: { i } });
  const ran: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const handlers = {
    "agent_run.execute": async (j: { id: string }) => {
      ran.push(j.id);
      await held;
    },
  };
  const pumps = ["a", "b"].map((w) => createOutboxPump(db, handlers, { workerId: w, maxInFlight: 10, quickSlots: 2 }));
  // Both claim at once: 8 long slots each.
  expect(await Promise.all(pumps.map((p) => p.pump()))).toEqual([8, 8]);
  const byOrg = async () => {
    const rows = await db.select().from(schema.outbox).where(eq(schema.outbox.status, "processing"));
    return orgs.map((org) => rows.filter((r) => r.orgId === org).length);
  };
  expect(await byOrg()).toEqual([8, 8]);
  release();
  for (let i = 0; i < 20 && (await rows()).some((r) => r.status !== "done"); i++) {
    await Promise.all(pumps.map((p) => p.idle()));
    await Promise.all(pumps.map((p) => p.pump()));
  }
  await Promise.all(pumps.map((p) => p.idle()));
  expect(ran).toHaveLength(60);
  expect(new Set(ran).size).toBe(60);
  expect((await rows()).every((r) => r.status === "done")).toBe(true);
});

test("finished jobs lose their content after 30 days and keep their row and dedupe key", async () => {
  const day = 86_400_000;
  for (const kind of ["old", "failed", "recent", "waiting"]) await enqueue(db, job(kind, { dedupeKey: kind }));
  const set = (kind: string, values: Partial<typeof schema.outbox.$inferInsert>) =>
    db.update(schema.outbox).set(values).where(eq(schema.outbox.kind, kind));
  await set("old", { status: "done", completedAt: at(-31 * day), lastError: "a@example.com bounced" });
  await set("failed", { status: "failed", createdAt: at(-31 * day), lastError: "a@example.com bounced" });
  await set("recent", { status: "done", completedAt: at(-29 * day) });
  await set("waiting", { createdAt: at(-31 * day) });

  expect(await clearOldOutboxPayloads(db)).toBe(2);
  const kept = Object.fromEntries((await rows()).map((r) => [r.kind, [r.payload, r.lastError, r.dedupeKey]]));
  expect(kept).toEqual({
    old: [{}, null, "old"],
    failed: [{}, null, "failed"],
    recent: [{ n: 1 }, null, "recent"],
    waiting: [{ n: 1 }, null, "waiting"],
  });
  // The cleared row still refuses the same key, and a second pass finds nothing to clear.
  await enqueue(db, job("old", { dedupeKey: "old" }));
  expect(await rows()).toHaveLength(4);
  expect(await clearOldOutboxPayloads(db)).toBe(0);
});

test("drainOutbox follows chains of jobs", async () => {
  await enqueue(db, job("first"));
  const done: string[] = [];
  await drainOutbox(db, {
    first: async (j) => {
      done.push("first");
      await enqueue(db, { orgId: j.orgId, kind: "second", payload: {} });
    },
    second: async () => {
      done.push("second");
    },
  });
  expect(done).toEqual(["first", "second"]);
  const [r] = await db.select().from(schema.outbox).where(eq(schema.outbox.kind, "second"));
  expect(r?.status).toBe("done");
});
