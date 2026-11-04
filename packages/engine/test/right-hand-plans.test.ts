import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, LOCKED_BRAIN_PROTOCOL, MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainTurn,
  createClaudeCodeBrain,
  createJobHandlers,
  drainOutbox,
  getAgentBrain,
  type MachineStatus,
  machineAgents,
  mayFallBack,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  RIGHT_HAND_TURN,
  resolveBrain,
  setAgentBrain,
} from "../src";
import { agentAiState } from "../src/ai-status";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/*
 * ADR 0137 §1, §4 and §7, amended 2026-11-04: the team's right hand thinks with a person's Claude plan, as that plan's
 * CLI on the computer where it is signed in, locked down to its own tools; the plan's owner pays; "Atende outras
 * pessoas" decides whether other people's DMs think with it; with its computer away it says why, never on a key.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ANAS = "0193dddd-0000-4000-8000-0000000000a1";
const CAIOS = "0193dddd-0000-4000-8000-0000000000c1";

const statusOf = (id: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id,
  orgId: "org",
  name: "Mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

/** Lodi, Ana's computer with her Claude account and Caio's (an admin), Bia a member. */
async function world() {
  const fx = await setup({ rightHand: true });
  f = fx;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  await fx.db
    .update(schema.machines)
    .set({ executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() } })
    .where(eq(schema.machines.id, machineId));
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  const account = (id: string, createdBy: string, kind = "claude_code") =>
    fx.db
      .insert(schema.machineAccounts)
      .values({ id, orgId: fx.org.id, machineId, kind, label: id, status: "active", createdBy, shared: true });
  await account(ANAS, fx.owner.id);
  await account(CAIOS, caio.id);
  const lodi = async () => {
    const [row] = await fx.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!row) throw new Error("no right hand");
    return row;
  };
  return { fx, deps: { db: fx.db }, machineId, bia, caio, lodi, account };
}

const codeOf = (p: Promise<unknown>) => p.then(() => null).catch((e: { code?: string }) => e.code);

test("Lodi takes a Claude plan signed in as an account, never Codex nor a computer's own sign-in, and stays on no computer", async () => {
  const { fx, deps, machineId, caio, lodi, account } = await world();
  const id = (await lodi()).id;
  await account("0193dddd-0000-4000-8000-0000000000a2", fx.owner.id, "codex");
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: "codex" }))).toBe(
    "brain.right_hand_plan",
  );
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: "claude_code" }))).toBe(
    "brain.right_hand_account",
  );
  // Before a plan: the computer it would sign one in on, the caller's.
  const before = await getAgentBrain(deps, fx.owner.id, fx.org.id, id);
  expect(before).toMatchObject({ brain: "model", computer: { machineId }, canUsePlans: true });
  const view = await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: "claude_code", account: ANAS });
  expect(view).toMatchObject({ brain: "claude_code", account: ANAS, computer: { machineId }, onlyOwner: true });
  expect(await lodi()).toMatchObject({
    brain: "claude_code",
    brainAccountId: ANAS,
    machineId: null,
    planForOthers: false,
  });
  // Its audience is its own: everyone still has their DM with it.
  expect((await lodi()).audienceMode).toBe("everyone");
  // Its user there holds the sign-in while it thinks (system mode lends the folder by the `agents` frame).
  expect((await machineAgents(fx.db, fx.org.id, machineId)).find((a) => a.id === id)).toMatchObject({ account: ANAS });
  // An admin's view: Ana's plan, not theirs to give or open to others.
  expect(await getAgentBrain(deps, caio.id, fx.org.id, id)).toMatchObject({ canUsePlans: false, account: ANAS });
  expect(await codeOf(setAgentBrain(deps, caio.id, fx.org.id, id, { onlyOwner: false }))).toBe("account.not_owner");
  expect(await codeOf(setAgentBrain(deps, caio.id, fx.org.id, id, { account: ANAS, onlyOwner: true }))).toBeNull();
  // Only Ana opens her plan to other people's DMs; anyone who sets Lodi's AI takes it back to a key.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { onlyOwner: false });
  expect((await lodi()).planForOthers).toBe(true);
  await setAgentBrain(deps, caio.id, fx.org.id, id, { brain: "model" });
  expect(await lodi()).toMatchObject({ brain: "model", brainAccountId: null, machineId: null });
  // Caio gives it his own.
  await setAgentBrain(deps, caio.id, fx.org.id, id, { brain: "claude_code", account: CAIOS });
  expect(await lodi()).toMatchObject({ brainAccountId: CAIOS, planForOthers: false });
});

test("its turns think on the plan's computer and owner; another person's DM only once the plan answers others", async () => {
  const { fx, deps, machineId, bia, lodi } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, (await lodi()).id, { brain: "claude_code", account: ANAS });
  const agent = await lodi();
  const runIn = async (userId: string) => {
    const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, agent.id);
    const m = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body: "oi" });
    const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, m.id));
    if (!run) throw new Error("no run");
    return { run, dm };
  };
  const machines = { status: async (id: string) => statusOf(id) };
  const ana = await runIn(fx.owner.id);
  const plan = await resolveBrain({ db: fx.db, machines }, agent, ana.run, ana.dm.id);
  expect(plan).toMatchObject({ kind: "claude_code", account: { id: ANAS }, session: { machineId } });
  expect(plan.unavailable).toBeUndefined();
  // Bia's DM: Ana's plan answers only Ana.
  const theirs = await runIn(bia.id);
  expect((await resolveBrain({ db: fx.db, machines }, agent, theirs.run, theirs.dm.id)).unavailable).toMatchObject({
    code: "plan_not_shared",
  });
  await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { onlyOwner: false });
  const open = await lodi();
  expect((await resolveBrain({ db: fx.db, machines }, open, theirs.run, theirs.dm.id)).unavailable).toBeUndefined();
  // A runner that can't lock Claude Code down never gets its turn.
  const old = { status: async (id: string) => statusOf(id, { protocol: LOCKED_BRAIN_PROTOCOL - 1 }) };
  expect((await resolveBrain({ db: fx.db, machines: old }, open, ana.run, ana.dm.id)).unavailable).toMatchObject({
    code: "runner_outdated",
  });
  // It never stands in on the API, and its state says the computer is away, not "no AI".
  expect(mayFallBack(open, { background: false })).toBe(false);
  const away = { status: async (id: string) => statusOf(id, { online: false }) };
  expect(await agentAiState({ db: fx.db, gateway: fx.gateway, machines: away }, open)).toEqual({ state: "waiting" });
});

test("its computer asleep: one line says why, the run fails at once, no wait and never a key", async () => {
  const { fx, deps, lodi } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, (await lodi()).id, { brain: "claude_code", account: ANAS });
  const agent = await lodi();
  let turns = 0;
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      turns++;
      yield { type: "done", text: "nope" };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online: false, lastSeenAt: new Date(0).toISOString() }) },
  });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "oi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run?.status).toBe("failed");
  expect(run?.brain).not.toBe("model");
  expect(turns).toBe(0);
  const cards = (await fx.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id))).filter(
    (m) => m.meta.bodyCode === "no_ai",
  );
  expect(cards).toHaveLength(1);
  expect(cards[0]?.meta.noAi).toMatchObject({ agentId: agent.id, reason: "computer_away" });
  // Nothing went to the API (no model call recorded for it).
  const usage = await fx.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.agentId, agent.id));
  expect(usage.filter((u) => u.billedTo !== "plan")).toEqual([]);
});

test("its turn goes to the runner as the locked-down chat profile, with no checkout and none of the owner's servers", async () => {
  const sent: Record<string, unknown>[] = [];
  const hub = {
    status: async (id: string) => statusOf(id),
    call: async (_machineId: string, request: Record<string, unknown>) => {
      sent.push(request);
      return { runId: "r", final: { type: "done", text: "ok" } };
    },
  };
  let prepared = 0;
  const brain = createClaudeCodeBrain({
    hub: hub as never,
    pubsub: { publish: async () => {}, subscribe: () => () => {} } as never,
    agentScope: async () => ({ id: "a", handle: "lodi" }),
    permissions: () => RIGHT_HAND_TURN,
    personalMcp: () => true,
    prepare: async () => {
      prepared++;
      return { cwd: "repos/acme/app", prompt: "# Your code", start: "" } as never;
    },
    finalGraceMs: 0,
  });
  const turn = {
    runId: "0193bbbb-0000-7000-8000-000000000001",
    orgId: "o",
    agentId: "a",
    channelId: "c",
    threadRootId: null,
    system: "You are Lodi.",
    messages: [{ role: "user", content: "oi" }],
    tools: [],
    trigger: "oi",
    session: { id: "0193aaaa-0000-7000-8000-000000000001", resume: false, machineId: "m", cwd: "" },
  } satisfies BrainTurn;
  const events = [];
  for await (const e of brain.run(turn, {
    signal: new AbortController().signal,
    executeTool: async () => ({ content: "" }),
  }))
    events.push(e);
  expect(events.at(-1)).toMatchObject({ type: "done" });
  expect(prepared).toBe(0);
  expect(sent[0]).toMatchObject({ op: "brain.turn", permissions: { mode: "chat" }, personalMcp: false, cwd: "" });
  // An older runner reads any mode but `plan` as `work`: nothing is sent to it.
  sent.length = 0;
  hub.status = async (id: string) => statusOf(id, { protocol: LOCKED_BRAIN_PROTOCOL - 1 });
  const refused = [];
  for await (const e of brain.run(turn, {
    signal: new AbortController().signal,
    executeTool: async () => ({ content: "" }),
  }))
    refused.push(e);
  expect(refused).toEqual([expect.objectContaining({ type: "error", code: "runner_outdated" })]);
  expect(sent).toEqual([]);
});
