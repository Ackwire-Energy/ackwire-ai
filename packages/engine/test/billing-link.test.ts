import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import {
  BILLING_FROM,
  type BillingLinkClaims,
  mintBillingLink,
  setBillingHold,
  setOrgStanding,
  signBillingLink,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

// The billing service checks the same vector: both sides sign and verify these exact bytes.
const SECRET = "test-billing-link-secret-000000000000000";
const VECTOR: BillingLinkClaims = {
  aud: "agentes-billing",
  jti: "00000000-0000-4000-8000-000000000001",
  iat: 1798761600,
  exp: 1798761900,
  orgId: "00000000-0000-4000-8000-0000000000aa",
  orgName: "Acme",
  userId: "user_test_1",
  email: "ana@example.com",
  name: "Ana",
  role: "owner",
  locale: "pt-BR",
  from: "settings",
  return: "/org/00000000-0000-4000-8000-0000000000aa/settings/billing",
  usage: { members: 3, agents: 6, storageBytes: 1073741824 },
};
const TOKEN =
  "v1.eyJhdWQiOiJhZ2VudGVzLWJpbGxpbmciLCJqdGkiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJpYXQiOjE3OTg3NjE2MDAsImV4cCI6MTc5ODc2MTkwMCwib3JnSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwYWEiLCJvcmdOYW1lIjoiQWNtZSIsInVzZXJJZCI6InVzZXJfdGVzdF8xIiwiZW1haWwiOiJhbmFAZXhhbXBsZS5jb20iLCJuYW1lIjoiQW5hIiwicm9sZSI6Im93bmVyIiwibG9jYWxlIjoicHQtQlIiLCJmcm9tIjoic2V0dGluZ3MiLCJyZXR1cm4iOiIvb3JnLzAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDBhYS9zZXR0aW5ncy9iaWxsaW5nIiwidXNhZ2UiOnsibWVtYmVycyI6MywiYWdlbnRzIjo2LCJzdG9yYWdlQnl0ZXMiOjEwNzM3NDE4MjR9fQ.dvyPwQDNmTuhUO1sFg7AEXupL2WW8PZMVBjHbgKxVYg";

const NOW = new Date("2027-01-01T00:00:00Z");
const mint = (
  userId: string,
  from: (typeof BILLING_FROM)[number] = "settings",
  baseUrl = "https://billing.example.com",
) => mintBillingLink(f.db, { secret: SECRET, baseUrl, userId, orgId: f.org.id, from, now: NOW });

/** The link's token, checked like the billing service checks it: the HMAC over the payload as sent. */
function claimsOf(url: string) {
  const token = new URL(url).searchParams.get("t") ?? "";
  const [version, payload, signature] = token.split(".");
  expect(version).toBe("v1");
  expect(signature).toBe(createHmac("sha256", SECRET).update(`v1.${payload}`).digest("base64url"));
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as BillingLinkClaims;
}

describe("signBillingLink", () => {
  test("the shared test vector, byte for byte", () => {
    expect(signBillingLink(SECRET, VECTOR)).toBe(TOKEN);
  });
});

describe("mintBillingLink", () => {
  test("an owner's link: who, where, for 5 minutes, in the vector's key order", async () => {
    const link = await mint(f.owner.id);
    expect(link.url.startsWith("https://billing.example.com/link?t=v1.")).toBe(true);
    expect(link.expiresAt).toEqual(new Date(NOW.getTime() + 300_000));
    const [owner] = await f.db.select().from(schema.users).where(eq(schema.users.id, f.owner.id));
    const claims = claimsOf(link.url);
    expect(Object.keys(claims)).toEqual(Object.keys(VECTOR));
    expect(Object.keys(claims.usage)).toEqual(Object.keys(VECTOR.usage));
    expect(claims).toEqual({
      aud: "agentes-billing",
      jti: expect.any(String),
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 300,
      orgId: f.org.id,
      orgName: "Acme",
      userId: f.owner.id,
      email: owner?.email ?? "",
      name: owner?.name ?? "",
      role: "owner",
      locale: "pt-BR",
      from: "settings",
      return: `/org/${f.org.id}/settings/billing`,
      usage: { members: 1, agents: 1, storageBytes: null },
    });
    // Single use on the billing side: every link is its own.
    expect(claimsOf((await mint(f.owner.id)).url).jti).not.toBe(claims.jti);
  });

  test("admins too, in their language; back to where each entry point opened it", async () => {
    const admin = await addMember(f.db, f.org.id, "admin");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, admin.id));
    const returns = Object.fromEntries(
      await Promise.all(BILLING_FROM.map(async (from) => [from, claimsOf((await mint(admin.id, from)).url).return])),
    );
    const org = `/org/${f.org.id}`;
    expect(returns).toEqual({
      settings: `${org}/settings/billing`,
      hold: org,
      onboarding: org,
      new_workspace: org,
      invite_full: `${org}/members`,
      upload_full: org,
      storage: `${org}/settings/storage`,
    });
    const claims = claimsOf((await mint(admin.id, "hold", "https://billing.example.com/")).url);
    expect(claims).toMatchObject({ role: "admin", locale: "en", usage: { members: 2 } });
  });

  test("members and strangers never get one; a held workspace does, a suspended one doesn't", async () => {
    const member = await addMember(f.db, f.org.id, "member");
    await expect(mint(member.id)).rejects.toMatchObject({ code: "forbidden" });
    const stranger = await addUser(f.db, "eve");
    await expect(mint(stranger.id)).rejects.toMatchObject({ code: "forbidden" });

    await setBillingHold({ db: f.db }, f.org.id, "payment");
    expect(claimsOf((await mint(f.owner.id, "hold")).url).from).toBe("hold");
    await setOrgStanding({ db: f.db }, f.org.id, { state: "suspended", reason: "abuse", notice: "shown" });
    await expect(mint(f.owner.id)).rejects.toMatchObject({ code: "org.suspended" });
  });
});
