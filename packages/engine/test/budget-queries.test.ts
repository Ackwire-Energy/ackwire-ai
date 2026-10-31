import { afterEach, expect, test } from "bun:test";
import { currentQueryCount } from "@agenteschat/db";
import {
  createChannel,
  createJobHandlers,
  drainOutbox,
  enableCaches,
  issueFromMessage,
  postPersonMessage,
  type StageTiming,
  updateIssue,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { until } from "./stream-fixtures";

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
test("claim → model request stays within 13 statements; a whole mention run within 23", async () => {
  let beforeModel = -1;
  const statusPicked = new Set<string>();
  f = await setup({
    reply: (req) => {
      // The agent's call only: the router's (structured output) may run after an agent's answer (ADR 0034).
      if (!req.outputSchema) beforeModel = currentQueryCount();
      return { chunks: [req.outputSchema ? '{"needs_agent":0,"scores":[],"reason":"none"}' : "ok"] };
    },
    judge: (kind, _id, _state, _question, request) => {
      if (kind === "agent_status" && request.runId) statusPicked.add(request.runId);
      return undefined;
    },
  });
  // Its open tasks from private channels it isn't in: hidden from #general, in the same one statement.
  const deps = { db: f.db, pubsub: f.pubsub };
  for (const n of [1, 2, 3]) {
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: `secreto-${n}`, visibility: "private" });
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: `Cofre ${n}` });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, said.id);
    await updateIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, issue.id, {
      assignee: { type: "agent", id: f.agent.id },
    });
  }
  enableCaches();
  let profile: { runId: string; stages: StageTiming[]; total: { queries: number } } | null = null;
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
  // 13 since a run's context lists the agent's open tasks (one statement however many, read while the thread is).
  expect(beforeModel).toBeLessThanOrEqual(13);
  expect(profile).not.toBeNull();
  const p = profile as unknown as { runId: string; stages: StageTiming[]; total: { queries: number } };
  // 22 since the reply carries how many tool calls the run made, so the apps leave "Ver o que ele fez" out at 0.
  // 23 with the open tasks.
  expect(p.total.queries).toBeLessThanOrEqual(23);
  expect(p.stages.map((s) => s.stage)).toEqual(["claim", "context", "model#1", "persist", "events"]);
  // Its status line is still picked, in a request of its own beside the run (ADR 0084 §8), counted in neither.
  await until(() => statusPicked.has(p.runId), "the run's status pick");
});
