import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("emails go through the outbox: invitation (create, batch, resend) and password reset", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  await t.drain();
  t.email.sent.length = 0; // sign-up verification email

  const res = await owner(`/api/app/organizations/${orgId}/invitations`, {
    json: { email: "ana@example.com", role: "member" },
  });
  const { url } = (await res.json()) as { url: string };
  expect(t.email.sent).toEqual([]); // never inline in the request
  await t.drain();
  expect(t.email.sent.map((m) => [m.to, m.subject])).toEqual([
    [["ana@example.com"], "owner convidou você para Acme no agentes"],
  ]);
  expect(t.email.sent[0]?.text).toContain(url);

  await owner(`/api/app/organizations/${orgId}/invitations/batch`, {
    json: { emails: ["bia@example.com"], role: "admin" },
  });
  const all = (await (await owner(`/api/app/organizations/${orgId}/invitations/all`)).json()) as {
    invitations: { id: string; email: string }[];
  };
  await owner(`/api/app/organizations/${orgId}/invitations/${all.invitations[0]?.id}/resend`, { json: {} });
  await t.drain();
  expect(t.email.sent.map((m) => m.to[0]).sort()).toEqual(["ana@example.com", "ana@example.com", "bia@example.com"]);
  expect(new Set(t.email.sent.map((m) => m.idempotencyKey)).size).toBe(3);

  const reset = await browser(t)("/api/auth/request-password-reset", {
    json: { email: "owner@example.com", redirectTo: "/reset" },
  });
  expect(reset.status).toBe(200);
  await t.drain();
  expect(t.email.sent.at(-1)).toMatchObject({ to: ["owner@example.com"], subject: "Redefinir sua senha do agentes" });
});

test("password reset: the email links straight to the web's /reset-password with a token, good once", async () => {
  t = await createTestServer();
  await signUp(browser(t), "owner@example.com");
  await t.drain();
  const anon = browser(t);
  const asked = await anon("/api/auth/request-password-reset", {
    json: { email: "owner@example.com", redirectTo: "/reset-password" },
  });
  expect(asked.status).toBe(200);
  await t.drain();
  // No redirect through /api/auth: the same address opens the phone app when it is installed (app-links.ts).
  const link = new URL(/https?:\/\/\S+\/reset-password\S*/.exec(t.email.sent.at(-1)?.text ?? "")?.[0] ?? "", ORIGIN);
  expect(`${link.origin}${link.pathname}`).toBe(`${ORIGIN}/reset-password`);
  const token = link.searchParams.get("token") ?? "";
  expect(token).not.toBe("");
  const reset = await anon("/api/auth/reset-password", { json: { token, newPassword: "a brand new password" } });
  expect(reset.status).toBe(200);
  const signIn = await anon("/api/auth/sign-in/email", {
    json: { email: "owner@example.com", password: "a brand new password" },
  });
  expect(signIn.status).toBe(200);

  // A used (or expired) token gets the 400 the page shows as an expired link.
  const again = await anon("/api/auth/reset-password", { json: { token, newPassword: "another new password" } });
  expect(again.status).toBe(400);
  expect(await again.json()).toMatchObject({ code: "INVALID_TOKEN" });
});

test("the sign-up's own language: the confirmation email and the account follow it before anything else is picked", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const localeOf = async (email: string) =>
    (await t.db.select({ locale: schema.users.locale }).from(schema.users).where(eq(schema.users.email, email)))[0]
      ?.locale;
  // Neither the web app nor the phone app names a page for the link: the server picks it.
  const signUpIn = async (email: string, acceptLanguage: string, callbackURL?: string) => {
    const b = browser(t);
    const res = await b("/api/auth/sign-up/email", {
      json: { email, password: "correct horse battery", name: "Bia", ...(callbackURL ? { callbackURL } : {}) },
      headers: { "accept-language": acceptLanguage },
    });
    expect(res.status).toBe(200);
    await t.drain();
    return b;
  };
  const linkTo = (email: string) => {
    const text = t.email.sent.filter((m) => m.to[0] === email).at(-1)?.text ?? "";
    return new URL(/https?:\/\/\S+\/api\/auth\/verify-email\S*/.exec(text)?.[0] ?? "", ORIGIN);
  };

  // The web app says its own language; a browser's list counts its most preferred language of ours.
  const bia = await signUpIn("bia@example.com", "en");
  expect(t.email.sent.at(-1)).toMatchObject({ to: ["bia@example.com"], subject: "Confirm your email on agentes" });
  expect(await localeOf("bia@example.com")).toBe("en");
  const ana = await signUpIn("ana@example.com", "de-DE,pt-PT;q=0.9,en;q=0.8");
  expect(t.email.sent.at(-1)).toMatchObject({ to: ["ana@example.com"], subject: "Confirme seu e-mail no agentes" });
  expect(await localeOf("ana@example.com")).toBe("pt-BR");

  // The link works for the hour the onboarding promises.
  const [, payload = ""] = (linkTo("bia@example.com").searchParams.get("token") ?? "").split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iat: number; exp: number };
  expect(claims.exp - claims.iat).toBe(60 * 60);

  // Not confirmed until its link is opened; the link lands where the web app says how it went.
  const me = async () => ((await (await bia("/api/app/me")).json()) as { user: { emailVerified: boolean } }).user;
  expect((await me()).emailVerified).toBe(false);
  const link = linkTo("bia@example.com");
  const opened = await browser(t)(`${link.pathname}${link.search}`);
  expect(opened.status).toBe(302);
  expect(opened.headers.get("location")).toBe("/?email_confirmed=1");
  expect((await me()).emailVerified).toBe(true);

  // A new link, asked for while signed in: in the account's language, landing in the same place. (A link is
  // stamped to the second: asked for within the sign-up's second, it would be the same link.)
  await Bun.sleep(1000 - (Date.now() % 1000));
  const sent = t.email.sent.length;
  const again = await ana("/api/auth/send-verification-email", { json: { email: "ana@example.com" } });
  expect(again.status).toBe(200);
  await t.drain();
  expect(t.email.sent.slice(sent)).toMatchObject([
    { to: ["ana@example.com"], subject: "Confirme seu e-mail no agentes" },
  ]);
  expect(linkTo("ana@example.com").searchParams.get("callbackURL")).toBe("/?email_confirmed=1");
  // A sign-up that names its own page keeps it.
  await signUpIn("caio@example.com", "pt-BR", "/onboarding");
  expect(linkTo("caio@example.com").searchParams.get("callbackURL")).toBe("/onboarding");

  // An account that never had a language (made before sign-up kept one): the reset follows the request's.
  await signUp(browser(t), "old@example.com");
  await t.db.update(schema.users).set({ locale: null }).where(eq(schema.users.email, "old@example.com"));
  await t.drain();
  await browser(t)("/api/auth/request-password-reset", {
    json: { email: "old@example.com", redirectTo: "/reset-password" },
    headers: { "accept-language": "en-US,en;q=0.9" },
  });
  await t.drain();
  expect(t.email.sent.at(-1)).toMatchObject({ to: ["old@example.com"], subject: "Reset your agentes password" });
});
