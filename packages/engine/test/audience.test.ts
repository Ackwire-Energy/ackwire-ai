import { afterEach, describe, expect, test } from "bun:test";
import { BRAIN_PROTOCOL, userTopic } from "@agenteschat/adapters";
import { eq, rowsOf, schema, sql } from "@agenteschat/db";
import {
  acceptInvitation,
  addChannelMember,
  audienceOf,
  audienceSql,
  canTalkTo,
  createAgent,
  createOrganization,
  createRole,
  createRoutine,
  dispatchMentions,
  drainOutbox,
  executeRoutineRun,
  ForbiddenError,
  getAgentBrain,
  insertMessageWithRuns,
  inviteMany,
  NotFoundError,
  openDm,
  postPersonMessage,
  type RouterStrategy,
  removeMember,
  routeMessage,
  setAgentAudience,
  setAgentBrain,
  setInvitationRoles,
} from "../src";
import { addMember, addUser, type Fixture, makeAdmin, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

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
    const updated = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, {
      mode: "people",
      userIds: [bia.id, zed.id],
    });
    expect(updated.audienceUserIds).toEqual([bia.id]);
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

  test("someone invited with a role changed before accepting can be given the agent; one who left drops out", async () => {
    const { bia } = await world();
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    const [sent] = await inviteMany(f.db, f.owner.id, f.org.id, { emails: ["teo@example.com"], secret: SECRET });
    if (sent?.status !== "invited") throw new Error("expected an invitation");
    await setInvitationRoles(f.db, f.owner.id, f.org.id, sent.invitationId, [support.id]);
    await f.db.insert(schema.users).values({ id: "u_teo", name: "Teo", email: "teo@example.com" });
    await acceptInvitation(f.db, { id: "u_teo", email: "teo@example.com" }, sent.token);
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [bia.id] });
    // bia leaves: her id no longer stays on the agent, and the list the apps still hold is saved without her.
    await removeMember(f.db, bia.id, f.org.id, bia.id);
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(row?.audienceUserIds).toEqual([]);
    const updated = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, {
      mode: "people",
      userIds: [bia.id, "u_teo"],
    });
    expect(updated.audienceUserIds).toEqual(["u_teo"]);
  });

  test("the migration takes people no longer in the workspace off the agents' lists, keeping the order", async () => {
    const { bia } = await world();
    const cid = await addMember(f.db, f.org.id, "member", "cid");
    const gone = await addUser(f.db, "gone");
    const stale = [cid.id, gone.id, bia.id];
    await f.db.update(schema.agents).set({ audienceMode: "people", audienceUserIds: stale });
    const file = await Bun.file(new URL("../../db/migrations/0169_agent_audience_members.sql", import.meta.url)).text();
    await f.db.execute(sql.raw(file));
    await f.db.execute(sql.raw(file));
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(row?.audienceUserIds).toEqual([cid.id, bia.id]);
  });

  test("a mention from someone not allowed starts nothing and only they get the notice", async () => {
    const { bia } = await world();
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    const heard: unknown[] = [];
    f.pubsub.subscribe(userTopic(f.org.id, bia.id), (e) => heard.push(e));
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    expect(await runsOf(sent.id)).toEqual([]);
    expect(sent.notices).toEqual([
      {
        agentId: f.agent.id,
        text: "Dev only replies to ana.",
        code: "audience.only",
        params: { agentId: f.agent.id, agentName: "Dev", userIds: [f.owner.id], names: ["ana"] },
      },
    ]);
    await Bun.sleep(5);
    expect(heard).toContainEqual(
      expect.objectContaining({ type: "agent.unavailable", agentId: f.agent.id, text: "Dev only replies to ana." }),
    );
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);
    const mine = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    expect(await runsOf(mine.id)).toHaveLength(1);
    expect(mine.notices).toBeUndefined();
  });

  test("an agent nobody may talk to (no owner, only its owner) still tells whoever mentions it", async () => {
    const { bia } = await world();
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: null, audienceMode: "owner" })
      .where(eq(schema.agents.id, f.agent.id));
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    expect(sent.notices).toMatchObject([{ code: "audience.nobody", text: "Dev isn't replying to anyone right now." }]);
    expect(await runsOf(sent.id)).toEqual([]);
  });

  test("a DM can't be started by someone not allowed; in an old DM their messages start nothing", async () => {
    const { bia } = await world();
    const dm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id }); // before the change
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [] });
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, dm.id, { body: "oi" });
    expect(await runsOf(sent.id)).toEqual([]);
    expect(sent.notices?.[0]?.text).toBe("Dev only replies to ana.");
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);
    const cara = await addMember(f.db, f.org.id, "member", "cara");
    await expect(openDm(f.db, cara.id, f.org.id, { agentId: f.agent.id })).rejects.toMatchObject({
      code: "audience.only",
      params: { agentName: "Dev", names: ["ana"] },
    });
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
          threadId: null, // asked in the channel, dev answers there
          author: { type: "agent", agentId: f.agent.id, runId: run?.id ?? "", hop: 1 },
          body: "@ops pode olhar o deploy?",
        },
        { startRuns: false },
      );
      const out = await dispatchMentions(f.db, { orgId: f.org.id, messageId: message.id }, { maxHops: 3 });
      // Dev answered: its run ends (a second call in the channel would otherwise join it while it works).
      if (run) await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
      return out;
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
    await makeAdmin(f.db, f.org.id, bia.id);
    const routine = await createRoutine(routineDeps, bia.id, f.org.id, input);
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    await expect(createRoutine(routineDeps, bia.id, f.org.id, input)).rejects.toMatchObject({ code: "audience.only" });
    const [run] = await f.db
      .insert(schema.routineRuns)
      .values({ orgId: f.org.id, routineId: routine.id, at: new Date(), trigger: "schedule", status: "queued" })
      .returning();
    await executeRoutineRun(routineDeps, run?.id ?? "");
    const [after] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
    expect(after).toMatchObject({ active: false, pausedReason: "audience" });
    const [done] = await f.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, run?.id ?? ""));
    expect(done).toMatchObject({ status: "skipped", code: "audience" });
    expect((await f.db.select().from(schema.messages)).some((m) => m.meta.routineBrief !== undefined)).toBe(false);
  });

  test("on a plan only its owner widens it, with nothing to accept, audited as any change; admins narrow", async () => {
    const { bia } = await world();
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", audienceMode: "owner" })
      .where(eq(schema.agents.id, f.agent.id));
    const everyone = { mode: "everyone" as const, userIds: [] };
    const some = { mode: "people" as const, userIds: [bia.id] };
    const widen = (actor: string, to: typeof everyone | typeof some) =>
      setAgentAudience(f.db, actor, f.org.id, f.agent.id, to).catch((e) => e);
    expect(await widen(caio.id, everyone)).toMatchObject({ code: "audience.plan_owner_only" });
    expect(audienceOf(await widen(f.owner.id, some))).toEqual(some);
    const audits = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "agent.audience_changed");
    expect(audits.map((a) => a.details)).toEqual([{ from: { mode: "owner", userIds: [] }, to: some }]);
    expect((await widen(f.owner.id, everyone)).audienceMode).toBe("everyone");
    expect((await widen(caio.id, some)).audienceMode).toBe("people");
    expect(await widen(caio.id, everyone)).toBeInstanceOf(ForbiddenError);
    // On the API nothing of this applies.
    await f.db.update(schema.agents).set({ brain: "model" }).where(eq(schema.agents.id, f.agent.id));
    expect((await widen(caio.id, everyone)).audienceMode).toBe("everyone");
  });

  test("the gate in SQL and in code agree: every audience, on a plan or the API, with an owner or none", async () => {
    const { bia } = await world();
    const cara = await addMember(f.db, f.org.id, "member", "cara");
    const people = [f.owner.id, bia.id, cara.id, null];
    let checked = 0;
    for (const brain of ["model", "claude_code", "codex"] as const)
      for (const audienceMode of ["everyone", "people", "owner"] as const)
        for (const ownerUserId of [f.owner.id, null]) {
          const set = { brain, audienceMode, ownerUserId, audienceUserIds: [bia.id] };
          const [row] = await f.db.update(schema.agents).set(set).where(eq(schema.agents.id, f.agent.id)).returning();
          if (!row) throw new Error("no agent");
          for (const person of people) {
            const [found] = rowsOf<{ ok: boolean }>(
              await f.db.execute(
                sql`select ${audienceSql("a", sql`${person}::text`)} as ok from agents a where a.id = ${f.agent.id}::uuid`,
              ),
            );
            expect({ ...set, person, ok: found?.ok }).toEqual({ ...set, person, ok: canTalkTo(row, person) });
            checked++;
          }
        }
    expect(checked).toBe(72);
  });

  test("an agent that thinks with its owner's plan: a DM from anyone else gets the notice until its owner lets everyone in", async () => {
    const { bia } = await world();
    const dm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id }); // before the plan
    const { machineId } = await pairMachine(deps(), f.owner.id, f.org.id, {
      name: "mac",
      protocol: BRAIN_PROTOCOL,
      exec: true,
    });
    await f.db
      .update(schema.machines)
      .set({ executors: { claude: { version: "2.1.304", loggedIn: true }, detectedAt: new Date().toISOString() } })
      .where(eq(schema.machines.id, machineId));
    await f.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, f.agent.id));
    await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id, { brain: "claude_code" });
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, dm.id, { body: "oi" });
    expect(sent.notices).toEqual([
      {
        agentId: f.agent.id,
        text: "Dev only replies to ana.",
        code: "audience.only",
        params: { agentId: f.agent.id, agentName: "Dev", userIds: [f.owner.id], names: ["ana"] },
      },
    ]);
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);
    const cara = await addMember(f.db, f.org.id, "member", "cara");
    await expect(openDm(f.db, cara.id, f.org.id, { agentId: f.agent.id })).rejects.toMatchObject({
      code: "audience.only",
    });

    // "Atende outras pessoas": its owner turns it on, nothing to accept, on whatever server.
    expect((await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id, { onlyOwner: false })).onlyOwner).toBe(
      false,
    );
    expect((await getAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id)).brain).toBe("claude_code");
    const again = await postPersonMessage(deps(), bia.id, f.org.id, dm.id, { body: "oi de novo" });
    expect(again.notices).toBeUndefined();
    expect(await runsOf(again.id)).toHaveLength(1);
    expect((await openDm(f.db, cara.id, f.org.id, { agentId: f.agent.id })).kind).toBe("dm");
  });
});
