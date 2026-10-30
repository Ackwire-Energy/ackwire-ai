import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

interface Summary {
  id: string;
  onboarding?: { step: string; generalChannelId: string };
}
interface Created {
  organization: { id: string; name: string };
  generalChannelId: string;
}

const orgsOf = async (b: Browser) =>
  ((await (await b("/api/app/me")).json()) as { organizations: Summary[] }).organizations;
const create = (b: Browser, name: string) => b("/api/app/organizations", { json: { name } });
const save = (b: Browser, orgId: string, json: { step?: string; finished?: true }) =>
  b(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json });

test("a new workspace is its owner's to set up: /me says where it resumes, to them only, until it's finished", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const made = await create(owner, "Acme");
  expect(made.status).toBe(201);
  const { organization, generalChannelId } = (await made.json()) as Created;
  // Creating it passed the first step.
  expect(await orgsOf(owner)).toEqual([
    expect.objectContaining({ id: organization.id, onboarding: { step: "context", generalChannelId } }),
  ]);

  // Someone invited never goes through it, and can't save it.
  const ana = await joinByInvitation(t, owner, organization.id, "ana@example.com", { role: "admin" });
  expect((await orgsOf(ana))[0]).not.toHaveProperty("onboarding");
  expect((await save(ana, organization.id, { step: "team" })).status).toBe(403);
  expect((await save(ana, organization.id, { finished: true })).status).toBe(403);

  // Only forward: an earlier step changes nothing.
  const at = async (json: { step?: string; finished?: true }) => (await save(owner, organization.id, json)).json();
  expect(await at({ step: "agents" })).toEqual({ step: "agents", finished: false });
  expect(await at({ step: "import" })).toEqual({ step: "agents", finished: false });
  expect((await orgsOf(owner))[0]?.onboarding?.step).toBe("agents");
  expect((await save(owner, organization.id, { step: "elsewhere" })).status).toBe(400);

  // Finished, for good.
  expect(await at({ finished: true })).toEqual({ step: "done", finished: true });
  expect((await orgsOf(owner))[0]).not.toHaveProperty("onboarding");
  expect(await at({ step: "team" })).toEqual({ step: "done", finished: true });
});

test("making another while one is being set up gives that one back: a stale tab, two presses at once", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const first = (await (await create(owner, "Acme")).json()) as Created;
  await save(owner, first.organization.id, { step: "computer" });
  // The stale tab's step 1 gets the workspace as it is, its progress kept.
  const stale = await create(owner, "Acme again");
  expect(stale.status).toBe(200);
  expect(await stale.json()).toEqual({
    organization: expect.objectContaining({ id: first.organization.id, name: "Acme", role: "owner" }),
    generalChannelId: first.generalChannelId,
  });
  expect(await orgsOf(owner)).toEqual([
    expect.objectContaining({ id: first.organization.id, onboarding: expect.objectContaining({ step: "computer" }) }),
  ]);

  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  const twice = await Promise.all([create(bia, "Beta"), create(bia, "Beta")]);
  expect(twice.map((r) => r.status).sort()).toEqual([200, 201]);
  const ids = await Promise.all(twice.map(async (r) => ((await r.json()) as Created).organization.id));
  expect(new Set(ids).size).toBe(1);
  expect((await orgsOf(bia)).map((o) => o.id)).toEqual(ids.slice(0, 1));
  // Suspended, it shows as suspended, not as its onboarding.
  await t.db
    .update(schema.organizations)
    .set({ standing: "suspended" })
    .where(eq(schema.organizations.id, ids[0] ?? ""));
  expect((await orgsOf(bia))[0]).not.toHaveProperty("onboarding");

  // Once it's set up, the next one is a new workspace.
  await save(owner, first.organization.id, { finished: true });
  const next = await create(owner, "Labs");
  expect(next.status).toBe(201);
  expect(((await next.json()) as Created).organization.id).not.toBe(first.organization.id);
});
