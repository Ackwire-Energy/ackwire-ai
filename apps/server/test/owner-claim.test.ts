import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { deleteAccount } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

/**
 * The installation's first account when the install left a secret for its owner (ADR 0060 §6): the
 * setup's owner link (a claim) or the desktop app's owner key. Every other way to the first account
 * waits until the owner exists.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const CLAIM = "claim-token-0123456789abcdefghijklmnopqrstu";
const KEY = "owner-key-0123456789abcdefghijklmnopqrstuvwx";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const PASSWORD = "correct horse battery";

const instance = async () => (await (await t.app.request("/api/instance")).json()) as Record<string, unknown>;
const authConfig = async () => (await (await t.app.request("/api/app/auth-config")).json()) as Record<string, unknown>;

/** What the desktop app sends, from no web view: no Origin, no cookie. */
const ownerKey = (body: Record<string, unknown>) =>
  t.app.request("/api/auth/owner-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A window trading a one-time sign-in for its own session. */
async function trade(token: string) {
  const window = browser(t);
  const res = await window("/api/auth/sign-in/one-time-token", { json: { token } });
  return { res, window };
}

describe("the owner link (OWNER_CLAIM_SHA256)", () => {
  test("the first account waits for it, by email and by any other sign-up", async () => {
    t = await createTestServer({ env: { OWNER_CLAIM_SHA256: sha256(CLAIM) } });
    expect(await instance()).toMatchObject({ ownerClaim: true, signup: "invite" });
    expect(await authConfig()).toMatchObject({ ownerClaim: true, firstRun: false, signupOpen: false });

    const res = await browser(t)("/api/auth/sign-up/email", {
      json: { name: "Ana", email: "ana@example.com", password: PASSWORD },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "OWNER_CLAIM_REQUIRED" });
    const options = await browser(t)("/api/app/sign-in-options", { json: { email: "ana@example.com" } });
    expect(await options.json()).toMatchObject({ account: false, canSignUp: false });
    // Social sign-ups create users through the same hook.
    const { internalAdapter } = await t.auth.$context;
    await expect(
      internalAdapter.createUser({ name: "Ana", email: "ana@example.com" }, { method: "email-password" }),
    ).rejects.toThrow(/waits for its owner/);
    expect(await t.db.select().from(schema.users)).toEqual([]);
  });

  test("it makes the owner once, with a password, and signs them in", async () => {
    t = await createTestServer({ env: { OWNER_CLAIM_SHA256: sha256(CLAIM) } });
    const owner = browser(t);
    expect(
      (
        await owner("/api/auth/owner-claim", {
          json: { token: "x".repeat(43), name: "Ana", email: "a@x.io", password: PASSWORD },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await owner("/api/auth/owner-claim", {
          json: { token: CLAIM, name: "Ana", email: "ana@example.com", password: "short" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await owner("/api/auth/owner-claim", { json: { token: CLAIM, name: "Ana", email: "ana@example.com" } })).status,
    ).toBe(400);

    const claimed = await owner("/api/auth/owner-claim", {
      json: { token: CLAIM, name: "Ana", email: "Ana@Example.com", password: PASSWORD },
    });
    expect(claimed.status).toBe(201);
    const me = (await (await owner("/api/app/me")).json()) as { user: { email: string; hasPassword: boolean } };
    expect(me.user).toMatchObject({ email: "ana@example.com", hasPassword: true });
    const org = await owner("/api/app/organizations", { json: { name: "Acme" } });
    expect(org.status).toBe(201);

    // Inert from here: the link again, and the ordinary rules for everyone else.
    const again = await browser(t)("/api/auth/owner-claim", {
      json: { token: CLAIM, name: "Bia", email: "bia@example.com", password: PASSWORD },
    });
    expect(again.status).toBe(409);
    expect(await instance()).toMatchObject({ ownerClaim: false });
    expect(
      (await browser(t)("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: PASSWORD } })).status,
    ).toBe(200);
    const second = await browser(t)("/api/auth/sign-up/email", {
      json: { name: "Bia", email: "bia@example.com", password: PASSWORD },
    });
    expect(second.status).toBe(403);
    expect(await t.db.select().from(schema.users)).toHaveLength(1);
  });

  test("without it nothing changes: the first account to sign up owns the installation", async () => {
    t = await createTestServer();
    expect(await instance()).toMatchObject({ ownerClaim: false, signup: "open" });
    expect(await authConfig()).toMatchObject({ ownerClaim: false, firstRun: true });
    expect(
      (
        await browser(t)("/api/auth/owner-claim", {
          json: { token: CLAIM, name: "A", email: "a@x.io", password: PASSWORD },
        })
      ).status,
    ).toBe(404);
    await signUp(browser(t), "ana@example.com");
  });
});

describe("the desktop app's owner key (OWNER_KEY_SHA256)", () => {
  test("makes the owner with no password, then a one-time sign-in for them on every call", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY) } });
    expect((await ownerKey({ key: "y".repeat(43), name: "Ana", email: "ana@example.com" })).status).toBe(401);
    const none = await ownerKey({ key: KEY });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: "OWNER_NONE" });
    const signup = await browser(t)("/api/auth/sign-up/email", {
      json: { name: "Eve", email: "eve@example.com", password: PASSWORD },
    });
    expect(signup.status).toBe(403);

    const first = await ownerKey({ key: KEY, name: "Ana", email: "ana@example.com" });
    expect(first.status).toBe(200);
    const { token, userId } = (await first.json()) as { token: string; expiresIn: number; userId: string };
    const { res, window } = await trade(token);
    expect(res.status).toBe(200);
    const me = (await (await window("/api/app/me")).json()) as {
      user: { id: string; email: string; hasPassword: boolean };
    };
    expect(me.user).toMatchObject({ email: "ana@example.com", hasPassword: false });
    // Who the owner is: the app compares it with who its window was signed in as.
    expect(userId).toBe(me.user.id);
    // Single use.
    expect((await trade(token)).res.status).toBe(401);

    // Later (a session that ended): the same owner, no name needed, any extra fields ignored.
    const later = await ownerKey({ key: KEY, name: "Someone", email: "someone@example.com" });
    const again = await trade(((await later.json()) as { token: string }).token);
    expect(again.res.status).toBe(200);
    expect(((await (await again.window("/api/app/me")).json()) as { user: { email: string } }).user.email).toBe(
      "ana@example.com",
    );
    expect(await t.db.select().from(schema.users)).toHaveLength(1);
  });

  test("the owner adds a password for other browsers, then a new one after Continue on this Mac (ADR 0158)", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY) } });
    const { token } = (await (await ownerKey({ key: KEY, name: "Ana", email: "ana@example.com" })).json()) as {
      token: string;
    };
    const { window } = await trade(token);
    expect(
      (await browser(t)("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: PASSWORD } })).status,
    ).toBe(401);
    expect((await window("/api/app/me/password", { json: { password: "short" } })).status).toBe(400);
    expect((await window("/api/app/me/password", { json: { password: PASSWORD } })).status).toBe(204);
    expect(
      (await browser(t)("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: PASSWORD } })).status,
    ).toBe(200);
    // Forgot it: the app signs the owner in again with its key, and the fresh sign-in sets a new one.
    const again = (await (await ownerKey({ key: KEY })).json()) as { token: string };
    const { window: fresh } = await trade(again.token);
    expect((await fresh("/api/app/me/password", { json: { password: "another one entirely" } })).status).toBe(204);
    // Every other session ended with the old password: only the window that set it stays signed in.
    expect(await t.db.select().from(schema.sessions)).toHaveLength(1);
    const signIn = (password: string) =>
      browser(t)("/api/auth/sign-in/email", { json: { email: "ana@example.com", password } });
    expect((await signIn(PASSWORD)).status).toBe(401);
    expect((await signIn("another one entirely")).status).toBe(200);
  });

  test("the key follows the pinned owner: once she deleted her account it answers OWNER_GONE, never Bia", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY), ALLOW_SIGNUP: "true" } });
    expect((await ownerKey({ key: KEY, name: "Ana", email: "ana@example.com" })).status).toBe(200);
    const [ana] = await t.db.select().from(schema.users);
    if (!ana) throw new Error("no owner account");
    // A newer account, then the owner deletes hers (deleteAccount pins the owner first, so it stays Ana once gone).
    await signUp(browser(t), "bia@example.com");
    await deleteAccount(t.db, ana.id);
    expect((await ownerKey({ key: "y".repeat(43) })).status).toBe(401);
    const later = await ownerKey({ key: KEY, name: "Carla", email: "carla@example.com" });
    expect(later.status).toBe(409);
    const body = (await later.json()) as { code?: string; token?: string };
    expect(body.code).toBe("OWNER_GONE");
    expect(body.token).toBeUndefined();
    expect(await t.db.select().from(schema.users)).toHaveLength(1);
  });

  test("the only account deleted: the key alone answers OWNER_NONE, with a name and email it makes the new owner", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY) } });
    expect((await ownerKey({ key: KEY, name: "Ana", email: "ana@example.com" })).status).toBe(200);
    const [ana] = await t.db.select().from(schema.users);
    if (!ana) throw new Error("no owner account");
    await deleteAccount(t.db, ana.id);
    const none = await ownerKey({ key: KEY });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: "OWNER_NONE" });

    const made = await ownerKey({ key: KEY, name: "Carla", email: "carla@example.com" });
    expect(made.status).toBe(200);
    const { token, userId } = (await made.json()) as { token: string; userId: string };
    const { res, window } = await trade(token);
    expect(res.status).toBe(200);
    const me = (await (await window("/api/app/me")).json()) as { user: { id: string; email: string } };
    expect(me.user).toMatchObject({ id: userId, email: "carla@example.com" });
  });
});

describe("deleting with no password on the desktop app's own server (ADR 0088 §2, addendum 2026-11-14)", () => {
  /** A response's status and error code. */
  const answer = async (res: Response) => [
    res.status,
    ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code,
  ];
  /** A window the app signs in as the owner with its key: Continue on this Mac. */
  const continueOnThisMac = async () => {
    const res = await ownerKey({ key: KEY, name: "Ana", email: "ana@example.com" });
    return (await trade(((await res.json()) as { token: string }).token)).window;
  };
  const meOf = async (b: Browser) =>
    ((await (await b("/api/app/me")).json()) as { user: { id: string; confirmsOnThisMac: boolean } }).user;
  const workspace = async (b: Browser, name = "Acme") =>
    ((await (await b("/api/app/organizations", { json: { name } })).json()) as { organization: { id: string } })
      .organization.id;
  const deleteOrg = (b: Browser, orgId: string, json: Record<string, unknown> = {}) =>
    b(`/api/app/organizations/${orgId}/deletion`, { json });
  const deleteMyAccount = (b: Browser, json: Record<string, unknown> = {}) =>
    b("/api/app/account", { method: "DELETE", json });
  /** Every session of theirs signed in an hour ago, as the database says. */
  const signedInAnHourAgo = (userId: string) =>
    t.db
      .update(schema.sessions)
      .set({ createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(schema.sessions.userId, userId));

  test("a fresh sign-in through the key deletes; an old one, a phone minted from it, and a teammate don't", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY) }, emailDelivers: false });
    const owner = await continueOnThisMac();
    const ownerMe = await meOf(owner);
    expect(ownerMe.confirmsOnThisMac).toBe(true);
    const orgId = await workspace(owner);
    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
    // A teammate, signed in just now: still their password.
    expect((await meOf(bia)).confirmsOnThisMac).toBe(false);
    expect(await answer(await deleteMyAccount(bia))).toEqual([403, "reauth.password"]);

    await signedInAnHourAgo(ownerMe.id);
    expect(await answer(await deleteOrg(owner, orgId))).toEqual([403, "reauth.sign_in"]);
    // A phone signed in from that old session signed in when it did.
    const { token } = (await (await owner("/api/app/phone-sign-in", { json: {} })).json()) as { token: string };
    const phone = browser(t);
    expect((await phone("/api/auth/sign-in/one-time-token", { json: { token } })).status).toBe(200);
    expect((await meOf(phone)).confirmsOnThisMac).toBe(true);
    expect(await answer(await deleteOrg(phone, orgId))).toEqual([403, "reauth.sign_in"]);

    // Continue on this Mac again: nothing to type.
    expect((await deleteOrg(await continueOnThisMac(), orgId)).status).toBe(202);
    // The account too, the same way.
    await signedInAnHourAgo(ownerMe.id);
    expect(await answer(await deleteMyAccount(owner))).toEqual([403, "reauth.sign_in"]);
    expect((await deleteMyAccount(await continueOnThisMac())).status).toBe(204);
  });

  test("an owner who added a password: a fresh sign-in is enough, an old one still takes the password", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY) }, emailDelivers: false });
    const owner = await continueOnThisMac();
    expect((await owner("/api/app/me/password", { json: { password: PASSWORD } })).status).toBe(204);
    const ownerMe = await meOf(owner);
    expect(ownerMe.confirmsOnThisMac).toBe(true);
    expect((await deleteOrg(owner, await workspace(owner, "First"))).status).toBe(202);

    const second = await workspace(owner, "Second");
    await signedInAnHourAgo(ownerMe.id);
    expect(await answer(await deleteOrg(owner, second))).toEqual([403, "reauth.sign_in"]);
    expect(await answer(await deleteOrg(owner, second, { password: "not my password" }))).toEqual([
      403,
      "reauth.password",
    ]);
    expect((await deleteOrg(owner, second, { password: PASSWORD })).status).toBe(202);
  });

  test("a server that sends email still takes the emailed code, even from the owner signed in just now", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY) } });
    const owner = await continueOnThisMac();
    expect((await meOf(owner)).confirmsOnThisMac).toBe(false);
    expect(await answer(await deleteOrg(owner, await workspace(owner)))).toEqual([403, "reauth.code"]);
  });

  test("a server with no owner key takes the password from its first account, however fresh", async () => {
    t = await createTestServer({ emailDelivers: false });
    const owner = browser(t);
    await signUp(owner, "ana@example.com");
    expect((await meOf(owner)).confirmsOnThisMac).toBe(false);
    expect(await answer(await deleteOrg(owner, await workspace(owner)))).toEqual([403, "reauth.password"]);
  });
});
