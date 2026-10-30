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
