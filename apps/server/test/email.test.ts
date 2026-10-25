import { afterEach, expect, test } from "bun:test";
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
