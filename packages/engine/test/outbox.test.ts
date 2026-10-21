import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  claimJobs,
  completeJob,
  createOutboxPump,
  DEFAULT_LEASE_MS,
  drainOutbox,
  enqueue,
  failJob,
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
