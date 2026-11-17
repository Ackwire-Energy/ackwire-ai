import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  pairComputer,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

/**
 * What an agent keeps running (`keep_running`, ADR 0176), as the apps read it on the agent's computer: for whoever may
 * watch that computer, and stopped by whoever may use it or an admin.
 */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

test("the agent's holds for who may watch its computer; a person's Stop ends one, even with the computer away", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const api = (path: string, init?: Parameters<Browser>[1]) =>
    owner(`/api/app/organizations/${org.orgId}${path}`, init);
  const machine = await pairComputer(t, api, { os: "linux", arch: "x64", hostname: "box", version: "0.1.0" });
  await t.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, org.agentId));
  const [hold] = await t.db
    .insert(schema.machineHolds)
    .values({
      orgId: org.orgId,
      agentId: org.agentId,
      machineId: machine.machineId,
      what: "Telegram bot",
      why: "answers the support group",
      pid: 4242,
    })
    .returning();
  const holds = `/agents/${org.agentId}/holds`;
  expect(await (await api(holds)).json()).toEqual({
    holds: [
      {
        id: hold?.id,
        agentId: org.agentId,
        machineId: machine.machineId,
        what: "Telegram bot",
        why: "answers the support group",
        kind: "program",
        since: hold?.createdAt.toISOString(),
        until: null,
      },
    ],
    canStop: true,
  });

  // A member the agent's work doesn't involve sees nothing of it, and stops nothing.
  const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com", { role: "member" });
  expect((await ana(`/api/app/organizations/${org.orgId}${holds}`)).status).toBe(403);
  expect((await ana(`/api/app/organizations/${org.orgId}${holds}/${hold?.id}`, { method: "DELETE" })).status).toBe(403);

  expect((await api(`${holds}/${hold?.id}`, { method: "DELETE" })).status).toBe(204);
  const [row] = await t.db
    .select()
    .from(schema.machineHolds)
    .where(eq(schema.machineHolds.id, hold?.id as string));
  expect(row).toMatchObject({ endReason: "stopped_by_person" });
  expect(await (await api(holds)).json()).toMatchObject({ holds: [] });
  expect((await api(`${holds}/${hold?.id}`, { method: "DELETE" })).status).toBe(404);
});
