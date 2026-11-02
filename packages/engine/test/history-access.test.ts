import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  drainOutbox,
  ForbiddenError,
  getRun,
  listAgentMemoryRows,
  listNotifications,
  listOrgMemoryRows,
  listRuns,
  NotFoundError,
  notify,
  openDm,
  postPersonMessage,
  removeChannelMember,
  removeMember,
  revertMemoryChange,
  setMemberRoles,
} from "../src";
import { addMember, type Fixture, makeAdmin, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("run history quotes a conversation only to who reads it", () => {
  test("the agent's owner and an admin see a colleague's DM run as numbers only", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"], usage: { inputTokens: 1000, outputTokens: 100 } }) });
    const colleague = await addMember(f.db, f.org.id, "member", "colleague");
    const admin = await addMember(f.db, f.org.id, "admin", "auditor");
    const dm = await openDm(f.db, colleague.id, f.org.id, { agentId: f.agent.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, colleague.id, f.org.id, dm.id, {
      body: "my salary is late, payroll secret",
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev check the deploy",
    });
    await drainOutbox(f.db, f.handlers);

    for (const viewer of [f.owner.id, admin.id]) {
      const runs = await listRuns(f.db, viewer, f.org.id, { agentId: f.agent.id });
      const inDm = runs.find((r) => r.channelId === dm.id);
      expect(inDm?.private).toBe(true);
      expect(inDm?.what).toBe("");
      expect(inDm?.inputTokens).toBe(1000);
      expect(inDm?.status).toBe("done");
      const detail = await getRun(f.db, viewer, f.org.id, inDm?.id ?? "");
      expect(detail.steps).toEqual([]);
      expect(detail.run?.what).toBe("");
    }
    // A conversation the owner is in stays fully readable to them.
    const runs = await listRuns(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const inGeneral = runs.find((r) => r.channelId === f.general.id);
    expect(inGeneral?.private).toBe(false);
    expect(inGeneral?.what).toBe("@dev check the deploy");
    expect((await getRun(f.db, f.owner.id, f.org.id, inGeneral?.id ?? "")).steps.length).toBeGreaterThan(0);
  });
});

describe("memory undo and other people's preferences", () => {
  const item = async (values: Partial<typeof schema.contextItems.$inferInsert>) => {
    const [row] = await f.db
      .insert(schema.contextItems)
      .values({
        orgId: f.org.id,
        kind: "fact",
        scopeType: "agent",
        scopeId: f.agent.id,
        agentId: f.agent.id,
        content: "never discount above 10%",
        ...values,
      })
      .returning();
    if (!row) throw new Error("no item");
    return row;
  };

  test("a member who may not edit it can't undo it; the owner can", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "member");
    const fact = await item({});
    await expect(revertMemoryChange(f.db, member.id, f.org.id, fact.id)).rejects.toBeInstanceOf(ForbiddenError);
    const [kept] = await f.db.select().from(schema.contextItems);
    expect(kept?.status).toBe("active");
    expect((await revertMemoryChange(f.db, f.owner.id, f.org.id, fact.id)).status).toBe("archived");
  });

  test("the person an agent changed it for may undo it while its window is open", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "member");
    const fact = await item({});
    const action = {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      requestedByUserId: member.id,
      kind: "memory.saved",
      targetType: "memory",
      targetId: fact.id,
    };
    await f.db.insert(schema.agentActions).values({ ...action, undoableUntil: new Date(Date.now() - 1000) });
    await expect(revertMemoryChange(f.db, member.id, f.org.id, fact.id)).rejects.toBeInstanceOf(ForbiddenError);
    await f.db.insert(schema.agentActions).values({ ...action, undoableUntil: new Date(Date.now() + 60_000) });
    expect((await revertMemoryChange(f.db, member.id, f.org.id, fact.id)).status).toBe("archived");
  });

  test("someone else's preference is out of both lists and can't be undone", async () => {
    f = await setup();
    const alice = await addMember(f.db, f.org.id, "member", "alice");
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const pref = await item({ kind: "preference", scopeType: "person", scopeId: alice.id, content: "call me Al" });
    // Bob owns the agent: he may edit its memory, still not read Alice's preferences.
    await f.db.update(schema.agents).set({ ownerUserId: bob.id });
    await f.db.insert(schema.channelMembers).values([
      { orgId: f.org.id, channelId: f.general.id, userId: alice.id },
      { orgId: f.org.id, channelId: f.general.id, userId: bob.id },
    ]);
    const forBob = await listAgentMemoryRows(f.db, bob.id, f.org.id, f.agent.id);
    expect(forBob.items.map((i) => i.id)).not.toContain(pref.id);
    expect((await listOrgMemoryRows(f.db, bob.id, f.org.id)).items.map((i) => i.id)).not.toContain(pref.id);
    await expect(revertMemoryChange(f.db, bob.id, f.org.id, pref.id)).rejects.toBeInstanceOf(NotFoundError);
    // Alice and who reviews memory still see it.
    expect((await listAgentMemoryRows(f.db, alice.id, f.org.id, f.agent.id)).items.map((i) => i.id)).toContain(pref.id);
    expect((await listOrgMemoryRows(f.db, f.owner.id, f.org.id)).items.map((i) => i.id)).toContain(pref.id);
  });
});

describe("notifications follow access", () => {
  const deps = () => ({ db: f.db, pubsub: f.pubsub });
  const inbox = async (userId: string) =>
    (await listNotifications(deps(), userId, f.org.id)).items.map((n) => `${n.kind}:${n.latest.text}`).sort();

  test("leaving a channel takes its snippets; an approval its member may still decide stays", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin", "admin");
    const [secret] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "secret", visibility: "private", createdByUserId: f.owner.id })
      .returning();
    const channelId = secret?.id ?? "";
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId, userId: admin.id });
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [admin.id],
      kind: "mention",
      groupKey: "mention:1",
      source: { channelId },
      latest: { text: "the merger closes friday" },
    });
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [admin.id],
      kind: "approval",
      groupKey: "approval:1",
      waiting: true,
      source: { channelId, approvalId: crypto.randomUUID() },
      latest: { text: "deploy" },
    });
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [admin.id],
      kind: "mention",
      groupKey: "mention:2",
      source: { channelId: f.general.id },
      latest: { text: "hello" },
    });
    await removeChannelMember(f.db, admin.id, f.org.id, channelId, { userId: admin.id });
    expect(await inbox(admin.id)).toEqual(["approval:deploy", "mention:hello"]);
  });

  test("leaving the workspace empties the inbox there: invited back, nothing returns", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "member");
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [member.id],
      kind: "mention",
      groupKey: "mention:1",
      source: { channelId: f.general.id },
      latest: { text: "private snippet" },
    });
    await removeMember(f.db, f.owner.id, f.org.id, member.id);
    await f.db.insert(schema.organizationMembers).values({ orgId: f.org.id, userId: member.id, role: "member" });
    expect(await inbox(member.id)).toEqual([]);
  });

  test("an approval leaves the inbox with approve_actions; the agent's owner it was asked of keeps theirs", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin", "admin");
    const owner = await addMember(f.db, f.org.id, "member", "agent-owner");
    const [approval] = await f.db
      .insert(schema.approvals)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        toolUseId: "t1",
        tool: "github",
        scope: "github:pr.merge",
        params: {},
        actionHash: "h",
        title: "Merge PR #42",
        ownerUserId: owner.id,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [admin.id, owner.id],
      kind: "approval",
      groupKey: "approval:1",
      waiting: true,
      source: { channelId: f.general.id, approvalId: approval?.id },
      latest: { text: "merge it" },
    });
    expect(await inbox(admin.id)).toEqual(["approval:merge it"]);
    expect(await inbox(owner.id)).toEqual(["approval:merge it"]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, admin.id, []);
    expect(await inbox(admin.id)).toEqual([]);
    expect((await listNotifications(deps(), admin.id, f.org.id)).counts.waiting).toBe(0);
    expect(await inbox(owner.id)).toEqual(["approval:merge it"]);
    // Given the key back, it returns.
    await makeAdmin(f.db, f.org.id, admin.id);
    expect(await inbox(admin.id)).toEqual(["approval:merge it"]);
  });
});
