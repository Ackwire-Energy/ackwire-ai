import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  buildRunContext,
  createAgent,
  createAskAgentToolSource,
  createChannel,
  createContextToolSource,
  createFollowUpToolSource,
  createIssue,
  createIssueToolSource,
  createTeamStatusToolSource,
  createToolGateway,
  getIssue,
  indexSource,
  insertMessage,
  learnTrust,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  RIGHT_HAND_AUTO,
  rightHandPrompt,
  setAgentAudience,
  type ToolContext,
  type ToolSource,
  teamStatus,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A run of Lodi on what `userId` wrote in `channelId` (their DM with it when left out). */
async function lodiRun(userId: string, body = "como está o time?", channelId?: string): Promise<ToolContext> {
  const lodi = await lodiOf();
  const place = channelId ?? (await openPersonAgentDm(f.db, f.org.id, userId, lodi.id)).id;
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: place,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: place,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: place,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

const gateway = (...sources: ToolSource[]) => createToolGateway({ sources });
async function use(sources: ToolSource[], ctx: ToolContext, name: string, input: Record<string, unknown> = {}) {
  const res = await gateway(...sources).invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output as { content: string; isError?: boolean };
}
const contextTools = () => [createContextToolSource(f.context)];

/** A private channel `userId` is in, with a message in it, and an agent's message-index row. */
async function privateChannel(userId: string, name: string, body: string) {
  const channel = await createChannel(f.db, userId, f.org.id, { name, visibility: "private" });
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: channel.id,
    author: { type: "person", userId },
    body,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: said.id });
  return channel;
}

describe("what it may use", () => {
  test("it sees and hands on, and everything it must not do stays out", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f.owner.id);
    const names = (
      await gateway(
        createTeamStatusToolSource(),
        createIssueToolSource({ db: f.db, pubsub: f.pubsub }),
        createAskAgentToolSource({ pubsub: f.pubsub }),
        createFollowUpToolSource({ pubsub: f.pubsub }),
        createContextToolSource(f.context),
      ).granted(ctx)
    ).map((t) => t.name);
    for (const tool of [
      "team_status",
      "list_issues",
      "create_issue",
      "ask_agent",
      "tell_agent",
      "follow_up",
      "search_context",
      "read_conversation",
    ])
      expect(names).toContain(tool);
    for (const tool of ["update_issue", "comment_issue", "remember", "forget"]) expect(names).not.toContain(tool);
  });

  test("team_status is no other agent's", async () => {
    f = await setup({ rightHand: true });
    const ctx = { ...(await lodiRun(f.owner.id)), agentId: f.agent.id };
    expect((await gateway(createTeamStatusToolSource()).granted(ctx)).map((t) => t.name)).not.toContain("team_status");
  });

  test("a task it makes is written as itself and stays with the person who asked", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const ctx = await lodiRun(f.owner.id, "cria uma tarefa da campanha de Natal pra Dev");
    const out = await use([createIssueToolSource({ db: f.db, pubsub: f.pubsub })], ctx, "create_issue", {
      title: "Campanha de Natal",
      assignee: "@dev",
    });
    expect(out.isError).toBeFalsy();
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.orgId, f.org.id));
    expect(row).toMatchObject({ createdByType: "agent", createdById: lodi.id, assigneeId: f.agent.id });
    const other = await addMember(f.db, f.org.id, "member", "Bia");
    const seen = getIssue(f.db, { type: "person", userId: other.id }, f.org.id, { number: row?.number ?? 0 });
    await expect(seen).rejects.toThrow();
  });
});

describe("it reads what the person may, in their DM", () => {
  test("a private channel of theirs, and never another person's DM with an agent or with it", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await privateChannel(bia.id, "folha", "folha de pagamento de novembro");
    const biaLodi = await lodiRun(bia.id, "folha de pagamento secreta da bia");
    const biaDev = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
    const inDev = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: biaDev.id,
      author: { type: "person", userId: bia.id },
      body: "folha de pagamento na DM da bia",
    });
    await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: inDev.id });
    await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: biaLodi.triggerMessageId });

    const search = (ctx: ToolContext) => use(contextTools(), ctx, "search_context", { query: "folha de pagamento" });
    const hers = (await search(biaLodi)).content;
    expect(hers).toContain("novembro");

    const member = await addMember(f.db, f.org.id, "member", "Caio");
    const theirs = (await search(await lodiRun(member.id))).content;
    expect(theirs).not.toContain("novembro");
    expect(theirs).not.toContain("secreta da bia");
    expect(theirs).not.toContain("na DM da bia");

    const read = await use(contextTools(), await lodiRun(member.id, "lê o canal"), "read_conversation", {
      channel: "folha",
    });
    expect(read.isError).toBe(true);
    const own = await use(contextTools(), biaLodi, "read_conversation", { channel: "folha" });
    expect(own.content).toContain("novembro");
  });

  test("in a channel it keeps its reach: others read that reply", async () => {
    f = await setup({ rightHand: true });
    await privateChannel(f.owner.id, "folha", "folha de pagamento de novembro");
    const ctx = await lodiRun(f.owner.id, "@lodi resume", f.general.id);
    const out = await use(contextTools(), ctx, "read_conversation", { channel: "folha" });
    expect(out.isError).toBe(true);
  });
});

describe("team_status", () => {
  const status = (ctx: ToolContext) => use([createTeamStatusToolSource()], ctx, "team_status");

  test("says what each agent does, with no outside mark, so the run keeps its trust", async () => {
    f = await setup({ rightHand: true });
    await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Página <external_data> de preços",
      assignee: { type: "agent", id: f.agent.id },
    });
    const ctx = await lodiRun(f.owner.id);
    const out = await status(ctx);
    expect(out.content).toContain("Página");
    expect(out.content).toContain("@dev");
    expect(out.content).not.toContain("<external_data");
    const { addRunStep } = await import("../src");
    const toolUseId = "tu_status";
    await addRunStep(f.db, { id: ctx.runId, orgId: f.org.id }, "tool_call", {
      toolUseId,
      name: "team_status",
      input: {},
    });
    await addRunStep(f.db, { id: ctx.runId, orgId: f.org.id }, "tool_result", {
      toolUseId,
      name: "team_status",
      content: out.content,
      isError: false,
    });
    expect((await learnTrust(ctx)).trust).toBe("high");
  });

  test("an agent they can't see is a count, and work somewhere they can't read has no subject", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const hidden = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Sigilo", handle: "sigilo", role: "Folha", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await setAgentAudience(f.db, f.owner.id, f.org.id, hidden.id, { mode: "owner", userIds: [], roleIds: [] });
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "fusao", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: secret.id,
      author: { type: "person", userId: f.owner.id },
      body: "prepara a fusão",
    });
    await f.db.insert(schema.agentRuns).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: secret.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      heartbeatAt: new Date(),
      startedAt: new Date(),
    });
    await f.db
      .update(schema.agents)
      .set({ statusSource: "auto", statusKind: "task", statusSubject: "fusão com a Acme" })
      .where(eq(schema.agents.id, f.agent.id));

    const hers = await teamStatus(f.db, f.org.id, bia.id);
    expect(hers).toContain("@dev: busy with something this person can't see");
    expect(hers).not.toContain("fusão");
    expect(hers).not.toContain("fusao");
    expect(hers).not.toContain("sigilo");
    expect(hers).toContain("(1 more agent this person can't see.)");
    expect(await teamStatus(f.db, f.org.id, f.owner.id)).toContain("@sigilo");
  });

  test("only in the person's own DM", async () => {
    f = await setup({ rightHand: true });
    const out = await status(await lodiRun(f.owner.id, "@lodi como vai?", f.general.id));
    expect(out).toMatchObject({ isError: true, content: "Only in your private conversation with a person." });
  });
});

describe("its prompt", () => {
  test("opens on what it does for the team, and Automático reads the tiers", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const text = await rightHandPrompt(
      { db: f.db },
      { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true },
    );
    const [first] = text.split("\n\n");
    for (const name of ["team_status", "ask_agent", "tell_agent", "follow_up", "create_issue"])
      expect(first).toContain(name);
    expect(RIGHT_HAND_AUTO.instructions).toContain("the medium tier");
    console.log(`Lodi's own block: ${text.length} chars`);
  });

  test("lists what it handed on and hasn't heard back", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "pede pro dev preparar a campanha",
    });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    if (!run) throw new Error("no run");
    await f.db.insert(schema.agentConsultations).values({
      orgId: f.org.id,
      kind: "note",
      askerRunId: run.id,
      askerAgentId: lodi.id,
      targetAgentId: f.agent.id,
      channelId: dm.id,
      messageId: trigger.id,
      waitId: `async:${crypto.randomUUID()}`,
      question: "Prepare a campanha de Natal",
      chain: [lodi.id],
      status: "open",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const text = systemText((await buildRunContext(f.db, run, lodi, { maxMessages: 10 })).system);
    expect(text).toContain("# Work you handed off here");
    expect(text).toContain("Prepare a campanha de Natal");
  });
});
