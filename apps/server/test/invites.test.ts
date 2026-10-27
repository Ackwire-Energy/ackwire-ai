import { afterEach, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

type Link = { id: string; url: string; expiresAt: string };
type Request = { id: string; name: string; email: string; note: string | null; confirmed: boolean };
const DAY = 86_400_000;

async function start(env: Record<string, string> = {}) {
  t = await createTestServer({ env });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const res = await owner(`/api/app/organizations/${seeded.orgId}/invite-links`, { json: {} });
  const link = (await res.json()) as Link;
  return { owner, ...seeded, status: res.status, link, token: link.url.split("/invite/")[1] ?? "" };
}

const ask = (b: Browser, token: string, json: Record<string, string>, headers?: Record<string, string>) =>
  b(`/api/app/invitations/${token}/requests`, { json, headers });
const requests = async (b: Browser, orgId: string) =>
  ((await (await b(`/api/app/organizations/${orgId}/join-requests`)).json()) as { requests: Request[] }).requests;
const mailTo = (to: string) => t.email.sent.filter((m) => m.to.includes(to));

test("a link only asks: the same link every time, no sign-up from it, and an approval invites the address", async () => {
  const { owner, orgId, agentId, status, link, token } = await start();
  expect(status).toBe(201);
  expect(new Date(link.expiresAt).getTime() - Date.now()).toBeGreaterThan(29.9 * DAY);
  const again = await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual(link);
  const [stored] = await t.db.select().from(schema.organizationInviteLinks);
  expect(JSON.stringify(stored)).not.toContain(token);

  // Signed out: who shared it and a few of the workspace's agents, by name and look only.
  const anon = browser(t);
  expect(await (await anon(`/api/app/invitations/${token}`)).json()).toEqual({
    orgName: "Acme",
    email: "",
    role: "member",
    kind: "link",
    invitedBy: "owner",
    agents: [{ id: agentId, name: "Dev", appearance: null }],
  });
  // The link's token never opens sign-up, nor joins anyone.
  const header = await anon("/api/auth/sign-up/email", {
    json: { email: "eve@example.com", password: "correct horse battery", name: "Eve" },
    headers: { "x-invite-token": token },
  });
  expect(header.status).toBe(403);

  // A typed request gets the same answer whatever happens behind it.
  const typed = { name: "  Ana   Souza ", email: "Ana@Example.com", note: "Paula's new designer" };
  for (let i = 0; i < 2; i++) {
    const res = await ask(anon, token, typed);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: "pending", email: "ana@example.com", emailed: true });
  }
  expect((await ask(anon, token, { email: "x@example.com" })).status).toBe(400);
  // A job files a typed request, apart from the reply.
  expect(await requests(owner, orgId)).toEqual([]);
  await t.drain();
  const [request] = await requests(owner, orgId);
  expect(request).toMatchObject({ name: "Ana Souza", email: "ana@example.com", note: "Paula's new designer" });
  expect(request?.confirmed).toBe(false);

  await t.drain();
  const [toOwner] = mailTo("owner@example.com").filter((m) => m.subject === "Alguém pede para entrar no seu workspace");
  expect(toOwner?.text).toContain("Ana Souza · ana@\u200aexample.\u200acom");
  expect(toOwner?.text).toContain(`/org/${orgId}/settings/members?request=${request?.id}&do=approve`);
  expect(toOwner?.text).not.toContain("Paula");
  const inbox = (await (await owner(`/api/app/organizations/${orgId}/notifications`)).json()) as {
    items: { kind: string; waiting: boolean; latest: { title?: string; names?: string[] } }[];
  };
  expect(inbox.items).toEqual([
    expect.objectContaining({
      kind: "join_request",
      waiting: true,
      latest: { title: "Ana Souza", names: ["Ana Souza"] },
    }),
  ]);

  const approved = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, {
    json: { role: "member" },
  });
  const answer = (await approved.json()) as { outcome: string; url: string; emailed: boolean };
  expect(answer).toMatchObject({ outcome: "invited", emailed: true });
  expect(await requests(owner, orgId)).toEqual([]);
  await t.drain();
  const [toAna] = mailTo("ana@example.com");
  expect(toAna?.subject).toBe("Seu pedido para entrar foi aprovado");
  expect(toAna?.text).toContain(answer.url);

  // The invitation opens sign-up for that address only, and joins as the role picked.
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const invitation = answer.url.split("/invite/")[1] ?? "";
  expect(await (await ana(`/api/app/invitations/${invitation}/accept`, { json: {} })).json()).toEqual({ orgId });
  const me = (await (await ana("/api/app/me")).json()) as { organizations: { id: string; role: string }[] };
  expect(me.organizations).toEqual([expect.objectContaining({ id: orgId, role: "member" })]);
  const [used] = await t.db.select().from(schema.organizationInviteLinks);
  expect(used?.uses).toBe(1);
  const after = (await (await owner(`/api/app/organizations/${orgId}/notifications`)).json()) as { items: unknown[] };
  expect(after.items).toEqual([]);
  // Joining with the link itself is refused: it only asks.
  expect((await (await ana(`/api/app/invitations/${token}/accept`, { json: {} })).json()) as object).toMatchObject({
    error: { code: "invitation.ask_to_join" },
  });
});

test("asks are limited per IP (10 an hour) and per link (20 an hour)", async () => {
  const { token } = await start();
  const from = (ip: string, i: number) =>
    ask(browser(t), token, { name: `P ${ip} ${i}`, email: `p${i}-${ip}@example.com` }, { "x-forwarded-for": ip });
  for (let i = 0; i < 10; i++) expect((await from("203.0.113.1", i)).status).toBe(201);
  const limited = await from("203.0.113.1", 10);
  expect(limited.status).toBe(429);
  expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("join.rate_limited");
  for (let i = 0; i < 10; i++) expect((await from("203.0.113.2", i)).status).toBe(201);
  expect((await from("203.0.113.3", 0)).status).toBe(429);
});

test("signed in: a confirmed address joins at approval; an unconfirmed one gets an invitation", async () => {
  const { owner, orgId, token } = await start({ ALLOW_SIGNUP: "true" });
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  await t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, "bia@example.com"));
  const preview = async (b: Browser) =>
    ((await (await b(`/api/app/invitations/${token}`)).json()) as { you?: Record<string, unknown> }).you;
  expect(await preview(bia)).toEqual({ member: false, email: "bia@example.com", request: null });

  expect((await ask(bia, token, { note: "From the design team" })).status).toBe(201);
  expect((await ask(bia, token, {})).status).toBe(200);
  expect(await preview(bia)).toMatchObject({ request: { status: "pending", reason: null } });
  const [request] = await requests(owner, orgId);
  expect(request).toMatchObject({ email: "bia@example.com", confirmed: true });

  const res = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, {
    json: { role: "admin" },
  });
  expect(await res.json()).toEqual({ outcome: "joined" });
  expect(await preview(bia)).toEqual({
    member: true,
    orgId,
    email: "bia@example.com",
    request: { status: "approved", reason: null },
  });
  const me = (await (await bia("/api/app/me")).json()) as { organizations: { id: string; role: string }[] };
  expect(me.organizations).toEqual([expect.objectContaining({ id: orgId, role: "admin" })]);
  expect((await ask(bia, token, {})).status).toBe(409);

  const cris = browser(t);
  await signUp(cris, "cris@example.com");
  await ask(cris, token, {});
  await t.drain();
  const [unconfirmed] = await requests(owner, orgId);
  expect(unconfirmed?.confirmed).toBe(false);
  const invited = await owner(`/api/app/organizations/${orgId}/join-requests/${unconfirmed?.id}/approve`, {
    json: { role: "member" },
  });
  expect(await invited.json()).toMatchObject({ outcome: "invited" });
});

test("members' open apps hear whoever joins, changes role or leaves, to read the people again", async () => {
  const { owner, orgId, token } = await start({ ALLOW_SIGNUP: "true" });
  let heard = 0;
  t.adapters.pubsub.subscribe(orgTopic(orgId), (e) => {
    if ((e as { event?: { type?: string } }).event?.type === "org.members") heard++;
  });
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  await t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, "bia@example.com"));
  await ask(bia, token, {});
  const [request] = await requests(owner, orgId);
  await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, { json: { role: "member" } });
  expect(heard).toBe(1);
  const cai = await joinByInvitation(t, owner, orgId, "cai@example.com");
  expect(heard).toBe(2);
  const { user } = (await (await cai("/api/app/me")).json()) as { user: { id: string } };
  const member = `/api/app/organizations/${orgId}/members/${user.id}`;
  expect((await owner(member, { method: "PATCH", json: { role: "admin" } })).status).toBe(204);
  expect(heard).toBe(3);
  expect((await owner(member, { method: "DELETE" })).status).toBe(204);
  expect(heard).toBe(4);
});

test("only admins see and answer requests; asks must come from our own pages", async () => {
  const { owner, orgId, link, token } = await start();
  await ask(browser(t), token, { name: "Ana", email: "ana@example.com" });
  await t.drain();
  const [request] = await requests(owner, orgId);
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const calls = (b: Browser) => [
    b(`/api/app/organizations/${orgId}/join-requests`),
    b(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, { json: { role: "member" } }),
    b(`/api/app/organizations/${orgId}/join-requests/${request?.id}/deny`, { json: {} }),
    b(`/api/app/organizations/${orgId}/invite-links`),
    b(`/api/app/organizations/${orgId}/invite-links`, { json: {} }),
    b(`/api/app/organizations/${orgId}/invite-links/${link.id}`, { method: "DELETE" }),
  ];
  for (const res of await Promise.all(calls(member))) expect(res.status).toBe(403);
  for (const res of await Promise.all(calls(browser(t)))) expect(res.status).toBe(401);
  const foreign = await browser(t)(`/api/app/invitations/${token}/requests`, {
    json: { name: "Eve", email: "eve@example.com" },
    origin: "https://evil.example",
  });
  expect(foreign.status).toBe(403);

  // Denied with a reason: the person reads it in the email.
  const denied = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/deny`, {
    json: { reason: "We only take people from <the studio>" },
  });
  expect(denied.status).toBe(204);
  const again = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/deny`, { json: {} });
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("join.answered");
  await t.drain();
  const [toAna] = mailTo("ana@example.com");
  expect(toAna?.subject).toBe("Seu pedido para entrar não foi aprovado");
  expect(toAna?.html).toContain("We only take people from &lt;the studio&gt;");
});

test("an account that never confirmed its address reads no one else's answer, nor takes over their request", async () => {
  const { owner, orgId, token } = await start({ ALLOW_SIGNUP: "true" });
  await ask(browser(t), token, { name: "Otto", email: "otto@corp.com" });
  await t.drain();
  const [otto] = await requests(owner, orgId);
  const denied = await owner(`/api/app/organizations/${orgId}/join-requests/${otto?.id}/deny`, {
    json: { reason: "Not this team" },
  });
  expect(denied.status).toBe(204);
  const notOtto = browser(t);
  await signUp(notOtto, "otto@corp.com");
  const preview = (await (await notOtto(`/api/app/invitations/${token}`)).json()) as { you?: unknown };
  expect(preview.you).toEqual({ member: false, email: "otto@corp.com", request: null });
  expect((await ask(notOtto, token, {})).status).toBe(201);
  await t.drain();
  expect(await requests(owner, orgId)).toEqual([]);
});

test("joining by an email invitation closes the person's request and the admins' notice", async () => {
  const { owner, orgId, token } = await start();
  await ask(browser(t), token, { name: "Rui", email: "rui@example.com" });
  await t.drain();
  const inbox = async () =>
    ((await (await owner(`/api/app/organizations/${orgId}/notifications`)).json()) as { items: { kind: string }[] })
      .items;
  expect(await requests(owner, orgId)).toHaveLength(1);
  expect((await inbox()).map((n) => n.kind)).toEqual(["join_request"]);
  await joinByInvitation(t, owner, orgId, "rui@example.com");
  expect(await requests(owner, orgId)).toEqual([]);
  expect(await inbox()).toEqual([]);
});

test("a link turned off: its requests close quietly, its page says it no longer works", async () => {
  const { owner, orgId, link, token } = await start({ ALLOW_SIGNUP: "true" });
  await ask(browser(t), token, { name: "Ana", email: "ana@example.com" });
  await t.drain();
  t.email.sent.length = 0;
  expect((await owner(`/api/app/organizations/${orgId}/invite-links`)).status).toBe(200);
  expect((await owner(`/api/app/organizations/${orgId}/invite-links/${link.id}`, { method: "DELETE" })).status).toBe(
    204,
  );
  expect(await requests(owner, orgId)).toEqual([]);
  expect(await (await browser(t)(`/api/app/invitations/${token}`)).json()).toMatchObject({
    kind: "link",
    closed: true,
  });
  const refused = await ask(browser(t), token, { name: "Bia", email: "bia@example.com" });
  expect(refused.status).toBe(404);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("join.link_closed");
  expect((await browser(t)(`/api/app/invitations/${token}/request-new`, { json: {} })).status).toBe(404);
  await t.drain();
  expect(t.email.sent).toEqual([]);
  // A member opening it is told they're in; anyone else signed in hears only that it no longer works.
  expect(await (await owner(`/api/app/invitations/${token}`)).json()).toMatchObject({
    closed: true,
    you: { member: true, orgId },
  });
  const eve = browser(t);
  await signUp(eve, "eve@example.com");
  expect(await (await eve(`/api/app/invitations/${token}`)).json()).not.toHaveProperty("you");
  // A new link is made the next time one is asked for.
  const next = (await (await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} })).json()) as Link;
  expect(next.url).not.toBe(link.url);
});

test("request a new invitation: the inviter is emailed once; valid or unknown tokens are refused", async () => {
  const { owner, orgId } = await start();
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
  expect(t.email.sent.map((m) => [m.to, m.subject])).toEqual([[["owner@example.com"], "Pediram um novo convite"]]);
  // The address as typed, with the hair spaces that keep mail clients from linking it.
  expect(t.email.sent[0]?.text).toContain("ana@\u200aexample.\u200acom abriu um convite vencido da Acme");
  expect(t.email.sent[0]?.text).toContain(`/org/${orgId}/settings/members`);
});
