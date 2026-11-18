import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** An agent's approvals level over the API (ADR 0173): on the agent, changed by who manages agents. */

let t: TestServer;
afterEach(() => t.close());

type Agent = { id: string; approvalsLevel: string };

test("an agent's approvals level: risky when made, changed by PATCH, never by a member, in the OpenAPI document", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const created = (await (await owner(`${org}/agents`, { json: { name: "Ada", handle: "ada" } })).json()) as Agent;
  expect(created.approvalsLevel).toBe("risky");

  const patched = await owner(`${org}/agents/${created.id}`, { method: "PATCH", json: { approvalsLevel: "never" } });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as Agent).approvalsLevel).toBe("never");
  const list = (await (await owner(`${org}/agents`)).json()) as { agents: Agent[] };
  expect(list.agents.find((a) => a.id === created.id)?.approvalsLevel).toBe("never");

  expect(
    (await owner(`${org}/agents/${created.id}`, { method: "PATCH", json: { approvalsLevel: "sometimes" } })).status,
  ).toBe(400);
  expect(
    (await bia(`${org}/agents/${created.id}`, { method: "PATCH", json: { approvalsLevel: "always" } })).status,
  ).toBe(403);
  const after = (await (await owner(`${org}/agents`)).json()) as { agents: Agent[] };
  expect(after.agents.find((a) => a.id === created.id)?.approvalsLevel).toBe("never");

  const doc = (await (await owner("/api/openapi.json")).json()) as {
    components: { schemas: Record<string, { enum?: string[] }> };
  };
  expect(doc.components.schemas.ApprovalsLevel?.enum).toEqual(["always", "risky", "never"]);
});

test("the workspace's level: in its settings, set by who manages agents, followed by agents without their own", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  type Own = Agent & { approvalsLevelOwn: boolean };
  const ada = (await (await owner(`${org}/agents`, { json: { name: "Ada", handle: "ada" } })).json()) as Own;
  const atlas = (await (await owner(`${org}/agents`, { json: { name: "Atlas", handle: "atlas" } })).json()) as Own;
  expect(ada.approvalsLevelOwn).toBe(false);
  await owner(`${org}/agents/${atlas.id}`, { method: "PATCH", json: { approvalsLevel: "always" } });
  expect(((await (await owner(`${org}/settings`)).json()) as { approvalsLevel: string }).approvalsLevel).toBe("risky");

  const level = (who: typeof owner, json: unknown) => who(`${org}/approvals-level`, { method: "PUT", json });
  expect((await level(bia, { level: "never" })).status).toBe(403);
  // Another workspace's owner reads and sets nothing here.
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  await seedOrg(stranger);
  expect((await level(stranger, { level: "never" })).status).toBe(403);
  expect((await stranger(`${org}/settings`)).status).toBe(403);
  expect((await stranger(`${org}/agents/${ada.id}`, { method: "PATCH", json: { approvalsLevel: null } })).status).toBe(
    403,
  );
  expect((await level(owner, { level: "sometimes" })).status).toBe(400);
  const set = await level(owner, { level: "never" });
  expect(set.status).toBe(200);
  expect(await set.json()).toEqual({ level: "never", ownAgents: 1 });
  expect(((await (await bia(`${org}/settings`)).json()) as { approvalsLevel: string }).approvalsLevel).toBe("never");
  const agents = async () => ((await (await owner(`${org}/agents`)).json()) as { agents: Own[] }).agents;
  const pick = (list: Own[], id: string) => {
    const a = list.find((x) => x.id === id);
    return a && { level: a.approvalsLevel, own: a.approvalsLevelOwn };
  };
  expect(pick(await agents(), ada.id)).toEqual({ level: "never", own: false });
  expect(pick(await agents(), atlas.id)).toEqual({ level: "always", own: true });

  // Null follows the workspace again.
  const back = await owner(`${org}/agents/${atlas.id}`, { method: "PATCH", json: { approvalsLevel: null } });
  expect(back.status).toBe(200);
  expect(pick(await agents(), atlas.id)).toEqual({ level: "never", own: false });

  await owner(`${org}/agents/${atlas.id}`, { method: "PATCH", json: { approvalsLevel: "risky" } });
  expect(await (await level(owner, { level: "always", everyAgent: true })).json()).toEqual({
    level: "always",
    ownAgents: 0,
  });
  expect(pick(await agents(), atlas.id)).toEqual({ level: "always", own: false });
});
