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

/** The token in the last password reset email sent to `email`. */
async function resetToken(server: TestServer, email: string) {
  await server.drain();
  const mail = server.email.sent.filter((m) => m.to[0] === email).at(-1);
  const link = /https?:\/\/\S+\/reset-password\S*/.exec(mail?.text ?? "")?.[0] ?? "";
  return new URL(link, ORIGIN).searchParams.get("token") ?? "";
}

test("a password account not confirmed yet: Google links nothing and signs nobody in, on every app; a new password by email ends the one nobody proved, then Google joins", async () => {
  t = await createTestServer({ env: GOOGLE_ENV });
  const server = t;
  // Whoever made this account may not own the address.
  const maker = browser(server);
  await signUp(maker, "ana@acme.test");

  for (const app of ["web", "desktop", "phone"] as const) {
    const { location, browser: landed } = await googleSignIn(server, app, "ana@acme.test");
    expect(location.startsWith("/login?")).toBe(true);
    const back = new URL(location, ORIGIN).searchParams;
    expect([back.get("error"), back.get("email")]).toEqual(["account_not_linked", "ana@acme.test"]);
    expect((await landed("/api/app/me")).status).toBe(401);
  }
  const accounts = await server.db.select({ providerId: schema.accounts.providerId }).from(schema.accounts);
  expect(accounts).toEqual([{ providerId: "credential" }]);

  // "Criar uma senha nova" on that page: the forgot-password step's request, limited as it is (email.test.ts).
  const ana = browser(server);
  const asked = await ana("/api/auth/request-password-reset", {
    json: { email: "ana@acme.test", redirectTo: "/reset-password" },
  });
  expect(asked.status).toBe(200);
  const token = await resetToken(server, "ana@acme.test");
  expect(
    (await ana("/api/auth/reset-password", { json: { token, newPassword: "ana's very own password" } })).status,
  ).toBe(200);

  // The password from before signs nobody in, and the sessions it made are over.
  const before = { email: "ana@acme.test", password: "correct horse battery" };
  expect((await browser(server)("/api/auth/sign-in/email", { json: before })).status).toBe(401);
  expect(await (await maker("/api/auth/get-session?disableCookieCache=true")).json()).toBeNull();
  const users = await server.db.select({ emailVerified: schema.users.emailVerified }).from(schema.users);
  expect(users).toEqual([{ emailVerified: true }]);

  // The link reached her mailbox, so the address is hers: Google signs her in and joins her account.
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
