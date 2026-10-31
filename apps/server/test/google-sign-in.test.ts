import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  browser,
  createTestServer,
  GOOGLE_BACK,
  GOOGLE_ENV,
  googleSignIn,
  ORIGIN,
  signUp,
  type TestServer,
} from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** The confirmation emails sent to `email` so far, with their links. */
async function confirmations(server: TestServer, email: string) {
  await server.drain();
  return server.email.sent
    .filter((m) => m.to[0] === email)
    .flatMap((m) => /https?:\/\/\S+\/api\/auth\/verify-email\S*/.exec(m.text)?.[0] ?? []);
}

test("a password account not confirmed yet: Google links nothing and signs nobody in, on every app; the sign-in page gets the address back to send the confirmation again", async () => {
  t = await createTestServer({ env: GOOGLE_ENV });
  const server = t;
  await signUp(browser(server), "ana@acme.test");

  for (const app of ["web", "desktop", "phone"] as const) {
    const { location, browser: landed } = await googleSignIn(server, app, "ana@acme.test");
    expect(location.startsWith("/login?")).toBe(true);
    const back = new URL(location, ORIGIN).searchParams;
    expect([back.get("error"), back.get("email")]).toEqual(["account_not_linked", "ana@acme.test"]);
    expect((await landed("/api/app/me")).status).toBe(401);
  }
  const accounts = await server.db.select({ providerId: schema.accounts.providerId }).from(schema.accounts);
  expect(accounts).toEqual([{ providerId: "credential" }]);

  // "Mandar outro link" on that page: the onboarding's request, limited as it is (email.test.ts). Links are stamped
  // to the second, so a new second makes this one a new email.
  expect(await confirmations(server, "ana@acme.test")).toHaveLength(1);
  const page = browser(server);
  await Bun.sleep(1000 - (Date.now() % 1000));
  expect((await page("/api/auth/send-verification-email", { json: { email: "ana@acme.test" } })).status).toBe(200);
  const links = await confirmations(server, "ana@acme.test");
  expect(links).toHaveLength(2);

  // Confirmed from the link, the address is hers: Google signs her in and is linked to her account.
  const link = new URL(links.at(-1) ?? "");
  expect((await page(`${link.pathname}${link.search}`)).status).toBe(302);
  const { location, browser: web } = await googleSignIn(server, "web", "ana@acme.test");
  expect(location).toBe(GOOGLE_BACK.web);
  expect((await web("/api/app/me")).status).toBe(200);
  const linked = await server.db.select({ providerId: schema.accounts.providerId }).from(schema.accounts);
  expect(linked.map((a) => a.providerId).sort()).toEqual(["credential", "google"]);
});

test("a refusal of another kind comes back without the address", async () => {
  t = await createTestServer({ env: GOOGLE_ENV });
  const server = t;
  await signUp(browser(server), "owner@acme.test");
  // Past the first account sign-up is closed.
  const closed = await googleSignIn(server, "web", "bia@acme.test");
  const back = new URL(closed.location, ORIGIN).searchParams;
  expect([back.get("error"), back.get("email")]).toEqual(["SIGNUP_CLOSED", null]);
});
