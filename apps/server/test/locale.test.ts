import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("the person's language (ADR 0121): PATCH /me saves any language of the app, /me returns it", async () => {
  t = await createTestServer();
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const me = async () =>
    ((await (await ana("/api/app/me")).json()) as { user: { locale: string | null; localeAuto: boolean } }).user;
  expect(await me()).toMatchObject({ localeAuto: true });

  expect((await ana("/api/app/me", { method: "PATCH", json: { locale: "fr", auto: false } })).status).toBe(204);
  expect(await me()).toMatchObject({ locale: "fr", localeAuto: false });
  // Detected by a device: `auto` defaults to false only when it is left out.
  expect((await ana("/api/app/me", { method: "PATCH", json: { locale: "ja", auto: true } })).status).toBe(204);
  expect(await me()).toMatchObject({ locale: "ja", localeAuto: true });
  expect((await ana("/api/app/me", { method: "PATCH", json: { locale: "xx" } })).status).toBe(400);

  // An email to them is written in that language (English where it has no words yet).
  await ana("/api/app/me", { method: "PATCH", json: { locale: "fr" } });
  await t.drain();
  const before = t.email.sent.length;
  const reset = await browser(t)("/api/auth/request-password-reset", {
    json: { email: "ana@example.com", redirectTo: "/reset-password" },
  });
  expect(reset.status).toBe(200);
  await t.drain();
  expect(t.email.sent.slice(before).map((m) => m.html.includes('lang="fr"'))).toEqual([true]);
});
