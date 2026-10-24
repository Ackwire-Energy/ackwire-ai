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
test("claim → model request stays within 12 statements; a whole mention run within 21", async () => {
  let beforeModel = -1;
  f = await setup({
    reply: (req) => {
      // The agent's call only: the router's (structured output) may run after an agent's answer (ADR 0034).
      if (!req.outputSchema) beforeModel = currentQueryCount();
      return { chunks: [req.outputSchema ? '{"needs_agent":0,"scores":[],"reason":"none"}' : "ok"] };
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
  // 12 since the run stores the brain it runs with (ADR 0053 §10).
  expect(beforeModel).toBeLessThanOrEqual(12);
  expect(profile).not.toBeNull();
  const p = profile as unknown as { stages: StageTiming[]; total: { queries: number } };
  expect(p.total.queries).toBeLessThanOrEqual(21);
  expect(p.stages.map((s) => s.stage)).toEqual(["claim", "context", "model#1", "persist", "events"]);
});
