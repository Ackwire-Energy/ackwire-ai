import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  createAgent,
  createAskAgentToolSource,
  createChannel,
  createJobHandlers,
  drainOutbox,
  insertMessage,
  openDm,
  postPersonMessage,
  type RouterStrategy,
  runRoutineNow,
} from "../src";
import { notifyAgentUnreached } from "../src/notification-producers";
import { reachNote, reachOf } from "../src/reach";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, messagesIn, notificationsOf, routineDeps } from "./routine-fixtures";

/**
 * A message meant for an agent reaches it, or someone is told why not: an agent's @mention of an agent outside the
 * conversation goes to it as a note, one the person behind it can't talk to says so under the message, and a
 * routine whose creator can't reach the agent tells the agent's owner. Every skip is in `routing_decisions`.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const inAgentDm = (req: ModelRequest) => systemText(req.system).includes("A private conversation between agents");
const NO_ROUTE = { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] };

async function agentOf(name: string, handle: string, options: { inGeneral: boolean }) {
  const a = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role: "Pesquisa", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  if (options.inGeneral)
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
  return a;
}

const runsOf = () => f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));

/** Dev, woken by Ana, writes `body` in #general (or `channelId`) from its run (its mentions are resolved as the server's). */
async function devWrites(body: string, unreached: string[], channelId = f.general.id) {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, {
    body: "@dev prepara o resumo",
  });
  const [run] = await runsOf();
  if (!run) throw new Error("no run");
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  return insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
    body,
    meta: { unreachedAgents: unreached },
  });
}

const decisionOf = async (messageId: string) =>
  (await f.db.select().from(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, messageId)))[0];
const messageOf = async (id: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0];

describe("an agent's mention of an agent outside the conversation", () => {
  test("goes to it as a note, shows under the message and in the author's next context", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) =>
        req.outputSchema ? NO_ROUTE : inAgentDm(req) ? { chunks: ["Vou revisar."] } : { chunks: ["ok"] },
    });
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const sent = await devWrites("@ivo revisa o relatório de hoje.", ["ivo"]);
    await drainOutbox(f.db, f.handlers);

    const [note] = await f.db.select().from(schema.agentConsultations);
    expect(note).toMatchObject({ kind: "note", askerAgentId: f.agent.id, targetAgentId: ivo.id });
    expect(note?.question).toContain("revisa o relatório de hoje");
    expect((await runsOf()).some((r) => r.agentId === ivo.id && r.channelId === note?.channelId)).toBe(true);
    const reach = reachOf((await messageOf(sent.id))?.meta);
    expect(reach).toEqual([{ agentId: ivo.id, handle: "ivo", reason: "not_in_channel", consultationId: note?.id }]);
    expect((await decisionOf(sent.id))?.reason).toContain("not_in_channel: @ivo");
    expect(reachNote(reach)).toContain("went to it as a note");
  });

  test("the judge reads as needing nothing: no note", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.95 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    await agentOf("Ivo", "ivo", { inGeneral: false });
    const sent = await devWrites("Valeu, @ivo!", ["ivo"]);
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
    expect(reachOf((await messageOf(sent.id))?.meta)).toEqual([]);
  });

  test("one the person behind it can't talk to gets nothing, and the message says so", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, ivo.id));
    const sent = await devWrites("@ivo revisa o relatório de hoje.", ["ivo"]);
    await drainOutbox(f.db, f.handlers);

    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
    const reach = reachOf((await messageOf(sent.id))?.meta);
    expect(reach).toEqual([{ agentId: ivo.id, handle: "ivo", reason: "audience", outside: true, userId: f.owner.id }]);
    expect((await decisionOf(sent.id))?.reason).toContain("audience: @ivo");
    expect(reachNote(reach)).toContain("the person you are helping isn't one of them");
  });
});

describe("a member the person behind an agent's message can't talk to", () => {
  test("isn't woken, and the message says why", async () => {
    f = await setup({
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, gil.id));
    const sent = await devWrites("@gil revisa o relatório de hoje.", []);
    await drainOutbox(f.db, f.handlers);

    expect((await runsOf()).filter((r) => r.agentId === gil.id)).toEqual([]);
    expect(reachOf((await messageOf(sent.id))?.meta)).toEqual([
      { agentId: gil.id, handle: "gil", reason: "audience", userId: f.owner.id },
    ]);
    expect((await decisionOf(sent.id))?.reason).toContain("audience: @gil");
  });
});

describe("a member that takes consultations for the person behind an agent's message", () => {
  test("isn't woken here: it is asked privately by note, and answers the agent in their DM", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner" })
      .where(eq(schema.agents.id, gil.id));
    const sent = await devWrites("@gil revisa o relatório de hoje.", []);
    await drainOutbox(f.db, f.handlers);

    const [note] = await f.db.select().from(schema.agentConsultations);
    expect(note).toMatchObject({ targetAgentId: gil.id, kind: "note" });
    const gilRuns = (await runsOf()).filter((r) => r.agentId === gil.id);
    expect(gilRuns.map((r) => r.channelId)).toEqual([note?.channelId ?? ""]);
    const said = await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, gil.id));
    expect(said.every((m) => m.channelId === note?.channelId)).toBe(true);
    const reach = reachOf((await messageOf(sent.id))?.meta);
    expect(reach).toEqual([{ agentId: gil.id, handle: "gil", reason: "audience", consultationId: note?.id ?? "" }]);
    expect(reachNote(reach)).toContain("only answers the people here through other agents");
    // It was reached: the author isn't told its mention woke nobody.
    const skipped = (await f.db.select().from(schema.messages)).filter(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "wake_skipped",
    );
    expect(skipped).toEqual([]);
  });
});

describe("a routine whose creator can't reach the agent it names", () => {
  test("its report says so, the agent's owner is told, and the decision is recorded", async () => {
    f = await setup({
      handOff: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => {
        if (req.outputSchema) return NO_ROUTE;
        if (isRoutine(req)) return { chunks: ["Relatório: o Gil precisa revisar o PR #42."] };
        return { chunks: ["@gil revisa o PR #42 hoje, por favor."] };
      },
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, gil.id));
    const routine = await channelRoutine(f, {
      access: "act",
      report: "always",
      prompt: "Cobre o @gil sobre o PR #42.",
    });
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);

    expect((await runsOf()).filter((r) => r.agentId === gil.id)).toEqual([]);
    const said = (await messagesIn(f, f.general.id)).find((m) => m.body.startsWith("@gil"));
    if (!said) throw new Error("the report wasn't told");
    expect(reachOf(said.meta)).toEqual([
      {
        agentId: gil.id,
        handle: "gil",
        reason: "routine_creator_reach",
        userId: f.owner.id,
        routine: { id: routine.id, name: routine.name, creatorUserId: f.owner.id, access: "act" },
      },
    ]);
    expect((await decisionOf(said.id))?.reason).toContain("routine_creator_reach: @gil");
    const [told] = await notificationsOf(f, "agent_unreached");
    expect(told).toMatchObject({ userId: bob.id });
    expect(told?.source).toMatchObject({ agentId: gil.id, routineId: routine.id, messageId: said.id });
  });
});

describe("never silent, the edges", () => {
  test("an outside mention leaves the chime-in router its say: a member it picks still starts", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const ops = await agentOf("Ops", "ops", { inGeneral: true });
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        return {
          agents: input.candidates.map((c) => ({ agentId: c.agentId, score: c.handle === "ops" ? 0.9 : 0 })),
          reason: "test",
        };
      },
    };
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", strategy },
    });
    const sent = await devWrites("Deploy feito, @ivo pode conferir os logs?", ["ivo"]);
    await drainOutbox(f.db, handlers);

    expect((await runsOf()).some((r) => r.agentId === ops.id && r.triggerMessageId === sent.id)).toBe(true);
    expect((await f.db.select().from(schema.agentConsultations)).map((c) => c.targetAgentId)).toEqual([ivo.id]);
    expect((await decisionOf(sent.id))?.reason).toContain("not_in_channel: @ivo");
  });

  test("from a private channel too it goes as a note, with the line under it", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const rh = await createChannel(f.db, f.owner.id, f.org.id, { name: "rh", visibility: "private" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: rh.id, agentId: f.agent.id });
    const sent = await devWrites("Como o @ivo pediu, segue a planilha de salários.", ["ivo"], rh.id);
    await drainOutbox(f.db, f.handlers);

    const [note] = await f.db.select().from(schema.agentConsultations);
    expect(note?.targetAgentId).toBe(ivo.id);
    const reach = reachOf((await messageOf(sent.id))?.meta);
    expect(reach).toEqual([{ agentId: ivo.id, handle: "ivo", reason: "not_in_channel", consultationId: note?.id }]);
    expect((await decisionOf(sent.id))?.reason).toContain("not_in_channel: @ivo");
    expect(reachNote(reach)).toContain("[Delivered as a note]");
  });

  test("from a DM too it goes as a note, but only to an agent the person behind it may talk to", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const eva = await agentOf("Eva", "eva", { inGeneral: false });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, eva.id));
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const sent = await devWrites("@ivo e @eva, revisem o resumo.", ["eva", "ivo"], dm.id);
    await drainOutbox(f.db, f.handlers);

    const notes = await f.db.select().from(schema.agentConsultations);
    expect(notes.map((c) => c.targetAgentId)).toEqual([ivo.id]);
    const reach = reachOf((await messageOf(sent.id))?.meta);
    expect(reach.map((e) => [e.handle, e.reason, !!e.consultationId]).sort()).toEqual([
      ["eva", "audience", false],
      ["ivo", "not_in_channel", true],
    ]);
  });

  test("an agent with no AI isn't shown as handed: the line says nothing could answer", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    await f.db
      .update(schema.agents)
      .set({ model: "gpt-6-luna", credentialId: null })
      .where(eq(schema.agents.id, ivo.id));
    const sent = await devWrites("@ivo revisa o relatório de hoje.", ["ivo"]);
    await drainOutbox(f.db, f.handlers);

    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
    expect(reachOf((await messageOf(sent.id))?.meta)).toEqual([
      { agentId: ivo.id, handle: "ivo", reason: "not_in_channel", noAi: true },
    ]);
  });

  test("a tell_agent after the mention was handed sends no second note", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const sent = await devWrites("@ivo revisa o relatório de hoje.", ["ivo"]);
    // Ivo never works on it: the note stays open.
    const handlers = { ...f.handlers, "agent_run.execute": async () => {} };
    await drainOutbox(f.db, handlers);
    expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(1);

    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: sent.agentRunId as string,
      channelId: f.general.id,
      threadRootId: sent.id,
      triggerMessageId: sent.id,
    };
    const tell = (await createAskAgentToolSource().tools(ctx)).find((t) => t.name === "tell_agent");
    const out = await tell?.execute({ agent: "@ivo", message: "Confere os logs também." }, ctx);
    expect(out?.content).toContain("already has it");
    expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(1);
    expect((await f.db.select().from(schema.agentConsultations))[0]?.targetAgentId).toBe(ivo.id);
  });
});

describe("a routine's own tell_agent to an agent its creator can't reach", () => {
  test("the report shows the line, the agent's owner is told, and the decision is recorded", async () => {
    const hasResult = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content).includes("tool_result");
    f = await setup({
      askAgent: true,
      handOff: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => {
        if (req.outputSchema) return NO_ROUTE;
        if (isRoutine(req) && !hasResult(req))
          return {
            chunks: [],
            toolUses: [{ name: "tell_agent", input: { agent: "@gil", message: "Revise o PR #42." } }],
          };
        return { chunks: ["Relatório: não consegui chamar o Gil sobre o PR #42."] };
      },
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: false });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, gil.id));
    const routine = await channelRoutine(f, { access: "act", report: "always", prompt: "Cobre o Gil sobre o PR #42." });
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);

    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
    const all = await f.db.select().from(schema.messages);
    const said = all.find((m) => reachOf(m.meta).length > 0);
    if (!said) throw new Error("no line under the routine's message");
    expect(reachOf(said.meta)).toEqual([
      {
        agentId: gil.id,
        handle: "gil",
        reason: "routine_creator_reach",
        userId: f.owner.id,
        routine: { id: routine.id, name: routine.name, creatorUserId: f.owner.id, access: "act" },
      },
    ]);
    expect(all.filter((m) => reachOf(m.meta).length > 0)).toHaveLength(1);
    expect((await decisionOf(said.id))?.reason).toContain("routine_creator_reach: @gil");
    const told = await notificationsOf(f, "agent_unreached");
    expect(told.map((n) => n.userId)).toEqual([bob.id]);
    expect(told[0]?.source).toMatchObject({ agentId: gil.id, routineId: routine.id, userId: f.owner.id });
  });

  test("an agent with no owner: who manages agents hears it", async () => {
    f = await setup();
    const gil = await agentOf("Gil", "gil", { inGeneral: false });
    await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, gil.id));
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await notifyAgentUnreached(
      { db: f.db, pubsub: f.pubsub },
      {
        orgId: f.org.id,
        agentId: gil.id,
        routineId: crypto.randomUUID(),
        routineName: "Cobrança",
        creatorUserId: bob.id,
        channelId: f.general.id,
      },
    );
    expect((await notificationsOf(f, "agent_unreached")).map((n) => n.userId)).toEqual([f.owner.id]);
  });
});
