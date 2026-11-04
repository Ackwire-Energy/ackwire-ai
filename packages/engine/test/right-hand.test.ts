import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  archiveAgent,
  buildRunContext,
  changeMemberRole,
  createAgent,
  createOrganization,
  deleteAgent,
  ensureRightHand,
  ensureRightHands,
  exportBundle,
  grantedScopeKeys,
  grantKey,
  insertMessage,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  reflectThread,
  rightHandPrompt,
  setAgentAudience,
  setAgentChannels,
  setAgentComputerTarget,
  updateAgent,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const rightHandOf = async (orgId: string) =>
  f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, RIGHT_HAND)));

test("every workspace comes with one right hand, Lodi, owned by its owner", async () => {
  f = await setup({ rightHand: true });
  const [lodi, ...more] = await rightHandOf(f.org.id);
  expect(more).toEqual([]);
  expect(lodi).toMatchObject({
    name: "Lodi",
    handle: "lodi",
    model: "auto",
    ownerUserId: f.owner.id,
    monthlyBudgetNanoUsd: null,
    audienceMode: "everyone",
    machineId: null,
    appearance: { color: "teal", eyes: "happy", accessory: "headset" },
  });
  // Again changes nothing.
  expect(await ensureRightHand(f.db, f.org.id)).toBeNull();
  expect(await rightHandOf(f.org.id)).toHaveLength(1);
});

test("the boot backfill gives older workspaces theirs, not one being deleted, and takes the next free handle", async () => {
  f = await setup();
  // `setup` leaves the workspace without it, as one made before it; `@lodi` is taken there.
  await createAgent(f.db, f.owner.id, f.org.id, { name: "Lodi", handle: "lodi" }, { model: "claude-sonnet-5-5" });
  const other = await addUser(f.db, "bia");
  const { organization: closing } = await createOrganization(f.db, other.id, { name: "Closing" });
  await f.db.delete(schema.agents).where(eq(schema.agents.orgId, closing.id));
  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() + 86_400_000) })
    .where(eq(schema.organizations.id, closing.id));
  expect(await ensureRightHands(f.db)).toBe(1);
  expect((await rightHandOf(f.org.id))[0]?.handle).toBe("lodi-2");
  expect(await rightHandOf(closing.id)).toEqual([]);
  expect(await ensureRightHands(f.db)).toBe(0);
});

test("its owner follows the workspace's owner", async () => {
  f = await setup({ rightHand: true });
  const second = await addMember(f.db, f.org.id, "owner", "Theo");
  await changeMemberRole(f.db, second.id, f.org.id, f.owner.id, "member");
  expect((await rightHandOf(f.org.id))[0]?.ownerUserId).toBe(second.id);
});

test("it can't be archived, deleted or given other instructions; its name, model and budget can change", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const permanent = { code: "agent.right_hand_permanent" };
  await expect(archiveAgent(f.db, f.owner.id, f.org.id, lodi.id)).rejects.toMatchObject(permanent);
  await expect(
    deleteAgent({ db: f.db, pubsub: f.pubsub, hub: f.machineHub }, f.owner.id, f.org.id, lodi.id),
  ).rejects.toMatchObject(permanent);
  await expect(
    updateAgent(f.db, f.owner.id, f.org.id, lodi.id, { instructions: "be someone else" }),
  ).rejects.toMatchObject(permanent);
  await expect(updateAgent(f.db, f.owner.id, f.org.id, lodi.id, { ownerUserId: null })).rejects.toMatchObject(
    permanent,
  );
  const renamed = await updateAgent(f.db, f.owner.id, f.org.id, lodi.id, {
    name: "Nina",
    monthlyBudgetNanoUsd: 5_000_000_000,
  });
  expect(renamed).toMatchObject({ name: "Nina", monthlyBudgetNanoUsd: 5_000_000_000, archivedAt: null });
  // Never exported, so never imported elsewhere.
  expect((await exportBundle(f.db, f.owner.id, f.org.id)).agents.map((a) => a.handle)).toEqual(["dev"]);
});

test("its tools are fixed in code: a grant row gives it nothing, and its memory tools are off", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  await f.db.insert(schema.agentScopes).values({ orgId: f.org.id, agentId: lodi.id, scope: "sandbox:run" });
  const keys = await grantedScopeKeys(f.db, f.org.id, lodi.id);
  expect(keys.has(grantKey(null, "sandbox:run"))).toBe(false);
  expect(keys.has(grantKey(null, "setup:write"))).toBe(true);
  expect(keys.has(grantKey(null, "deny:remember"))).toBe(true);
  expect(keys.has(grantKey(null, "deny:web_fetch"))).toBe(true);
  expect(keys.has(grantKey(null, "deny:add_agent_to_channel"))).toBe(true);
});

test("it is in no channel and on no computer, whoever asks", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const permanent = { code: "agent.right_hand_permanent" };
  await expect(addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: lodi.id })).rejects.toMatchObject(
    permanent,
  );
  await expect(
    setAgentChannels(f.db, f.owner.id, f.org.id, lodi.id, [{ channelId: f.general.id }]),
  ).rejects.toMatchObject(permanent);
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await expect(
    setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, lodi.id, machineId),
  ).rejects.toMatchObject(permanent);
});

test("its prompt says what the person may do, and shows only the agents they may see", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const nina = await addMember(f.db, f.org.id, "member", "Nina");
  const secret = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Cofre", handle: "cofre" },
    { model: "claude-sonnet-5-5" },
  );
  await setAgentAudience(f.db, f.owner.id, f.org.id, secret.id, { mode: "owner", userIds: [] });
  const prompt = (personId: string) =>
    rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId, inDm: true });
  const owner = await prompt(f.owner.id);
  expect(owner).toContain("You are Lodi (@lodi)");
  expect(owner).toContain("an owner of this workspace");
  expect(owner).toContain("They may: create agents; change any agent's settings");
  expect(owner).not.toContain("They can't");
  expect(owner).toContain("- @cofre (Cofre)");
  expect(owner).toContain("- @dev (Dev), Developer");
  const member = await prompt(nina.id);
  expect(member).toContain("They can't: ");
  expect(member).toMatch(/They can't: [^\n]*change any agent's settings/);
  expect(member).not.toContain("@cofre");
  expect(member).toContain("(1 more agent this person can't see.)");
  expect(member).toContain("Never ask for a key, password or token in the chat");
  // Money only for who may see usage (ADR 0063).
  expect(owner).toMatch(/@dev \(Dev\)[^\n]*budget US\$/);
  expect(member).toMatch(/@dev \(Dev\)[^\n]*% of its monthly budget used/);
  expect(member).not.toContain("US$");
});

test("its setup checklist names the workspace's context and a computer until they are there", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const prompt = () =>
    rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true });
  await f.db.update(schema.organizations).set({ context: "" }).where(eq(schema.organizations.id, f.org.id));
  const bare = await prompt();
  expect(bare).toContain("The workspace has no context yet");
  expect(bare).toContain("No computer is ready for the agents yet");
  await f.db
    .update(schema.organizations)
    .set({ context: "We sell stock software." })
    .where(eq(schema.organizations.id, f.org.id));
  const [machine] = await f.db
    .insert(schema.machines)
    .values({ orgId: f.org.id, name: "Mac", tokenHash: "hash-of-a-fake-token" })
    .returning();
  const set = await prompt();
  expect(set).not.toContain("The workspace has no context yet");
  expect(set).not.toContain("No computer is ready");
  // A deleted computer (its token cleared) is none.
  await f.db
    .update(schema.machines)
    .set({ tokenHash: null })
    .where(eq(schema.machines.id, machine?.id ?? ""));
  expect(await prompt()).toContain("No computer is ready for the agents yet");
});

test("nothing said to it becomes memory", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId: f.owner.id },
    body: "our staging password policy is strict, remember that",
  });
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    threadId: root.id,
    author: { type: "agent", agentId: lodi.id, runId: null, hop: 1, stretchId: null },
    body: "Entendi.",
  });
  expect((await reflectThread(f.context, { orgId: f.org.id, threadRootId: root.id })).skipped).toBe("right_hand");
});

test("in its DM its run reads its own block, not an agent's instructions", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
    body: "preciso de alguém pro suporte",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const text = systemText((await buildRunContext(f.db, run, lodi, { maxMessages: 10 })).system);
  expect(text).toContain("this workspace's assistant: the team's right hand");
  expect(text).toContain("# Where you are\nYour private conversation with this person");
  expect(text).not.toContain("# Your instructions");
});

test("in no channel, an @mention in any channel still reaches it, and only that", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await rightHandOf(f.org.id);
  if (!lodi) throw new Error("no right hand");
  const runsOf = async (messageId: string) =>
    (
      await f.db
        .select({ agentId: schema.agentRuns.agentId, trigger: schema.agentRuns.trigger })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.triggerMessageId, messageId))
    ).map((r) => [r.agentId, r.trigger]);
  const called = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@lodi cria um agente de suporte?",
  });
  expect(called.mentionedAgentIds).toEqual([lodi.id]);
  expect(await runsOf(called.id)).toEqual([[lodi.id, "mention"]]);
  const members = await f.db
    .select({ agentId: schema.channelMembers.agentId })
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, f.general.id));
  expect(members.map((m) => m.agentId)).not.toContain(lodi.id);
});
