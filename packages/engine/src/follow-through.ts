import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gt, isNull, schema, sql } from "@agenteschat/db";
import { requireChannelAccess } from "./channels";
import { getChannelCached } from "./context";
import { publishDelivery } from "./delivery";
import { isAgentOnlyDm } from "./dms";
import { ConflictError, NotFoundError } from "./errors";
import { publishMessageCreated } from "./events";
import type { Judge } from "./judge";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import { enqueue } from "./outbox";
import { deliverNoticeToRun, NOTICE_WAKE_MAX_HOP } from "./run-resume";
import { type AgentRun, replyThreadOf } from "./runs";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

/**
 * Agents follow through (ADR 0037, round 3): a run that ends right after a decision without a word gets
 * one more turn with the result (`decisionNudge`); a run whose last message promises more that nothing
 * keeps is caught by one judge call (`promiseIn`, `followThroughVerdict`) and told once to keep it
 * (`followThroughNudge`); and an agent comes back to a conversation by itself (`follow_up`): a notice
 * line there now, and at its time a notice that wakes the agent in that conversation (`wakeFollowUp`).
 */

const { agentRuns, messages } = schema;

export const FOLLOW_UP_TOOL = "follow_up";
export const CANCEL_FOLLOW_UP_TOOL = "cancel_follow_up";
/** The outbox job that wakes the agent at a follow-up's time. */
export const FOLLOW_UP_JOB = "agent.follow_up";
/** How far ahead one goes, how many one run sets, how many wait at once in one conversation. */
export const FOLLOW_UP_LIMITS = { maxMinutes: 24 * 60, perRun: 2, perConversation: 3 } as const;

export type FollowUpState = "pending" | "done" | "canceled";

const str = (v: unknown) => (typeof v === "string" ? v : "");

// ── After a decision ─────────────────────────────────────────────────────────

/** What a run reads when it ended its turn right after a decision without telling anyone what came of it. */
export const decisionNudge = (decided: string) =>
  [
    "A person decided what you were waiting on, and you ended your turn without telling them anything. What they decided and what came back:",
    decided,
    "Go on with the task with this result now (call the tools you need), then tell them the outcome. If the result isn't what you needed (empty, a placeholder, an error), say so and what you'll do instead.",
  ].join("\n");

// ── Promises at the end of a run ─────────────────────────────────────────────

/**
 * Words that promise more work by the agent itself (English, Portuguese, Spanish), looked for at the end of
 * its last message: only then is the judge asked. A miss costs a nudge, a false hit one cheap judge call.
 */
const PROMISE =
  /\b(?:i['’]ll|i will|i['’]m going to|i am going to|will (?:update you|report back|let you know|get back to you)|vou\s|volto\b|te (?:aviso|falo|conto|mando|passo|retorno)|(?:eu )?aviso (?:quando|assim)|assim que (?:terminar|acabar|sair|ficar)|quando (?:terminar|acabar|ficar pronto|sair o)|fico de olho|voy a\s|te (?:cuento|paso)|cuando termine)/i;

/** How much of the end of the message is read for a promise (the start is the answer itself). */
const PROMISE_TAIL = 600;

/** The sentence of the reply's end that promises more ("When you approve, I'll give you the numbers"), or null. */
export function promiseIn(reply: string): string | null {
  const tail = reply.trim().slice(-PROMISE_TAIL);
  const m = PROMISE.exec(tail);
  if (!m) return null;
  const start = Math.max(...[".", "!", "?", "\n"].map((c) => tail.lastIndexOf(c, m.index))) + 1;
  const rest = tail.slice(m.index).search(/[.!?\n]/);
  const end = rest < 0 ? tail.length : m.index + rest + 1;
  return tail.slice(start, end).trim().slice(0, 300) || null;
}

export type FollowThroughVerdict = "done" | "waiting" | "unkept";

/**
 * One judge call on a run's last message: it finished, it waits on a person for something specific
 * (legitimate), or it stopped with a promise or work left that nothing will bring it back to.
 */
export async function followThroughVerdict(
  judge: Judge,
  input: { orgId: string; agentId: string; runId: string; request: string; reply: string },
): Promise<FollowThroughVerdict> {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "follow_through",
    state: { request: input.request.slice(0, 2000), reply: input.reply.slice(-3000) },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "An AI agent in a team chat was asked `request` and ended its turn with `reply`, its last message. It won't act again until someone writes to it or something it set up wakes it. Did it finish, does it wait on a person for something specific, or did it stop with work it said it would do still undone?",
        criteria: {
          done: "The reply gives the result or the answer, or says plainly what it couldn't do. Offers that wait for a yes ('want me to…?', 'if you want, I can…') and 'let me know if…' count as done.",
          waiting:
            "To go on it needs something specific from a person (a decision, an answer, an approval, access, a file) and asks for it, or an approval card it asked for will wake it.",
          unkept:
            "It says it will do more itself, later or next (check again, send the numbers, report when something finishes, continue after a build or an approval), but it stopped without doing it and nothing it set up brings it back.",
        },
      },
    },
  });
  const a = answers.verdict;
  const unkept = a?.probabilities?.unkept ?? (a?.choice === "unkept" ? 1 : 0);
  if (unkept >= 0.6) return "unkept";
  return a?.choice === "waiting" ? "waiting" : "done";
}

/** What a run reads, once, when its last message promised more and nothing keeps that promise. */
export const followThroughNudge = (promise: string) =>
  `You ended with a promise nothing keeps: "${promise}". Do it now with your tools and tell them what came of it. If it has to wait (a build, a deploy, a job still running), set a follow_up to come back to it and say when, in one line.`;

// ── Coming back by itself (`follow_up`) ──────────────────────────────────────

/** A follow-up notice's refs: the run that set it, when, the people's words for it, and its state. */
const refsOf = (m: Pick<Message, "meta">) =>
  ((m.meta.notice as { refs?: Record<string, string> } | undefined)?.refs ?? {}) as Record<string, string>;

const isFollowUpLine = (m: Pick<Message, "meta">) =>
  (m.meta.notice as { kind?: unknown } | undefined)?.kind === "follow_up" && !refsOf(m).wake;

/** The follow-ups still waiting in a run's conversation (all set in the last day: none goes further ahead). */
async function pendingFollowUps(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId">,
) {
  const threadId = replyThreadOf(run);
  return db
    .select({ id: messages.id, runId: sql<string>`${messages.meta}->'notice'->'refs'->>'runId'` })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        threadId ? eq(messages.threadId, threadId) : isNull(messages.threadId),
        eq(messages.authorAgentId, run.agentId),
        isNull(messages.deletedAt),
        gt(messages.createdAt, new Date(Date.now() - (FOLLOW_UP_LIMITS.maxMinutes + 60) * 60_000)),
        sql`${messages.meta}->'notice'->>'kind' = 'follow_up'`,
        sql`${messages.meta}->'notice'->'refs'->>'state' = 'pending'`,
      ),
    );
}

/** Whether this run set a follow-up that hasn't come yet (it keeps the run's promise). */
export async function runHasFollowUp(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId">,
) {
  return (await pendingFollowUps(db, run)).some((f) => f.runId === run.id);
}

/** Moves a pending follow-up line to `state`; null when it isn't pending anymore. */
async function settle(tx: Executor, line: Pick<Message, "id" | "orgId">, state: FollowUpState, by?: string) {
  const patch = JSON.stringify({ state, ...(by ? { canceledBy: by } : {}) });
  const [row] = await tx
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{notice,refs}', coalesce(${messages.meta}->'notice'->'refs', '{}'::jsonb) || ${patch}::jsonb)`,
    })
    .where(
      and(
        eq(messages.orgId, line.orgId),
        eq(messages.id, line.id),
        sql`${messages.meta}->'notice'->'refs'->>'state' = 'pending'`,
      ),
    )
    .returning();
  return row ?? null;
}

const refused = (content: string): ToolOutput => ({ content, isError: true });

/** The line shows up, or changes in place (the apps replace a message they have by its id). */
const publishLine = async (pubsub: PubSub | undefined, line: Message) => {
  if (pubsub) await publishMessageCreated(pubsub, messageView(line));
};

/** The run a tool call belongs to: a conversation's run, never a routine's background work or a mission task. */
async function conversationRun(ctx: ToolContext) {
  if (!ctx.runId || ctx.background || ctx.bridge?.taskId) return null;
  const [run] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.agentId, ctx.agentId)));
  return run && !run.background ? run : null;
}

/**
 * `follow_up` and `cancel_follow_up`, for every agent (no scope; routines' background runs are refused by
 * the run policy: they run again on their own schedule). Setting one posts its line in the run's
 * conversation (a `follow_up` notice that wakes nobody, `refs.state` `pending`) and queues the job that
 * wakes the agent there at its time (`wakeFollowUp`).
 */
export function createFollowUpToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const tools: ToolDefinition[] = [
    {
      name: FOLLOW_UP_TOOL,
      description:
        'Come back to this conversation by yourself later: at that time you are woken here with your note and the conversation, to do the work and tell the people (check a CI run or a deploy again, send the numbers once a job ends). Use it instead of promising to come back. `minutes` from now, or `at` (ISO 8601 with its offset), at most 24 hours ahead. `note`: what to do then, for yourself. `about`: a few words in the people\'s language for the line they see ("ver o CI", "check the deploy"). Then tell them in a line when you\'ll be back.',
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          minutes: { type: "integer", minimum: 1, maximum: FOLLOW_UP_LIMITS.maxMinutes },
          at: { type: "string", minLength: 10, maxLength: 40 },
          note: { type: "string", minLength: 1, maxLength: 1000 },
          about: { type: "string", minLength: 1, maxLength: 80 },
        },
        required: ["note", "about"],
        additionalProperties: false,
      },
      describe: (input) => ({ title: `Follow up: ${str(input.about)}` }),
      async execute(input, ctx) {
        const run = await conversationRun(ctx);
        if (!run) return refused("Only a conversation's run can come back to it.");
        const channel = await getChannelCached(ctx.db, run.orgId, run.channelId);
        if (channel && isAgentOnlyDm(channel))
          return refused("Answer the agent that asked now: no person reads this conversation to come back to.");
        // Each follow-up wakes a run one hop further (`deliverNoticeToRun`): past the cap it would wake nobody.
        if (run.hop >= NOTICE_WAKE_MAX_HOP)
          return refused(
            "No more follow-ups from here: you already came back several times in a row. Tell the people what is left and stop.",
          );
        const now = Date.now();
        const given = str(input.at).trim();
        const due = given ? Date.parse(given) : now + Number(input.minutes ?? 0) * 60_000;
        if (!Number.isFinite(due) || (!given && !input.minutes))
          return refused("Say when: `minutes` from now, or `at` as an ISO 8601 time with its offset.");
        if (due < now + 30_000) return refused("That time has passed: pick one at least a minute ahead.");
        if (due > now + FOLLOW_UP_LIMITS.maxMinutes * 60_000)
          return refused("At most 24 hours ahead. For later or recurring checks, ask the person for a routine.");
        const note = str(input.note).trim();
        const about = str(input.about).trim();
        const at = new Date(due).toISOString();
        const line = await ctx.db.transaction(async (tx) => {
          const pending = await pendingFollowUps(tx, run);
          if (pending.filter((p) => p.runId === run.id).length >= FOLLOW_UP_LIMITS.perRun) return "run" as const;
          if (pending.length >= FOLLOW_UP_LIMITS.perConversation) return "conversation" as const;
          const message = await insertMessage(tx, {
            orgId: run.orgId,
            channelId: run.channelId,
            threadId: replyThreadOf(run),
            author: { type: "agent", agentId: run.agentId, runId: null, hop: run.hop },
            body: note,
            meta: {
              notice: { kind: "follow_up", text: note, refs: { runId: run.id, at, about, state: "pending" } },
            },
          });
          await enqueue(tx, {
            orgId: run.orgId,
            kind: FOLLOW_UP_JOB,
            payload: { messageId: message.id },
            dedupeKey: `${FOLLOW_UP_JOB}:${message.id}`,
            runAt: new Date(due),
            maxAttempts: 4,
          });
          return message;
        });
        if (line === "run") return refused(`This run already set ${FOLLOW_UP_LIMITS.perRun} follow-ups.`);
        if (line === "conversation")
          return refused(
            `${FOLLOW_UP_LIMITS.perConversation} follow-ups already wait in this conversation: cancel one first (cancel_follow_up) or do it now.`,
          );
        await publishLine(deps.pubsub, line);
        return {
          content: `Follow-up ${line.id} set for ${at}: you'll be woken here then with your note. Tell them in a line when you'll be back.`,
          data: { followUp: { id: line.id, at } },
        };
      },
    },
    {
      name: CANCEL_FOLLOW_UP_TOOL,
      description:
        "Cancel your follow-ups still waiting in this conversation: the one `id` names (from follow_up), or all of them. When the person says there is no need, or it's done already.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", minLength: 36, maxLength: 36 } },
        additionalProperties: false,
      },
      describe: () => ({ title: "Cancel follow-up" }),
      async execute(input, ctx) {
        const run = await conversationRun(ctx);
        if (!run) return refused("Only a conversation's run has follow-ups.");
        const id = str(input.id);
        const pending = (await pendingFollowUps(ctx.db, run)).filter((p) => !id || p.id === id);
        if (pending.length === 0) return refused(id ? "No such follow-up waits here." : "No follow-up waits here.");
        const lines: Message[] = [];
        for (const p of pending) {
          const row = await settle(ctx.db, { id: p.id, orgId: run.orgId }, "canceled", `agent:${run.agentId}`);
          if (row) lines.push(row);
        }
        for (const line of lines) await publishLine(deps.pubsub, line);
        return { content: `Canceled ${lines.length} follow-up${lines.length === 1 ? "" : "s"}.` };
      },
    },
  ];
  return { name: "follow-ups", tools: async () => tools };
}

/**
 * Job `agent.follow_up`: a follow-up's time came. Its line moves to `done` and a `follow_up` notice for the run
 * that set it (`refs.wake`) goes to its conversation: while that run is still active it reads it at its next step,
 * else it starts a run of the agent there (or joins one working for the same person), which reads the note and
 * the conversation since. A canceled or deleted line, or a run that is gone, wakes nobody.
 */
export async function wakeFollowUp(deps: { db: Database; pubsub?: PubSub }, orgId: string, messageId: string) {
  const woke = await deps.db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
      .for("update");
    if (!line || line.deletedAt || !isFollowUpLine(line) || refsOf(line).state !== "pending") return null;
    const refs = refsOf(line);
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, refs.runId ?? "")));
    const settled = await settle(tx, line, run ? "done" : "canceled");
    if (!settled || !run) return settled ? { line: settled, delivered: null } : null;
    const delivered = await deliverNoticeToRun(tx, run, {
      kind: "follow_up",
      text: str((line.meta.notice as { text?: unknown }).text) || line.body,
      refs: { runId: run.id, followUpId: line.id, at: refs.at ?? "", about: refs.about ?? "", wake: "1" },
    });
    return { line: settled, delivered };
  });
  if (!woke) return null;
  await publishLine(deps.pubsub, woke.line);
  if (woke.delivered) await publishDelivery(deps.pubsub, woke.delivered).catch(() => {});
  return woke.delivered?.message ?? null;
}

/** A person cancels a follow-up from its line: anyone who can read the conversation. */
export async function cancelFollowUp(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  messageId: string,
): Promise<void> {
  const line = await getMessage(deps.db, orgId, messageId);
  if (!line || line.deletedAt || !isFollowUpLine(line))
    throw new NotFoundError("Follow-up not found", "follow_up.not_found");
  await requireChannelAccess(deps.db, userId, orgId, line.channelId);
  const row = await settle(deps.db, line, "canceled", userId);
  if (!row) throw new ConflictError("This follow-up already came or was canceled", "follow_up.not_pending");
  await publishLine(deps.pubsub, row);
}
