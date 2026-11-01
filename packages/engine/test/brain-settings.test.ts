import { afterEach, describe, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, BRAIN_PROTOCOL, CONTEXT_LIMIT_PROTOCOL, MISSION_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { planOf } from "@agenteschat/providers/plans";
import {
  ConflictError,
  canTalkTo,
  ForbiddenError,
  getAgentBrain,
  newAgentBrainMachines,
  releaseAgents,
  setAgentAudience,
  setAgentBrain,
  updateAgent,
  ValidationError,
} from "../src";
import {
  brainModelId,
  brainModelLabel,
  brainModelOptions,
  brainOf,
  brainOptions,
  defaultBrainModel,
  executorBrain,
  normalizeBrainModel,
} from "../src/brain-settings";
import { contextFields } from "../src/brains/claude-code";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

const mac = (patch: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "mac",
  protocol: BRAIN_PROTOCOL,
  execAllowed: true,
  executors: { claude: { version: "2.1.0" }, detectedAt: "2026-10-17" },
  online: true,
  lastSeenAt: new Date(),
  deletedAt: null,
  ...patch,
});

describe("brain settings", () => {
  test("a coding plan's models: any of them by id, its aliases named after what they run there", () => {
    expect(brainModelOptions("claude_code").map((o) => o.label)).toEqual(["Opus", "Sonnet", "Haiku"]);
    expect(brainModelOptions("codex").every((o) => o.modelId?.startsWith("gpt"))).toBe(true);
    // Codex offers the catalog's OpenAI rows, GPT-6.1 Terra among them.
    expect(brainModelOptions("codex").map((o) => o.label)).toEqual([
      "GPT-6.1 Sol",
      "GPT-6.1 Terra",
      "GPT-6 Sol",
      "GPT-6 Luna",
    ]);
    // An alias the plan leaves out, or "Automático", is its main model; the value stays an alias.
    expect(brainModelLabel("claude_code", "opus", "zai")).toBe("GLM-5.3");
    expect(brainModelLabel("claude_code", "auto", "minimax")).toBe("MiniMax M3.1 Flash");
    expect(brainModelLabel("claude_code", "opus")).toBe("Opus");
    expect(normalizeBrainModel("claude_code", "haiku")).toBe("haiku");
    // One of a plan's other models is stored by its id and named after it there; while Claude thinks it runs Sonnet.
    expect(normalizeBrainModel("claude_code", "deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
    expect(normalizeBrainModel("claude_code", "k3-256k")).toBe("k3-256k");
    expect(brainModelLabel("claude_code", "deepseek-v4.1-flash", "opencode")).toBe("DeepSeek V4.1 Flash");
    expect(brainModelLabel("claude_code", "deepseek-v4.1-flash", "kimi")).toBe("Kimi for Coding");
    expect(brainModelLabel("claude_code", "deepseek-v4.1-flash")).toBe("Sonnet");
    expect(brainModelLabel("claude_code", "auto")).toBe("auto");
  });

  test("stored values read back; executors map to brains", () => {
    expect(brainOf("claude_code")).toBe("claude_code");
    expect(brainOf("robot")).toBe("model");
    expect(brainOf(null)).toBe("model");
    expect(executorBrain("claude")).toBe("claude_code");
    expect(executorBrain("codex")).toBe("codex");
    expect(executorBrain("agent")).toBe("model");
  });

  test("models: Claude Code aliases mapped to today's ids, Codex free text, defaults", () => {
    expect(normalizeBrainModel("claude_code", "Opus")).toBe("opus");
    expect(normalizeBrainModel("claude_code", "claude-sonnet-5-5")).toBe("sonnet");
    expect(normalizeBrainModel("claude_code", null)).toBeNull();
    expect(() => normalizeBrainModel("claude_code", "gpt-6-sol")).toThrow();
    expect(normalizeBrainModel("codex", "gpt-6.1-codex")).toBe("gpt-6.1-codex");
    expect(() => normalizeBrainModel("codex", "rm -rf /")).toThrow();
    expect(() => normalizeBrainModel("model", "opus")).toThrow();
    expect(defaultBrainModel("claude_code")).toBe("sonnet");
    expect(defaultBrainModel("codex")).toBe("gpt-6.1-sol");
    expect(defaultBrainModel("model")).toBeNull();
    expect(brainModelId("claude_code", "opus")).toBe("claude-opus-5-5");
    expect(brainModelId("claude_code", null)).toBe("claude-sonnet-5-5");
    expect(brainModelId("codex", "gpt-6.1-codex")).toBe("gpt-6.1-codex");
  });

  test("options: only what the computer has; why the rest can't be chosen", () => {
    const reasons = (m: ReturnType<typeof mac> | null) =>
      brainOptions(m).map((o) => [o.kind, o.available, o.reason ?? null]);
    expect(reasons(null)).toEqual([
      ["model", true, null],
      ["claude_code", false, "no_computer"],
      ["codex", false, "no_computer"],
      ["cursor", false, "no_computer"],
    ]);
    expect(reasons(mac())).toEqual([
      ["model", true, null],
      ["claude_code", true, null],
      ["codex", false, "not_installed"],
      // Cursor needs runner protocol 35 (`CURSOR_PROTOCOL`).
      ["cursor", false, "runner_old"],
    ]);
    expect(reasons(mac({ execAllowed: false }))[1]).toEqual(["claude_code", false, "exec_off"]);
    expect(reasons(mac({ protocol: MISSION_PROTOCOL - 1 }))[1]).toEqual(["claude_code", false, "runner_old"]);
    // A runner with missions (protocol 5–7) but without `brain.turn`: the engine would refuse every run.
    expect(reasons(mac({ protocol: BRAIN_PROTOCOL - 1 })).slice(1, 3)).toEqual([
      ["claude_code", false, "runner_old"],
      ["codex", false, "runner_old"],
    ]);
    expect(reasons(mac({ protocol: BRAIN_PROTOCOL }))[1]).toEqual(["claude_code", true, null]);
    const oldCodex = mac({ executors: { codex: { version: "codex-cli 0.100.0" }, detectedAt: "x" } });
    expect(reasons(oldCodex).slice(1, 3)).toEqual([
      ["claude_code", false, "not_installed"],
      ["codex", false, "outdated"],
    ]);
    const both = mac({ executors: { claude: { version: "2" }, codex: { version: "0.170.0" }, detectedAt: "x" } });
    expect(brainOptions(both).every((o) => o.available || o.kind === "cursor")).toBe(true);
    expect(brainOptions(both).find((o) => o.kind === "codex")?.experimental).toBe(true);
    // Installed but turned off in the app's Tools: says so (not "not installed"); turned on, available.
    const off = mac({ ...both, access: { tools: { claude: false, codex: true } } });
    expect(reasons(off).slice(1, 3)).toEqual([
      ["claude_code", false, "tool_off"],
      ["codex", true, null],
    ]);
    expect(reasons(mac({ access: { tools: { claude: true } } }))[1]).toEqual(["claude_code", true, null]);
  });
});

/*
 * ADR 0059 §2–3 and §5: a plan thinks only for its owner's agents, one
 * account per agent, and an agent on a plan answers only its owner until the
 * owner turns on "Atende outras pessoas".
 */
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ANAS = "0193dddd-0000-4000-8000-0000000000a1";
const BIAS = "0193dddd-0000-4000-8000-0000000000b1";

/** Ana's computer, with Claude Code on it, and her agent Dev there on the API; Bia a member, Caio an admin. */
async function world() {
  const fx = await setup();
  f = fx;
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "mac",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  const machineId = paired.machineId;
  await fx.db
    .update(schema.machines)
    .set({ executors: { claude: { version: "2.1.304", loggedIn: true }, detectedAt: new Date().toISOString() } })
    .where(eq(schema.machines.id, machineId));
  await fx.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, fx.agent.id));
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  const account = (id: string, createdBy: string) =>
    fx.db
      .insert(schema.machineAccounts)
      .values({ id, orgId: fx.org.id, machineId, kind: "claude_code", label: id, status: "active", createdBy });
  const row = async (id = fx.agent.id) => {
    const [r] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, id));
    if (!r) throw new Error("no agent");
    return r;
  };
  const audits = (action: string) => fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  return { fx, deps: { db: fx.db }, machineId, bia, caio, account, row, audits };
}

describe("Criar agente: what a new agent could think with", () => {
  test("admins see every computer with what it offers; a member can't create agents", async () => {
    const { fx, deps, machineId, bia, caio } = await world();
    const [mine] = await newAgentBrainMachines(deps, caio.id, fx.org.id);
    expect(mine).toMatchObject({ machineId, name: "mac" });
    expect(mine?.options.find((o) => o.kind === "claude_code")?.available).toBe(true);
    expect(mine?.options.find((o) => o.kind === "codex")).toMatchObject({ available: false, reason: "not_installed" });
    await expect(newAgentBrainMachines(deps, bia.id, fx.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("context window (Configuração avançada)", () => {
  test("any brain keeps a limit from CONTEXT_LIMITS through a switch; anything else is refused; audited", async () => {
    const { fx, deps, row, audits } = await world();
    const onApi = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { contextTokens: 400_000 });
    expect(onApi).toMatchObject({ brain: "model", contextTokens: 400_000 });
    expect(await row()).toMatchObject({ contextTokens: 400_000 });
    expect((await audits("agent.brain")).at(-1)?.details).toMatchObject({
      from: { contextTokens: null },
      to: { contextTokens: 400_000 },
    });
    // It is the agent's, not the brain's: a switch keeps it, and so does a change that leaves it out.
    const onPlan = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect(onPlan).toMatchObject({ brain: "claude_code", contextTokens: 400_000 });
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { model: "opus" })).contextTokens).toBe(
      400_000,
    );
    for (const bad of [300_000, "400000", -1, 2_000_000]) {
      await expect(
        setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { contextTokens: bad }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    // Null: the model's own window again.
    expect(
      (await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { contextTokens: null })).contextTokens,
    ).toBe(null);
    expect(await row()).toMatchObject({ contextTokens: null });
  });

  test("a computer turn carries it only to a runner that knows it (protocol 28)", () => {
    expect(contextFields(CONTEXT_LIMIT_PROTOCOL, { contextTokens: 400_000 })).toEqual({ contextTokens: 400_000 });
    expect(contextFields(CONTEXT_LIMIT_PROTOCOL - 1, { contextTokens: 400_000 })).toEqual({});
    expect(contextFields(CONTEXT_LIMIT_PROTOCOL, {})).toEqual({});
  });

  test("each model choice says its window: which limits are worth offering with it", () => {
    expect(brainModelOptions("claude_code").find((o) => o.value === "opus")?.contextWindow).toBe(1_000_000);
    // A coding plan's models are listed from its catalog by the apps, which read the window off the id (`[1m]`).
    expect(planOf("minimax")?.claudeCode.models.every((m) => m.id.endsWith("[1m]"))).toBe(true);
  });
});

describe("a plan answers its owner until it answers other people (Atende outras pessoas)", () => {
  test("onto a plan it answers only its owner; turning it on asks nothing and is audited as who may talk to it", async () => {
    const { fx, deps, bia, caio, row, audits } = await world();
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [bia.id] });
    const onPlan = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect(onPlan).toMatchObject({ brain: "claude_code", onlyOwner: true, canUsePlans: true, ownSignIn: true });
    // The people it answered wait for it to be let out again.
    expect(await row()).toMatchObject({ audienceMode: "owner", audienceUserIds: [bia.id] });
    const changes = async () => (await audits("agent.audience_changed")).map((a) => a.details);
    expect((await changes()).at(-1)).toEqual({
      from: { mode: "people", userIds: [bia.id] },
      to: { mode: "owner", userIds: [] },
    });

    // On, it replies to whoever its "who can talk" list lets in: Bia, not the whole workspace.
    const brainAudits = (await audits("agent.brain")).length;
    const shared = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    expect(shared.onlyOwner).toBe(false);
    expect(await row()).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
    expect((await changes()).at(-1)).toEqual({
      from: { mode: "owner", userIds: [bia.id] },
      to: { mode: "people", userIds: [bia.id] },
    });
    // Nothing about what it thinks with changed: no brain entry for it.
    expect(await audits("agent.brain")).toHaveLength(brainAudits);
    // Other changes keep it on, and off brings back only its owner.
    expect(await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { model: "opus" })).toMatchObject({
      onlyOwner: false,
    });
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: true })).onlyOwner).toBe(true);
    expect(await row()).toMatchObject({ audienceMode: "owner", audienceUserIds: [bia.id] });
    expect((await changes()).at(-1)).toEqual({
      from: { mode: "people", userIds: [bia.id] },
      to: { mode: "owner", userIds: [] },
    });
    // Off and on again never widens it: still Bia alone.
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    const again = await row();
    expect(again).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
    expect([canTalkTo(again, bia.id), canTalkTo(again, caio.id)]).toEqual([true, false]);
  });

  test("moved onto a plan with it on, an agent keeps its list as it was: nothing widens, nothing to record", async () => {
    const { fx, deps, bia, caio, row, audits } = await world();
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [bia.id] });
    const changes = (await audits("agent.audience_changed")).length;
    const moved = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      onlyOwner: false,
    });
    expect(moved).toMatchObject({ brain: "claude_code", onlyOwner: false });
    const after = await row();
    expect(after).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
    expect([canTalkTo(after, bia.id), canTalkTo(after, caio.id)]).toEqual([true, false]);
    expect(await audits("agent.audience_changed")).toHaveLength(changes);
  });

  test("only the plan's owner lets more people in; an admin only narrows; a member can't touch it", async () => {
    const { fx, deps, bia, caio, row } = await world();
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect(await getAgentBrain(deps, caio.id, fx.org.id, fx.agent.id)).toMatchObject({
      onlyOwner: true,
      canUsePlans: false,
    });
    const refused = await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { onlyOwner: false }).catch((e) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(refused.code).toBe("audience.plan_owner_only");
    const member = await setAgentBrain(deps, bia.id, fx.org.id, fx.agent.id, { onlyOwner: true }).catch((e) => e);
    expect(member).toBeInstanceOf(ForbiddenError);
    // With no "who can talk" list, on means everyone.
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    expect(await row()).toMatchObject({ audienceMode: "everyone", audienceUserIds: [] });
    expect((await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { onlyOwner: true })).onlyOwner).toBe(true);
  });

  test("back on the API it still answers only its owner; letting it out brings back whoever it answered", async () => {
    const { fx, deps, bia, caio, row } = await world();
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [bia.id] });
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "model" })).onlyOwner).toBe(true);
    // No plan any more: an admin may let them in.
    await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    expect(await row()).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
  });
});

describe("a plan thinks only for its owner's agents, one account each", () => {
  test("the owner's accounts only; both the account and the agent the caller's; another agent's with moveAccount, unless for all", async () => {
    const { fx, deps, machineId, bia, caio, account, row, audits } = await world();
    await account(ANAS, fx.owner.id);
    await account(BIAS, bia.id);
    const [theo] = await fx.db
      .insert(schema.agents)
      .values({
        orgId: fx.org.id,
        name: "Theo",
        handle: "theo",
        model: "claude-sonnet-5-5",
        ownerUserId: fx.owner.id,
        machineId,
        brain: "claude_code",
        brainAccountId: ANAS,
      })
      .returning();
    if (!theo) throw new Error("no agent");
    // Dev's page lists Ana's account, never Bia's.
    const seen = await getAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id);
    expect(seen.accounts.map((a) => a.id)).toEqual([ANAS]);

    const theirs = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      account: BIAS,
    }).catch((e) => e);
    expect(theirs).toBeInstanceOf(ForbiddenError);
    expect(theirs.code).toBe("account.not_owner");
    // An admin owns neither.
    const admin = await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      account: ANAS,
      moveAccount: true,
    }).catch((e) => e);
    expect(admin.code).toBe("account.not_owner");
    const taken = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      account: ANAS,
    }).catch((e) => e);
    expect(taken).toBeInstanceOf(ConflictError);
    expect(taken).toMatchObject({ code: "account.in_use", params: { agent: "Theo", agentId: theo.id } });

    const moved = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      account: ANAS,
      moveAccount: true,
    });
    expect(moved.account).toBe(ANAS);
    // Theo goes back to the computer's own sign-in, Ana's like Theo.
    expect(await row(theo.id)).toMatchObject({ brainAccountId: null, brain: "claude_code" });
    expect((await audits("account.moved"))[0]?.details).toEqual({ from: theo.id, to: fx.agent.id });
    // Theo can't take it back without moving it: a login made for one agent thinks for one.
    const back = await setAgentBrain(deps, fx.owner.id, fx.org.id, theo.id, { account: ANAS }).catch((e) => e);
    expect(back).toMatchObject({ code: "account.in_use", params: { agentId: fx.agent.id } });

    // One the runner made for all of Ana's agents there thinks for both, with no move.
    await fx.db.update(schema.machineAccounts).set({ shared: true }).where(eq(schema.machineAccounts.id, ANAS));
    const both = await setAgentBrain(deps, fx.owner.id, fx.org.id, theo.id, { account: ANAS });
    expect(both.accounts.find((a) => a.id === ANAS)?.usedBy.sort()).toEqual(["Dev", "Theo"]);
    expect(await row(fx.agent.id)).toMatchObject({ brainAccountId: ANAS });
    expect(await audits("account.moved")).toHaveLength(1);
  });

  test("the computer's own sign-in: only for its pairer's agents; an account that goes sends the others to the API", async () => {
    const { fx, deps, bia, account, row } = await world();
    await account(BIAS, bia.id);
    await fx.db
      .update(schema.agents)
      .set({ ownerUserId: bia.id, brain: "claude_code", brainAccountId: BIAS })
      .where(eq(schema.agents.id, fx.agent.id));
    expect(await getAgentBrain(deps, bia.id, fx.org.id, fx.agent.id)).toMatchObject({
      canUsePlans: true,
      ownSignIn: false,
      canManageAccounts: false,
    });
    const own = await setAgentBrain(deps, bia.id, fx.org.id, fx.agent.id, { account: null }).catch((e) => e);
    expect(own).toBeInstanceOf(ForbiddenError);
    expect(own.code).toBe("account.not_owner");
    // Her account goes: the computer's own sign-in is Ana's, so Bia's agent goes back to the API.
    expect(await releaseAgents(fx.db, fx.org.id, [BIAS])).toEqual([fx.agent.id]);
    expect(await row()).toMatchObject({ brain: "model", brainAccountId: null });
  });

  test("a new owner who doesn't own the plan sends the agent to the API (audited); one who does answers alone", async () => {
    const { fx, bia, account, row, audits } = await world();
    await account(ANAS, fx.owner.id);
    await fx.db
      .update(schema.agents)
      .set({ brain: "claude_code", brainAccountId: ANAS })
      .where(eq(schema.agents.id, fx.agent.id));
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ownerUserId: bia.id });
    expect(await row()).toMatchObject({ ownerUserId: bia.id, brain: "model", brainAccountId: null });
    expect((await audits("agent.brain")).at(-1)?.details).toMatchObject({
      to: { brain: "model", account: null },
      reason: "owner_changed",
    });
    // On the computer's own sign-in (Ana's), shared by someone else: Ana takes it over and answers alone.
    await fx.db
      .update(schema.agents)
      .set({ brain: "claude_code", audienceMode: "everyone" })
      .where(eq(schema.agents.id, fx.agent.id));
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ownerUserId: fx.owner.id });
    expect(await row()).toMatchObject({ brain: "claude_code", audienceMode: "owner" });
  });
});
