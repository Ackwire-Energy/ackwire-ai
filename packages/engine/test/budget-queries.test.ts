import { afterEach, expect, test } from "bun:test";
import { currentQueryCount } from "@agenteschat/db";
import { createJobHandlers, drainOutbox, enableCaches, postPersonMessage, type StageTiming } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  enableCaches(false);
  await f?.close();
});

/**
 * Round-trip budget of the hot path (the database may be ~185 ms away). Counts
 * SQL statements; transaction BEGIN/COMMIT are not counted. Raise these only
 * on purpose.
 */
test("claim → model request stays within 11 statements; a whole mention run within 20", async () => {
  let beforeModel = -1;
  f = await setup({
    reply: () => {
      beforeModel = currentQueryCount();
      return { chunks: ["ok"] };
    },
  });
  enableCaches();
  let profile: { stages: StageTiming[]; total: { queries: number } } | null = null;
  const handlers = createJobHandlers({
    ...f.jobDeps,
    onRunProfile: (p) => {
      profile = p;
    },
  });
  // Warm the caches like a running server would have them (agent, org, channel, scopes).
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev warm up" });
  await drainOutbox(f.db, handlers);

  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev hi" });
  await drainOutbox(f.db, handlers);
  expect(beforeModel).toBeGreaterThan(0);
  // 11 since every agent has a budget (ADR 0026): the call always reserves (one statement on the fast path).
  expect(beforeModel).toBeLessThanOrEqual(11);
  expect(profile).not.toBeNull();
  const p = profile as unknown as { stages: StageTiming[]; total: { queries: number } };
  expect(p.total.queries).toBeLessThanOrEqual(20);
  expect(p.stages.map((s) => s.stage)).toEqual(["claim", "context", "model#1", "persist", "events"]);
});
