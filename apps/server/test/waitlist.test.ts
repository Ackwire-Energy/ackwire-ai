import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("joining stores the email once, lowercase, with the language; the answer never tells it was there", async () => {
  const anon = browser(t);
  const first = await anon("/api/waitlist", { json: { email: "  Ana@Acme.com ", locale: "en" } });
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ ok: true });
  const again = await anon("/api/waitlist", { json: { email: "ana@acme.com", locale: "pt-BR" } });
  expect(again.status).toBe(202);
  expect(await again.json()).toEqual({ ok: true });

  const rows = await t.db.select().from(schema.waitlistEntries);
  expect(rows.map((r) => [r.email, r.locale, r.source])).toEqual([["ana@acme.com", "en", "landing"]]);
});

test("no locale means pt-BR", async () => {
  expect((await browser(t)("/api/waitlist", { json: { email: "bia@acme.com" } })).status).toBe(202);
  const [row] = await t.db.select().from(schema.waitlistEntries);
  expect(row?.locale).toBe("pt-BR");
});

test("a bad email or body is refused with a stable code", async () => {
  const anon = browser(t);
  const bad = await anon("/api/waitlist", { json: { email: "not-an-email" } });
  expect(bad.status).toBe(400);
  expect(await errorCode(bad)).toBe("invalid_email");
  const wrongLocale = await anon("/api/waitlist", { json: { email: "a@acme.com", locale: "fr" } });
  expect(wrongLocale.status).toBe(400);
  expect(await errorCode(wrongLocale)).toBe("invalid_request");
  expect(await t.db.select().from(schema.waitlistEntries)).toEqual([]);
});

test("only our own origin can join", async () => {
  const res = await browser(t)("/api/waitlist", { json: { email: "a@acme.com" }, origin: "https://evil.example" });
  expect(res.status).toBe(403);
  expect(await errorCode(res)).toBe("bad_origin");
  const none = await browser(t)("/api/waitlist", { json: { email: "a@acme.com" }, origin: null });
  expect(none.status).toBe(403);
});

test("too many attempts from one address are throttled", async () => {
  const anon = browser(t);
  const headers = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 10; i++) {
    expect((await anon("/api/waitlist", { json: { email: `p${i}@acme.com` }, headers })).status).toBe(202);
  }
  const limited = await anon("/api/waitlist", { json: { email: "p10@acme.com" }, headers });
  expect(limited.status).toBe(429);
  expect(await errorCode(limited)).toBe("rate_limited");
  // Another address is not affected.
  const other = await anon("/api/waitlist", {
    json: { email: "q@acme.com" },
    headers: { "x-forwarded-for": "198.51.100.2" },
  });
  expect(other.status).toBe(202);
});
