import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  acceptInvitation,
  approveJoinRequest,
  askToJoin,
  cancelSuggestion,
  claimJoinRequest,
  denyJoinRequest,
  type EmailTemplate,
  invitationState,
  invitationToken,
  inviteLink,
  inviteMany,
  listInvitationsWithStatus,
  listMySuggestions,
  listWaitingJoinRequests,
  NotFoundError,
  noticeInvitationAccepted,
  previewInvitation,
  pruneJoinRequests,
  queueInvitationEmail,
  renewInviteLink,
  resendInvitation,
  sendJoinCode,
  setInvitationRoles,
  sha256,
  suggestPerson,
} from "../src";
import { addMember, adminRoleId, type Fixture, SECRET, setup } from "./fixtures";

// ADR 0089: a link asks with a password, the account is made at approval; invitations keep their link; members
// suggest; the inviter hears who joined.

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const PUBLIC = "https://agentes.test";
const NOW = new Date("2026-10-31T10:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
let limiter = createMemoryRateLimiter();
const fx = () => f as Fixture;
const deps = () => ({ db: fx().db, pubsub: fx().pubsub, rateLimiter: limiter });

async function start() {
  f = await setup();
  limiter = createMemoryRateLimiter();
  return inviteLink(f.db, SECRET, f.owner.id, f.org.id, NOW);
}

const outboxEmails = async () =>
  (await fx().db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send")).orderBy(schema.outbox.id))
    .map((r) => r.payload as { key: string; to: string[]; template: EmailTemplate })
    .filter((p) => p.template.kind !== "join_code");

/** Proves `email` with the code its email carries, then asks signed out with a password (as the route hashed it). */
async function askWithPassword(token: string, email: string, passwordHash: string, secret: string) {
  await sendJoinCode(deps(), PUBLIC, { token, user: null, email, locale: "pt-BR" }, NOW);
  const [codeEmail] = (
    await fx().db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send")).orderBy(schema.outbox.id)
  )
    .map((r) => r.payload as { template: EmailTemplate })
    .filter((p) => p.template.kind === "join_code")
    .slice(-1);
  const code = codeEmail?.template.kind === "join_code" ? codeEmail.template.code : "";
  return askToJoin(
    deps(),
    PUBLIC,
    {
      token,
      user: null,
      name: "Rafael Costa",
      email,
      note: "Do financeiro",
      proofNeeded: true,
      code,
      passwordHash,
      claimHash: sha256(secret),
    },
    NOW,
  );
}

const requestOf = async (id: string) =>
  (await fx().db.select().from(schema.organizationJoinRequests).where(eq(schema.organizationJoinRequests.id, id)))[0];
const memberOf = async (userId: string) =>
  (
    await fx()
      .db.select()
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, fx().org.id), eq(schema.organizationMembers.userId, userId)))
  )[0];

describe("asking through a link with a password (ADR 0089)", () => {
  test("approval makes the confirmed account with it and lets the page that asked in, once", async () => {
    const { token } = await start();
    const asked = await askWithPassword(token, "rafael@example.com", "hash:rafael", "page-secret");
    expect(asked).toMatchObject({ status: "pending", created: true });
    const id = "requestId" in asked ? asked.requestId : null;
    expect(id).toBeTruthy();
    const key = `${id}.page-secret`;
    expect(await requestOf(id ?? "")).toMatchObject({ passwordHash: "hash:rafael", claimHash: sha256("page-secret") });
    // Nobody signs up through a link: no account until an admin answers.
    expect(await fx().db.select().from(schema.users).where(eq(schema.users.email, "rafael@example.com"))).toEqual([]);
    expect(await claimJoinRequest(fx().db, token, key, NOW)).toEqual({ status: "pending" });
    await expect(claimJoinRequest(fx().db, token, `${id}.wrong`, NOW)).rejects.toBeInstanceOf(NotFoundError);

    expect(await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, id ?? "", [], NOW)).toEqual({
      outcome: "joined",
    });
    const [made] = await fx().db.select().from(schema.users).where(eq(schema.users.email, "rafael@example.com"));
    expect(made).toMatchObject({ name: "Rafael Costa", emailVerified: true });
    const [account] = await fx()
      .db.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, made?.id ?? ""));
    expect(account).toMatchObject({ providerId: "credential", password: "hash:rafael", accountId: made?.id });
    expect(await memberOf(made?.id ?? "")).toBeTruthy();
    // The password lives in the account now, nowhere else.
    expect(await requestOf(id ?? "")).toMatchObject({ status: "approved", passwordHash: null, userId: made?.id });
    const answer = (await outboxEmails()).find((e) => e.template.kind === "join_answer");
    expect(answer?.template).toMatchObject({ outcome: "joined", url: `${PUBLIC}/org/${fx().org.id}` });

    expect(await claimJoinRequest(fx().db, token, key, NOW)).toEqual({
      status: "in",
      userId: made?.id ?? "",
      orgId: fx().org.id,
    });
    // Spent: a second page with the same key gets nothing.
    await expect(claimJoinRequest(fx().db, token, key, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("an address with an account signs in as always; a denial keeps nothing of what they chose", async () => {
    const { token } = await start();
    await fx()
      .db.insert(schema.users)
      .values({ id: "u_bia", name: "Bia", email: "bia@example.com", emailVerified: true });
    const asked = await askWithPassword(token, "bia@example.com", "hash:bia", "bia-secret");
    const id = "requestId" in asked ? (asked.requestId ?? "") : "";
    await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, id, [], NOW);
    expect(await memberOf("u_bia")).toBeTruthy();
    expect(await fx().db.select().from(schema.accounts).where(eq(schema.accounts.userId, "u_bia"))).toEqual([]);
    expect(await requestOf(id)).toMatchObject({ passwordHash: null, claimHash: null });
    await expect(claimJoinRequest(fx().db, token, `${id}.bia-secret`, NOW)).rejects.toBeInstanceOf(NotFoundError);

    const other = await askWithPassword(token, "caio@example.com", "hash:caio", "caio-secret");
    const otherId = "requestId" in other ? (other.requestId ?? "") : "";
    await denyJoinRequest(deps(), fx().owner.id, fx().org.id, otherId, "Só o time interno", NOW);
    expect(await requestOf(otherId)).toMatchObject({ status: "denied", passwordHash: null });
    expect(await claimJoinRequest(fx().db, token, `${otherId}.caio-secret`, NOW)).toEqual({
      status: "denied",
      reason: "Só o time interno",
    });
  });

  test("joining another way closes the request and drops what it kept; a key is good for a day", async () => {
    const { token } = await start();
    const asked = await askWithPassword(token, "gabi@example.com", "hash:gabi", "gabi-secret");
    const id = "requestId" in asked ? (asked.requestId ?? "") : "";
    // An email invitation to the same address, accepted: the request closes, keeping nothing.
    const [invited] = await inviteMany(fx().db, fx().owner.id, fx().org.id, { emails: ["gabi@example.com"] }, NOW);
    if (invited?.status !== "invited") throw new Error("expected an invitation");
    await fx().db.insert(schema.users).values({ id: "u_gabi", name: "Gabi", email: "gabi@example.com" });
    await acceptInvitation(fx().db, { id: "u_gabi", email: "gabi@example.com" }, invited.token, NOW);
    expect(await requestOf(id)).toMatchObject({ status: "closed", passwordHash: null, claimHash: null });

    // Approved and made, but the page never came back: a day later its key signs in no one.
    const other = await askWithPassword(token, "hugo@example.com", "hash:hugo", "hugo-secret");
    const otherId = "requestId" in other ? (other.requestId ?? "") : "";
    await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, otherId, [], NOW);
    expect((await requestOf(otherId))?.claimHash).toBe(sha256("hugo-secret"));
    expect(await claimJoinRequest(fx().db, token, `${otherId}.hugo-secret`, at(2))).toEqual({ status: "closed" });
    await pruneJoinRequests(deps(), at(2));
    expect(await requestOf(otherId)).toMatchObject({ passwordHash: null, claimHash: null });
  });

  test("a request that runs out drops the password and the key", async () => {
    const { token } = await start();
    const asked = await askWithPassword(token, "duda@example.com", "hash:duda", "duda-secret");
    const id = "requestId" in asked ? (asked.requestId ?? "") : "";
    await pruneJoinRequests(deps(), at(15));
    expect(await requestOf(id)).toMatchObject({ passwordHash: null, claimHash: null });
  });

  test("a link gets 30 more days and stays the same", async () => {
    const { link, token } = await start();
    const { expiresAt } = await renewInviteLink(fx().db, fx().owner.id, fx().org.id, link.id, at(20));
    expect(expiresAt).toEqual(at(50));
    const [row] = await fx()
      .db.select()
      .from(schema.organizationInviteLinks)
      .where(eq(schema.organizationInviteLinks.id, link.id));
    expect(row?.tokenHash).toBe(sha256(token));
  });
});

describe("members suggest someone (ADR 0089)", () => {
  test("it waits with who suggested it, the admins are told, and its author can take it back", async () => {
    await start();
    const carla = await addMember(fx().db, fx().org.id, "member", "carla");
    const { id } = await suggestPerson(
      deps(),
      carla.id,
      fx().org.id,
      { email: " Otto@Example.com ", note: "Design do site" },
      NOW,
    );
    const [waiting] = await listWaitingJoinRequests(fx().db, fx().owner.id, fx().org.id, NOW);
    expect(waiting).toMatchObject({ id, email: "otto@example.com", suggestedBy: "carla", verified: false });
    const notices = await fx()
      .db.select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "join_request"));
    expect(notices.map((n) => n.userId)).toEqual([fx().owner.id]);
    await expect(
      suggestPerson(deps(), carla.id, fx().org.id, { email: "otto@example.com" }, NOW),
    ).rejects.toMatchObject({ code: "join.waiting" });
    await expect(suggestPerson(deps(), carla.id, fx().org.id, { email: carla.email }, NOW)).rejects.toMatchObject({
      code: "join.member",
    });
    expect((await listMySuggestions(fx().db, carla.id, fx().org.id, NOW)).map((s) => s.id)).toEqual([id]);
    await cancelSuggestion(deps(), carla.id, fx().org.id, id, NOW);
    expect(await listMySuggestions(fx().db, carla.id, fx().org.id, NOW)).toEqual([]);
  });

  test("approving a suggestion sends an invitation: nobody proved the address", async () => {
    await start();
    const carla = await addMember(fx().db, fx().org.id, "member", "carla");
    const { id } = await suggestPerson(deps(), carla.id, fx().org.id, { email: "lu@example.com" }, NOW);
    const approval = await approveJoinRequest(
      { ...deps(), secret: SECRET },
      PUBLIC,
      fx().owner.id,
      fx().org.id,
      id,
      [],
      NOW,
    );
    expect(approval.outcome).toBe("invited");
    // Its link is the one the list can copy.
    const [invitation] = await listInvitationsWithStatus(fx().db, fx().owner.id, fx().org.id, NOW, SECRET);
    expect(approval.outcome === "invited" && approval.url).toBe(`${PUBLIC}/invite/${invitation?.token}`);
  });
});

describe("email invitations (ADR 0089)", () => {
  test("a link that stays the same, roles per person, channels, and the inviter told", async () => {
    await start();
    const admin = await adminRoleId(fx().db, fx().org.id);
    const [produto] = await fx()
      .db.insert(schema.channels)
      .values({ orgId: fx().org.id, name: "produto", createdByUserId: fx().owner.id })
      .returning();
    const results = await inviteMany(
      fx().db,
      fx().owner.id,
      fx().org.id,
      {
        invites: [{ email: "rita@example.com", roleIds: [admin] }, { email: "theo@example.com" }],
        channelIds: [produto?.id ?? ""],
        note: "Vem para a Acme",
        secret: SECRET,
      },
      NOW,
    );
    expect(results.map((r) => r.status)).toEqual(["invited", "invited"]);
    const rita = results[0];
    if (rita?.status !== "invited") throw new Error("expected an invitation");
    expect(rita.token).toBe(invitationToken(SECRET, rita.invitationId));

    const listed = await listInvitationsWithStatus(fx().db, fx().owner.id, fx().org.id, NOW, SECRET);
    expect(listed.find((i) => i.email === "rita@example.com")).toMatchObject({
      roleIds: [admin],
      channelIds: [produto?.id],
      token: rita.token,
      invitedBy: "ana",
    });
    expect(listed.find((i) => i.email === "theo@example.com")?.roleIds).toEqual([]);

    // Sending it again keeps its link.
    const again = await resendInvitation(fx().db, fx().owner.id, fx().org.id, rita.invitationId, at(1), SECRET);
    expect(again.token).toBe(rita.token);
    await setInvitationRoles(fx().db, fx().owner.id, fx().org.id, rita.invitationId, []);
    expect(
      (await listInvitationsWithStatus(fx().db, fx().owner.id, fx().org.id, NOW, SECRET)).find(
        (i) => i.email === "rita@example.com",
      )?.roleIds,
    ).toEqual([]);

    // The page knows the address has no account yet.
    expect(await previewInvitation(fx().db, rita.token, at(1))).toMatchObject({
      kind: "email",
      account: { exists: false, password: false, providers: [] },
    });
    await fx().db.insert(schema.users).values({ id: "u_rita", name: "Rita", email: "rita@example.com" });
    const joined = await acceptInvitation(fx().db, { id: "u_rita", email: "rita@example.com" }, rita.token, at(1));
    expect(joined).toEqual({ orgId: fx().org.id, invitedBy: fx().owner.id });
    // In #produto too, and the address counts as confirmed: the token reached that mailbox.
    const channels = await fx()
      .db.select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.userId, "u_rita"));
    expect(channels.map((c) => c.channelId)).toContain(produto?.id ?? "");
    const [user] = await fx().db.select().from(schema.users).where(eq(schema.users.id, "u_rita"));
    expect(user?.emailVerified).toBe(true);

    await noticeInvitationAccepted(
      deps(),
      { orgId: fx().org.id, inviterId: joined.invitedBy, userId: "u_rita" },
      at(1),
    );
    const [notice] = await fx()
      .db.select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "invitation_accepted"));
    expect(notice).toMatchObject({ userId: fx().owner.id });

    // A dead link says what happened; one that never was says nothing.
    expect(await invitationState(fx().db, rita.token, at(2))).toMatchObject({ state: "accepted", orgId: fx().org.id });
    const theo = results[1];
    if (theo?.status !== "invited") throw new Error("expected an invitation");
    expect(await invitationState(fx().db, theo.token, at(9))).toMatchObject({ state: "expired", invitedBy: "ana" });
    expect(await invitationState(fx().db, "nope", NOW)).toBeNull();
  });

  test("the note goes in the email, and every sending is its own email", async () => {
    await start();
    const [result] = await inviteMany(
      fx().db,
      fx().owner.id,
      fx().org.id,
      { emails: ["lia@example.com"], note: "Oi Lia", secret: SECRET },
      NOW,
    );
    if (result?.status !== "invited") throw new Error("expected an invitation");
    const send = () =>
      queueInvitationEmail(fx().db, {
        orgId: fx().org.id,
        invitationId: result.invitationId,
        email: "lia@example.com",
        role: "member",
        url: `${PUBLIC}/invite/${result.token}`,
        inviterId: fx().owner.id,
      });
    await send();
    await resendInvitation(fx().db, fx().owner.id, fx().org.id, result.invitationId, at(1), SECRET);
    await send();
    const sent = (await outboxEmails()).filter((e) => e.template.kind === "invitation");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.template).toMatchObject({ note: "Oi Lia" });
  });

  test("a channel the sender can't give refuses the invitation; a full workspace says so first", async () => {
    await start();
    const [secret] = await fx()
      .db.insert(schema.channels)
      .values({ orgId: fx().org.id, name: "diretoria", visibility: "private", createdByUserId: fx().owner.id })
      .returning();
    const admin = await addMember(fx().db, fx().org.id, "admin", "bruno");
    await expect(
      inviteMany(fx().db, admin.id, fx().org.id, { emails: ["x@example.com"], channelIds: [secret?.id ?? ""] }, NOW),
    ).rejects.toMatchObject({ code: "invitation.channel" });

    const [result] = await inviteMany(fx().db, fx().owner.id, fx().org.id, { emails: ["y@example.com"] }, NOW);
    if (result?.status !== "invited") throw new Error("expected an invitation");
    await fx().db.update(schema.organizations).set({ limitMembers: 2 }).where(eq(schema.organizations.id, fx().org.id));
    expect(await previewInvitation(fx().db, result.token, NOW)).toMatchObject({ full: true });
  });
});
