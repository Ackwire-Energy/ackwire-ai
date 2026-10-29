import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { schema } from "@agenteschat/db";
import { desktopChallenge, HANDOFF_PREFIX } from "../src/desktop-sign-in";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

/**
 * The Mac app's window signs in with Google or Apple through the browser
 * (ADR 0036): the browser hands its fresh sign-in over for a challenge and gets a
 * one-time code, which it gives the app on this computer through the app's link;
 * the window redeems code + verifier and gets a session of its own.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const pair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: desktopChallenge(verifier) };
};

const handoff = async (site: ReturnType<typeof browser>, challenge: string) => {
  const res = await site("/api/auth/desktop/handoff", { json: { challenge } });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return code;
};

test("the window gets its own session with the code and its verifier, once", async () => {
  t = await createTestServer();
  const site = browser(t);
  const window = browser(t);
  await signUp(site, "ana@acme.com");
  const { verifier, challenge } = pair();
  const code = await handoff(site, challenge);
  // The code isn't the challenge: nothing that travelled in the sign-in link finds the row.
  expect(code).not.toBe(challenge);

  expect(await (await window("/api/auth/desktop/redeem", { json: { code, verifier } })).json()).toEqual({
    signedIn: true,
  });
  const me = (await (await window("/api/app/me")).json()) as { user: { email: string } };
  expect(me.user.email).toBe("ana@acme.com");
  // Its own session: different from the browser's.
  expect(window.cookie()).not.toBe(site.cookie());

  // Single use.
  const again = browser(t);
  expect(await (await again("/api/auth/desktop/redeem", { json: { code, verifier } })).json()).toEqual({
    signedIn: false,
  });
});

test("a sign-in link made by someone else hands them nothing", async () => {
  t = await createTestServer();
  // The attacker made the link: they know its verifier and challenge.
  const attacker = pair();
  const victim = browser(t);
  await signUp(victim, "bia@acme.com");
  // The victim's browser follows the link, signs in and hands over; the code goes to the victim's own app.
  const code = await handoff(victim, attacker.challenge);

  // The verifier alone redeems nothing (the old polling): the code is required, and a guessed one finds nothing.
  const thief = browser(t);
  expect((await thief("/api/auth/desktop/redeem", { json: { verifier: attacker.verifier } })).status).toBe(400);
  expect(
    await (
      await thief("/api/auth/desktop/redeem", {
        json: { code: randomBytes(32).toString("base64url"), verifier: attacker.verifier },
      })
    ).json(),
  ).toEqual({ signedIn: false });

  // The victim's app gets the code but holds no verifier for that challenge: nothing, and the code is spent.
  const app = browser(t);
  expect(await (await app("/api/auth/desktop/redeem", { json: { code, verifier: pair().verifier } })).json()).toEqual(
    { signedIn: false },
  );
  expect(
    await (await thief("/api/auth/desktop/redeem", { json: { code, verifier: attacker.verifier } })).json(),
  ).toEqual({ signedIn: false });
  expect((await thief("/api/app/me")).status).toBe(401);
});

test("a handoff needs a signed-in browser with a fresh sign-in", async () => {
  t = await createTestServer();
  const { challenge } = pair();
  expect((await browser(t)("/api/auth/desktop/handoff", { json: { challenge } })).status).toBe(401);

  const site = browser(t);
  await signUp(site, "bia@acme.com");
  await t.db.update(schema.sessions).set({ createdAt: new Date(Date.now() - 60 * 60_000) });
  // The cookie cache still has the old copy for a few minutes: a new browser on the same session row.
  const stale = browser(t);
  const token = site
    .cookie()
    .split("; ")
    .find((c) => c.includes("session_token="));
  if (!token) throw new Error("no session cookie");
  const res = await stale("/api/auth/desktop/handoff", { json: { challenge }, headers: { cookie: token } });
  expect(res.status).toBe(403);
  const rows = await t.db.select().from(schema.verifications);
  expect(rows.filter((r) => r.identifier.startsWith(HANDOFF_PREFIX))).toHaveLength(0);
});

test("only well-formed keys", async () => {
  t = await createTestServer();
  const site = browser(t);
  await signUp(site, "caio@acme.com");
  expect((await site("/api/auth/desktop/handoff", { json: { challenge: "short" } })).status).toBe(400);
  const { verifier } = pair();
  expect((await browser(t)("/api/auth/desktop/redeem", { json: { code: "x".repeat(200), verifier } })).status).toBe(
    400,
  );
  expect((await browser(t)("/api/auth/desktop/redeem", { json: { code: verifier, verifier: "short" } })).status).toBe(
    400,
  );
});
