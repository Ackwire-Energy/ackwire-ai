import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { desktopChallenge } from "../src/desktop-sign-in";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

/**
 * The Mac app's window signs in with Google or Apple through the browser
 * (D79): the browser hands its fresh sign-in over for a challenge, the window
 * redeems it with the verifier and gets a session of its own.
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

test("the window gets its own session once the browser hands it over, once", async () => {
  t = await createTestServer();
  const site = browser(t);
  const window = browser(t);
  await signUp(site, "ana@acme.com");
  const { verifier, challenge } = pair();

  // Nothing yet: the window keeps asking.
  expect(await (await window("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({ signedIn: false });

  expect((await site("/api/auth/desktop/handoff", { json: { challenge } })).status).toBe(200);
  // Someone else's verifier gets nothing.
  expect(await (await window("/api/auth/desktop/redeem", { json: { verifier: pair().verifier } })).json()).toEqual({
    signedIn: false,
  });

  expect(await (await window("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({ signedIn: true });
  const me = (await (await window("/api/app/me")).json()) as { user: { email: string } };
  expect(me.user.email).toBe("ana@acme.com");
  // Its own session: different from the browser's.
  expect(window.cookie()).not.toBe(site.cookie());

  // Single use.
  const again = browser(t);
  expect(await (await again("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({ signedIn: false });
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
  const rows = await t.db
    .select()
    .from(schema.verifications)
    .where(eq(schema.verifications.identifier, `desktop-handoff:${challenge}`));
  expect(rows).toHaveLength(0);
});

test("only well-formed keys", async () => {
  t = await createTestServer();
  const site = browser(t);
  await signUp(site, "caio@acme.com");
  expect((await site("/api/auth/desktop/handoff", { json: { challenge: "short" } })).status).toBe(400);
  expect((await browser(t)("/api/auth/desktop/redeem", { json: { verifier: "x".repeat(200) } })).status).toBe(400);
});
