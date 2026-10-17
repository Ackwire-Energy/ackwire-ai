import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  brainFor,
  brainModelFor,
  brainSessionId,
  clearPlanLimits,
  computerBrainUnavailable,
  createJobHandlers,
  createMachinePairing,
  createMissionEngine,
  decideApproval,
  drainOutbox,
  engineMigrateDedupeKey,
  enqueue,
  executeToolForRun,
  grantScopes,
  invokeToolForRun,
  listApprovals,
  listMessages,
  type MachineStatus,
  notePlanLimit,
  postPersonMessage,
  redeemMachinePairing,
  resumeRunsWaitingForMachine,
  runWhere,
  type ToolSource,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

/**
 * ADR 0032 integration: the engine with a computer brain (Claude Code, here a
 * scripted fake) on the agent's computer — the turn ends after tools the brain
 * ran through the bridge, a bridged pause leaves the run waiting and resumes
 * the session with the decision, a plan limit falls back to the model brain,
 * and with nothing to fall back on the run waits for the computer.
 */

let f: Fixture;
afterEach(() => {
  clearPlanLimits();
  return f?.close();
});

const RUNNER = {
  hostname: "mac",
  os: "darwin" as const,
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const statusOf = (machineId: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

/** Pairs a computer and makes it the agent's, thinking with Claude Code. */
async function computerAgent(fx: Fixture, over: Partial<typeof schema.agents.$inferInsert> = {}) {
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const { code } = await createMachinePairing(deps, fx.owner.id, fx.org.id, { name: "MacBook" });
  const paired = await redeemMachinePairing(deps, { code, ...RUNNER, exec: true });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code", ...over })
    .where(eq(schema.agents.id, fx.agent.id));
  return paired.machineId;
}

/** A Claude Code stand-in that replays a script per turn and keeps what each turn received. */
function scriptedComputerBrain(script: (n: number, turn: BrainTurn) => AsyncIterable<BrainEvent> | BrainEvent[]) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      yield* script(n, turn) as AsyncIterable<BrainEvent>;
    },
  };
  return { brain, seen };
}

const post = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

test("brainFor: the mission's brain first, then the agent's; unknown values are the model brain", () => {
  const run = { id: "r" };
  expect(brainFor({ brain: "codex" }, run, { brain: "claude_code" })).toBe("claude_code");
  expect(brainFor({ brain: "codex" }, run, null)).toBe("codex");
  expect(brainFor({ brain: "claude_code" }, run)).toBe("claude_code");
  expect(brainFor({ brain: "something" }, run)).toBe("model");
});

test("availability: no computer, offline, old runner, not logged in, Codex missing, plan limit", () => {
  expect(computerBrainUnavailable("model", null, null)).toBeNull();
  expect(computerBrainUnavailable("claude_code", null, null)?.code).toBe("no_computer");
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1", { online: false }))?.code).toBe(
    "machine_offline",
  );
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1", { protocol: 7 }))?.code).toBe("runner_outdated");
  expect(
    computerBrainUnavailable(
      "claude_code",
      "m1",
      statusOf("m1", { executors: { claude: { version: "2.1.300", loggedIn: false } } }),
    )?.code,
  ).toBe("not_logged_in");
  expect(computerBrainUnavailable("codex", "m1", statusOf("m1"))?.code).toBe("codex_missing");
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1"))).toBeNull();
  notePlanLimit("m1", "claude_code", new Date(Date.now() + 3600_000).toISOString());
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1"))?.code).toBe("plan_limit");
  expect(
    computerBrainUnavailable("codex", "m1", statusOf("m1", { executors: { codex: { version: "0.163.0" } } })),
  ).toBeNull();
});

test("a computer-brain turn ends after the tools it ran through the bridge (never sent again); plan usage at no cost", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain((n) =>
    n === 0
      ? [
          { type: "text_delta", text: "Rodei os testes." },
          { type: "tool_call", id: "t1", name: "Bash", input: { command: "bun test" }, executed: { content: "ok" } },
          { type: "usage", input: 40, output: 9, source: "plan", model: "claude-sonnet-5-5" },
          { type: "done", text: "Rodei os testes: tudo verde." },
        ]
      : [{ type: "done", text: "SENT TWICE" }],
  );
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const question = await post(f, "@dev roda os testes");
  await drainOutbox(f.db, handlers);

  expect(seen.length).toBe(1);
  expect(seen[0]?.trigger).toBe("@dev roda os testes");
  expect(seen[0]?.model).toBe("sonnet");
  expect(seen[0]?.session).toEqual({
    id: brainSessionId(f.agent.id, question.id, "claude_code"),
    resume: false,
    machineId,
    cwd: "",
  });
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
  expect(thread.map((m) => m.body)).toEqual(["@dev roda os testes", "Rodei os testes: tudo verde."]);
  // The transcript stays valid for the model brain: no tool_use without its result.
  expect(JSON.stringify(run?.transcript)).not.toContain('"type":"tool_use"');
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(usage).toMatchObject([
    { provider: "claude_code", billedTo: "plan", costNanoUsd: 0, inputTokens: 40, outputTokens: 9 },
  ]);
  // The turn's bridge token died with the run.
  const tokens = await f.db
    .select()
    .from(schema.runToolTokens)
    .where(eq(schema.runToolTokens.runId, run?.id ?? ""));
  expect(tokens.length).toBe(1);
  expect(tokens[0]?.revokedAt).not.toBeNull();
});

test("a gated call through the bridge leaves the run waiting; the decision resumes the session with the result", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      // What the runner bridge does for the brain's MCP call (the run's identity, this machine).
      const result = await executeToolForRun(
        f.jobDeps,
        { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
        { id: "call-1", name: "github_merge_pr", input: { repo: "acme/app", pr: 42 } },
      );
      yield { type: "tool_call", id: "call-1", name: "github_merge_pr", input: {}, executed: result };
      yield { type: "usage", input: 10, output: 2, source: "plan" };
      yield { type: "done", text: "Pedi aprovação para o merge." };
      return;
    }
    yield { type: "done", text: "Merge feito." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const question = await post(f, "@dev faz o merge do PR 42");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_approval");
  expect(gh.executed).toEqual([]);
  expect(seen.length).toBe(1);
  const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
  expect(thread.map((m) => m.body)).toContain("Pedi aprovação para o merge.");
  expect(thread.some((m) => typeof m.meta.approvalId === "string")).toBe(true);
  const transcript = run?.transcript as { pending?: { calls: { toolUseId: string; bridged?: boolean }[] } };
  expect(transcript.pending?.calls).toMatchObject([{ toolUseId: "call-1", bridged: true }]);

  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);

  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(gh.executed).toEqual([{ tool: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }]);
  // The same session goes on, reading what the person decided (not the original message again).
  expect(seen.length).toBe(2);
  expect(seen[1]?.session?.resume).toBe(true);
  expect(seen[1]?.session?.id).toBe(seen[0]?.session?.id);
  expect(seen[1]?.trigger).toContain("github_merge_pr");
  expect(seen[1]?.trigger).toContain("github_merge_pr ok: acme/app#42");
});

test("a plan limit falls back to the model brain; the reply carries a quiet note", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(() => [
    { type: "limit", resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your limit." },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const question = await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  expect(seen.length).toBe(1);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
  const reply = thread.at(-1);
  expect(reply?.body).toBe("Respondi pela API.");
  expect(reply?.meta.brainFallback).toMatchObject({ from: "claude_code", code: "plan_limit" });
  // That turn ran on the API (the agent's budget) and the limit is remembered for the next turns.
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(usage.some((u) => u.provider === "anthropic")).toBe(true);
  expect(computerBrainUnavailable("claude_code", machineId, statusOf(machineId))?.code).toBe("plan_limit");
});

test("with no model credential, an offline computer: the agent says so once and the run waits until it is back", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  // No key the API could answer with: nothing can stand in.
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let online = false;
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Voltei e respondo." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online }) },
  });
  const question = await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(seen.length).toBe(0);
  let thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
  expect(thread.at(-1)?.meta).toMatchObject({
    bodyCode: "brain_unavailable",
    brainUnavailable: { brain: "claude_code", code: "machine_offline" },
  });

  // The computer it waits for is on the row (indexed), not only in the transcript.
  expect(run?.waitingMachineId).toBe(machineId);
  online = true;
  expect(await resumeRunsWaitingForMachine(f.db, machineId)).toEqual([run?.id ?? ""]);
  // Reconnecting again before the job ran: still one job for this wait.
  expect(await resumeRunsWaitingForMachine(f.db, machineId)).toEqual([run?.id ?? ""]);
  const back = (await f.db.select().from(schema.outbox)).filter((j) => j.dedupeKey?.includes(":brain_back:"));
  expect(back.length).toBe(1);
  await drainOutbox(f.db, handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(run?.waitingMachineId).toBeNull();
  // Nothing waits for that computer anymore.
  expect(await resumeRunsWaitingForMachine(f.db, machineId)).toEqual([]);
  expect(seen.length).toBe(1);
  thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
  expect(thread.at(-1)?.body).toBe("Voltei e respondo.");
});

test("the mission engine: one run per agent and notice; a resume answers the call waiting on that id", async () => {
  f = await setup();
  const engine = createMissionEngine({ db: f.db, pubsub: f.pubsub });
  const root = crypto.randomUUID();
  const start = {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: root,
    triggerMessageId: root,
    hop: 0,
    trigger: "Plan it",
    brain: "model" as const,
    missionId: crypto.randomUUID(),
    requestedBy: null,
    kind: "system" as const,
  };
  const first = await f.db.transaction((tx) => engine.startRun(tx, start));
  expect(first?.steered).toBe(false);
  expect(await f.db.transaction((tx) => engine.startRun(tx, start))).toBeNull();
  expect((await f.db.select().from(schema.agentRuns)).length).toBe(1);

  // That run paused on a blocking decision (the tool returned `data.pause` with the decision's id).
  await f.db
    .update(schema.agentRuns)
    .set({
      status: "waiting_input",
      transcript: { pending: { calls: [{ toolUseId: "call-9", name: "ask_decision", waitId: "decision-1" }] } },
    })
    .where(eq(schema.agentRuns.id, first?.runId ?? ""));
  const identity = { orgId: f.org.id, agentId: f.agent.id, runId: first?.runId ?? "", machineId: "" };
  expect(
    await engine.resumeRun({ run: identity, pause: { kind: "input", id: "other" }, result: { content: "x" } }),
  ).toBeNull();
  expect(
    await engine.resumeRun({
      run: identity,
      pause: { kind: "input", id: "decision-1" },
      result: { content: "Decision: Tabs or drawer? → Tabs" },
    }),
  ).toEqual({ runId: first?.runId ?? "" });
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(
    (run?.transcript as { pending?: { calls: { result?: unknown }[] } } | undefined)?.pending?.calls[0]?.result,
  ).toEqual({
    content: "Decision: Tabs or drawer? → Tabs",
    isError: false,
  });
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  expect(jobs.some((j) => j.dedupeKey === `agent_run.execute:${run?.id}:wait:decision-1`)).toBe(true);
  // Answered once: a second answer finds nothing waiting.
  expect(
    await engine.resumeRun({ run: identity, pause: { kind: "input", id: "decision-1" }, result: { content: "y" } }),
  ).toBeNull();
});

// ── Review fixes (PR #9) ─────────────────────────────────────────────────────

/** A run row that is running now, with the transcript the engine keeps (as before a computer turn). */
async function runningRun(fx: Fixture, trigger: { id: string }, threadRootId = trigger.id) {
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
      transcript: { system: [], messages: [], postedUpTo: 0, postedCount: 0, deltaSeq: 0 },
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** Tools whose results carry side effects for the reply (`data`), like `react`, artifacts and memory tools. */
function effectTools(fx: () => Fixture) {
  const artifactId = crypto.randomUUID();
  const source: ToolSource = {
    name: "effects",
    tools: async () => [
      {
        name: "react_now",
        description: "React to the message",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: "Reacted.", data: { reacted: true } }),
      },
      {
        name: "save_note",
        description: "Save a note as a file and remember it",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({
          content: "Saved.",
          data: {
            artifact: { id: artifactId, version: 1 },
            memoryUpdate: {
              action: "remembered",
              itemId: "item-1",
              text: "Deploys happen on Fridays",
              requestedByUserId: fx().owner.id,
            },
          },
        }),
      },
      {
        name: "check_env",
        description: "Check the environment",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: "go: not found" }),
      },
    ],
  };
  return { source, artifactId };
}

test("a routine's run: a bridged gated call posts its card and events in the main timeline, like its replies", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const call = await post(f, "Daily PR check");
  await f.db
    .update(schema.messages)
    .set({ meta: { routine: { id: crypto.randomUUID(), name: "Daily" } } })
    .where(eq(schema.messages.id, call.id));
  const run = await runningRun(f, call);
  expect((await runWhere(f.db, run)).threadId).toBeNull();
  const events = f.listen(f.general.id);

  const out = await invokeToolForRun(
    { db: f.db, pubsub: f.pubsub, tools: f.tools },
    { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId },
    { id: "call-1", name: "github_merge_pr", input: { repo: "acme/app", pr: 1 } },
  );
  expect(out.result.pause?.kind).toBe("approval");
  const card = (await f.db.select().from(schema.messages)).find((m) => typeof m.meta.approvalId === "string");
  expect(card?.threadId).toBeNull();
  const waiting = events.find((e) => e.type === "agent.run") as { threadId?: string | null; status?: string };
  expect(waiting).toMatchObject({ status: "waiting_approval", threadId: null });
  const chips = events.filter((e) => e.type === "agent.tool") as { threadId?: string | null }[];
  expect(chips.length).toBeGreaterThan(0);
  expect(chips.every((e) => e.threadId === null)).toBe(true);
});

test("bridged side effects reach the engine: a bridged react ends the turn silently (no Done.)", async () => {
  const fx = effectTools(() => f);
  f = await setup({ toolSources: [fx.source] });
  const machineId = await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (_n, turn) {
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    const result = await executeToolForRun(f.jobDeps, id, { id: "r-1", name: "react_now", input: {} });
    yield { type: "tool_call", id: "r-1", name: "react_now", input: {}, executed: result };
    yield { type: "done", text: "" };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const question = await post(f, "@dev valeu!");
  await drainOutbox(f.db, handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
  expect(thread.map((m) => m.body)).toEqual(["@dev valeu!"]);
  // Taken by the engine: nothing left over on the run.
  expect(JSON.stringify(run?.transcript)).not.toContain("bridgeEffects");
});

test("bridged side effects reach the engine: artifacts and memory cards on the reply, memory.updated published", async () => {
  const fx = effectTools(() => f);
  f = await setup({ toolSources: [fx.source] });
  const machineId = await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (_n, turn) {
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    const result = await executeToolForRun(f.jobDeps, id, { id: "s-1", name: "save_note", input: {} });
    yield { type: "tool_call", id: "s-1", name: "save_note", input: {}, executed: result };
    yield { type: "done", text: "Anotado." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const events = f.listen(f.general.id);
  const question = await post(f, "@dev anota que deploy é na sexta");
  await drainOutbox(f.db, handlers);

  const reply = (await f.db.select().from(schema.messages)).find((m) => m.body === "Anotado.");
  expect(reply?.threadId).toBe(question.id);
  expect(reply?.meta.artifacts).toEqual([{ id: fx.artifactId, version: 1 }]);
  expect(reply?.meta.memoryUpdates).toMatchObject([{ action: "remembered", text: "Deploys happen on Fridays" }]);
  expect(events.some((e) => e.type === "memory.updated")).toBe(true);
});

test("a computer brain that fails after a bridged tool ran: no fallback, what it did is posted, nothing runs twice", async () => {
  let checks = 0;
  const env: ToolSource = {
    name: "env",
    tools: async () => [
      {
        name: "check_env",
        description: "Check the environment",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          checks++;
          return { content: "go: not found" };
        },
      },
    ],
  };
  f = await setup({ toolSources: [env], reply: () => ({ chunks: ["Respondi pela API."] }) });
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(async function* (_n, turn) {
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    const result = await executeToolForRun(f.jobDeps, id, { id: "c-1", name: "check_env", input: {} });
    yield { type: "text_delta", text: "Verifiquei o ambiente." };
    yield { type: "tool_call", id: "c-1", name: "check_env", input: {}, executed: result };
    yield { type: "error", code: "executor_crashed", message: "Claude Code exited", retryable: true };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const question = await post(f, "@dev tem Go aí?");
  await drainOutbox(f.db, handlers);

  expect(seen.length).toBe(1);
  expect(checks).toBe(1);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  // The model brain never redid the turn.
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(usage.some((u) => u.provider === "anthropic")).toBe(false);
  const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
  const last = thread.at(-1);
  expect(last?.body).toContain("Verifiquei o ambiente.");
  expect(last?.meta.brainInterrupted).toMatchObject({
    brain: "claude_code",
    code: "executor_crashed",
    text: "Verifiquei o ambiente.",
    tools: ["check_env"],
  });
  expect(last?.meta.brainFallback).toBeUndefined();
});

test("a computer brain that fails after a bridged pause: the run keeps waiting with its pending call, then resumes", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source], reply: () => ({ chunks: ["Respondi pela API."] }) });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
      const result = await executeToolForRun(f.jobDeps, id, {
        id: "call-1",
        name: "github_merge_pr",
        input: { repo: "acme/app", pr: 42 },
      });
      yield { type: "tool_call", id: "call-1", name: "github_merge_pr", input: {}, executed: result };
      yield { type: "error", code: "executor_crashed", message: "Claude Code exited", retryable: true };
      return;
    }
    yield { type: "done", text: "Merge feito." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev faz o merge do PR 42");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_approval");
  expect(run?.error).toBeNull();
  const transcript = run?.transcript as { pending?: { calls: { toolUseId: string; bridged?: boolean }[] } };
  expect(transcript.pending?.calls).toMatchObject([{ toolUseId: "call-1", bridged: true }]);
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(usage.some((u) => u.provider === "anthropic")).toBe(false);

  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(seen.length).toBe(2);
  expect(gh.executed).toEqual([{ tool: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }]);
});

test("two gated bridged calls in one turn both wait; a gated call for a run that isn't running posts nothing", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const question = await post(f, "@dev merge os dois");
  const run = await runningRun(f, question);
  const deps = { db: f.db, pubsub: f.pubsub, tools: f.tools };
  const id = { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId };
  const [first, second] = await Promise.all([
    invokeToolForRun(deps, id, { id: "m-1", name: "github_merge_pr", input: { repo: "acme/app", pr: 1 } }),
    invokeToolForRun(deps, id, { id: "m-2", name: "github_merge_pr", input: { repo: "acme/app", pr: 2 } }),
  ]);
  expect(first.result.pause?.kind).toBe("approval");
  expect(second.result.pause?.kind).toBe("approval");
  const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(after?.status).toBe("waiting_approval");
  const pending =
    (after?.transcript as { pending?: { calls: { toolUseId: string }[] } } | undefined)?.pending?.calls ?? [];
  expect(pending.map((c) => c.toolUseId).sort()).toEqual(["m-1", "m-2"]);
  const cards = (await f.db.select().from(schema.messages)).filter((m) => typeof m.meta.approvalId === "string");
  expect(cards.length).toBe(2);

  // The run ended: the gated call is refused before anything is posted, and its request canceled.
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  const late = await invokeToolForRun(deps, id, {
    id: "m-3",
    name: "github_merge_pr",
    input: { repo: "acme/app", pr: 3 },
  });
  expect(late).toMatchObject({ code: "bridge.run_not_running", result: { isError: true } });
  expect(late.result.pause).toBeUndefined();
  const all = (await f.db.select().from(schema.messages)).filter((m) => typeof m.meta.approvalId === "string");
  expect(all.length).toBe(2);
  const [third] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.toolUseId, "m-3"));
  expect(third?.status).toBe("canceled");
  expect(gh.executed).toEqual([]);
});

test("a computer brain's model: the mission's, else the agent's only for the same brain, else the brain's default", () => {
  const agent = { brain: "claude_code", brainModel: "opus" };
  expect(brainModelFor("claude_code", agent)).toBe("opus");
  // The agent's Claude Code model means nothing to Codex (a mission on Codex): Codex's own default.
  expect(brainModelFor("codex", agent)).toBeUndefined();
  expect(brainModelFor("codex", agent, { model: "gpt-6.1-codex" })).toBe("gpt-6.1-codex");
  expect(brainModelFor("claude_code", { brain: "codex", brainModel: "gpt-6.1-codex" })).toBe("sonnet");
  expect(brainModelFor("claude_code", { brain: "claude_code", brainModel: null }, { model: "haiku" })).toBe("haiku");
  expect(brainModelFor("model", agent)).toBeUndefined();
});

test("the missions' boot migration is enqueued once per version, however many replicas boot", async () => {
  f = await setup();
  const job = { orgId: null, kind: "mission.engine_migrate", payload: {}, maxAttempts: 3 };
  await enqueue(f.db, { ...job, dedupeKey: engineMigrateDedupeKey("1.2.3") });
  await enqueue(f.db, { ...job, dedupeKey: engineMigrateDedupeKey("1.2.3") });
  await enqueue(f.db, { ...job, dedupeKey: engineMigrateDedupeKey("1.2.4") });
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "mission.engine_migrate"));
  expect(jobs.map((j) => j.dedupeKey).sort()).toEqual(["mission.engine_migrate:1.2.3", "mission.engine_migrate:1.2.4"]);
});
