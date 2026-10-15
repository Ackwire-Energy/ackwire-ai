import { afterEach, describe, expect, test } from "bun:test";
import { userTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  canTalkTo,
  createAgent,
  createOrganization,
  createRoutine,
  dispatchMentions,
  drainOutbox,
  executeRoutineRun,
  ForbiddenError,
  insertMessageWithRuns,
  NotFoundError,
  openDm,
  postPersonMessage,
  type RouterStrategy,
  routeMessage,
  setAgentAudience,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** ana owns @dev; bia is a member in #general. */
async function world() {
  f = await setup({ reply: () => ({ chunks: ["ok"] }) });
  await f.db.update(schema.agents).set({ ownerUserId: f.owner.id }).where(eq(schema.agents.id, f.agent.id));
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  return { bia };
}

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const runsOf = async (messageId: string) =>
  (await f.db.select().from(schema.agentRuns)).filter((r) => r.triggerMessageId === messageId);

describe("who can talk to the agent", () => {
  test("default is everyone; owner or admins change it (members can't), audited; members must be in the org", async () => {
    const { bia } = await world();
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(row).toMatchObject({ audienceMode: "everyone", audienceUserIds: [] });
    await expect(
      setAgentAudience(f.db, bia.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // bia owns another agent: she can restrict it without being an admin.
    const hers = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Bot", handle: "bot", ownerUserId: bia.id },
      { model: "claude-sonnet-5-5" },
    );
    expect((await setAgentAudience(f.db, bia.id, f.org.id, hers.id, { mode: "owner", userIds: [] })).audienceMode).toBe(
      "owner",
    );
    const zed = await addUser(f.db, "zed");
    await expect(
      setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [zed.id] }),
    ).rejects.toBeInstanceOf(ValidationError);
    const updated = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, {
      mode: "people",
      userIds: [bia.id],
    });
    expect(canTalkTo(updated, bia.id)).toBe(true);
    expect(canTalkTo(updated, f.owner.id)).toBe(true); // the owner always can
    const audit = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "agent.audience_changed");
    expect(audit).toHaveLength(2);
    // Another organization can't touch it.
    const { organization } = await createOrganization(f.db, zed.id, { name: "Outra" });
    await expect(
      setAgentAudience(f.db, zed.id, organization.id, f.agent.id, { mode: "everyone", userIds: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a mention from someone not allowed starts nothing and only they get the notice", async () => {
    const { bia } = await world();
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    const heard: unknown[] = [];
    f.pubsub.subscribe(userTopic(f.org.id, bia.id), (e) => heard.push(e));
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    expect(await runsOf(sent.id)).toEqual([]);
    expect(sent.notices).toEqual([{ agentId: f.agent.id, text: "O Dev só responde a ana." }]);
    await Bun.sleep(5);
    expect(heard).toContainEqual(
      expect.objectContaining({ type: "agent.unavailable", agentId: f.agent.id, text: "O Dev só responde a ana." }),
    );
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);
    const mine = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    expect(await runsOf(mine.id)).toHaveLength(1);
    expect(mine.notices).toBeUndefined();
  });

  test("a DM can't be started by someone not allowed; in an old DM their messages start nothing", async () => {
    const { bia } = await world();
    const dm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id }); // before the change
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [] });
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, dm.id, { body: "oi" });
    expect(await runsOf(sent.id)).toEqual([]);
    expect(sent.notices?.[0]?.text).toBe("O Dev só responde a ana.");
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);
    const cara = await addMember(f.db, f.org.id, "member", "cara");
    await expect(openDm(f.db, cara.id, f.org.id, { agentId: f.agent.id })).rejects.toThrow("O Dev só responde a ana.");
    expect((await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).kind).toBe("dm");
  });

  test("the router never offers an agent the author can't talk to (also not as the follow-up agent)", async () => {
    const { bia } = await world();
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    const seen: string[][] = [];
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        seen.push(input.candidates.map((c) => c.handle));
        return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 1 })), reason: "test" };
      },
    };
    const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };
    const route = async (userId: string, body: string, threadId?: string) => {
      const m = await postPersonMessage(deps(), userId, f.org.id, f.general.id, { body, threadId });
      return routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id });
    };
    const theirs = await route(bia.id, "alguém pode revisar o deploy?");
    expect(theirs.runs).toEqual([]);
    expect(theirs.skipped).toBe("no_candidates");
    const root = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev revisa o deploy" });
    await drainOutbox(f.db, f.handlers);
    // bia's short follow-up in that thread would go to "the last agent": not to one she can't talk to.
    const followUp = await route(bia.id, "e agora?", root.id);
    expect(followUp.runs).toEqual([]);
    const anas = await route(f.owner.id, "alguém pode revisar o deploy?");
    expect(anas.runs.map((r) => r.agentId)).toEqual([f.agent.id]);
    expect(seen).toEqual([["dev"]]);
  });

  test("an agent asking another one acts for the person behind its run", async () => {
    const { bia } = await world();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", ownerUserId: f.owner.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    await setAgentAudience(f.db, f.owner.id, f.org.id, ops.id, { mode: "owner", userIds: [] });
    const askFor = async (userId: string) => {
      const asked = await postPersonMessage(deps(), userId, f.org.id, f.general.id, { body: "@dev verifica" });
      const [run] = await runsOf(asked.id);
      const { message } = await insertMessageWithRuns(
        f.db,
        {
          orgId: f.org.id,
          channelId: f.general.id,
          threadId: asked.id,
          author: { type: "agent", agentId: f.agent.id, runId: run?.id ?? "", hop: 1 },
          body: "@ops pode olhar o deploy?",
        },
        { startRuns: false },
      );
      return dispatchMentions(f.db, { orgId: f.org.id, messageId: message.id }, { maxHops: 3 });
    };
    expect((await askFor(bia.id)).runs).toEqual([]);
    expect((await askFor(f.owner.id)).runs.map((r) => r.agentId)).toEqual([ops.id]);
  });

  test("routines: only allowed people create them; a routine whose creator lost access pauses", async () => {
    const { bia } = await world();
    const routineDeps = { db: f.db, pubsub: f.pubsub, context: f.context };
    const input = {
      agentId: f.agent.id,
      prompt: "Resuma o dia.",
      target: { type: "channel" as const, channelId: f.general.id },
      trigger: { type: "schedule" as const, phrase: "todo dia às 9h" },
    };
    await f.db
      .update(schema.organizationMembers)
      .set({ role: "admin" })
      .where(eq(schema.organizationMembers.userId, bia.id));
    const routine = await createRoutine(routineDeps, bia.id, f.org.id, input);
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    await expect(createRoutine(routineDeps, bia.id, f.org.id, input)).rejects.toThrow("O Dev só responde a ana.");
    const [run] = await f.db
      .insert(schema.routineRuns)
      .values({ orgId: f.org.id, routineId: routine.id, at: new Date(), trigger: "schedule", status: "queued" })
      .returning();
    await executeRoutineRun(routineDeps, run?.id ?? "");
    const [after] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
    expect(after?.active).toBe(false);
    const [done] = await f.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, run?.id ?? ""));
    expect(done).toMatchObject({ status: "skipped", summary: "Pausada: O Dev só responde a ana." });
    expect((await f.db.select().from(schema.messages)).some((m) => m.meta.routineId === routine.id)).toBe(false);
  });
});
