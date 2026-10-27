import { afterEach, describe, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BILLING = { BILLING_URL: "https://billing.example.com", BILLING_LINK_SECRET: "b".repeat(32) };

async function ownerWithWorkspace(server: TestServer) {
  const owner = browser(server);
  await signUp(owner, "owner@example.com");
  const res = await owner("/api/app/organizations", { json: { name: "Acme" } });
  const { organization } = (await res.json()) as { organization: { id: string } };
  return { owner, orgId: organization.id };
}

describe("the billing link", () => {
  test("no billing service: 404 billing.off, and auth-config names none", async () => {
    t = await createTestServer();
    const { owner, orgId } = await ownerWithWorkspace(t);
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({ billingUrl: null });
    const res = await owner(`/api/app/organizations/${orgId}/billing-link`, { json: { from: "settings" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "billing.off" } });
  });

  test("owners and admins get a signed link for 5 minutes; members get 403", async () => {
    t = await createTestServer({ env: BILLING });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      billingUrl: "https://billing.example.com",
    });
    const { owner, orgId } = await ownerWithWorkspace(t);
    const admin = await joinByInvitation(t, owner, orgId, "admin@example.com", { role: "admin" });
    const member = await joinByInvitation(t, owner, orgId, "member@example.com");
    const link = (who: typeof owner, from = "settings") =>
      who(`/api/app/organizations/${orgId}/billing-link`, { json: { from } });

    for (const who of [owner, admin]) {
      const res = await link(who);
      expect(res.status).toBe(200);
      const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
      expect(url).toMatch(/^https:\/\/billing\.example\.com\/link\?t=v1\.[\w-]+\.[\w-]+$/);
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(290_000);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    }
    const refused = await link(member);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "forbidden" } });
    expect((await link(owner, "anywhere")).status).toBe(400);
  });

  test("with the hold on new workspaces: a new one waits for its plan, and its owner makes no other meanwhile", async () => {
    t = await createTestServer({
      env: { ...BILLING, BILLING_HOLD_NEW_WORKSPACES: "true", OPERATOR_API_TOKEN: "o".repeat(40) },
    });
    const { owner, orgId } = await ownerWithWorkspace(t);
    const me = (await (await owner("/api/app/me")).json()) as {
      organizations: { id: string; standing: { state: string; reason: string | null } }[];
    };
    expect(me.organizations).toEqual([
      expect.objectContaining({ id: orgId, standing: { state: "hold", reason: "payment" } }),
    ]);
    // Paying is how the hold ends: its owner may open the plan.
    expect((await owner(`/api/app/organizations/${orgId}/billing-link`, { json: { from: "onboarding" } })).status).toBe(
      200,
    );
    const again = await owner("/api/app/organizations", { json: { name: "Beta" } });
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ error: { code: "org.create_unpaid", params: { orgId } } });
  });
});
