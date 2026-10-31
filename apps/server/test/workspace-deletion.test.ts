import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, schema } from "@agenteschat/db";
import { publishOrgEvent, purgeWorkspace } from "@agenteschat/engine";
import { desktopChallenge } from "../src/desktop-sign-in";
import { currentSubscriptions } from "../src/realtime/ws";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  listen,
  ORIGIN,
  pairComputer,
  seedOrg,
  signUp,
  type TestServer,
  upgradeStatus,
} from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

type Deletion = { dueAt: string | null; requestedAt: string | null; requestedBy: { id: string; name: string } | null };
const meOf = async (b: ReturnType<typeof browser>) =>
  (await (await b("/api/app/me")).json()) as {
    user: { id: string };
    organizations: { id: string; deletion?: Deletion }[];
  };

const deleteOrg = (b: Browser, orgId: string, json: Record<string, unknown> = {}) =>
  b(`/api/app/organizations/${orgId}/deletion`, { json });
const restoreOrg = (b: Browser, orgId: string) => b(`/api/app/organizations/${orgId}/deletion`, { method: "DELETE" });
/** A response's status and error code. */
const answer = async (res: Response) => [
  res.status,
  ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code,
];
/** Every session of theirs signed in an hour ago, as the database says. */
const signedInAnHourAgo = (userId: string) =>
  t.db
    .update(schema.sessions)
    .set({ createdAt: new Date(Date.now() - 3600_000) })
    .where(eq(schema.sessions.userId, userId));

test("a workspace being deleted: its sockets close and none opens; who you are and leaving still answer", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const ownerId = (await meOf(owner)).user.id;
  const anaId = (await meOf(ana)).user.id;
  const server = listen(t);
  const url = `ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`;
  const socket = new WebSocket(url, { headers: { origin: ORIGIN, cookie: owner.cookie() } } as unknown as string[]);
  const dueAt = new Date(Date.now() + 7 * 86_400_000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        if ((JSON.parse(String(event.data)) as { type?: string }).type === "ready") resolve();
      });
      socket.addEventListener("error", () => reject(new Error("socket did not open")), { once: true });
    });
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );
    expect(await currentSubscriptions(t.db, ownerId, orgId, [channelId])).toEqual(new Set([channelId]));

    await t.db.update(schema.organizations).set({ deletionDueAt: dueAt }).where(eq(schema.organizations.id, orgId));
    expect(await currentSubscriptions(t.db, ownerId, orgId, [channelId])).toBeNull();
    expect(await upgradeStatus(url, { origin: ORIGIN, cookie: owner.cookie() })).toBe(403);
    await publishOrgEvent(t.adapters.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "org.deleting", orgId, dueAt: dueAt.toISOString() },
    });
    expect(await Promise.race([closed, Bun.sleep(2000).then(() => -1)])).toBe(4403);
  } finally {
    socket.close();
    await Promise.race([server.stop(true), Bun.sleep(500)]);
  }

  const refused = await owner(`/api/app/organizations/${orgId}/issues`);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({
    error: { code: "org.deleting", params: { dueAt: dueAt.toISOString() } },
  });
  expect((await meOf(ana)).organizations.map((o) => o.id)).toEqual([orgId]);
  expect((await ana(`/api/app/organizations/${orgId}/members/${anaId}`, { method: "DELETE" })).status).toBe(204);
  expect((await meOf(ana)).organizations).toEqual([]);
});

describe("proof that it's you", () => {
  test("a password: five wrong ones in 15 minutes, then 429; without one, an old session must sign in again", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    await signedInAnHourAgo((await meOf(owner)).user.id);
    const answers = [];
    for (let i = 0; i < 6; i++)
      answers.push(await answer(await deleteOrg(owner, orgId, { password: "not my password" })));
    expect(answers).toEqual([...Array(5).fill([403, "reauth.password"]), [429, "rate_limited"]]);
    expect(await answer(await deleteOrg(owner, orgId))).toEqual([403, "reauth.sign_in"]);

    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
    const theirs = await seedOrg(bia);
    await signedInAnHourAgo((await meOf(bia)).user.id);
    expect((await deleteOrg(bia, theirs.orgId, { password: "correct horse battery" })).status).toBe(202);
  });

  test("past the limit, an old session can't try passwords on the sign-in service's own routes either", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    await signedInAnHourAgo((await meOf(owner)).user.id);
    const right = { password: "correct horse battery" };
    expect((await owner("/api/auth/verify-password", { json: right })).status).toBe(404);
    const change = { currentPassword: right.password, newPassword: "another fake password" };
    expect((await owner("/api/auth/change-password", { json: change })).status).toBe(404);
  });

  test("an account without a password signs in again: its old session can't delete nor add a password, a fresh one can", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const ownerId = (await meOf(owner)).user.id;
    await t.db
      .delete(schema.accounts)
      .where(and(eq(schema.accounts.userId, ownerId), eq(schema.accounts.providerId, "credential")));
    await signedInAnHourAgo(ownerId);
    const password = { password: "another fake password" };
    expect(await answer(await deleteOrg(owner, orgId))).toEqual([403, "reauth.sign_in"]);
    expect(await answer(await owner("/api/app/me/password", { json: password }))).toEqual([403, "reauth.sign_in"]);

    await t.db.update(schema.sessions).set({ createdAt: new Date() }).where(eq(schema.sessions.userId, ownerId));
    expect((await deleteOrg(owner, orgId)).status).toBe(202);
    expect((await owner("/api/app/me/password", { json: password })).status).toBe(204);
  });

  test("a session minted from an old one, for the phone or the desktop app, is just as old", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const ownerId = (await meOf(owner)).user.id;

    await signedInAnHourAgo(ownerId);
    const { token } = (await (await owner("/api/app/phone-sign-in", { json: {} })).json()) as { token: string };
    const phone = browser(t);
    expect((await phone("/api/auth/sign-in/one-time-token", { json: { token } })).status).toBe(200);
    expect(await answer(await deleteOrg(phone, orgId))).toEqual([403, "reauth.sign_in"]);

    // The desktop app's window, handed a browser's sign-in that turns old before the window picks it up.
    const site = browser(t);
    const signIn = { email: "owner@example.com", password: "correct horse battery" };
    expect((await site("/api/auth/sign-in/email", { json: signIn })).status).toBe(200);
    const verifier = randomBytes(32).toString("base64url");
    const window = browser(t);
    const opened = await window("/api/auth/desktop/open", { json: { challenge: desktopChallenge(verifier) } });
    const { requestId } = (await opened.json()) as { requestId: string };
    expect(await (await site("/api/auth/desktop/handoff", { json: { requestId } })).json()).toEqual({ ok: true });
    await signedInAnHourAgo(ownerId);
    expect(await (await window("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({
      signedIn: true,
    });
    expect(await answer(await deleteOrg(window, orgId))).toEqual([403, "reauth.sign_in"]);
  });
});

describe("deleting and restoring a workspace", () => {
  test("owners only; again keeps its date; GET /me says when it goes, null past its date; restored only before it", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const ana = await joinByInvitation(t, owner, orgId, "ana@example.com", { role: "admin" });
    const ownerId = (await meOf(owner)).user.id;
    const deletionOf = async (b: Browser) => (await meOf(b)).organizations.find((o) => o.id === orgId)?.deletion;

    expect(await deletionOf(ana)).toBeUndefined();
    expect(await answer(await deleteOrg(ana, orgId))).toEqual([403, "forbidden"]);
    const deleted = await deleteOrg(owner, orgId);
    expect(deleted.status).toBe(202);
    const { deletion } = (await deleted.json()) as { deletion: { dueAt: string } };
    expect(await (await deleteOrg(owner, orgId)).json()).toEqual({ deletion });
    expect(await deletionOf(ana)).toEqual({
      dueAt: deletion.dueAt,
      requestedAt: expect.any(String),
      requestedBy: { id: ownerId, name: "owner" },
    });
    expect(await answer(await restoreOrg(ana, orgId))).toEqual([403, "forbidden"]);

    await t.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.organizations.id, orgId));
    expect((await deletionOf(ana))?.dueAt).toBeNull();
    expect(await answer(await restoreOrg(owner, orgId))).toEqual([409, "org.not_restorable"]);
    expect(await purgeWorkspace({ db: t.db }, orgId)).toBe(true);
    expect(await answer(await restoreOrg(owner, orgId))).toEqual([404, "not_found"]);
    expect((await meOf(ana)).organizations).toEqual([]);
  });

  test("restored, it opens again; a workspace takes 3 deletions a day", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const statuses: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await deleteOrg(owner, orgId)).status);
      statuses.push((await restoreOrg(owner, orgId)).status);
      statuses.push((await owner(`/api/app/organizations/${orgId}`)).status);
    }
    expect(statuses).toEqual([202, 204, 200, 202, 204, 200, 202, 204, 200, 429, 409, 200]);
  });
});

/** A workspace `b` makes and finishes setting up, so their next one is a new one. */
async function workspace(b: Browser, name: string) {
  const made = (await (await b("/api/app/organizations", { json: { name } })).json()) as {
    organization: { id: string };
  };
  await b(`/api/app/organizations/${made.organization.id}/onboarding`, { method: "PATCH", json: { finished: true } });
  return made.organization.id;
}
const deleteAccount = (b: Browser, json?: Record<string, unknown>) =>
  b("/api/app/account", { method: "DELETE", ...(json ? { json } : {}) });

describe("deleting an account", () => {
  test("the preflight lists what stops it, what closes, what they leave, the computers that go and what stays behind", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com", { role: "admin" });
    const inAcme = (path: string, init?: Parameters<Browser>[1]) => bia(`/api/app/organizations/${orgId}${path}`, init);
    const key = { provider: "anthropic", label: "Bia's key", apiKey: "sk-ant-api-fake-1234" };
    expect((await inAcme("/credentials", { json: key })).status).toBe(201);
    const runner = { os: "linux", arch: "x64", hostname: "box", version: "0.1.0" };
    const laptop = await pairComputer(t, inAcme, runner, { name: "Bia's laptop" });
    const solo = await workspace(bia, "Solo");
    const team = await workspace(bia, "Team");
    await joinByInvitation(t, bia, team, "owner@example.com", { as: owner });
    // One being deleted already keeps its own date.
    const old = await workspace(bia, "Old");
    const { deletion } = (await (await deleteOrg(bia, old)).json()) as { deletion: { dueAt: string } };

    const plan = await (await bia("/api/app/account/deletion")).json();
    expect(plan).toEqual({
      password: true,
      freshUntil: expect.any(String),
      closes: [
        { id: solo, name: "Solo" },
        { id: old, name: "Old", deletion },
      ],
      leaves: [
        { id: orgId, name: "Acme", role: "member" },
        { id: team, name: "Team", role: "owner" },
      ],
      soleOwner: [{ id: team, name: "Team" }],
      computers: [{ orgId, id: laptop.machineId, name: "Bia's laptop" }],
      staysBehind: [{ orgId, kind: "key", name: "Bia's key" }],
      serverOwner: false,
    });
    expect(((await (await owner("/api/app/account/deletion")).json()) as { serverOwner: boolean }).serverOwner).toBe(
      true,
    );
    await signedInAnHourAgo((await meOf(bia)).user.id);
    expect(((await (await bia("/api/app/account/deletion")).json()) as { freshUntil: unknown }).freshUntil).toBeNull();
  });

  test("the password proves it's you, as a fresh sign-in does; an old session without it signs in again; a workspace's only owner hears that first", async () => {
    const revoked: unknown[] = [];
    await t.close();
    t = await createTestServer({
      appleRevoke: async (token) => {
        revoked.push(token);
      },
    });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
    const biaId = (await meOf(bia)).user.id;
    await t.db.insert(schema.accounts).values({
      id: "apple-bia",
      accountId: "apple-sub-bia",
      providerId: "apple",
      userId: biaId,
      refreshToken: "refresh-bia",
    });
    await signedInAnHourAgo((await meOf(owner)).user.id);
    await signedInAnHourAgo(biaId);

    const refused = await deleteAccount(owner);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "sole_owner", params: { organizations: ["Acme"], orgIds: [orgId] } },
    });
    expect(await answer(await deleteAccount(bia))).toEqual([403, "reauth.sign_in"]);
    expect(await answer(await deleteAccount(bia, { password: "not my password" }))).toEqual([403, "reauth.password"]);
    expect(revoked).toEqual([]);
    const deleted = await deleteAccount(bia, { password: "correct horse battery" });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token=;"))).toBe(true);
    expect(revoked).toEqual([{ value: "refresh-bia", hint: "refresh_token" }]);
    expect(await t.db.select().from(schema.users).where(eq(schema.users.id, biaId))).toEqual([]);

    // No body, signed in just now: how the phone's older builds delete.
    const cy = await joinByInvitation(t, owner, orgId, "cy@example.com");
    expect((await deleteAccount(cy)).status).toBe(204);
  });

  test("its other sessions: GET /me answers 401 and expires the cookies, and no workspace is made with them", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const other = browser(t);
    const signIn = { email: "owner@example.com", password: "correct horse battery" };
    expect((await other("/api/auth/sign-in/email", { json: signIn })).status).toBe(200);
    expect((await other("/api/app/me")).status).toBe(200);
    const cached = other.cookie();

    expect((await deleteAccount(owner, signIn)).status).toBe(204);
    const me = await other("/api/app/me");
    expect(me.status).toBe(401);
    expect(me.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_data=;"))).toBe(true);
    const made = await t.app.request("/api/app/organizations", {
      method: "POST",
      headers: { cookie: cached, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Late" }),
    });
    expect(await answer(made)).toEqual([401, "unauthorized"]);
  });

  test("a person makes at most 10 workspaces a day", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await owner("/api/app/organizations", { json: { name: `W${i}` } })).status);
    expect(statuses).toEqual([201, ...Array(9).fill(200), 429]);
  });
});
