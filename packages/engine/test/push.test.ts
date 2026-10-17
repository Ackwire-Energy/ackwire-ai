import { afterEach, describe, expect, test } from "bun:test";
import { createFakePushSender } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  approvalIsHighRisk,
  checkPushReceipts,
  createJobHandlers,
  deleteAccount,
  drainOutbox,
  listMembers,
  listPushDevices,
  markNotificationRead,
  notify,
  openDm,
  PUSH_RECEIPTS_DELAY_MS,
  postPersonMessage,
  pushLocale,
  pushTicketsOf,
  registerPushDevice,
  renderPush,
  unregisterPushDevice,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const TOKEN_BIA = "ExponentPushToken[bia-phone-0001]";
const TOKEN_BIA_EN = "ExponentPushToken[bia-tablet-0001]";

/** Bia in #general with a phone (pt-BR), and the fake sender wired into the job handlers. */
async function withPhone(options: { unregistered?: string[]; goneLater?: string[] } = {}) {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await listMembers(f.db, f.org.id); // assigns handles
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await registerPushDevice(f.db, bia.id, { token: TOKEN_BIA, platform: "ios", locale: "pt-BR" });
  const push = createFakePushSender({ unregistered: options.unregistered, goneLater: options.goneLater });
  const handlers = createJobHandlers({ ...f.jobDeps, push });
  const drain = () => drainOutbox(f.db, handlers);
  return { bia, push, drain };
}

const pushJobs = async () =>
  (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "push.send"))).map((j) => j.payload);

describe("push text", () => {
  test("picks the language from the device locale", () => {
    expect(pushLocale("pt-BR")).toBe("pt-BR");
    expect(pushLocale("pt_PT")).toBe("pt-BR");
    expect(pushLocale("en-US")).toBe("en");
    expect(pushLocale(null)).toBe("en");
  });

  test("kinds render short friendly text; high-risk approvals only say to open the app", () => {
    expect(renderPush("pt-BR", { kind: "mention", waiting: false, actorName: "Ana", text: "olha isso" })).toEqual({
      title: "Ana mencionou você",
      body: "olha isso",
    });
    const question = renderPush("en", { kind: "agent_question", waiting: true, actorName: "Dev", text: "Which?" });
    expect(question).toEqual({ title: "Dev has a question for you", body: "Which?" });
    const risky = renderPush("pt-BR", {
      kind: "approval",
      waiting: true,
      actorName: "Dev",
      title: "Deploy api to production",
      highRisk: true,
    });
    expect(risky.title).toBe("Dev precisa da sua aprovação");
    expect(risky.body).toBe("Deploy api to production. Abra o app para revisar com calma.");
    expect(renderPush("en", { kind: "dm", waiting: false, actorType: "user", text: "hi" }).title).toBe("Someone");
    const long = renderPush("en", { kind: "mention", waiting: false, actorName: "Ana", text: "x".repeat(500) });
    expect(long.body.length).toBeLessThanOrEqual(180);
  });

  test("high risk follows the approval card's rule", () => {
    expect(approvalIsHighRisk({ tool: "github.merge_pull_request", scope: "github:merge" })).toBe(false);
    expect(approvalIsHighRisk({ tool: "deploy", scope: "railway:deploy" })).toBe(true);
    expect(approvalIsHighRisk({ tool: "send_email", scope: "gmail:send" })).toBe(true);
    expect(approvalIsHighRisk({ tool: "post_message", scope: "chat:send" })).toBe(false);
  });
});

describe("push delivery", () => {
  test("a mention pushes once to the person's phone with the deep link data", async () => {
    f = await setup();
    const { bia, push, drain } = await withPhone();
    await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@bia pode revisar?" });
    await drain();
    expect(push.sent).toHaveLength(1);
    const [n] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, bia.id));
    expect(push.sent[0]).toMatchObject({
      to: TOKEN_BIA,
      title: "ana mencionou você",
      body: "@bia pode revisar?",
      data: { orgId: f.org.id, kind: "mention", notificationId: n?.id, channelId: f.general.id },
    });
    // A retried job sends nothing new (one job per notification).
    await drain();
    expect(push.sent).toHaveLength(1);
  });

  test("a DM from a person pushes; each device gets its own language", async () => {
    f = await setup();
    const { bia, push, drain } = await withPhone();
    await registerPushDevice(f.db, bia.id, { token: TOKEN_BIA_EN, platform: "android", locale: "en" });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    await postPersonMessage(deps(), f.owner.id, f.org.id, dm.id, { body: "Te mandei o contrato" });
    await drain();
    expect(push.sent.map((m) => [m.to, m.title, m.body]).sort()).toEqual([
      [TOKEN_BIA, "ana", "Te mandei o contrato"],
      [TOKEN_BIA_EN, "ana", "Te mandei o contrato"],
    ]);
    expect(push.sent[0]?.data).toMatchObject({ kind: "dm", channelId: dm.id });
  });

  test("thread replies and other non-pushing kinds don't push", async () => {
    f = await setup();
    const { bia, push, drain } = await withPhone();
    const root = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "Release checklist" });
    await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "done", threadId: root.id });
    await drain();
    const [n] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, bia.id));
    expect(n?.kind).toBe("thread_reply");
    expect(push.sent).toHaveLength(0);
    expect(await pushJobs()).toEqual([]);
  });

  test("waiting items push with high priority; read before delivery means no push", async () => {
    f = await setup();
    const { bia, push, drain } = await withPhone();
    const [question] = await notify(deps(), {
      orgId: f.org.id,
      userIds: [bia.id],
      kind: "agent_question",
      groupKey: "agent_question:q1",
      waiting: true,
      actor: { type: "agent", id: f.agent.id },
      source: { channelId: f.general.id },
      latest: { text: "Qual branch?" },
    });
    const [read] = await notify(deps(), {
      orgId: f.org.id,
      userIds: [bia.id],
      kind: "mention",
      groupKey: "mention:m1",
      actor: { type: "agent", id: f.agent.id },
      source: { channelId: f.general.id },
      latest: { text: "seen already" },
    });
    await markNotificationRead(deps(), bia.id, f.org.id, read?.id ?? "", true);
    await drain();
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({
      title: "Dev tem uma pergunta para você",
      body: "Qual branch?",
      priority: "high",
      data: { kind: "agent_question", notificationId: question?.id },
    });
  });

  test("an unregistered token is deleted", async () => {
    f = await setup();
    const { bia, push, drain } = await withPhone({ unregistered: [TOKEN_BIA] });
    await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@bia oi" });
    await drain();
    expect(push.sent).toHaveLength(0);
    expect(await listPushDevices(f.db, bia.id)).toEqual([]);
  });

  test("receipts ~15 min later: a device gone since is deleted, a working one stays", async () => {
    f = await setup();
    const { bia, push, drain } = await withPhone({ goneLater: [TOKEN_BIA] });
    await registerPushDevice(f.db, bia.id, { token: TOKEN_BIA_EN, platform: "android", locale: "en" });
    await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@bia oi" });
    await drain();
    expect(push.sent).toHaveLength(2);
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "push.receipts"));
    expect(job?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + PUSH_RECEIPTS_DELAY_MS - 60_000);
    // Not due yet: nothing asked.
    await drain();
    expect(push.receiptRequests).toEqual([]);
    expect((await listPushDevices(f.db, bia.id)).length).toBe(2);

    const later = new Date(Date.now() + PUSH_RECEIPTS_DELAY_MS + 60_000);
    await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, push }), { now: later });
    expect(push.receiptRequests).toHaveLength(1);
    expect((await listPushDevices(f.db, bia.id)).map((d) => d.token)).toEqual([TOKEN_BIA_EN]);
  });

  test("checkPushReceipts ignores malformed tickets and senders without receipts", async () => {
    f = await setup();
    expect(pushTicketsOf([{ id: "a", token: "t" }, { id: 1 }, null, "x"])).toEqual([{ id: "a", token: "t" }]);
    expect(pushTicketsOf(undefined)).toEqual([]);
    const noReceipts = { id: "x", send: async () => [] };
    expect(await checkPushReceipts({ db: f.db, push: noReceipts }, [{ id: "a", token: "t" }])).toEqual({
      checked: 0,
      removed: 0,
    });
  });

  test("no phone, no job", async () => {
    f = await setup();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [caio.id],
      kind: "mention",
      groupKey: "mention:x",
      actor: { type: "agent", id: f.agent.id },
      source: { channelId: f.general.id },
    });
    expect(await pushJobs()).toEqual([]);
  });
});

describe("push devices", () => {
  test("a token moves to whoever registers it; only the owner can remove it", async () => {
    f = await setup();
    const { bia } = await withPhone();
    await registerPushDevice(f.db, f.owner.id, { token: TOKEN_BIA, platform: "ios", locale: "en" });
    expect(await listPushDevices(f.db, bia.id)).toEqual([]);
    expect(await unregisterPushDevice(f.db, bia.id, TOKEN_BIA)).toBe(false);
    expect((await listPushDevices(f.db, f.owner.id)).map((d) => [d.token, d.locale])).toEqual([[TOKEN_BIA, "en"]]);
    expect(await unregisterPushDevice(f.db, f.owner.id, TOKEN_BIA)).toBe(true);
    expect(await listPushDevices(f.db, f.owner.id)).toEqual([]);
  });

  test("keeps the newest 10 per person", async () => {
    f = await setup();
    const base = Date.now();
    for (let i = 0; i < 12; i++) {
      await registerPushDevice(
        f.db,
        f.owner.id,
        { token: `ExponentPushToken[device-${String(i).padStart(4, "0")}]`, platform: "android", locale: "en" },
        new Date(base + i * 1000),
      );
    }
    const tokens = (await listPushDevices(f.db, f.owner.id)).map((d) => d.token);
    expect(tokens).toHaveLength(10);
    expect(tokens).not.toContain("ExponentPushToken[device-0000]");
    expect(tokens).not.toContain("ExponentPushToken[device-0001]");
  });
});

describe("account deletion", () => {
  test("refused for the only owner of an organization with other members", async () => {
    f = await setup();
    await addMember(f.db, f.org.id, "member", "bia");
    await expect(deleteAccount(f.db, f.owner.id)).rejects.toMatchObject({
      code: "sole_owner",
      params: { organizations: ["Acme"] },
    });
    const [still] = await f.db.select().from(schema.users).where(eq(schema.users.id, f.owner.id));
    expect(still).toBeDefined();
  });

  test("a member leaves: memberships and phones go, messages stay without an author", async () => {
    f = await setup();
    const { bia } = await withPhone();
    const m = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "bye" });
    expect(await deleteAccount(f.db, bia.id)).toEqual({ deletedOrgIds: [] });
    expect(await f.db.select().from(schema.users).where(eq(schema.users.id, bia.id))).toEqual([]);
    expect(await f.db.select().from(schema.pushDevices)).toEqual([]);
    const members = await f.db
      .select()
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.userId, bia.id));
    expect(members).toEqual([]);
    const [kept] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, m.id));
    expect(kept).toMatchObject({ body: "bye", authorType: "person", authorUserId: null });
  });

  test("an organization where they are alone goes with them", async () => {
    f = await setup();
    expect(await deleteAccount(f.db, f.owner.id)).toEqual({ deletedOrgIds: [f.org.id] });
    expect(await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, f.org.id))).toEqual([]);
  });
});
