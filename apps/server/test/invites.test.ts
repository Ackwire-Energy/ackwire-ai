import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("invite link: anyone signed in joins as a member; members can't create links", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const res = await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} });
  expect(res.status).toBe(201);
  const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
  expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  const token = url.split("/invite/")[1] ?? "";
  // Before signing in: who invited and a few of the org's agents, by name and look only.
  expect(await (await browser(t)(`/api/app/invitations/${token}`)).json()).toEqual({
    orgName: "Acme",
    email: "",
    role: "member",
    kind: "link",
    invitedBy: "owner",
    agents: [{ id: agentId, name: "Dev", appearance: null }],
  });
  // Sign-up is closed here: the link's token lets a new person register.
  await expect(signUp(browser(t), "eve@example.com")).rejects.toThrow("403");
  await expect(signUp(browser(t), "eve@example.com", { inviteToken: "bad" })).rejects.toThrow("403");
  for (const email of ["ana@example.com", "bia@example.com"]) {
    const b = browser(t);
    await signUp(b, email, { inviteToken: token });
    expect(await (await b(`/api/app/invitations/${token}/accept`, { json: {} })).json()).toEqual({ orgId });
    const me = (await (await b("/api/app/me")).json()) as { organizations: { id: string; role: string }[] };
    expect(me.organizations).toEqual([expect.objectContaining({ id: orgId, role: "member" })]);
    expect((await b(`/api/app/organizations/${orgId}/invite-links`, { json: {} })).status).toBe(403);
  }
  const [link] = await t.db.select().from(schema.organizationInviteLinks);
  expect(link?.uses).toBe(2);
  expect(JSON.stringify(link)).not.toContain(token);
});

test("request a new invitation: the inviter is emailed once; valid or unknown tokens are refused", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { url } = (await (
    await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
  ).json()) as { url: string };
  const token = url.split("/invite/")[1] ?? "";
  const anon = browser(t);
  expect((await anon(`/api/app/invitations/${token}/request-new`, { json: {} })).status).toBe(409); // still valid
  expect((await anon("/api/app/invitations/nope/request-new", { json: {} })).status).toBe(404);

  await t.db.update(schema.organizationInvitations).set({ expiresAt: new Date(Date.now() - 1000) });
  await t.drain();
  t.email.sent.length = 0;
  expect((await anon(`/api/app/invitations/${token}/request-new`, { json: {} })).status).toBe(204);
  expect((await anon(`/api/app/invitations/${token}/request-new`, { json: {} })).status).toBe(204);
  await t.drain();
  expect(t.email.sent.map((m) => [m.to, m.subject])).toEqual([
    [["owner@example.com"], "Pedido de novo convite para Acme"],
  ]);
  expect(t.email.sent[0]?.text).toContain("ana@example.com");
  expect(t.email.sent[0]?.text).toContain(`/org/${orgId}/members`);
});
