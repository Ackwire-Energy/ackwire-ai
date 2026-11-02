import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { extraUsageOn, planBinding } from "@agenteschat/ui/plan-state";
import {
  addChannelMember,
  answerNow,
  type Brain,
  type BrainEvent,
  type BrainTurn,
  clearPlanLimits,
  createJobHandlers,
  createRoutine,
  drainOutbox,
  enqueueRunJob,
  holdsMessages,
  insertMessage,
  isLongWork,
  listMessages,
  type MachineStatus,
  postPersonMessage,
  RESUME_AFTER_MS,
  runRoutineNow,
} from "../src";
import { monthStartUtc } from "../src/usage";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** ADR 0118: long work pauses at 95% of its plan or budget, picks up at the reset, and Continuar agora lets it go on. */

let f: Fixture;
afterEach(() => {
  clearPlanLimits();
  const fx: Fixture | undefined = f;
  f = undefined as unknown as Fixture;
  return fx?.close();
});

const later = (ms: number) => new Date(Date.now() + ms);
const iso = (ms: number) => later(ms).toISOString();
const reading = (
  windows: { kind: string; usedPercent: number; resetsAt?: string; label?: string }[],
  at = new Date().toISOString(),
) => ({
  windows,
  source: "turn",
  at,
});

test("the window that binds long work: live, of this model, never extra usage", () => {
  const now = Date.now();
  const u = reading([
    { kind: "five_hour", usedPercent: 40, resetsAt: iso(3600_000) },
    { kind: "seven_day", usedPercent: 99, resetsAt: iso(-1000) },
    { kind: "seven_day_opus", usedPercent: 97, resetsAt: iso(86_400_000) },
    { kind: "other", label: "Extra usage", usedPercent: 100 },
  ]);
  // The week reset already, Opus's week isn't this model's, extra usage never counts.
  expect(planBinding(u, { model: "sonnet", now })).toEqual({
    kind: "five_hour",
    used: 40,
    resetsAt: u.windows[0]?.resetsAt as string,
  });
  expect(planBinding(u, { model: "opus", now })?.used).toBe(97);
  // A reading with no reset counts while its window lasts.
  const old = reading([{ kind: "five_hour", usedPercent: 96 }], iso(-6 * 3600_000));
  expect(planBinding(old, { now })).toBeNull();
  expect(planBinding(reading([{ kind: "five_hour", usedPercent: 96 }]), { now })?.used).toBe(96);
  expect(planBinding(null)).toBeNull();
  expect(extraUsageOn(u)).toBe(true);
  expect(extraUsageOn(reading([{ kind: "five_hour", usedPercent: 1 }]))).toBe(false);
});

test("long work: a routine or a mission by kind, else by size in this claim", () => {
  const base = { routine: false, mission: false, pausedBefore: false, computer: false, calls: 0, elapsedMs: 0 };
  expect(isLongWork(base)).toBe(false);
  expect(isLongWork({ ...base, routine: true })).toBe(true);
  expect(isLongWork({ ...base, mission: true })).toBe(true);
  expect(isLongWork({ ...base, pausedBefore: true })).toBe(true);
  expect(isLongWork({ ...base, calls: 7 })).toBe(false);
  expect(isLongWork({ ...base, calls: 8 })).toBe(true);
  expect(isLongWork({ ...base, computer: true, calls: 1 })).toBe(false);
  expect(isLongWork({ ...base, computer: true, calls: 2 })).toBe(true);
  expect(isLongWork({ ...base, elapsedMs: 11 * 60_000 })).toBe(false);
  expect(isLongWork({ ...base, calls: 1, elapsedMs: 11 * 60_000 })).toBe(true);
});

// ── The model brain on its budget ────────────────────────────────────────────

const BUDGET = 100_000_000_000;

async function spend(fx: Fixture, percent: number) {
  const spentNanoUsd = (BUDGET * percent) / 100;
  await fx.db
    .insert(schema.agentBudgetPeriods)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      periodStart: monthStartUtc(new Date()).toISOString().slice(0, 10),
      spentNanoUsd,
    })
    .onConflictDoUpdate({
      target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
      set: { spentNanoUsd },
    });
}

/** A model that looks things up `steps` times, then answers. */
const stepper = (steps: number) => (_: unknown, call: number) =>
  call < steps
    ? { chunks: [], toolUses: [{ name: "search_context", input: { query: `pedido ${call}` } }] }
    : { chunks: ["Pronto."] };

const runs = (fx: Fixture) => fx.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
const cards = async (fx: Fixture) =>
  (await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id)).filter(
    (m) => (m.meta.actionCard as { kind?: string } | undefined)?.kind === "usage_paused",
  );
/** Usage cards anywhere, threads too. */
const allCards = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).where(eq(schema.messages.orgId, fx.org.id))).filter(
    (m) => (m.meta.actionCard as { kind?: string } | undefined)?.kind === "usage_paused",
  );
const post = (fx: Fixture, body: string, userId = fx.owner.id) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, fx.general.id, { body });

test("at 96% of its budget a long run parks between steps with a card; a short reply finishes", async () => {
  f = await setup({ contextTools: true, budgetNanoUsd: BUDGET, reply: stepper(12) });
  await spend(f, 96);
  await post(f, "@dev analisa os pedidos");
  await drainOutbox(f.db, f.handlers);
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  const t = run?.transcript as {
    waitingForBrain?: { code: string; source?: string; until?: string };
    usagePause?: { paused?: boolean };
    messages: { role: string; content: unknown }[];
  };
  expect(t.waitingForBrain?.code).toBe("usage_pause");
  expect(t.waitingForBrain?.source).toBe("budget");
  expect(t.usagePause?.paused).toBe(true);
  // It stopped at the 8th call, its last step a tool's result: nothing in flight.
  expect(f.provider.calls).toHaveLength(8);
  expect(t.messages.at(-1)?.role).toBe("user");
  const [card] = await cards(f);
  expect(card?.meta.bodyCode).toBe("usage_paused_budget");
  expect(card?.meta.actionCard).toEqual(
    expect.objectContaining({ state: "paused", source: "budget", percent: 96, forUserId: f.owner.id }),
  );
  // The job comes back when the budget renews.
  expect(Date.parse(t.waitingForBrain?.until ?? "")).toBeGreaterThan(Date.now() + 1000);
});

test("a short reply at 96% of its budget finishes, with no card", async () => {
  f = await setup({ contextTools: true, budgetNanoUsd: BUDGET, reply: stepper(2) });
  await spend(f, 96);
  await post(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  expect((await runs(f))[0]?.status).toBe("done");
  expect(await cards(f)).toHaveLength(0);
});

test("Continuar agora: who may press it lets the run go on once; a person's message meanwhile gets its own run", async () => {
  f = await setup({ contextTools: true, budgetNanoUsd: BUDGET, reply: stepper(12) });
  await spend(f, 96);
  await post(f, "@dev analisa os pedidos");
  await drainOutbox(f.db, f.handlers);
  const [paused] = await runs(f);
  expect(paused && (await holdsMessages(f.db, paused))).toBe(true);
  const [card] = await cards(f);
  if (!card || !paused) throw new Error("no card");
  const deps = { db: f.db, pubsub: f.pubsub, gateway: f.gateway };

  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const refused = await answerNow(deps, bia.id, f.org.id, card.id).catch((e) => e);
  expect((refused as { code?: string }).code).toBe("run.answer_forbidden");

  expect(await answerNow(deps, f.owner.id, f.org.id, card.id)).toEqual({
    runs: [{ agentId: f.agent.id, runId: paused.id }],
  });
  expect(await answerNow(deps, f.owner.id, f.org.id, card.id)).toEqual({ runs: [] });
  await drainOutbox(f.db, f.handlers);
  const [done] = await runs(f);
  expect(done?.status).toBe("done");
  expect(f.provider.calls.length).toBeGreaterThan(8);
  const [after] = await cards(f);
  expect(after?.meta.actionCard).toEqual(
    expect.objectContaining({ state: "continued", continuedByUserId: f.owner.id }),
  );
  const audit = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "usage.continued")));
  expect(audit).toHaveLength(1);
});

test("a person's message during a pause is answered by a run of its own", async () => {
  f = await setup({
    contextTools: true,
    budgetNanoUsd: BUDGET,
    reply: (req, call) => (JSON.stringify(req).includes("tudo bem") ? { chunks: ["Tudo."] } : stepper(12)(req, call)),
  });
  await spend(f, 96);
  await post(f, "@dev analisa os pedidos");
  await drainOutbox(f.db, f.handlers);
  await post(f, "@dev tudo bem?");
  await drainOutbox(f.db, f.handlers);
  const [paused, quick] = await runs(f);
  expect(paused?.status).toBe("waiting_input");
  expect(quick?.status).toBe("done");
});

// ── A computer brain on its plan ─────────────────────────────────────────────

const RUNNER = {
  hostname: "mac",
  os: "darwin" as const,
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

async function computerAgent(fx: Fixture, over: Partial<typeof schema.agents.$inferInsert> = {}) {
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code", brainFallback: false, ...over })
    .where(eq(schema.agents.id, fx.agent.id));
  return paired.machineId;
}

async function storeOwnUsage(fx: Fixture, machineId: string, usage: Record<string, unknown>) {
  const [m] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  await fx.db
    .update(schema.machines)
    .set({ executors: { ...m?.executors, ownUsage: { claude_code: usage as never } } })
    .where(eq(schema.machines.id, machineId));
}

function scripted(script: (n: number) => BrainEvent[]) {
  // A computer brain's turn also carries "# This turn".
  const seen: (BrainTurn & { thisTurn?: string })[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      yield* script(n);
    },
  };
  return { brain, seen };
}

const handlersWith = (fx: Fixture, brain: Brain) =>
  createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });

/** A scheduled slot of a routine (Rodar agora, then marked as its schedule's: by hand it wouldn't be long work). */
async function scheduledSlot(fx: Fixture) {
  const deps = { db: fx.db, pubsub: fx.pubsub, context: fx.context };
  const routine = await createRoutine(deps, fx.owner.id, fx.org.id, {
    name: "Deploys",
    agentId: fx.agent.id,
    prompt: "Check the deploys.",
    target: { type: "channel", channelId: fx.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  await runRoutineNow(deps, fx.owner.id, fx.org.id, routine.id);
  await fx.db
    .update(schema.routineRuns)
    .set({ trigger: "schedule" })
    .where(eq(schema.routineRuns.routineId, routine.id));
}

test("a routine's slot at 96% of the plan parks before its first turn and picks up after the reset", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  const resetsAt = iso(3600_000);
  await storeOwnUsage(f, machineId, reading([{ kind: "five_hour", usedPercent: 96, resetsAt }]));
  const { brain, seen } = scripted(() => [{ type: "done", text: "Deploys ok." }]);
  const handlers = handlersWith(f, brain);
  await scheduledSlot(f);
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(0);
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  const wait = (run?.transcript as { waitingForBrain?: { code: string; source?: string; until?: string } } | undefined)
    ?.waitingForBrain;
  expect(wait?.code).toBe("usage_pause");
  expect(wait?.source).toBe("plan");
  expect(Date.parse(wait?.until ?? "")).toBe(Date.parse(resetsAt) + RESUME_AFTER_MS);
  // A routine's pause is quiet: its slot says it, not a card in the conversation.
  expect(await cards(f)).toHaveLength(0);

  // The window reset (a fresh reading says so): it runs.
  await storeOwnUsage(f, machineId, reading([{ kind: "five_hour", usedPercent: 2, resetsAt: iso(5 * 3600_000) }]));
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen).toHaveLength(1);
});

test("the plan's paid extra usage lets long work go on, unless its switch is off", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await storeOwnUsage(
    f,
    machineId,
    reading([
      { kind: "five_hour", usedPercent: 97, resetsAt: iso(3600_000) },
      { kind: "other", label: "Extra usage", usedPercent: 10 },
    ]),
  );
  const { brain, seen } = scripted(() => [{ type: "done", text: "ok" }]);
  const handlers = handlersWith(f, brain);
  await scheduledSlot(f);
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(1);

  await f.db.update(schema.agents).set({ brainExtraUsage: false }).where(eq(schema.agents.id, f.agent.id));
  await scheduledSlot(f);
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(1);
  expect((await runs(f)).at(-1)?.status).toBe("waiting_input");
});

test("from 90% of its plan the agent reads where it stands; at 50% it doesn't", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await storeOwnUsage(f, machineId, reading([{ kind: "five_hour", usedPercent: 91, resetsAt: iso(3600_000) }]));
  const { brain, seen } = scripted(() => [{ type: "done", text: "ok" }]);
  const handlers = handlersWith(f, brain);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect(seen[0]?.thisTurn).toContain("Your Claude plan is at 91% of its 5 hours");

  await storeOwnUsage(f, machineId, reading([{ kind: "five_hour", usedPercent: 50, resetsAt: iso(3600_000) }]));
  const first = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id))[0];
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev e agora?",
    ...(first ? { threadId: first.id } : {}),
  });
  await drainOutbox(f.db, handlers);
  expect(seen[1]?.thisTurn ?? "").not.toContain("Your Claude plan");
});

test("a paused mission: a person's question in its thread gets an answer, its notices wait for the work", async () => {
  f = await setup({
    contextTools: true,
    budgetNanoUsd: BUDGET,
    reply: (req, call) =>
      JSON.stringify(req).includes("qual o status") ? { chunks: ["Pausado."] } : stepper(12)(req, call),
  });
  await spend(f, 96);
  const root = await post(f, "Migrar o login");
  await f.db.insert(schema.missions).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: root.id,
    ownerId: f.owner.id,
    title: "Migrar o login",
    goal: "Trocar a biblioteca de sessão",
    status: "active",
    brain: "model",
    mainSessionId: crypto.randomUUID(),
  });
  const notice = (text: string) =>
    f.db.transaction(async (tx) => {
      const m = await insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: root.id,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
        body: text,
        meta: { missionInbox: { text } },
      });
      return enqueueRunJob(tx, { ...m, threadId: root.id }, f.agent.id);
    });
  await notice("Siga o plano.");
  await drainOutbox(f.db, f.handlers);
  const [main] = await runs(f);
  expect(main?.status).toBe("waiting_input");
  expect(await allCards(f)).toHaveLength(1);

  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev qual o status?",
    threadId: root.id,
  });
  await drainOutbox(f.db, f.handlers);
  const all = await runs(f);
  expect(all).toHaveLength(2);
  expect(all[1]?.status).toBe("done");
  expect(await allCards(f)).toHaveLength(1);

  // The mission's next notice joins its paused work: no new run, no second card.
  const told = await notice("Mais um passo.");
  expect(told.steered).toBe(main?.id ?? "");
  expect(await runs(f)).toHaveLength(2);
});
