import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFakeEmailSender } from "@agenteschat/adapters";
import { countQueries, type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  ConflictError,
  canCreateWorkspace,
  createInvitation,
  createOrganization,
  deleteAccount,
  EARLY_ACCESS_TOKEN,
  earlyAccessEmail,
  enqueueWaitlistContacts,
  hasWorkspaceAllowance,
  importWaitlist,
  inviteEarlyAccess,
  isSignupAllowed,
  listEarlyAccess,
  NotFoundError,
  needsWorkspaceAllowance,
  resendEarlyAccess,
  revokeEarlyAccess,
  type SignupPolicy,
  saveWaitlistContact,
  setSignupMode,
  sha256,
  signInOptions,
  signupAdmission,
  signupMode,
  useEarlyAccess,
  ValidationError,
  waitlistCounts,
  waitlistNext,
} from "../src";

const { earlyAccessInvitations: invitations, waitlistEntries, outbox } = schema;

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(() => close());

const CLOSED: SignupPolicy = { allowSignup: false, ownerByLink: false };
const CLOUD = { paidMachines: true, allowSignup: false };
const APP = "https://app.test";
const T0 = new Date("2026-11-02T12:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

let accounts = 0;
// A millisecond apart, in order: made back to back they could share `created_at`, and the installation's owner (the
// earliest) would then be picked by a random id.
async function account(email: string) {
  const id = `user_${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = new Date(T0.getTime() - DAY + accounts++);
  await db.insert(schema.users).values({ id, name: email.split("@")[0] ?? "x", email, createdAt });
  return id;
}

async function invite(email: string, now = T0, options: { resend?: boolean; locale?: "en" | "pt-BR" } = {}) {
  const [result] = await inviteEarlyAccess(
    db,
    { emails: [email], resend: options.resend ?? true, locale: options.locale, publicUrl: APP },
    now,
  );
  if (!result) throw new Error("no answer");
  return result;
}

type Sent = {
  key: string;
  to: string[];
  template: { kind: string; locale: string; url: string } & Record<string, unknown>;
};

/** The early-access emails queued, oldest first. */
async function sent() {
  const rows = await db.select({ payload: outbox.payload }).from(outbox).where(eq(outbox.kind, "email.send"));
  return rows.map((r) => r.payload as Sent).filter((p) => p.key.startsWith("early-access:"));
}

/** The token in the latest link sent to `email`. */
async function tokenOf(email: string) {
  const links = (await sent()).filter((s) => s.to[0] === email);
  const token = new URL(links.at(-1)?.template.url ?? "x:").searchParams.get("access");
  if (!token) throw new Error(`no link for ${email}`);
  return token;
}

async function row(email: string) {
  const [r] = await db.select().from(invitations).where(eq(invitations.email, email));
  if (!r) throw new Error(`no invitation for ${email}`);
  return r;
}

/** An account made with the address's link, as the sign-up hook does. */
async function signUpWithLink(email: string, now = T0) {
  const userId = await account(email);
  expect(await useEarlyAccess(db, { access: await tokenOf(email), email, userId }, now)).toBe(true);
  return userId;
}

describe("the sign-up mode", () => {
  test("no row reads as invite; it changes live, and changedAt moves only when the mode does", async () => {
    expect(await signupMode(db)).toEqual({ mode: "invite", changedAt: null });
    expect(await setSignupMode(db, "invite", at(1))).toEqual({ mode: "invite", changedAt: null });
    expect(await setSignupMode(db, "open", at(2))).toEqual({ mode: "open", changedAt: at(2) });
    expect(await setSignupMode(db, "open", at(3))).toEqual({ mode: "open", changedAt: at(2) });
    expect(await setSignupMode(db, "invite", at(4))).toEqual({ mode: "invite", changedAt: at(4) });
  });
});

describe("who may sign up", () => {
  test("in order: ALLOW_SIGNUP, the first account, the live mode, a workspace invitation", async () => {
    // No account yet: the first one, unless the owner's link or key makes it.
    expect(await signupAdmission(db, "ana@acme.com", CLOSED)).toBe("first");
    expect(await signupAdmission(db, "ana@acme.com", { allowSignup: false, ownerByLink: true })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", { allowSignup: true, ownerByLink: true })).toBeNull();
    const owner = await account("owner@acme.com");
    expect(await signupAdmission(db, "ana@acme.com", CLOSED)).toBeNull();
    // ALLOW_SIGNUP forces it open, whatever the mode.
    expect(await signupAdmission(db, "ana@acme.com", { allowSignup: true, ownerByLink: false })).toBe("open");
    expect(await signupAdmission(db, "ana@acme.com", { allowSignup: true, ownerByLink: true })).toBe("open");
    // The live mode lets anyone in, and back.
    await setSignupMode(db, "open");
    expect(await signupAdmission(db, "ana@acme.com", CLOSED)).toBe("open");
    expect(await isSignupAllowed(db, "ana@acme.com", CLOSED)).toBe(true);
    // Never on a server that is its agents' computer.
    expect(await signupAdmission(db, "ana@acme.com", { ...CLOSED, hostComputer: true })).toBeNull();
    await setSignupMode(db, "invite");
    expect(await isSignupAllowed(db, "ana@acme.com", CLOSED)).toBe(false);
    // A pending workspace invitation, as before.
    const { organization } = await createOrganization(db, owner, { name: "Acme" });
    await createInvitation(db, owner, organization.id, { email: "Ana@Acme.com", role: "member" });
    expect(await signupAdmission(db, " ANA@acme.com ", CLOSED)).toBe("invitation");
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { now: at(400 * DAY) })).toBeNull();
  });

  test("an early-access link opens sign-up for its own address, in any case or spacing, until it expires", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const access = await tokenOf("ana@acme.com");
    expect(access).toMatch(EARLY_ACCESS_TOKEN);
    expect(await signupAdmission(db, "  Ana@ACME.com ", CLOSED, { access, now: at(MIN) })).toBe("early_access");
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access, now: at(14 * DAY - 1) })).toBe("early_access");
    // Expired, another address, a wrong token, a malformed one, none.
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access, now: at(14 * DAY) })).toBeNull();
    expect(await signupAdmission(db, "bia@acme.com", CLOSED, { access, now: at(MIN) })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: "A".repeat(43) })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: `${access}A` })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", CLOSED)).toBeNull();
  });

  test("a revoked or used link opens nothing", async () => {
    await account("owner@acme.com");
    const { invitationId } = await invite("ana@acme.com");
    await invite("bia@acme.com");
    const ana = await tokenOf("ana@acme.com");
    await revokeEarlyAccess(db, invitationId ?? "", at(MIN));
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: ana, now: at(2 * MIN) })).toBeNull();
    const bia = await tokenOf("bia@acme.com");
    await signUpWithLink("bia@acme.com");
    expect(await signupAdmission(db, "bia@acme.com", CLOSED, { access: bia })).toBeNull();
  });

  test("without its token an invited address answers like any other, with the same queries", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const invited = await countQueries(() => signupAdmission(db, "ana@acme.com", CLOSED));
    const stranger = await countQueries(() => signupAdmission(db, "bia@acme.com", CLOSED));
    expect(invited).toEqual({ result: null, queries: stranger.queries });
    expect(await signInOptions(db, "ana@acme.com", CLOSED)).toEqual(await signInOptions(db, "bia@acme.com", CLOSED));
  });

  test("the sign-in screen: canSignUp with the link, and accessExpired only for the link's own address", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const access = await tokenOf("ana@acme.com");
    const none = { account: false, password: false, providers: [] };
    expect(await signInOptions(db, "Ana@acme.com", CLOSED, access, at(MIN))).toEqual({ ...none, canSignUp: true });
    const later = at(15 * DAY);
    expect(await signInOptions(db, "ana@acme.com", CLOSED, access, later)).toEqual({
      ...none,
      canSignUp: false,
      accessExpired: true,
    });
    expect(await signInOptions(db, "bia@acme.com", CLOSED, access, later)).toEqual({ ...none, canSignUp: false });
    expect(await signInOptions(db, "ana@acme.com", CLOSED, undefined, later)).toEqual({ ...none, canSignUp: false });
  });
});

describe("using an invitation", () => {
  test("once, by its own address: the token goes; deleting the account keeps the use", async () => {
    await account("owner@acme.com");
    const { invitationId } = await invite("ana@acme.com");
    const access = await tokenOf("ana@acme.com");
    const bia = await account("bia@acme.com");
    expect(await useEarlyAccess(db, { access, email: "bia@acme.com", userId: bia })).toBe(false);
    const ana = await account("ana@acme.com");
    expect(await useEarlyAccess(db, { access, email: " Ana@Acme.com", userId: ana }, at(MIN))).toBe(true);
    expect(await useEarlyAccess(db, { access, email: "ana@acme.com", userId: ana }, at(2 * MIN))).toBe(false);
    expect(await row("ana@acme.com")).toMatchObject({ usedAt: at(MIN), userId: ana, tokenHash: null });

    await deleteAccount(db, ana);
    expect(await row("ana@acme.com")).toMatchObject({ id: invitationId, usedAt: at(MIN), userId: null });
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access })).toBeNull();
    expect((await invite("ana@acme.com", at(DAY))).outcome).toBe("signed_up");
    const again = await account("ana@acme.com");
    expect(await hasWorkspaceAllowance(db, again)).toBe(false);
  });
});

describe("inviting", () => {
  test("one row with only the token's hash, and the email queued with the sign-up link", async () => {
    const [result] = await inviteEarlyAccess(
      db,
      { emails: ["  Ana@Acme.com "], resend: true, publicUrl: `${APP}/` },
      T0,
    );
    expect(result).toEqual({ email: "ana@acme.com", outcome: "invited", invitationId: expect.any(String) });
    const access = await tokenOf("ana@acme.com");
    const rows = await db.select().from(invitations);
    expect(rows).toEqual([
      {
        id: result?.invitationId ?? "",
        email: "ana@acme.com",
        locale: "pt-BR",
        tokenHash: sha256(access),
        createdAt: T0,
        sentAt: T0,
        sends: 1,
        expiresAt: at(14 * DAY),
        revokedAt: null,
        usedAt: null,
        userId: null,
        workspaceCreatedAt: null,
        workspaceId: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(access);
    expect(await sent()).toEqual([
      {
        key: `early-access:${result?.invitationId}:1`,
        to: ["ana@acme.com"],
        template: {
          kind: "early_access",
          locale: "pt-BR",
          email: "ana@acme.com",
          url: `${APP}/signup?email=ana%40acme.com&access=${access}`,
          days: 14,
        },
      },
    ]);
  });

  test("the email's language: the invitation's, else the waiting list's, else the request's, else pt-BR", async () => {
    await importWaitlist(db, [{ email: "listed@acme.com", locale: "en" }], at(-DAY));
    await invite("listed@acme.com", T0, { locale: "pt-BR" });
    await invite("asked@acme.com", T0, { locale: "en" });
    await invite("plain@acme.com", T0);
    await invite("plain@acme.com", at(3 * MIN), { locale: "en" });
    expect((await sent()).map((s) => [s.to[0], s.template.locale])).toEqual([
      ["listed@acme.com", "en"],
      ["asked@acme.com", "en"],
      ["plain@acme.com", "pt-BR"],
      ["plain@acme.com", "pt-BR"],
    ]);
    expect((await row("listed@acme.com")).locale).toBe("en");
  });

  test("again: the same invitation with a new link (the old one stops), one more send, 14 days more, not revoked", async () => {
    await account("owner@acme.com");
    const first = await invite("ana@acme.com", T0);
    const old = await tokenOf("ana@acme.com");
    await revokeEarlyAccess(db, first.invitationId ?? "", at(MIN));
    expect(await invite("ana@acme.com", at(3 * MIN))).toEqual({
      email: "ana@acme.com",
      outcome: "resent",
      invitationId: first.invitationId,
    });
    const access = await tokenOf("ana@acme.com");
    expect(access).not.toBe(old);
    expect(await db.select().from(invitations)).toHaveLength(1);
    expect(await row("ana@acme.com")).toMatchObject({
      tokenHash: sha256(access),
      sends: 2,
      sentAt: at(3 * MIN),
      expiresAt: at(3 * MIN + 14 * DAY),
      revokedAt: null,
    });
    expect((await sent()).map((s) => s.key)).toEqual([
      `early-access:${first.invitationId}:1`,
      `early-access:${first.invitationId}:2`,
    ]);
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: old, now: at(4 * MIN) })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access, now: at(4 * MIN) })).toBe("early_access");
  });

  test("within 2 minutes of the last send nothing goes out (recent); after them it does", async () => {
    const first = await invite("ana@acme.com", T0);
    expect(await invite("ana@acme.com", at(2 * MIN - 1))).toEqual({ ...first, outcome: "recent" });
    const resent = await resendEarlyAccess(db, first.invitationId ?? "", APP, at(MIN));
    expect(resent).toMatchObject({ sent: false, invitation: { sends: 1, state: "sent" } });
    expect(await sent()).toHaveLength(1);
    expect((await invite("ana@acme.com", at(2 * MIN))).outcome).toBe("resent");
    const later = await resendEarlyAccess(db, first.invitationId ?? "", APP, at(5 * MIN));
    expect(later).toMatchObject({ sent: true, invitation: { sends: 3, sentAt: at(5 * MIN) } });
    expect(await sent()).toHaveLength(3);
  });

  test("outcomes in order, in the request's order, each address once", async () => {
    await account("owner@acme.com");
    const used = await invite("used@acme.com");
    await signUpWithLink("used@acme.com");
    const invited = await invite("sent@acme.com");
    await account("member@acme.com");
    const results = await inviteEarlyAccess(
      db,
      {
        emails: [
          "not an email",
          "used@acme.com",
          "member@acme.com",
          "SENT@acme.com",
          "new@acme.com",
          " New@Acme.com",
          `${"a".repeat(250)}@acme.com`,
        ],
        resend: false,
        publicUrl: APP,
      },
      at(10 * MIN),
    );
    expect(results).toEqual([
      { email: "not an email", outcome: "invalid_email" },
      { email: "used@acme.com", outcome: "signed_up", invitationId: used.invitationId },
      { email: "member@acme.com", outcome: "has_account" },
      { email: "sent@acme.com", outcome: "already_invited", invitationId: invited.invitationId },
      { email: "new@acme.com", outcome: "invited", invitationId: expect.any(String) },
      { email: `${"a".repeat(250)}@acme.com`, outcome: "invalid_email" },
    ]);
    expect((await sent()).map((s) => s.to[0])).toEqual(["used@acme.com", "sent@acme.com", "new@acme.com"]);
    await expect(
      inviteEarlyAccess(db, { emails: Array(201).fill("x@acme.com"), resend: true, publicUrl: APP }),
    ).rejects.toThrow(ValidationError);
  });

  test("a used invitation, or an address with an account, is never sent again", async () => {
    await account("owner@acme.com");
    const used = await invite("used@acme.com");
    await signUpWithLink("used@acme.com");
    const other = await invite("other@acme.com");
    await account("other@acme.com");
    await expect(resendEarlyAccess(db, used.invitationId ?? "", APP, at(DAY))).rejects.toMatchObject({
      code: "early_access.used",
    });
    await expect(resendEarlyAccess(db, other.invitationId ?? "", APP, at(DAY))).rejects.toMatchObject({
      code: "early_access.has_account",
    });
    await expect(resendEarlyAccess(db, crypto.randomUUID(), APP)).rejects.toThrow(NotFoundError);
    expect(await sent()).toHaveLength(2);
  });

  test("two invitations of one address at once send one email", async () => {
    const answers = await Promise.all([invite("ana@acme.com"), invite("ana@acme.com")]);
    expect(answers.map((a) => a.outcome).sort()).toEqual(["invited", "recent"]);
    expect(await sent()).toHaveLength(1);
    expect(await db.select().from(invitations)).toHaveLength(1);
  });

  test("the waiting list notes the first invitation only", async () => {
    await importWaitlist(db, [{ email: "ana@acme.com" }], at(-DAY));
    await invite("ana@acme.com", T0);
    await invite("ana@acme.com", at(3 * MIN));
    const [entry] = await db.select().from(waitlistEntries);
    expect(entry?.invitedAt).toEqual(T0);
  });
});

describe("revoking and expiry", () => {
  test("revoke kills the link, can be repeated, takes a signed-up account's allowance, and stops at the workspace", async () => {
    await account("owner@acme.com");
    const ana = await invite("ana@acme.com");
    const revoked = await revokeEarlyAccess(db, ana.invitationId ?? "", at(MIN));
    expect(revoked).toMatchObject({ state: "revoked", revokedAt: at(MIN) });
    expect((await row("ana@acme.com")).tokenHash).toBeNull();
    expect(await revokeEarlyAccess(db, ana.invitationId ?? "", at(2 * MIN))).toEqual(revoked);

    const bia = await invite("bia@acme.com");
    const biaId = await signUpWithLink("bia@acme.com");
    expect(await canCreateWorkspace(db, biaId, CLOUD)).toBe(true);
    await revokeEarlyAccess(db, bia.invitationId ?? "", at(MIN));
    expect(await hasWorkspaceAllowance(db, biaId)).toBe(false);
    expect(await canCreateWorkspace(db, biaId, CLOUD)).toBe(false);

    const cleo = await invite("cleo@acme.com");
    const cleoId = await signUpWithLink("cleo@acme.com");
    await createOrganization(db, cleoId, { name: "Cleo" }, { needsAllowance: true });
    const error = await revokeEarlyAccess(db, cleo.invitationId ?? "").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ code: "early_access.workspace_created" });
    await expect(revokeEarlyAccess(db, crypto.randomUUID())).rejects.toThrow(NotFoundError);
  });

  test("expiry: 14 days after the latest send, for sign-up only; an account made in time keeps its allowance", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com", T0);
    const list = async (now: Date) => (await listEarlyAccess(db, { limit: 10 }, now)).invitations[0]?.state;
    expect(await list(at(14 * DAY - 1))).toBe("sent");
    expect(await list(at(14 * DAY))).toBe("expired");
    const ana = await signUpWithLink("ana@acme.com", at(13 * DAY));
    expect(await list(at(30 * DAY))).toBe("signed_up");
    expect(await canCreateWorkspace(db, ana, CLOUD)).toBe(true);
    await createOrganization(db, ana, { name: "Ana" }, { needsAllowance: true });

    // An account let in another way (open mode, a workspace's invitation) with an expired link takes nothing from it.
    await invite("bia@acme.com", T0);
    const bia = await account("bia@acme.com");
    const late = { access: await tokenOf("bia@acme.com"), email: "bia@acme.com", userId: bia };
    expect(await useEarlyAccess(db, late, at(14 * DAY))).toBe(false);
    expect(await row("bia@acme.com")).toMatchObject({ usedAt: null, userId: null });
    expect(await canCreateWorkspace(db, bia, CLOUD)).toBe(false);
  });
});

describe("one workspace per invitation (by invitation only, every workspace with a paid computer)", () => {
  test("with none to take: refused, leaving no workspace and no event", async () => {
    await account("owner@acme.com");
    const bia = await account("bia@acme.com");
    expect(await needsWorkspaceAllowance(db, bia, CLOUD)).toBe(true);
    expect(await canCreateWorkspace(db, bia, CLOUD)).toBe(false);
    await expect(createOrganization(db, bia, { name: "Bia" }, { needsAllowance: true })).rejects.toMatchObject({
      code: "org.create_invite_only",
    });
    expect(await db.select().from(schema.organizations)).toEqual([]);
    expect(await db.select().from(schema.operatorEvents)).toEqual([]);
  });

  test("with one: one workspace, recorded on the invitation; two at once make one; a third is refused", async () => {
    await account("owner@acme.com");
    const { invitationId } = await invite("ana@acme.com");
    const ana = await signUpWithLink("ana@acme.com");
    expect(await canCreateWorkspace(db, ana, CLOUD)).toBe(true);
    const made = await Promise.allSettled([
      createOrganization(db, ana, { name: "One" }, { needsAllowance: true }),
      createOrganization(db, ana, { name: "Two" }, { needsAllowance: true }),
    ]);
    const kept = made.flatMap((m) => (m.status === "fulfilled" ? [m.value.organization.id] : []));
    expect(kept).toHaveLength(1);
    expect(made.find((m) => m.status === "rejected")).toMatchObject({ reason: { code: "org.create_invite_only" } });
    expect(await row("ana@acme.com")).toMatchObject({ id: invitationId, workspaceId: kept[0] });
    expect((await row("ana@acme.com")).workspaceCreatedAt).toBeInstanceOf(Date);
    expect(await canCreateWorkspace(db, ana, CLOUD)).toBe(false);
    await expect(createOrganization(db, ana, { name: "Three" }, { needsAllowance: true })).rejects.toMatchObject({
      code: "org.create_invite_only",
    });
    expect(await db.select().from(schema.organizations)).toHaveLength(1);
  });

  test("off for the installation's owner, without paid computers, with ALLOW_SIGNUP and in open mode", async () => {
    const owner = await account("owner@acme.com");
    const bia = await account("bia@acme.com");
    expect(await needsWorkspaceAllowance(db, owner, CLOUD)).toBe(false);
    expect(await canCreateWorkspace(db, owner, CLOUD)).toBe(true);
    expect(await canCreateWorkspace(db, bia, { paidMachines: false, allowSignup: false })).toBe(true);
    expect(await canCreateWorkspace(db, bia, { paidMachines: true, allowSignup: true })).toBe(true);
    await setSignupMode(db, "open");
    expect(await canCreateWorkspace(db, bia, CLOUD)).toBe(true);
  });

  test("off, the first workspace is still recorded on the invitation", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const ana = await signUpWithLink("ana@acme.com");
    const first = await createOrganization(db, ana, { name: "One" });
    await createOrganization(db, ana, { name: "Two" });
    expect((await row("ana@acme.com")).workspaceId).toBe(first.organization.id);
  });
});

describe("the waiting list", () => {
  test("import: confirmed entries in the list's order, deduplicated, invalid ones by index; a repeat changes nothing", async () => {
    await db.insert(waitlistEntries).values([
      { email: "landing@acme.com", locale: "en", source: "landing", createdAt: at(-DAY) },
      { email: "done@acme.com", source: "landing", createdAt: at(-DAY), confirmedAt: at(-DAY) },
    ]);
    const input = [
      { email: "First@Acme.com" },
      { email: "nope" },
      { email: "second@acme.com", locale: "en" as const },
      { email: " first@acme.com " },
      { email: "landing@acme.com" },
      { email: "done@acme.com" },
      { email: "past@acme.com", joinedAt: new Date("2025-06-01T00:00:00.000Z") },
      { email: "future@acme.com", joinedAt: at(DAY) },
      { email: `${"a".repeat(250)}@acme.com` },
    ];
    expect(await importWaitlist(db, input, T0)).toEqual({ added: 4, confirmed: 1, unchanged: 2, invalid: [1, 8] });
    const rows = new Map((await db.select().from(waitlistEntries)).map((r) => [r.email, r]));
    expect(rows.get("first@acme.com")).toMatchObject({ source: "import", locale: "pt-BR", createdAt: T0 });
    expect(rows.get("second@acme.com")).toMatchObject({ source: "import", locale: "en", createdAt: at(2) });
    expect(rows.get("past@acme.com")?.createdAt).toEqual(new Date("2025-06-01T00:00:00.000Z"));
    expect(rows.get("future@acme.com")?.createdAt).toEqual(T0);
    for (const r of rows.values()) expect(r.confirmedAt).toBeInstanceOf(Date);
    expect(rows.get("landing@acme.com")).toMatchObject({
      source: "landing",
      locale: "en",
      createdAt: at(-DAY),
      confirmedAt: T0,
    });
    expect(await importWaitlist(db, input, at(MIN))).toEqual({ added: 0, confirmed: 0, unchanged: 7, invalid: [1, 8] });
    await expect(
      importWaitlist(
        db,
        Array.from({ length: 5001 }, (_, i) => ({ email: `p${i}@acme.com` })),
      ),
    ).rejects.toThrow(ValidationError);
  });

  test("imported entries never reach the email provider's contacts, at import or at boot", async () => {
    await db.insert(waitlistEntries).values({ email: "landing@acme.com", source: "landing", confirmedAt: T0 });
    await importWaitlist(db, [{ email: "imported@acme.com" }]);
    const contacts = () =>
      db.select({ payload: outbox.payload }).from(outbox).where(eq(outbox.kind, "waitlist.contact"));
    expect(await contacts()).toEqual([]);
    expect(await enqueueWaitlistContacts(db)).toBe(1);
    const [landing] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.email, "landing@acme.com"));
    expect(await contacts()).toEqual([{ payload: { entryId: landing?.id } }]);
    const [imported] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.email, "imported@acme.com"));
    const sender = createFakeEmailSender();
    await saveWaitlistContact(db, sender, imported?.id ?? "");
    expect(sender.contacts).toEqual([]);
  });

  test("next: confirmed entries still waiting, oldest first, past invitations (revoked too), accounts and refused addresses", async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    await db.insert(waitlistEntries).values([
      { email: "old@acme.com", locale: "en", createdAt: day(1), confirmedAt: day(1) },
      { email: "unconfirmed@acme.com", createdAt: day(2) },
      { email: "two..dots@acme.com", createdAt: day(3), confirmedAt: day(3) },
      { email: "invited@acme.com", createdAt: day(4), confirmedAt: day(4) },
      { email: "member@acme.com", createdAt: day(5), confirmedAt: day(5) },
      { email: "new@acme.com", createdAt: day(6), confirmedAt: day(6) },
      { email: "newer@acme.com", createdAt: day(7), confirmedAt: day(7) },
    ]);
    const { invitationId } = await invite("invited@acme.com");
    await revokeEarlyAccess(db, invitationId ?? "");
    await account("member@acme.com");
    expect(earlyAccessEmail("two..dots@acme.com")).toBeNull();
    expect(await waitlistNext(db, 10)).toEqual([
      { email: "old@acme.com", locale: "en", joinedAt: day(1) },
      { email: "new@acme.com", locale: "pt-BR", joinedAt: day(6) },
      { email: "newer@acme.com", locale: "pt-BR", joinedAt: day(7) },
    ]);
    // A page that starts with a refused address reads on to fill the limit.
    expect((await waitlistNext(db, 2)).map((e) => e.email)).toEqual(["old@acme.com", "new@acme.com"]);
    expect((await waitlistNext(db, 1)).map((e) => e.email)).toEqual(["old@acme.com"]);
    expect(await waitlistCounts(db)).toEqual({
      unconfirmed: 1,
      confirmed: 6,
      waiting: 4,
      invited: 1,
      signedUp: 0,
      workspaceCreated: 0,
    });
  });

  test("the counts follow each invitation to its account and workspace", async () => {
    await account("owner@acme.com");
    await importWaitlist(
      db,
      ["a", "b", "c", "d"].map((n) => ({ email: `${n}@acme.com` })),
    );
    await db.insert(waitlistEntries).values({ email: "e@acme.com" });
    await inviteEarlyAccess(db, { emails: ["a@acme.com", "b@acme.com", "c@acme.com"], resend: true, publicUrl: APP });
    await signUpWithLink("b@acme.com");
    const c = await signUpWithLink("c@acme.com");
    await createOrganization(db, c, { name: "C" }, { needsAllowance: true });
    expect(await waitlistCounts(db)).toEqual({
      unconfirmed: 1,
      confirmed: 4,
      waiting: 1,
      invited: 3,
      signedUp: 2,
      workspaceCreated: 1,
    });
  });
});

describe("the list", () => {
  test("states by precedence, newest first in stable pages, q and state filters, counts whatever the filters", async () => {
    await account("owner@acme.com");
    // Several at the same instant: paging must keep them all.
    for (const email of ["s1@acme.com", "s2@acme.com", "s3@acme.com"]) await invite(email, T0);
    await invite("old@acme.com", at(-20 * DAY));
    const used = await invite("used_one@acme.com", at(MIN));
    await signUpWithLink("used_one@acme.com", at(2 * MIN));
    await revokeEarlyAccess(db, used.invitationId ?? "", at(3 * MIN));
    await invite("made@acme.com", at(-30 * DAY));
    const made = await signUpWithLink("made@acme.com", at(-29 * DAY));
    await createOrganization(db, made, { name: "Made" }, { needsAllowance: true });
    await invite("signed@acme.com", at(2 * MIN));
    await signUpWithLink("signed@acme.com", at(3 * MIN));

    const now = at(4 * MIN);
    const all: { email: string; state: string; createdAt: Date; id: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await listEarlyAccess(db, { limit: 2, cursor }, now);
      all.push(...page.invitations);
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(all.map((i) => i.email).slice(0, 2)).toEqual(["signed@acme.com", "used_one@acme.com"]);
    expect(
      all
        .map((i) => i.email)
        .slice(2, 5)
        .sort(),
    ).toEqual(["s1@acme.com", "s2@acme.com", "s3@acme.com"]);
    expect(all.map((i) => i.email).slice(5)).toEqual(["old@acme.com", "made@acme.com"]);
    expect(Object.fromEntries(all.map((i) => [i.email, i.state]))).toEqual({
      "signed@acme.com": "signed_up",
      "used_one@acme.com": "revoked",
      "s1@acme.com": "sent",
      "s2@acme.com": "sent",
      "s3@acme.com": "sent",
      "old@acme.com": "expired",
      "made@acme.com": "workspace_created",
    });
    const counts = { sent: 3, expired: 1, signedUp: 1, workspaceCreated: 1, revoked: 1 };
    const only = async (query: { state?: "sent" | "expired"; q?: string }) => {
      const page = await listEarlyAccess(db, { limit: 50, ...query }, now);
      expect(page.counts).toEqual(counts);
      return page.invitations.map((i) => i.email).sort();
    };
    expect(await only({ state: "expired" })).toEqual(["old@acme.com"]);
    expect(await only({ q: "S2@" })).toEqual(["s2@acme.com"]);
    // Literal: an underscore is no wildcard.
    expect(await only({ q: "_" })).toEqual(["used_one@acme.com"]);
    expect(await only({ q: "s", state: "sent" })).toEqual(["s1@acme.com", "s2@acme.com", "s3@acme.com"]);
    await expect(listEarlyAccess(db, { limit: 2, cursor: "nope" })).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});
