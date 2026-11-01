import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { accountablePerson, runAuthority } from "./authority";
import { getChannelCached } from "./context";
import { publishDelivery } from "./delivery";
import { isAgentOnlyDm } from "./dms";
import { decisionNudge, FOLLOW_THROUGH_NUDGE, FOLLOW_THROUGH_NUDGE_DM, MISSION_ASK_NUDGE } from "./follow-through";
import { cutText, cutTextEnd } from "./format";
import type { Judge } from "./judge";
import { notifyRunFailed } from "./notification-producers";
import { ANSWER_NUDGE } from "./reply-policy";
import { deliverNoticeToRun } from "./run-resume";
import type { AgentRun } from "./runs";

/**
 * The continuation controller (ADR 0096): every turn of every run kind that reaches its final answer ends in exactly
 * one of continue (the same run keeps working), waiting (something durable brings it back) or done. Cheap rules
 * first, then at most one judgment (`continuationVerdict`). A failed run goes to `reportRunFailure` instead.
 */

/**
 * Extra turns one run may be given, every kind counted together (the decision nudge, the answer nudge and the
 * continue nudges), plus one ask nudge. Worst case: 3 extra turns and 4 judgments, then a question card or done.
 */
export const CONTINUE = { maxPerRun: 2, routineMaxPerRun: 1 } as const;

/** Where the controller stands in a run (`transcript.continuation`). */
export interface ContinuationState {
  count: number;
  /** The run's executed tool calls when it was last told to continue: the next continue needs more. */
  executedAtNudge?: number;
  askNudged?: boolean;
}

export type ContinuationVerdict = "done" | "continue" | "ask";

/** What a run reads, once, when it described what only a person can give instead of asking for it. */
export const ASK_NUDGE =
  "You need something only a person can give (a credential, a decision, a test, access). Ask them now with ask_user: one direct question, with choices if it is one of a few. Do not end with a list of what's missing.";

/** The run's last judged turn, kept for the mission's keep-going check (`keepGoingBlocker` reads `waiting`). */
export const verdictRecord = (v: ContinuationVerdict) => (v === "continue" ? "unkept" : v === "ask" ? "waiting" : v);

/**
 * One judge call on a turn's end (kind `follow_through`, recorded on the agent's and the workspace's usage like
 * every judgment, not billed to the agent's budget). `continue` at p ≥ 0.45 and at least p(ask); `ask` at
 * p ≥ 0.45; otherwise done. A missed continuation is silent lost work, a needless one is one turn.
 */
export async function continuationVerdict(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    request: string;
    reply: string;
    did: string[];
    runKind: TurnKind;
  },
): Promise<ContinuationVerdict> {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "follow_through",
    state: {
      request: cutText(input.request, 2000),
      reply: cutTextEnd(input.reply, 3000),
      did: input.did.slice(-20),
      runKind: input.runKind,
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "An AI agent in a team chat was asked `request` and ended its turn with `reply`, its last message (`did`: the tools it ran this turn). It won't act again until someone writes to it or something it set up wakes it. Is it done, should it go on by itself, or does it need something only a person can give?",
        criteria: {
          done: "It gave the result or the answer, or said plainly what it couldn't do and why. An offer that needs someone else's decision (a sensitive or external action, a choice between their options) counts as done only when asked as one direct question.",
          continue:
            "It said it will do more itself (next, later, after a build), or offered reversible work inside what it was asked ('want me to create the issues?' after 'triage these'), or stopped midway, and nothing it set up brings it back.",
          ask: "To go on it needs something only a person can give (a credential, a decision, a test, access), but it described the need or listed what's missing instead of asking one direct question.",
        },
      },
    },
  });
  const a = answers.verdict;
  const p = (k: ContinuationVerdict) => a?.probabilities?.[k] ?? (a?.choice === k ? 1 : 0);
  if (p("continue") >= 0.45 && p("continue") >= p("ask")) return "continue";
  if (p("ask") >= 0.45) return "ask";
  return "done";
}

export type TurnKind = "conversation" | "agents_dm" | "routine";

export interface TurnEnd {
  state: ContinuationState;
  kind: TurnKind;
  /** Tool calls executed so far in the run. */
  executed: number;
  /** A bound already ended it: stuck, the step backstop, the turn cap. */
  bound: string | null;
  /** It passed, used the silence word, or a reaction, a GIF or a report card is its answer. */
  quiet: boolean;
  /** A person decided what it waited on and it ended without a word: the decision and its result. */
  decided: string | null;
  /** Addressed directly, it wrote nothing (or only the silence word). */
  unanswered: boolean;
  /** Its answer names agents outside the conversation (`unreachedNote`, "" none): the mention reached nobody. */
  unreached: string;
  /** What is judged ("" skips the judgment: nothing to read, or an agents' DM run that owes no answer). */
  judged: string;
  mission: boolean;
  /** Something durable brings it back (`wakesLater`), read only when the judgment would run. */
  wakesLater(): Promise<boolean>;
  /** The judgment; null when the workspace has no judge. */
  verdict: (() => Promise<ContinuationVerdict>) | null;
}

export type TurnEndDecision = {
  outcome: "continue" | "waiting" | "done" | "ask_card";
  rule: string;
  /** What the run reads next (continue only). */
  nudge?: string;
  verdict?: ContinuationVerdict;
  judgeError?: boolean;
};

/**
 * Decides how a turn that reached its final answer ends (rules in order, the first that applies wins). The caller
 * applies it: posts and goes on with the nudge, turns the reply into a question card, or ends the run, and records
 * the decision as the run's `continuation` step.
 */
export async function decideTurnEnd(t: TurnEnd): Promise<TurnEndDecision> {
  const max = t.kind === "routine" ? CONTINUE.routineMaxPerRun : CONTINUE.maxPerRun;
  const canNudge = t.state.count < max;
  if (t.bound) return { outcome: "done", rule: t.bound };
  if (t.quiet) return { outcome: "done", rule: "quiet" };
  if (t.decided && canNudge) return { outcome: "continue", rule: "decision", nudge: decisionNudge(t.decided) };
  if (t.unanswered && canNudge) return { outcome: "continue", rule: "answer", nudge: ANSWER_NUDGE };
  // A hand-off by mention to an agent that isn't here is an unkept hand-off: it goes on and hands it over.
  if (t.unreached && canNudge) return { outcome: "continue", rule: "unreached", nudge: t.unreached };
  if (!t.judged || !t.verdict) return { outcome: "done", rule: t.verdict ? "nothing_to_judge" : "no_judge" };
  if (!canNudge && (t.state.askNudged || t.kind !== "conversation")) return { outcome: "done", rule: "cap" };
  if (await t.wakesLater().catch(() => false)) return { outcome: "waiting", rule: "wakes_later" };
  let verdict: ContinuationVerdict;
  try {
    verdict = await t.verdict();
  } catch {
    return { outcome: "done", rule: "judge_error", judgeError: true };
  }
  // No person reads a routine's run or an agents' DM: what it lacks goes out in its report or its answer, and
  // the controller of the run that reads it can ask.
  if (verdict === "ask" && t.kind !== "conversation") return { outcome: "done", rule: "ask_elsewhere", verdict };
  if (verdict === "continue") {
    const progressed = t.state.count === 0 || t.executed > (t.state.executedAtNudge ?? 0);
    if (canNudge && progressed)
      return {
        outcome: "continue",
        rule: "promise",
        verdict,
        nudge: t.kind === "agents_dm" ? FOLLOW_THROUGH_NUDGE_DM : FOLLOW_THROUGH_NUDGE,
      };
    // Promising again without acting: a person is asked what it needs instead.
    if (t.kind !== "conversation") return { outcome: "done", rule: "cap", verdict };
  }
  if (verdict === "done") return { outcome: "done", rule: "judged", verdict };
  if (!t.state.askNudged)
    return { outcome: "continue", rule: "ask", verdict, nudge: t.mission ? MISSION_ASK_NUDGE : ASK_NUDGE };
  return { outcome: "ask_card", rule: "ask_card", verdict };
}

/** Moves the state on for a `continue` decision (the ask nudge has its own once-flag). */
export function advance(state: ContinuationState, d: TurnEndDecision, executed: number): ContinuationState {
  if (d.outcome !== "continue") return state;
  if (d.rule === "ask") return { ...state, askNudged: true };
  return { ...state, count: state.count + 1, executedAtNudge: executed };
}

/** Run errors the person already sees explained elsewhere, or that no one can act on. */
const UNREPORTED = new Set(["agent_archived", "no_ai", "canceled"]);

/**
 * A conversation run failed for good (I5): the person accountable for it (the person behind it, else the routine's
 * creator, else the agent's owner) gets one `run_failed` notification per agent and conversation, resolved by the
 * agent's next run there that ends well. A run another agent's @mention woke tells that agent once ("couldn't
 * finish"), so it tries another way or tells the person; hand-offs in an agents' DM close through their own rows
 * (`onConsultedRunFinished`). Never throws.
 */
export async function reportRunFailure(deps: { db: Database; pubsub?: PubSub }, run: AgentRun, reason: string) {
  if (run.background || UNREPORTED.has(reason)) return;
  try {
    const channel = await getChannelCached(deps.db, run.orgId, run.channelId);
    if (!channel || channel.kind === "forum") return;
    const person = accountablePerson(await runAuthority(deps.db, run));
    await notifyRunFailed(deps, run, person, reason);
    if (isAgentOnlyDm(channel)) return;
    const [trigger] = await deps.db
      .select({ agentId: schema.messages.authorAgentId, runId: schema.messages.agentRunId })
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, run.orgId), eq(schema.messages.id, run.triggerMessageId)));
    if (!trigger?.agentId || !trigger.runId || trigger.agentId === run.agentId) return;
    const [sender] = await deps.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, run.orgId), eq(schema.agentRuns.id, trigger.runId)));
    const agent = await getAgentCached(deps.db, run.orgId, run.agentId);
    if (!sender || sender.background || !agent) return;
    const delivered = await deps.db.transaction((tx) =>
      deliverNoticeToRun(tx, sender, {
        kind: "consult_reply",
        from: `@${agent.handle}`,
        text: `It couldn't finish what your mention handed it (${reason.split(":")[0]}).`,
        refs: {
          kind: "note",
          via: "mention",
          wake: "1",
          runId: run.id,
          agentId: run.agentId,
          askerAgentId: sender.agentId,
        },
      }),
    );
    await publishDelivery(deps.pubsub, delivered);
  } catch {
    // The failure itself is on the run; a report that couldn't go out leaves it there.
  }
}

/**
 * Agents an agent's @mention selected that dispatch couldn't wake because only certain people may talk to them and
 * the person behind the message isn't one (nobody, for a run with no requester): the skip goes in the message's
 * routing decision, and the author hears it once, as a line people see too, so it hands the work another way or
 * tells the person (I5, I7). Agents not in the conversation are told by `unreachedNote` already. Never throws.
 */
export async function reportDroppedMentions(
  deps: { db: Database; pubsub?: PubSub },
  message: { id: string; orgId: string; agentRunId: string | null },
  dropped: { agentId: string; handle: string; reason: "not_here" | "audience" }[],
) {
  if (dropped.length === 0) return;
  try {
    const why = dropped.map((d) => `skipped @${d.handle}: ${d.reason}`).join(", ");
    await deps.db
      .update(schema.routingDecisions)
      .set({ reason: sql`left(concat_ws(' · ', ${schema.routingDecisions.reason}, ${why}::text), 1000)` })
      .where(and(eq(schema.routingDecisions.orgId, message.orgId), eq(schema.routingDecisions.messageId, message.id)));
    const audience = dropped.filter((d) => d.reason === "audience");
    if (audience.length === 0 || !message.agentRunId) return;
    const [sender] = await deps.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, message.orgId), eq(schema.agentRuns.id, message.agentRunId)));
    if (!sender || sender.background) return;
    const person = (await runAuthority(deps.db, sender)).personId;
    const names = audience.map((d) => `@${d.handle}`).join(", ");
    const delivered = await deps.db.transaction((tx) =>
      deliverNoticeToRun(tx, sender, {
        kind: "wake_skipped",
        text: `${names} ${audience.length === 1 ? "wasn't" : "weren't"} woken by your mention: only certain people may talk to ${audience.length === 1 ? "it" : "them"}, and ${person ? "the person you work for isn't one" : "nobody is behind this work"}. Tell the people here what still needs ${names}, so someone who may talk to ${audience.length === 1 ? "it" : "them"} hands it over.`,
        refs: { runId: sender.id, messageId: message.id, agentHandles: audience.map((d) => d.handle).join(",") },
      }),
    );
    await publishDelivery(deps.pubsub, delivered);
  } catch {
    // The run that mentioned them is unaffected; the decision row keeps what it had.
  }
}
