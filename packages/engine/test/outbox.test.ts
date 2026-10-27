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
  MissingCredentialError,
  PermanentJobError,
  processOutbox,
  renewLease,
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

test("a lease that expires after the final attempt marks the job failed", async () => {
  await enqueue(db, job("k", { maxAttempts: 1 }));
  await claimJobs(db, { workerId: "dead" });
  expect(await claimJobs(db, { workerId: "w", now: at(DEFAULT_LEASE_MS + 1000) })).toHaveLength(0);
  expect((await rows())[0]?.status).toBe("failed");
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
