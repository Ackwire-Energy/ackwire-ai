import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, orgTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  archiveAgent,
  archiveChannel,
  channelMembersDetail,
  createAgent,
  createChannel,
  createSetupToolSource,
  createTeam,
  createToolGateway,
  deleteAgent,
  deleteChannel,
  joinChannel,
  listChannelMembers,
  openPersonAgentDm,
  PROPOSE_TEAM_TOOL,
  postPersonMessage,
  RIGHT_HAND,
  removeChannelMember,
  setAgentAppearance,
  setAgentChannels,
  type ToolContext,
  unarchiveAgent,
  unarchiveChannel,
  undoTeam,
  updateAgent,
  updateChannel,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** What the org's sockets are told, in order, with each transaction's commit in between. */
function watch(fx: Fixture, channelIds: string[] = []) {
  const log: string[] = [];
  fx.pubsub.subscribe(orgTopic(fx.org.id), (e) => {
    if (e.type === "org.broadcast") log.push((e.event as { type: string }).type);
  });
  for (const id of channelIds)
    fx.pubsub.subscribe(channelTopic(id), (e) => {
      if (e.type.startsWith("channel.member_")) log.push(e.type);
    });
  const transaction = fx.db.transaction.bind(fx.db);
  fx.db.transaction = (async (...args: Parameters<typeof transaction>) => {
    const out = await transaction(...args);
    log.push("commit");
    return out;
  }) as typeof fx.db.transaction;
  return log;
}

const AGENTS = "agents.changed";
const CHANNELS = "channels.changed";
const announced = (log: string[], type: string) => log.filter((t) => t === type).length;

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

async function lodiRun(fx: Fixture, body: string): Promise<ToolContext> {
  const lodi = await lodiOf(fx);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, lodi.id);
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body });
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: dm.id,
    threadRootId: run.threadRootId,
    triggerMessageId: trigger.id,
  };
}

const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
async function call(fx: Fixture, ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

const IARA = {
  name: "Iara",
  handle: "iara",
  role: "Atendimento",
  line: "Responde os clientes.",
  channel: "atendimento",
};
const CAIO = { name: "Caio", handle: "caio", role: "Cobrança", line: "Lembra quem atrasou.", channel: "financeiro" };
const ADA = { name: "Ada", handle: "ada", role: "Dev", line: "Corrige os bugs.", channel: "general" };

async function teamCard(fx: Fixture, agents: Record<string, unknown>[]) {
  const ctx = await lodiRun(fx, "Monta o time");
  const out = await call(fx, ctx, PROPOSE_TEAM_TOOL, { lead: "O time.", agents });
  return (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
}

describe("what Lodi creates reaches every open app, after its transaction commits", () => {
  test("Criar o time: the agents and the channels are announced once, and nothing goes out before the commit", async () => {
    f = await setup({ rightHand: true });
    const id = await teamCard(f, [IARA, CAIO, ADA]);
    const log = watch(f, [f.general.id]);
    const made = await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(made.card.state).toBe("created");
    expect(announced(log, AGENTS)).toBe(1);
    expect(announced(log, CHANNELS)).toBe(1);
    expect(log).toContain("channel.member_added");
    const commit = log.indexOf("commit");
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("channel.member_added")).toBeGreaterThan(commit);
    expect(log.indexOf(AGENTS)).toBeGreaterThan(commit);
    expect(log.indexOf(CHANNELS)).toBeGreaterThan(commit);
  });

  test("a team that fails is undone whole: nobody hears of what never was", async () => {
    f = await setup({ rightHand: true });
    const id = await teamCard(f, [ADA, IARA]);
    await f.db.insert(schema.agents).values({
      orgId: f.org.id,
      name: "Outra Iara",
      handle: "iara",
      role: "",
      instructions: "",
      model: "auto",
      ownerUserId: f.owner.id,
    });
    const log = watch(f, [f.general.id]);
    const tried = await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(tried.card.state).toBe("pending");
    expect(log.filter((t) => t !== "commit")).toEqual([]);
  });

  test("Desfazer: the agents and channels leave every list, once its transaction is done", async () => {
    f = await setup({ rightHand: true });
    const id = await teamCard(f, [IARA]);
    await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    const log = watch(f);
    await undoTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(announced(log, AGENTS)).toBe(1);
    expect(announced(log, CHANNELS)).toBe(1);
    expect(log.indexOf(AGENTS)).toBeGreaterThan(log.indexOf("commit"));
  });

  test("create_channel: announced after the run's transaction, with its agents in it", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, "cria o #vendas com o @dev");
    const log = watch(f);
    const out = await call(f, ctx, "create_channel", { name: "vendas", agents: ["@dev"] });
    expect(out.isError).toBeFalsy();
    expect(announced(log, CHANNELS)).toBe(1);
    expect(log.indexOf(CHANNELS)).toBeGreaterThan(log.indexOf("commit"));
  });
});

describe("every path that changes the agents or the channels tells the workspace", () => {
  const input = { name: "Iara", handle: "iara", role: "", instructions: "x" };
  const defaults = { model: "auto" };

  test("agents: made, renamed, a new look, archived, back, deleted", async () => {
    f = await setup();
    const log = watch(f);
    const { db, pubsub, org, owner } = f;
    const agent = await createAgent(db, owner.id, org.id, input, defaults, { pubsub });
    expect(announced(log, AGENTS)).toBe(1);
    await updateAgent(db, owner.id, org.id, agent.id, { name: "Iara Souza" }, { pubsub });
    expect(announced(log, AGENTS)).toBe(2);
    await setAgentAppearance(db, owner.id, org.id, agent.id, { color: "rose", eyes: "happy" }, { pubsub });
    expect(announced(log, AGENTS)).toBe(3);
    await archiveAgent(db, owner.id, org.id, agent.id, pubsub);
    expect(announced(log, AGENTS)).toBe(4);
    await unarchiveAgent(db, owner.id, org.id, agent.id, { pubsub });
    expect(announced(log, AGENTS)).toBe(5);
    await deleteAgent({ db, pubsub } as Parameters<typeof deleteAgent>[0], owner.id, org.id, agent.id);
    expect(announced(log, AGENTS)).toBe(6);
  });

  test("channels: made, renamed, archived, back, deleted", async () => {
    f = await setup();
    const log = watch(f);
    const { db, pubsub, org, owner } = f;
    const channel = await createChannel(db, owner.id, org.id, { name: "vendas" }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(1);
    await updateChannel(db, owner.id, org.id, channel.id, { name: "comercial" }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(2);
    await archiveChannel(db, owner.id, org.id, channel.id, { pubsub });
    expect(announced(log, CHANNELS)).toBe(3);
    await unarchiveChannel(db, owner.id, org.id, channel.id, { pubsub });
    expect(announced(log, CHANNELS)).toBe(4);
    await deleteChannel(
      { db, pubsub } as Parameters<typeof deleteChannel>[0],
      owner.id,
      org.id,
      channel.id,
      "comercial",
    );
    expect(announced(log, CHANNELS)).toBe(5);
  });

  test("members: added, taken out, joining, an agent's channels set from its page", async () => {
    f = await setup();
    const log = watch(f);
    const { db, pubsub, org, owner, agent } = f;
    const channel = await createChannel(db, owner.id, org.id, { name: "vendas" });
    const bia = await addMember(db, org.id, "member", "bia");
    await addChannelMember(db, owner.id, org.id, channel.id, { agentId: agent.id }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(1);
    await removeChannelMember(db, owner.id, org.id, channel.id, { agentId: agent.id }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(2);
    await joinChannel(db, bia.id, org.id, channel.id, { pubsub });
    expect(announced(log, CHANNELS)).toBe(3);
    await removeChannelMember(db, bia.id, org.id, channel.id, { userId: bia.id }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(4);
    await setAgentChannels(db, owner.id, org.id, agent.id, [{ channelId: channel.id }], { pubsub });
    expect(announced(log, CHANNELS)).toBe(5);
  });

  test("an archived agent stays a member, but leaves what a channel lists until it is back", async () => {
    f = await setup();
    const { db, pubsub, org, owner, agent, general } = f;
    const ids = async () => (await listChannelMembers(db, owner.id, org.id, general.id)).map((m) => m.id);
    const named = async () => (await channelMembersDetail(db, org.id, general.id)).map((m) => m.agentId);
    expect(await ids()).toContain(agent.id);
    expect(await named()).toContain(agent.id);
    await archiveAgent(db, owner.id, org.id, agent.id, pubsub);
    expect(await ids()).not.toContain(agent.id);
    expect(await named()).not.toContain(agent.id);
    await unarchiveAgent(db, owner.id, org.id, agent.id, { pubsub });
    expect(await ids()).toContain(agent.id);
    expect(await named()).toContain(agent.id);
  });
});
