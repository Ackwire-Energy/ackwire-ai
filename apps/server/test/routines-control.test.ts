import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

/** The owner's browser, their organization and a routine in #general. */
async function withRoutine(extra: Record<string, unknown> = {}) {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Resuma o dia",
      target: { type: "channel", channelId },
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
      ...extra,
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as Record<string, unknown> & { id: string };
  return { api, routine, orgId };
}

test("create and edit access and report; resuming clears the pause reason and the failure streak", async () => {
  const { api, routine } = await withRoutine({ access: "act", report: "always" });
  expect(routine).toMatchObject({
    access: "act",
    report: "always",
    state: "active",
    canManage: true,
    canSeeDetails: true,
    pausedReason: null,
    health: { ok: 0, total: 0 },
    usage: { runs: 0, tokens: 0, billedTo: "api" },
  });
  const edited = await api(`/routines/${routine.id}`, {
    method: "PATCH",
    json: { access: "read", report: "when_new" },
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ access: "read", report: "when_new" });

  // It paused itself after failing; a person resumes it.
  await t.db
    .update(schema.routines)
    .set({ active: false, nextRunAt: null, pausedReason: "failing", failuresInRow: 5 })
    .where(eq(schema.routines.id, routine.id));
  const paused = (await (await api("/routines")).json()) as { routines: Record<string, unknown>[] };
  expect(paused.routines[0]).toMatchObject({ state: "paused", pausedReason: "failing", failuresInRow: 5 });
  const resumed = await api(`/routines/${routine.id}`, { method: "PATCH", json: { active: true } });
  expect(await resumed.json()).toMatchObject({ active: true, state: "active", pausedReason: null, failuresInRow: 0 });

  // Too often is refused with its code.
  const often = await api(`/routines/${routine.id}`, {
    method: "PATCH",
    json: { trigger: { type: "schedule", phrase: "*/5 * * * *" } },
  });
  expect(often.status).toBe(400);
  expect(await often.json()).toMatchObject({ error: { code: "routine.too_frequent", params: { minutes: 15 } } });
});

test("stop ends the run in progress as canceled, by whoever stopped it", async () => {
  const { api, routine } = await withRoutine();
  // Queued, not run yet: the worker hasn't picked it up.
  await api(`/routines/${routine.id}/run`, { json: {} });
  const stopped = await api(`/routines/${routine.id}/stop`, { json: {} });
  expect(stopped.status).toBe(200);
  const view = (await stopped.json()) as { id: string; state: string; recentRuns: { status: string }[] };
  expect(view.id).toBe(routine.id);
  expect(view.state).not.toBe("running");
  const [run] = await t.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  expect(run).toMatchObject({ status: "canceled", code: "stopped" });
  expect(view.recentRuns[0]).toMatchObject({ status: "canceled", code: "stopped" });
});

test("take-over: an admin becomes the creator of a routine whose creator left", async () => {
  const { api, routine } = await withRoutine();
  const [me] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
  await t.db
    .update(schema.routines)
    .set({ createdByUserId: null, active: false, nextRunAt: null, pausedReason: "creator_left" })
    .where(eq(schema.routines.id, routine.id));
  const taken = await api(`/routines/${routine.id}/take-over`, { json: {} });
  expect(taken.status).toBe(200);
  expect(await taken.json()).toMatchObject({ id: routine.id, canManage: true });
  const [row] = await t.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
  expect(row?.createdByUserId).toBe(me?.id ?? "");
});
