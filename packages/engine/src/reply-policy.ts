import { and, asc, type Executor, eq, gt, isNull, ne, schema, sql } from "@agenteschat/db";
import type { Message } from "./messages";
import type { AgentRun } from "./runs";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agentRuns, messages, agents, routingDecisions } = schema;

/**
 * Who may stay quiet, and the silence word that is never posted.
 *
 * There is no magic word: a run nobody called by name may `pass` (a tool), and
 * a final text that is only the old sentinel (`NO_REPLY` and its variants) is
 * never posted on any run. A run that was addressed directly and answers only
 * the sentinel is told once to answer the person (`ANSWER_NUDGE`).
 */

/** The word models use for "nothing to say" (routines asked for it; models still write it elsewhere). */
export const NO_REPLY = "NO_REPLY";

/** Name of the built-in tool a run not called by name ends with when it has nothing to add. */
export const PASS_TOOL = "pass";

/** What a run that must answer reads after a reply that was only the sentinel (or nothing). */
export const ANSWER_NUDGE = "You were addressed directly; answer the person.";

/** The prompt block of runs that may pass. */
export const WHY_YOU_WERE_CALLED =
  "# Why you were called\nNobody called you by name; you were brought in because you might have something to add. If you don't, or another agent already answered, call pass: staying quiet in a room is normal. A thanks, an ok or people talking among themselves asks nothing of you: pass at once, without looking anything up and without re-checking an answer already given. Speak only when the message asks something in your area that nobody has answered yet.";

export interface ReplyPolicy {
  /** Nobody called it by name: it may end without a message (`pass`, an empty or sentinel-only answer). */
  mayPass: boolean;
  /** Background work (`agent_runs.background`): its final answer is never posted (`closeRoutineRun`). */
  background: boolean;
}

/**
 * Notices that only inform the agent (ADR 0053 §10): another agent's note, the late result of a wait it
 * stopped waiting on, its own fast reply. The run one of them wakes may stay quiet.
 */
const INFORMING_NOTICES: ReadonlySet<string> = new Set(["agent_note", "wait_result", "talker_reply"]);

/**
 * How a run must answer. Only runs nobody called by name may pass: the router
 * brought them in (a person's message without a mention, or an agent's reply
 * it chimes in on, `meta.joined`), or a notice that only informs woke them
 * (`INFORMING_NOTICES`). Never a mention, a DM, another agent's `ask_agent`
 * consultation (a DM between agents), a forum turn, a routine's call or
 * report, a quote reply to this agent, a router follow-up to the agent the
 * person was talking to, nor a run a person answered or wrote into
 * (`answerOwed`).
 */
export function replyPolicyFor(
  run: Pick<AgentRun, "agentId" | "trigger" | "background">,
  trigger: Pick<Message, "authorType" | "meta"> | null | undefined,
  options: { followUp?: boolean; answerOwed?: boolean } = {},
): ReplyPolicy {
  if (run.background) return { mayPass: false, background: true };
  if (options.answerOwed) return { mayPass: false, background: false };
  const notice = (trigger?.meta?.notice as { kind?: unknown } | undefined)?.kind;
  if (typeof notice === "string" && INFORMING_NOTICES.has(notice)) return { mayPass: true, background: false };
  if (run.trigger !== "router" || options.followUp) return { mayPass: false, background: false };
  const meta = trigger?.meta ?? {};
  if (meta.routine) return { mayPass: false, background: false };
  const replyTo = meta.replyTo as { author?: { type?: unknown; id?: unknown } } | undefined;
  const quotesThisAgent = replyTo?.author?.type === "agent" && replyTo.author.id === run.agentId;
  return { mayPass: !quotesThisAgent, background: false };
}

/**
 * The router's decision for the trigger kept the person with the agent they were talking to
 * (router.ts writes "follow-up" in `routing_decisions.reason`): that agent was addressed.
 */
const followUpSql = sql<boolean>`exists (select 1 from ${routingDecisions} d
  where d.message_id = ${agentRuns.triggerMessageId} and d.reason like '%follow-up%')`;

/** `replyPolicyFor` from the database (the run, its trigger, the router's decision): one read. */
export async function loadReplyPolicy(db: Executor, orgId: string, runId: string): Promise<ReplyPolicy | null> {
  if (!runId) return null;
  const [row] = await db
    .select({
      agentId: agentRuns.agentId,
      trigger: agentRuns.trigger,
      background: agentRuns.background,
      answerOwed: sql<boolean>`coalesce((${agentRuns.transcript} ->> 'answerOwed')::boolean, false)`,
      authorType: messages.authorType,
      meta: messages.meta,
      followUp: sql<boolean>`${agentRuns.trigger} = 'router' and ${followUpSql}`,
    })
    .from(agentRuns)
    .leftJoin(messages, and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId)))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!row) return null;
  return replyPolicyFor(row, row.authorType ? { authorType: row.authorType, meta: row.meta ?? {} } : null, {
    followUp: row.followUp === true,
    answerOwed: row.answerOwed === true,
  });
}

/** Whether the router sent this run's trigger to it as a follow-up of its own conversation. */
export async function routedAsFollowUp(db: Executor, run: Pick<AgentRun, "id" | "trigger">): Promise<boolean> {
  if (run.trigger !== "router") return false;
  const [row] = await db.select({ followUp: followUpSql }).from(agentRuns).where(eq(agentRuns.id, run.id));
  return row?.followUp === true;
}

// ── The sentinel ─────────────────────────────────────────────────────────────

/** Marks and punctuation a model wraps the word in: `NO_REPLY`, **NO_REPLY**, "NO_REPLY.", [NO_REPLY]. */
const EDGE = /^[\s`*_~"'“”‘’()[\]{}<>.,!?:;#|-]+|[\s`*_~"'“”‘’()[\]{}<>.,!?:;#|-]+$/g;
const core = (s: string) => s.replace(EDGE, "");
/** The word alone, in any case and spelling the models use (not "No reply.", which is a real answer). */
const WORD = /^no[_-]?reply$/i;
const MARKS = "`*_~\"'“”‘’()\\[\\]<>";
/** The exact word glued to real text at the start of a line ("NO_REPLY Sure…"); not part of an identifier. */
const GLUED_START = new RegExp(`^(\\s*)[${MARKS}]*${NO_REPLY}(?!_[A-Za-z0-9]|[0-9])[${MARKS}.!:;,-]*\\s*`);
/** …or at its end ("…done. NO_REPLY", "…done.NO_REPLY"). */
const GLUED_END = new RegExp(`(?<![_0-9])[${MARKS}]*${NO_REPLY}[${MARKS}.!]*\\s*$`);
/** A line still being written that could end as the glued word ("…done. NO_RE"): held while it could. */
const PARTIAL_END = new RegExp(`(?<![_0-9a-z])[${MARKS}]*N(?:O(?:_(?:R(?:E(?:P(?:L(?:Y)?)?)?)?)?)?)?[${MARKS}.!]*$`);
const SPELLINGS = ["no_reply", "no-reply", "noreply"];

/** A line that is only the word (with marks, spacing, punctuation). */
export const isSentinelLine = (line: string) => {
  const c = core(line);
  return WORD.test(c) || c === "NO REPLY";
};

/** The whole text is the word cut short ("NO", "NO_RE"): a model stopped mid-word. */
const isTruncatedSentinel = (text: string) => {
  const c = core(text);
  return c.length >= 2 && NO_REPLY.startsWith(c);
};

/** A line being streamed that may still turn into the word on its own. */
function couldBeSentinelLine(open: string) {
  if (isSentinelLine(open)) return true;
  const r = open.replace(/^[\s`*_~"'“”‘’()[\]{}<>#|-]+/, "");
  if (!r) return true;
  return SPELLINGS.some((s) => s.startsWith(r.toLowerCase())) || "NO REPLY".startsWith(r);
}

const stripGlued = (line: string) => line.replace(GLUED_START, "$1").replace(GLUED_END, "");

/**
 * What of `text` may be shown. Lines that are only the word go, and the word
 * glued to the start or end of a line is cut. While streaming (`final` false)
 * the line being written is held while it could still become the word, and so
 * is a trailing piece that could be the glued word: streamed text never shows
 * it. What was shown stays a prefix of what is shown later.
 */
export function visibleText(text: string, final: boolean): string {
  if (final && isTruncatedSentinel(text)) return "";
  const lines = text.split("\n");
  const open = final ? null : (lines.pop() ?? "");
  const kept = lines.filter((l) => !isSentinelLine(l)).map(stripGlued);
  if (final) return kept.join("\n");
  const tail =
    open === null || couldBeSentinelLine(open) ? "" : open.replace(GLUED_START, "$1").replace(PARTIAL_END, "");
  return kept.map((l) => `${l}\n`).join("") + tail;
}

/** The text without the sentinel, trimmed: what may be posted. */
export const stripSentinel = (text: string) => visibleText(text, true).trim();

/** Nothing but the sentinel (any variant, or the word cut short): there is nothing to post. */
export const isSentinelOnly = (text: string) => text.trim() !== "" && stripSentinel(text) === "";

/**
 * The model meant to stay quiet: only the word, or a note that closes with it
 * ("Nada novo desde ontem.\n\nNO_REPLY"). For runs that may stay quiet.
 */
export function endsWithSentinel(text: string) {
  if (isSentinelOnly(text)) return true;
  const last = text.trim().split("\n").at(-1) ?? "";
  return isSentinelLine(last) || GLUED_END.test(last);
}

// ── The `pass` tool ──────────────────────────────────────────────────────────

/**
 * The built-in `pass` tool: no scope, listed only in runs that may pass
 * (`loadReplyPolicy`). It changes nothing: `data.passed` tells the engine to
 * end the run without a message (a step keeps the reason; `agent.passed`).
 */
export function createPassToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: PASS_TOOL,
    description:
      "Stay quiet: end your turn without posting anything. Only for conversations where nobody called you by name: use it when you have nothing to add or another agent already answered. Give a short reason (for the record, nobody sees it in the chat). Then end your turn without any text.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", maxLength: 300 } },
      additionalProperties: false,
    },
    describe: () => ({ title: "Stay quiet" }),
    async execute(input, ctx) {
      const policy = await loadReplyPolicy(ctx.db, ctx.orgId, ctx.runId);
      if (!policy?.mayPass) {
        return { content: "You were addressed directly: answer the person instead.", isError: true };
      }
      const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
      return {
        content: "Passed: nothing is posted. End your turn now without any text.",
        data: { passed: { reason } },
      };
    },
  };
  return {
    name: "reply-policy",
    tools: async (ctx) =>
      (await loadReplyPolicy(ctx.db, ctx.orgId, ctx.runId).catch(() => null))?.mayPass ? [tool] : [],
  };
}

// ── Others already answered ──────────────────────────────────────────────────

/**
 * Other agents' replies to the same message posted after it (where this run
 * answers): a run brought in reads them before its first call, so it can pass
 * instead of answering twice. Its context only goes up to the trigger.
 */
export async function repliesAfterTrigger(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId">,
  trigger: Pick<Message, "createdAt">,
  threadId: string | null,
): Promise<string | null> {
  const rows = await db
    .select({ body: messages.body, name: agents.name, handle: agents.handle })
    .from(messages)
    .innerJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        threadId ? eq(messages.threadId, threadId) : isNull(messages.threadId),
        eq(messages.authorType, "agent"),
        ne(messages.authorAgentId, run.agentId),
        gt(messages.createdAt, trigger.createdAt),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(5);
  if (rows.length === 0) return null;
  return rows
    .map((m) => `[Meanwhile ${m.name} (@${m.handle}) replied here]: ${stripSentinel(m.body).slice(0, 4000)}`)
    .join("\n\n");
}
