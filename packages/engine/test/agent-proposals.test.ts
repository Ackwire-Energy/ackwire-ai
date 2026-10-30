import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, createPostgresPubSub, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  type AgentProposalCard,
  addChannelMember,
  agentProposalOf,
  ConflictError,
  createAgent,
  createAgentFromProposal,
  createChannel,
  createSetupToolSource,
  createToolGateway,
  denyAgentProposal,
  ForbiddenError,
  getAgentProposal,
  insertMessage,
  NEW_AGENT_DEFAULTS,
  openPersonAgentDm,
  suggestAgentAi,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, makeAdmin, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** A run of @dev on a message `userId` wrote in #general (or in `channelId`). */
async function runFor(fx: Fixture, userId: string, body: string, channelId = fx.general.id): Promise<ToolContext> {
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId,
    author: { type: "person", userId },
    body,
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

/** Through the Tool Gateway, as a run calls it: the scope and the input's schema apply. */
async function propose(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
  const tools = createToolGateway({
    sources: [createSetupToolSource({ pubsub: fx.pubsub, ai: { gateway: fx.gateway } })],
  });
  const res = await tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "propose_agent", input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

const ADA = {
  name: "Ada",
  handle: "ada",
  role: "Designer",
  instructions: "Desenha as telas e revisa o visual.",
  look: { color: "rose", eyes: "happy", accessory: "bow" },
  channels: ["#general"],
  why: "Você pediu alguém para cuidar do design.",
};

const proposals = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).where(eq(schema.messages.orgId, fx.org.id))).filter((m) =>
    agentProposalOf(m.meta),
  );
const cardOf = async (fx: Fixture, id: string) => {
  const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, id));
  return agentProposalOf(m?.meta) as AgentProposalCard;
};
const agentCount = async (fx: Fixture) =>
  (await fx.db.select().from(schema.agents).where(eq(schema.agents.orgId, fx.org.id))).length;
const connect = async (fx: Fixture, connector: string, label: string) => {
  const [row] = await fx.db
    .insert(schema.connectorConnections)
    .values({ orgId: fx.org.id, connector, label, serverUrl: `https://${connector}.example.com/mcp`, authType: "none" })
    .returning();
  if (!row) throw new Error("no connection");
  return row;
};
/** Ana proposes Ada through @dev; the card's message id. */
async function proposed(fx: Fixture) {
  const ctx = await runFor(fx, fx.owner.id, "cria um agente de design");
  const out = await propose(fx, ctx, ADA);
  expect(out.isError).toBeUndefined();
  return (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
}
const deps = (fx: Fixture) => ({ db: fx.db, pubsub: fx.pubsub });
const createAs = (fx: Fixture, userId: string, input: { name: string; handle: string }) => () =>
  createAgent(fx.db, userId, fx.org.id, { ...input, role: "Designer", instructions: "Desenha." }, NEW_AGENT_DEFAULTS);

describe("propose_agent", () => {
  test("a card where the run replies, with the draft as the create-agent screen takes it; it creates nothing", async () => {
    f = await setup();
    const github = await connect(f, "github", "GitHub");
    const ctx = await runFor(f, f.owner.id, "quero um bot de design");
    const agents = await agentCount(f);
    const scopes = (await f.db.select().from(schema.agentScopes)).length;
    const out = await propose(f, ctx, { ...ADA, access: [{ connector: "github", level: "write" }] });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("nothing exists until they create it");
    const [card] = await proposals(f);
    expect(card).toMatchObject({
      authorType: "agent",
      authorAgentId: f.agent.id,
      agentRunId: ctx.runId,
      body: "Proposed a new agent, Ada: Você pediu alguém para cuidar do design.",
    });
    expect(card?.meta).toMatchObject({ bodyCode: "agent_proposal", bodyParams: { name: "Ada" } });
    const meta = agentProposalOf(card?.meta) as AgentProposalCard;
    expect(meta).toMatchObject({
      kind: "agent_proposal",
      forUserId: f.owner.id,
      state: "pending",
      agentId: null,
      params: {
        why: ADA.why,
        draft: {
          name: "Ada",
          handle: "ada",
          role: "Designer",
          instructions: ADA.instructions,
          appearance: ADA.look,
          channelIds: [f.general.id],
          access: [{ connectionId: github.id, level: "write" }],
        },
      },
    });
    // Expires like an approval: a day.
    expect(Date.parse(meta.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await agentCount(f)).toBe(agents);
    expect((await f.db.select().from(schema.agentScopes)).length).toBe(scopes);
  });

  test("checked like the create-agent API: nothing is posted for a bad draft", async () => {
    f = await setup();
    const priv = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "board", visibility: "private" })
      .returning();
    expect(priv).toHaveLength(1);
    const ctx = await runFor(f, f.owner.id, "cria um agente");
    const refused = async (input: Record<string, unknown>, says: string) => {
      const out = await propose(f, ctx, { ...ADA, ...input });
      expect(out.isError).toBe(true);
      expect(out.content).toContain(says);
    };
    await refused({ handle: "dev" }, "@dev is already taken");
    await refused({ handle: "Ada Lovelace" }, "handle");
    await refused({ name: "   " }, "name");
    await refused({ channels: ["board"] }, "No public channel #board. Public channels: #general");
    await refused({ access: [{ connector: "jira", level: "read" }] }, 'No connected app "jira"');
    await refused({ look: { color: "gold", eyes: "round" } }, "color");
    await refused({ why: "  " }, "why");
    expect(await proposals(f)).toHaveLength(0);
  });

  test("only where someone who may create agents can open the conversation and decide it", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    // Bia's DM with @dev, and a private channel of hers: no admin or owner can read either.
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
    const hers = await createChannel(f.db, bia.id, f.org.id, { name: "bia-notes", visibility: "private" });
    for (const where of [dm.id, hers.id]) {
      const out = await propose(f, await runFor(f, bia.id, "cria um agente", where), ADA);
      expect(out.isError).toBe(true);
      expect(out.content).toContain("Nothing was posted: nobody who may create agents can open this conversation");
    }
    expect(await proposals(f)).toHaveLength(0);
    // With the owner in it, a private channel takes the card (as does a public one).
    await addChannelMember(f.db, bia.id, f.org.id, hers.id, { userId: f.owner.id });
    const out = await propose(f, await runFor(f, bia.id, "cria um agente", hers.id), ADA);
    expect(out.isError).toBeUndefined();
    expect(await proposals(f)).toHaveLength(1);
  });
});

describe("the AI it suggests", () => {
  test("an account of the person's that thinks for no agent, else the workspace's model, else none", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    const account = (id: string, label: string, createdBy: string, kind = "claude_code") =>
      f.db
        .insert(schema.machineAccounts)
        .values({ id, orgId: f.org.id, machineId, kind, label, status: "active", createdBy });
    const USED = "0193aaaa-0000-4000-8000-000000000001";
    const FREE = "0193aaaa-0000-4000-8000-000000000002";
    const BIAS = "0193aaaa-0000-4000-8000-000000000003";
    await account(USED, "Claude Max", f.owner.id);
    await account(FREE, "ChatGPT Plus", f.owner.id, "codex");
    await account(BIAS, "Claude da Bia", bia.id);
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", machineId, brainAccountId: USED })
      .where(eq(schema.agents.id, f.agent.id));
    const ai = { db: f.db, gateway: f.gateway };
    expect(await suggestAgentAi(ai, f.org.id, f.owner.id)).toEqual({
      kind: "account",
      brain: "codex",
      machineId,
      accountId: FREE,
      label: "ChatGPT Plus",
    });
    // On the card, for the person behind the run.
    const ctx = await runFor(f, f.owner.id, "cria um agente");
    const out = await propose(f, ctx, ADA);
    expect(out.content).toContain("Suggested AI: ChatGPT Plus");
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    expect((await cardOf(f, id)).params.draft.ai).toMatchObject({ kind: "account", accountId: FREE });
    // Reviewed by another admin: suggested for them (the account thinks only for its owner's agents).
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: caio.id });
    expect((await getAgentProposal(ai, caio.id, f.org.id, id)).params.draft.ai).toEqual({ kind: "model" });
    expect((await getAgentProposal(ai, f.owner.id, f.org.id, id)).params.draft.ai).toMatchObject({ accountId: FREE });
    // Taken, or nobody behind the run: the workspace's model (it has a key).
    await f.db.update(schema.machineAccounts).set({ status: "signed_out" }).where(eq(schema.machineAccounts.id, FREE));
    expect(await suggestAgentAi(ai, f.org.id, f.owner.id)).toEqual({ kind: "model" });
    expect(await suggestAgentAi(ai, f.org.id, null)).toEqual({ kind: "model" });
    // Bia's account isn't suggested to her while she can't create agents (it would think only for her own).
    expect(await suggestAgentAi(ai, f.org.id, bia.id)).toEqual({ kind: "model" });
    const asked = await propose(f, await runFor(f, bia.id, "cria um agente"), ADA);
    expect(asked.content).toContain("The person who asked can't create agents: an admin or owner reviews it.");
    expect(out.content).not.toContain("can't create agents");
    await makeAdmin(f.db, f.org.id, bia.id);
    expect(await suggestAgentAi(ai, f.org.id, bia.id)).toMatchObject({ kind: "account", accountId: BIAS });
    // No key either: none, connected after it is created.
    await f.db
      .update(schema.providerCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(schema.providerCredentials.orgId, f.org.id));
    expect(await suggestAgentAi(ai, f.org.id, f.owner.id)).toEqual({ kind: "none" });
  });
});

describe("deciding", () => {
  test("creating it: the edited agent, by someone who may create agents, once; the card says so and the agent hears it", async () => {
    f = await setup();
    const id = await proposed(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    for (const who of [bia, caio]) {
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: who.id });
    }
    // Read-only for who can't create agents; nobody but a person decides (an agent is no member).
    expect(await getAgentProposal(deps(f), bia.id, f.org.id, id)).toMatchObject({ canDecide: false, state: "pending" });
    expect(await getAgentProposal(deps(f), caio.id, f.org.id, id)).toMatchObject({
      canDecide: true,
      expired: false,
      proposedByAgentId: f.agent.id,
      channelId: f.general.id,
    });
    const agents = await agentCount(f);
    await expect(
      createAgentFromProposal(deps(f), bia.id, f.org.id, id, createAs(f, bia.id, { name: "Ada", handle: "ada" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(denyAgentProposal(deps(f), f.agent.id, f.org.id, id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await agentCount(f)).toBe(agents);
    // A failed creation (the handle taken meanwhile) leaves it open.
    await expect(
      createAgentFromProposal(deps(f), caio.id, f.org.id, id, createAs(f, caio.id, { name: "Ada", handle: "dev" })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await cardOf(f, id)).state).toBe("pending");

    const events = f.listen(f.general.id);
    const agent = await createAgentFromProposal(
      deps(f),
      caio.id,
      f.org.id,
      id,
      createAs(f, caio.id, { name: "Ada Lovelace", handle: "ada-l" }),
    );
    expect(agent).toMatchObject({ name: "Ada Lovelace", handle: "ada-l", ownerUserId: caio.id });
    expect(await cardOf(f, id)).toMatchObject({ state: "created", agentId: agent.id, decidedByUserId: caio.id });
    expect(events.find((e) => e.type === "agent.proposal.updated")).toMatchObject({
      messageId: id,
      state: "created",
      agentId: agent.id,
      decidedByUserId: caio.id,
    });
    // The agent that proposed it is told, in its conversation, and answers it.
    const [notice] = (
      await f.db
        .select()
        .from(schema.messages)
        .where(
          and(eq(schema.messages.orgId, f.org.id), sql`${schema.messages.meta}->'notice'->>'kind' = 'proposal_result'`),
        )
    ).map((m) => m.meta.notice as { text: string; from: string; refs: Record<string, string> });
    expect(notice).toMatchObject({
      from: "Your proposal of the agent «Ada»",
      text: "caio created it: @ada-l (Ada Lovelace). It is on the team now.",
      refs: { messageId: id, agentId: agent.id },
    });
    const woken = await f.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.agentId, f.agent.id), eq(schema.agentRuns.status, "queued")));
    expect(woken).toHaveLength(1);
    // Once.
    await expect(
      createAgentFromProposal(
        deps(f),
        f.owner.id,
        f.org.id,
        id,
        createAs(f, f.owner.id, { name: "Ada", handle: "ada" }),
      ),
    ).rejects.toMatchObject({ code: "agent_proposal.decided" });
    await expect(denyAgentProposal(deps(f), f.owner.id, f.org.id, id)).rejects.toMatchObject({
      code: "agent_proposal.decided",
    });
  });

  test("saying no: the card stays, marked denied, nothing is made and the agent is told", async () => {
    f = await setup();
    const id = await proposed(f);
    const agents = await agentCount(f);
    const denied = await denyAgentProposal(deps(f), f.owner.id, f.org.id, id);
    expect(denied).toMatchObject({ state: "denied", decidedByUserId: f.owner.id, canDecide: false, agentId: null });
    expect((await cardOf(f, id)).state).toBe("denied");
    expect(await agentCount(f)).toBe(agents);
    const notices = (await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, f.org.id))).filter(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "proposal_result",
    );
    expect((notices[0]?.meta.notice as { text: string } | undefined)?.text).toBe(
      "ana said no. Don't propose it again unless someone asks.",
    );
  });

  test("the decision reaches the conversation through Postgres NOTIFY, however long the instructions", async () => {
    f = await setup();
    // The server's pub/sub across replicas, looped back: it refuses a payload over the NOTIFY limit.
    let deliver: ((payload: string) => void) | null = null;
    const pg = await createPostgresPubSub({
      listen: async (_channel, on) => {
        deliver = on;
        return async () => {};
      },
      notify: async (_channel, payload) => deliver?.(payload),
    });
    const seen: RealtimeEvent[] = [];
    pg.subscribe(channelTopic(f.general.id), (e) => seen.push(e));
    const ctx = await runFor(f, f.owner.id, "cria um agente de acessibilidade");
    const out = await propose(f, ctx, { ...ADA, instructions: "Revisão de acessibilidade. ".repeat(1_850) });
    expect(out.isError).toBeUndefined();
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    await denyAgentProposal({ db: f.db, pubsub: pg }, f.owner.id, f.org.id, id);
    await pg.close?.();
    expect(seen.filter((e) => e.type === "agent.proposal.updated")).toEqual([
      {
        type: "agent.proposal.updated",
        channelId: f.general.id,
        threadId: null,
        messageId: id,
        state: "denied",
        agentId: null,
        decidedByUserId: f.owner.id,
        decidedAt: expect.any(String),
      },
    ]);
  });

  test("expired after a day: nobody decides it any more", async () => {
    f = await setup();
    const id = await proposed(f);
    await f.db
      .update(schema.messages)
      .set({
        meta: sql`jsonb_set(${schema.messages.meta}, '{actionCard,expiresAt}', ${JSON.stringify(new Date(Date.now() - 1000).toISOString())}::jsonb)`,
      })
      .where(eq(schema.messages.id, id));
    expect(await getAgentProposal(deps(f), f.owner.id, f.org.id, id)).toMatchObject({
      state: "pending",
      expired: true,
      canDecide: false,
    });
    await expect(denyAgentProposal(deps(f), f.owner.id, f.org.id, id)).rejects.toMatchObject({
      code: "agent_proposal.expired",
    });
    await expect(
      createAgentFromProposal(
        deps(f),
        f.owner.id,
        f.org.id,
        id,
        createAs(f, f.owner.id, { name: "Ada", handle: "ada" }),
      ),
    ).rejects.toMatchObject({ code: "agent_proposal.expired" });
    expect((await cardOf(f, id)).state).toBe("pending");
  });
});
