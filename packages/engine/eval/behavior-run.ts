/**
 * The behavior eval's machinery (`behavior.ts` is the command line): seeds an
 * in-memory database with a case, runs the agent through the real engine
 * path, observes what it did, and asks a judge model to grade it. The model
 * provider is passed in, so tests drive it with the fake provider (no network).
 */
import { createMemoryPubSub, createPostgresSearchResolver, noPlatformCredentials } from "@agenteschat/adapters";
import { and, asc, eq, inArray, schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  type ContentBlock,
  costNanoUsd,
  type ModelProvider,
  type ModelRequest,
  systemText,
} from "@agenteschat/providers";
import { ptBR } from "../../i18n/src/pt-BR";
import {
  addChannelMember,
  type ContextDeps,
  createAgent,
  createAskAgentToolSource,
  createAskUserToolSource,
  createChannel,
  createContextToolSource,
  createCredential,
  createFakeJudge,
  createFakeScheduleReader,
  createIssue,
  createIssueToolSource,
  createJevJudge,
  createJobHandlers,
  createLlmJudge,
  createLocalKeyWrapper,
  createModelGateway,
  createOrganization,
  createReactToolSource,
  createRoutine,
  createScheduleToolSource,
  createToolGateway,
  createWorkspaceToolSource,
  drainOutbox,
  grantScopes,
  insertContextItem,
  insertMessage,
  isNoReply,
  type Judge,
  openDm,
  postPersonMessage,
  type ToolSource,
  withJudgeFallback,
} from "../src";
import type { CheckResult, EvalToolCall, EvalTurn, Expectations } from "./behavior-checks";
import { type Canned, CONNECTORS, fakeConnectorSource, fakeMissionSource } from "./behavior-fakes";

// ── Cases ────────────────────────────────────────────────────────────────────

type RoleId = "dev" | "ops" | "qa" | "pm";

interface CaseMessage {
  /** A person's name, or "agent" for the agent under test. */
  author: string;
  body: string;
  meta?: Record<string, unknown>;
}

export interface BehaviorCase {
  id: string;
  title: string;
  /** Where it comes from ("real failure 2026-10-17", "synthetic"). */
  source?: string;
  agent: {
    /** Role preset of "Criar agente" (name, role and instructions from pt-BR). */
    preset?: RoleId;
    name?: string;
    handle?: string;
    role?: string;
    instructions?: string;
    model?: string;
  };
  org: { name: string; context: string };
  conversation: {
    where: "channel" | "dm";
    channel?: string;
    topic?: string;
    /** Channel only: everything after the first prior message (and the trigger) is a reply in its thread. */
    thread?: boolean;
    prior?: CaseMessage[];
    trigger: CaseMessage;
    /** The trigger is a routine's scheduled message (meta.routine), not a person typing. */
    routine?: { name: string };
    /**
     * The trigger is another agent's question (`ask_agent`) on behalf of the person who wrote
     * `origin` in the channel: `trigger.author` is that person, `trigger.body` the question.
     */
    consultation?: { from: string; origin: string };
  };
  /** Other agents of the org, in the channel too (their own runs are recorded, never executed). */
  otherAgents?: { name: string; handle: string; role?: string; instructions?: string }[];
  /** Routines already there: `agent` is a handle (or "self"), answering in the case's channel. */
  routines?: { agent: string; name: string; prompt: string; schedule: string }[];
  /** The scheduling tools (list_routines, update_routine…) and `ask_agent`. */
  schedule?: boolean;
  /** Who a person's message with several mentions is for: the org's cheap model decides (real call). */
  addressees?: boolean;
  /** Fake connectors granted to the agent (all their scopes). */
  connectors?: (keyof typeof CONNECTORS)[];
  /** Built-in issue tools (list_issues, create_issue…) on the real issues table. */
  issues?: boolean;
  /** Workspace tools (add_agent_to_channel, update_thread): internal changes with undo. */
  workspace?: boolean;
  /** A `propose_mission` with the real description and findings schema (no computer; recorded only). */
  missions?: boolean;
  /** Issues already in the workspace. */
  seedIssues?: { title: string; description?: string; labels?: string[] }[];
  /** The agent's memory (context items it can find with search_context). */
  memory?: { kind?: "note" | "fact" | "decision" | "lesson"; title?: string; content: string }[];
  /** Canned results per tool: the first entry whose `when` words all appear in the input wins. */
  fixtures?: Record<string, Canned[]>;
  expect: Expectations & {
    /** What a good answer does, for the judge. */
    behavior: string;
    /** Extra criteria for the judge, specific to the case. */
    rubric?: string[];
    /** Standard judge criteria that don't apply here. */
    skipJudge?: string[];
  };
}

// ── One case ─────────────────────────────────────────────────────────────────

const ROLE_PRESETS = ptBR.newAgent.roles as Record<string, { name: string; agent?: string; instructions: string }>;

export function agentOf(c: BehaviorCase, modelOverride?: string) {
  const preset = c.agent.preset ? ROLE_PRESETS[c.agent.preset] : undefined;
  if (c.agent.preset && !preset) throw new Error(`${c.id}: unknown preset ${c.agent.preset}`);
  const name = c.agent.name ?? preset?.agent ?? "Agente";
  return {
    name,
    handle: (c.agent.handle ?? name).toLowerCase(),
    role: c.agent.role ?? preset?.name ?? "",
    instructions: c.agent.instructions ?? preset?.instructions ?? "",
    model: modelOverride ?? c.agent.model ?? "claude-sonnet-5-5",
  };
}

export interface CaseRun {
  turns: EvalTurn[];
  calls: EvalToolCall[];
  reply: string;
  noReply: boolean;
  approvals: string[];
  status: string[];
  system: string;
  costNanoUsd: number;
  /** Handles of the other agents the trigger started. */
  triggered: string[];
  /** Receipt kinds on the run's messages (act with undo). */
  receipts?: string[];
  /** What the person sees besides the reply: the cards the run posted (a mission proposal's findings and plan). */
  cards?: string;
  /** The tools the agent had (names). */
  tools?: string[];
  /** The agent's model calls and their tokens (`input`: uncached; the prompt is input + cacheRead + cacheWrite). */
  tokens?: { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number };
  /** Tools on demand: the run's choice (`context` step). */
  toolGroups?: unknown;
  /** The cheap model's structured answers during the run (addressees), for the report. */
  classifier?: string[];
  error?: string;
}

/** Records the model's turns of a run (what it wrote and called), passing everything through. */
function recording(provider: ModelProvider) {
  const turns: (EvalTurn & { request: ModelRequest })[] = [];
  /** Structured answers (the addressee classifier), for the report. */
  const structured: string[] = [];
  const wrapped: ModelProvider = {
    id: provider.id,
    async stream(request, options) {
      const result = await provider.stream(request, options);
      // Structured calls (the addressee classifier) are not the agent's turns.
      if (request.outputSchema) {
        structured.push(`${JSON.stringify(request.messages).slice(0, 1500)} → ${result.text}`);
        return result;
      }
      turns.push({
        request,
        text: result.text,
        toolCalls: result.content
          .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => ({ name: b.name, input: b.input })),
      });
      return result;
    },
    ...(provider.countTokens ? { countTokens: provider.countTokens.bind(provider) } : {}),
  };
  return { provider: wrapped, turns, structured };
}

async function addPerson(db: Awaited<ReturnType<typeof createTestDatabase>>["db"], name: string) {
  const id = `user_${name.toLowerCase().replace(/\W+/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(schema.users).values({ id, name, email: `${id}@example.com` });
  return { id, name };
}

export interface RunOptions {
  /** The provider key the agent's credential holds (any string with the fake provider). */
  apiKey: string;
  /** The real Anthropic provider, or the fake one in tests. */
  provider: ModelProvider;
  maxToolTurns: number;
  /** Overrides every case's agent model. */
  agentModel?: string;
  /** TypeSafe key: the addressee classification uses Jev like production (the cheap model only without it). */
  jevKey?: string;
  /**
   * Tools on demand (D65) as in production: the run lists the core tools and the groups Jev expects
   * (only that judgment is Jev's; the others stay fake). Without `jevKey` the run gets the core tools.
   */
  toolsOnDemand?: boolean;
}

/** Runs one case through the engine on a fresh in-memory database. */
export async function runCase(c: BehaviorCase, options: RunOptions): Promise<CaseRun> {
  const { apiKey, maxToolTurns } = options;
  const { db, close } = await createTestDatabase();
  try {
    const keyWrapper = createLocalKeyWrapper(crypto.randomUUID().repeat(2));
    const conv = c.conversation;
    const personNames = [
      ...new Set([conv.trigger, ...(conv.prior ?? [])].map((m) => m.author).filter((a) => a !== "agent")),
    ];
    const ownerName = conv.trigger.author !== "agent" ? conv.trigger.author : (personNames[0] ?? "Marina");
    const owner = await addPerson(db, ownerName);
    const { organization: org } = await createOrganization(db, owner.id, c.org);
    const people = new Map([[ownerName, owner]]);
    for (const name of personNames.filter((n) => n !== ownerName)) {
      const p = await addPerson(db, name);
      await db.insert(schema.organizationMembers).values({ orgId: org.id, userId: p.id, role: "member" });
      people.set(name, p);
    }
    const credential = await createCredential(db, keyWrapper, owner.id, org.id, {
      provider: "anthropic",
      label: "eval",
      apiKey,
      makeDefault: true,
    });
    const a = agentOf(c, options.agentModel);
    const agent = await createAgent(
      db,
      owner.id,
      org.id,
      { name: a.name, handle: a.handle, role: a.role, instructions: a.instructions, credentialId: credential.id },
      { model: a.model },
    );

    // Tools: the fake connectors, the real built-ins (memory and search, issues, ask_user, react).
    const fakes: { source: ToolSource; executed: { name: string }[] }[] = (c.connectors ?? []).map((id) =>
      fakeConnectorSource(id, c.fixtures ?? {}),
    );
    await grantScopes(
      db,
      org.id,
      agent.id,
      [
        ...(c.connectors ?? []).flatMap((id) => [...new Set(CONNECTORS[id].map((t) => t.scope))]),
        ...(c.issues ? ["issues:read", "issues:write"] : []),
      ].map((scope) => ({ connectionId: null, scope })),
    );

    const recorder = recording(options.provider);
    const pubsub = createMemoryPubSub();
    const gateway = createModelGateway({
      db,
      keyWrappers: [keyWrapper],
      providers: { anthropic: recorder.provider },
      platformCredentials: noPlatformCredentials,
    });
    const search = createPostgresSearchResolver(db);
    const context: ContextDeps = {
      db,
      gateway,
      search,
      summaryModel: "claude-haiku-5-5",
      pubsub,
      // No reflection or summaries during the eval: only the agent's own calls cost.
      reflect: { everyMessages: 100_000, idleMinutes: 100_000, maxPerThread: 1 },
      judge: createFakeJudge(),
      // Schedule phrases of the seeded routines (a table, not a model).
      schedules: createFakeScheduleReader({
        "a cada hora": { rule: { freq: "hourly", times: ["00:00"] } },
        "dias úteis às 9h": { rule: { freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["09:00"] } },
      }),
    };
    const sources: ToolSource[] = [
      createAskUserToolSource(),
      ...(c.schedule ? [createAskAgentToolSource({ pubsub }), createScheduleToolSource({ pubsub, context })] : []),
      createReactToolSource({ pubsub }),
      createContextToolSource(context),
      ...(c.issues ? [createIssueToolSource({ db, pubsub })] : []),
      ...(c.workspace ? [createWorkspaceToolSource({ pubsub })] : []),
      ...(c.missions ? [fakeMissionSource().source] : []),
      ...fakes.map((f) => f.source),
    ];
    const tools = createToolGateway({ sources });
    if (options.toolsOnDemand && options.jevKey) {
      const jev = createJevJudge({ apiKey: options.jevKey, gateway, timeoutMs: 5000 });
      const fake = context.judge as Judge;
      context.judge = { name: "eval", ask: (r) => (r.kind === "tool_groups" ? jev : fake).ask(r) };
    }
    const handlers = createJobHandlers({
      db,
      gateway,
      pubsub,
      maxOutputTokens: 16_000,
      contextMessages: 30,
      maxHops: 3,
      maxToolTurns,
      deltaFlushMs: 0,
      tools,
      context,
      search,
      toolsOnDemand: options.toolsOnDemand ?? false,
    });

    // The conversation.
    let channelId: string;
    if (conv.where === "dm") {
      channelId = (await openDm(db, owner.id, org.id, { agentId: agent.id })).id;
    } else {
      const channel = await createChannel(db, owner.id, org.id, { name: conv.channel ?? "geral", topic: conv.topic });
      channelId = channel.id;
      await addChannelMember(db, owner.id, org.id, channelId, { agentId: agent.id });
      for (const [name, p] of people)
        if (name !== ownerName) await addChannelMember(db, owner.id, org.id, channelId, { userId: p.id });
    }
    const others = new Map<string, string>();
    for (const o of c.otherAgents ?? []) {
      const other = await createAgent(
        db,
        owner.id,
        org.id,
        {
          name: o.name,
          handle: o.handle,
          role: o.role ?? "",
          instructions: o.instructions ?? "",
          credentialId: credential.id,
        },
        { model: a.model },
      );
      others.set(other.id, o.handle);
      if (conv.where === "channel") await addChannelMember(db, owner.id, org.id, channelId, { agentId: other.id });
    }
    const agentIdOf = (handle: string) =>
      handle === "self" ? agent.id : [...others].find(([, h]) => h === handle.replace(/^@/, ""))?.[0];
    for (const r of c.routines ?? []) {
      const agentId = agentIdOf(r.agent);
      if (!agentId) throw new Error(`${c.id}: no agent ${r.agent} for routine "${r.name}"`);
      await createRoutine({ db, pubsub, context }, owner.id, org.id, {
        name: r.name,
        agentId,
        prompt: r.prompt,
        target: { type: "channel", channelId },
        trigger: { type: "schedule", phrase: r.schedule, timezone: "America/Sao_Paulo" },
      });
    }
    for (const m of c.memory ?? []) {
      await insertContextItem(db, {
        orgId: org.id,
        kind: m.kind ?? "note",
        scopeType: "agent",
        scopeId: agent.id,
        agentId: agent.id,
        title: m.title,
        content: m.content,
        channelIds: [channelId],
        createdByKind: "agent",
        createdById: agent.id,
      });
    }
    for (const issue of c.seedIssues ?? []) {
      await createIssue({ db, pubsub }, { type: "person", userId: owner.id }, org.id, { ...issue, channelId });
    }
    const author = (m: CaseMessage) =>
      m.author === "agent"
        ? ({ type: "agent", agentId: agent.id, runId: null, hop: 0 } as const)
        : ({ type: "person", userId: (people.get(m.author) ?? owner).id } as const);
    let threadId: string | null = null;
    for (const m of conv.prior ?? []) {
      const msg = await insertMessage(db, {
        orgId: org.id,
        channelId,
        threadId,
        author: author(m),
        body: m.body,
        meta: m.meta,
      });
      if (conv.thread && conv.where === "channel" && !threadId) threadId = msg.id;
    }
    // History only: earlier messages start no runs (their routing jobs go), but they are indexed for search.
    await db.delete(schema.outbox).where(eq(schema.outbox.kind, "message.posted"));
    await drainOutbox(db, handlers);
    recorder.turns.length = 0;

    const triggerAuthor = people.get(conv.trigger.author) ?? owner;
    const routine = conv.routine
      ? { routine: { id: crypto.randomUUID(), name: conv.routine.name, runId: crypto.randomUUID() } }
      : undefined;
    let askerRunId: string | null = null;
    if (conv.consultation) {
      // Another agent asks this one on the person's behalf: the person's message, the asking
      // agent's run on it, and its `ask_agent` call (the real tool: DM, question, consultation).
      const askerId = agentIdOf(conv.consultation.from);
      if (!askerId) throw new Error(`${c.id}: no agent ${conv.consultation.from} to ask`);
      const origin = await insertMessage(db, {
        orgId: org.id,
        channelId,
        threadId,
        author: { type: "person", userId: triggerAuthor.id },
        body: conv.consultation.origin,
      });
      const [asker] = await db
        .insert(schema.agentRuns)
        .values({
          orgId: org.id,
          agentId: askerId,
          channelId,
          threadRootId: threadId ?? origin.id,
          triggerMessageId: origin.id,
          trigger: "mention",
          hop: 1,
          status: "running",
        })
        .returning();
      if (!asker) throw new Error(`${c.id}: could not start the asking run`);
      askerRunId = asker.id;
      const ask = (await createAskAgentToolSource({ pubsub }).tools({} as never))[0];
      const asked = await ask?.execute(
        { agent: `@${agent.handle}`, question: conv.trigger.body },
        {
          db,
          orgId: org.id,
          agentId: askerId,
          runId: asker.id,
          channelId,
          threadRootId: asker.threadRootId,
          triggerMessageId: origin.id,
        },
      );
      if (asked?.isError) throw new Error(`${c.id}: ask_agent refused: ${asked.content}`);
    } else {
      // Same judge as production (apps/server/src/engine.ts): Jev, the cheap model as fallback.
      const llmJudge = createLlmJudge({ gateway, resolveModel: async () => "claude-haiku-5-5" });
      const judge = c.addressees
        ? options.jevKey
          ? withJudgeFallback(createJevJudge({ apiKey: options.jevKey, gateway, timeoutMs: 5000 }), llmJudge)
          : llmJudge
        : undefined;
      await postPersonMessage({ db, pubsub, judge }, triggerAuthor.id, org.id, channelId, {
        body: conv.trigger.body,
        threadId,
        meta: routine,
      });
    }
    // Other agents' runs: recorded (who the trigger started), never executed.
    const otherRuns = others.size
      ? await db
          .select({ id: schema.agentRuns.id, agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.orgId, org.id), inArray(schema.agentRuns.agentId, [...others.keys()])))
      : [];
    const triggered = [
      ...new Set(otherRuns.filter((r) => r.id !== askerRunId).map((r) => others.get(r.agentId) ?? "")),
    ].filter(Boolean);
    for (const r of otherRuns) {
      await db
        .delete(schema.outbox)
        .where(and(eq(schema.outbox.kind, "agent_run.execute"), sql`${schema.outbox.payload}->>'runId' = ${r.id}`));
    }
    await drainOutbox(db, handlers, { maxBatches: 500 });

    // What happened.
    const runs = await db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, org.id), eq(schema.agentRuns.agentId, agent.id)))
      .orderBy(asc(schema.agentRuns.createdAt));
    const runIds = runs.map((r) => r.id);
    const steps = runIds.length
      ? await db
          .select()
          .from(schema.agentRunSteps)
          .where(inArray(schema.agentRunSteps.runId, runIds))
          .orderBy(asc(schema.agentRunSteps.createdAt), asc(schema.agentRunSteps.seq))
      : [];
    const results = new Map(
      steps.filter((s) => s.kind === "tool_result").map((s) => [String(s.data.toolUseId), s.data] as const),
    );
    const calls: EvalToolCall[] = steps
      .filter((s) => s.kind === "tool_call")
      .map((s) => {
        const r = results.get(String(s.data.toolUseId)) as { isError?: boolean; content?: string } | undefined;
        const refused = r?.isError && /^(Not allowed|Invalid input|Unknown tool)/.test(r.content ?? "");
        return {
          name: String(s.data.name),
          input: (s.data.input ?? {}) as Record<string, unknown>,
          executed: Boolean(r) && !refused,
          isError: r?.isError === true,
          result: r?.content,
        };
      });
    const approvals = runIds.length
      ? (
          await db
            .select({ tool: schema.approvals.tool })
            .from(schema.approvals)
            .where(inArray(schema.approvals.runId, runIds))
        ).map((r) => r.tool)
      : [];
    const posted = runIds.length
      ? await db
          .select({ body: schema.messages.body })
          .from(schema.messages)
          .where(and(eq(schema.messages.orgId, org.id), inArray(schema.messages.agentRunId, runIds)))
          .orderBy(asc(schema.messages.createdAt))
      : [];
    const u = schema.usageRecords;
    const [usage] = await db
      .select({ cost: sql<number>`coalesce(sum(${u.costNanoUsd}), 0)::bigint` })
      .from(u)
      .where(eq(u.orgId, org.id));
    // The agent's own model calls (tools on demand: what each call carries).
    const [tokens] = await db
      .select({
        calls: sql<number>`count(*)::int`,
        input: sql<number>`coalesce(sum(${u.inputTokens}), 0)::int`,
        cacheRead: sql<number>`coalesce(sum(${u.cacheReadTokens}), 0)::int`,
        cacheWrite: sql<number>`coalesce(sum(${u.cacheWriteTokens}), 0)::int`,
        output: sql<number>`coalesce(sum(${u.outputTokens}), 0)::int`,
      })
      .from(u)
      .where(and(eq(u.orgId, org.id), eq(u.kind, "agent")));
    const contextStep = steps.find((s) => s.kind === "context");
    // Act with undo: the receipts the run's messages carry.
    const receipts = runIds.length
      ? (
          await db
            .select({ kind: schema.agentActions.kind })
            .from(schema.agentActions)
            .where(and(inArray(schema.agentActions.runId, runIds), sql`${schema.agentActions.messageId} is not null`))
        ).map((r) => r.kind)
      : [];
    const turns = recorder.turns.map(({ text, toolCalls }) => ({ text, toolCalls }));
    const cards = calls
      .filter((t) => t.name === "propose_mission" && t.executed && !t.isError)
      .map((t) => missionCard(t.input))
      .join("\n\n");
    const last = turns.at(-1);
    return {
      turns,
      calls,
      reply: posted.map((m) => m.body).join("\n\n"),
      noReply: Boolean(last && isNoReply(last.text)),
      approvals,
      status: runs.map((r) => (r.error ? `${r.status} (${r.error})` : r.status)),
      system: recorder.turns[0] ? systemText(recorder.turns[0].request.system) : "",
      costNanoUsd: Number(usage?.cost ?? 0),
      triggered,
      receipts,
      ...(cards ? { cards } : {}),
      tools: (recorder.turns[0]?.request.tools ?? []).map((t) => t.name),
      tokens: {
        calls: Number(tokens?.calls ?? 0),
        input: Number(tokens?.input ?? 0),
        cacheRead: Number(tokens?.cacheRead ?? 0),
        cacheWrite: Number(tokens?.cacheWrite ?? 0),
        output: Number(tokens?.output ?? 0),
      },
      ...(contextStep?.data.toolGroups ? { toolGroups: contextStep.data.toolGroups } : {}),
      ...(recorder.structured.length ? { classifier: [...recorder.structured] } : {}),
    };
  } finally {
    await close();
  }
}

/** A mission proposal as its card shows it (goal, findings, plan). */
function missionCard(input: Record<string, unknown>) {
  const findings = Array.isArray(input.findings) ? (input.findings as { kind?: unknown; text?: unknown }[]) : [];
  const plan = Array.isArray(input.plan) ? input.plan.map(String) : [];
  return [
    `Mission card: ${String(input.title ?? "")}`,
    `Goal: ${String(input.goal ?? "")}`,
    ...findings.map((f) => `- [${String(f.kind ?? "")}] ${String(f.text ?? "")}`),
    ...(plan.length ? ["Plan:", ...plan.map((x, i) => `${i + 1}. ${x}`)] : []),
  ].join("\n");
}

// ── The judge ────────────────────────────────────────────────────────────────

const STANDARD_CRITERIA: Record<string, string> = {
  looked_first:
    "Before answering, the agent looked at the real sources with its tools (code, errors, analytics, issues, memory) instead of answering from assumptions or replying with a plan made without looking.",
  grounded:
    "What it says about code, data or errors is backed by what the tools returned (file and line, numbers, ids, links). Nothing is invented or contradicts the tool results, and it never says it lacks access to something a tool returned.",
  next_step:
    "It ends with a concrete next step it takes or offers (e.g. 'abro um PR que muda X no arquivo Y', an issue created or to create, a specific action), not a vague 'let me know' or a list of generic ideas.",
  talks_like_a_colleague:
    "The reply reads like a colleague writing in the team chat: plain sentences in short paragraphs (no headings or bold; a list only for several items of the same kind), the people, places, times and versions in the data named as they are (not 'a user'), news put against what came before (new, same pattern, how many so far), and no ritual opening or closing ('I remain available', 'let me know if you need anything', 'hope this helps').",
  asks_well:
    "It does not ask permission to look and does not ask for information its tools could find. It asks only for decisions that are really the person's (product choice, priority) or before a sensitive action, and then one focused question. Internal changes it can undo (issues, priority, assignee, routines, memory) are expected without asking (ADR 0037): doing them is not a fault.",
};

interface JudgeVerdict {
  criteria: { id: string; pass: boolean; reason: string }[];
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface JudgeOptions {
  apiKey: string;
  provider: ModelProvider;
  model: string;
  agentModel?: string;
  /** Grade with Jev (TypeSafe): a calibrated probability per criterion, no written reason. */
  jev?: { apiKey: string; fetch?: typeof fetch };
}

/** Jev says a criterion holds at this probability or above. */
export const JEV_PASS = 0.5;

/** Grades a run against the standard criteria and the case's rubric (one structured-output call). */
export async function judge(c: BehaviorCase, run: CaseRun, options: JudgeOptions) {
  const { apiKey, provider, model: judgeModel } = options;
  const criteria = Object.entries(STANDARD_CRITERIA)
    .filter(([id]) => !(c.expect.skipJudge ?? []).includes(id))
    .filter(([id]) => id !== "looked_first" || c.expect.investigate)
    .filter(([id]) => id !== "talks_like_a_colleague" || c.expect.noReply !== true)
    .map(([id, text]) => ({ id, text }));
  for (const [i, text] of (c.expect.rubric ?? []).entries()) criteria.push({ id: `case_${i + 1}`, text });
  if (criteria.length === 0) return { checks: [] as CheckResult[], costNanoUsd: 0 };
  const a = agentOf(c, options.agentModel);
  const conversation = [...(c.conversation.prior ?? []), c.conversation.trigger]
    .map((m) => `[${m.author === "agent" ? a.name : m.author}]: ${m.body}`)
    .join("\n");
  const toolLines = run.calls.length
    ? run.calls
        .map(
          (t, i) =>
            `${i + 1}. ${t.name}(${clip(JSON.stringify(t.input), 1500)}) → ${
              t.executed
                ? // Whole files: the judge checks line citations against what the agent read.
                  clip(t.result ?? "(no output)", 6000)
                : run.approvals.includes(t.name)
                  ? "held for a person's approval"
                  : t.result
                    ? `refused: ${clip(t.result, 300)}`
                    : "not run"
            }`,
        )
        .join("\n")
    : "(no tool calls)";
  const prompt = [
    `# Case: ${c.title}`,
    `Agent: ${a.name}, ${a.role}. Where: ${c.conversation.where === "dm" ? "a DM" : `#${c.conversation.channel ?? "geral"}`}${c.conversation.routine ? ` (routine run: "${c.conversation.routine.name}")` : ""}.`,
    `# Conversation (last line is the message the agent answered)\n${conversation}`,
    `# What the agent already had in its prompt\nOrganization context: ${c.org.context}${
      c.memory?.length
        ? `\nIts memory:\n${c.memory.map((m) => `- [${m.kind ?? "note"}] ${m.title ? `${m.title}: ` : ""}${m.content}`).join("\n")}`
        : ""
    }`,
    `# The agent's tools\n${run.tools?.length ? run.tools.join(", ") : "(unknown)"} (it can't read what none of these covers)`,
    `# What a good answer does\n${c.expect.behavior}`,
    `# The agent's tool calls, in order\n${toolLines}`,
    `# The agent's reply in the chat\n${run.noReply ? "(stayed silent: NO_REPLY)" : run.reply.trim() || "(nothing posted)"}`,
    ...(run.cards ? [`# Cards posted with the reply (the person sees them under it)\n${run.cards}`] : []),
  ];
  if (options.jev) return judgeWithJev(c, criteria, prompt.join("\n\n"), options.jev);
  prompt.push(`# Criteria\n${criteria.map((k) => `- ${k.id}: ${k.text}`).join("\n")}`);
  const result = await provider.stream(
    {
      model: judgeModel,
      system:
        "You grade how an AI agent behaved in a team chat (agentes.chat), where agents have tools and are expected to investigate before answering. Grade each criterion strictly against the transcript: pass only if the reply clearly meets it. When a criterion does not apply to this case (e.g. nothing needed asking), it passes. Give a one-sentence reason quoting the reply when useful.",
      messages: [{ role: "user", content: prompt.join("\n\n") }],
      maxTokens: 1500,
      outputSchema: {
        type: "object",
        properties: {
          criteria: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", enum: criteria.map((k) => k.id) },
                // Reason first, then the verdict (it follows the reasoning).
                reason: { type: "string" },
                pass: { type: "boolean" },
              },
              required: ["id", "reason", "pass"],
              additionalProperties: false,
            },
          },
        },
        required: ["criteria"],
        additionalProperties: false,
      },
    },
    { apiKey, onDelta: () => {} },
  );
  const verdict = JSON.parse(result.text) as JudgeVerdict;
  const checks = criteria.map((k): CheckResult => {
    const v = verdict.criteria.find((x) => x.id === k.id);
    return {
      id: `judge:${k.id}`,
      pass: v?.pass === true,
      detail: v ? v.reason : "the judge gave no verdict",
    };
  });
  return { checks, costNanoUsd: costNanoUsd(judgeModel, result.usage) };
}

/**
 * The grading on Jev: one yes/no question per criterion over the transcript, answered
 * with a calibrated probability (no written reason: the detail shows it).
 */
async function judgeWithJev(
  c: BehaviorCase,
  criteria: { id: string; text: string }[],
  transcript: string,
  jev: { apiKey: string; fetch?: typeof fetch },
) {
  let costNanoUsd = 0;
  const judge = createJevJudge({
    apiKey: jev.apiKey,
    timeoutMs: 30_000,
    ...(jev.fetch ? { fetch: jev.fetch } : {}),
    gateway: {
      async recordExternalUsage(u) {
        costNanoUsd += u.costNanoUsd;
        return null;
      },
    },
  });
  const answers = await judge.ask({
    orgId: "eval",
    kind: "behavior_eval",
    state: { case: c.title, transcript },
    questions: Object.fromEntries(
      criteria.map((k) => [
        k.id,
        {
          type: "noul" as const,
          instructions: `You grade how an AI agent behaved in a team chat, from \`transcript\` (its tool calls with results, and its reply). Does the agent's behavior meet this criterion? ${k.text} Grade strictly: it holds only if the reply and tool calls clearly meet it. A criterion that does not apply to this case holds.`,
          criteria: { true: "The agent meets the criterion.", false: "The agent does not meet the criterion." },
        },
      ]),
    ),
  });
  const checks = criteria.map((k): CheckResult => {
    const p = answers[k.id]?.noul ?? 0;
    return { id: `judge:${k.id}`, pass: p >= JEV_PASS, detail: `Jev p=${p.toFixed(2)}` };
  });
  return { checks, costNanoUsd };
}
