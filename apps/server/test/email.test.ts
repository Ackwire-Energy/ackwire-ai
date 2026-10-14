import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

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
