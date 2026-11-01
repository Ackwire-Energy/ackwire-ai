import type { PubSub } from "@agenteschat/adapters";
import { and, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { routineBriefOfRun } from "./background";
import { deliverNotice, publishDelivery } from "./delivery";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { insertMessage, type Message, unreachedAgents } from "./messages";
import type { RoutineBrief } from "./routine-brief";
import { personCanPost } from "./routine-state";
import { type AgentRun, addRunStep } from "./runs";
import { REQUEST_SECRET_TOOL } from "./secrets";
import { maskCredentials } from "./tool-detail";
import { turnMeans } from "./tools/directory";
import type { ToolContext, ToolDefinition, ToolSource } from "./tools/types";

export const HAND_OFF_TOOL = "hand_off";
/** A report, not a transcript: long enough for findings, why and what next. */
export const MAX_HAND_OFF = 8000;

const { agentRuns, routines, routineRuns } = schema;

/** Why a routine's report can't be delivered now (the routine run ends `skipped` with it). */
export type HandOffBlock = "deleted" | "paused" | "creator_no_access" | "handoff_blocked";

/**
 * Whether a routine may still speak where it reports (ADR 0053 §4): it exists and is active (a
 * one-off or a manual run counts as live), and its creator can still post there. Read at delivery,
 * since the routine may have changed while its run worked. Null when it may.
 */
export async function routineDeliveryBlock(tx: Executor, brief: RoutineBrief): Promise<HandOffBlock | null> {
  const [routine] = await tx
    .select({
      orgId: routines.orgId,
      active: routines.active,
      deletedAt: routines.deletedAt,
      triggerType: routines.triggerType,
      creator: routines.createdByUserId,
    })
    .from(routines)
    .where(eq(routines.id, brief.routineId));
  if (!routine || routine.deletedAt) return "deleted";
  if (!routine.active && brief.trigger !== "manual" && routine.triggerType !== "once") return "paused";
  // Its creator now (an admin or the agent's owner may have taken it over since it fired).
  if (!routine.creator) return "creator_no_access";
  if (!(await personCanPost(tx, routine.orgId, routine.creator, brief.deliverTo.channelId))) return "creator_no_access";
  return null;
}

/**
 * A routine's message reaches the conversation it reports to (`brief.deliverTo`), never its room.
 * By default it is the message itself (ADR 0053 §4, amended): the agent's ordinary message there,
 * tagged with the routine (`meta.routine`), waking nobody, so a greeting or a digest reads as one
 * message. With `wake`, it is a `routine_handoff` notice for the same agent instead, which joins an
 * unattended run of the agent there or starts one that acts or decides on it (never a run working for
 * a person). Only while the routine run is still open: one stopped, replaced or given up meanwhile
 * tells nobody (null). The routine run is `reported`, with the text as its record and `code`
 * (`auto_report` when its final text was delivered for it). In the caller's transaction; publish
 * with `publishDelivery` after the commit.
 */
export async function deliverRoutineReport(
  tx: Executor,
  input: {
    run: Pick<AgentRun, "id" | "orgId" | "agentId">;
    brief: RoutineBrief;
    text: string;
    code?: string | null;
    wake?: boolean;
  },
): Promise<{ message: Message; runs: AgentRun[] } | null> {
  const { run, brief } = input;
  // Its final text delivered for it (`auto_report`) never went through the Tool Gateway: no credential in it.
  const text = maskCredentials(input.text);
  const [open] = await tx
    .update(routineRuns)
    .set({ status: "reported", summary: text.slice(0, 4000), code: input.code ?? null })
    .where(
      and(
        eq(routineRuns.id, brief.routineRunId),
        eq(routineRuns.orgId, run.orgId),
        inArray(routineRuns.status, ["queued", "starting", "started"]),
        isNull(routineRuns.finishedAt),
      ),
    )
    .returning({ id: routineRuns.id });
  if (!open) return null;
  if (!input.wake) {
    // Agents it names outside that conversation: the routine hands it to them (`settleReach`).
    const unreached = await unreachedAgents(tx, {
      orgId: run.orgId,
      channelId: brief.deliverTo.channelId,
      authorAgentId: run.agentId,
      body: text,
      handedTo: run.id,
    });
    const message = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: brief.deliverTo.channelId,
      threadId: brief.deliverTo.threadId ?? undefined,
      // Nobody is behind it (authority.ts) and it wakes nobody: a root at hop 0, like a reminder.
      author: { type: "agent", agentId: run.agentId, runId: null, hop: 0, stretchId: null },
      body: text,
      meta: {
        routine: { id: brief.routineId, name: brief.name, runId: brief.routineRunId },
        ...(unreached.length > 0 ? { unreachedAgents: unreached } : {}),
      },
    });
    await tx.update(routineRuns).set({ messageId: message.id }).where(eq(routineRuns.id, brief.routineRunId));
    return { message, runs: [] };
  }
  return deliverNotice(tx, {
    orgId: run.orgId,
    agentId: run.agentId,
    channelId: brief.deliverTo.channelId,
    threadId: brief.deliverTo.threadId,
    // Nobody is behind it (authority.ts): the run it wakes answers at hop 1, in a stretch of its own.
    hop: 0,
    stretchId: null,
    notice: {
      kind: "routine_handoff",
      text,
      from: brief.name ? `Routine «${brief.name}»` : "Routine",
      refs: {
        runId: run.id,
        routineId: brief.routineId,
        routineRunId: brief.routineRunId,
        routineName: brief.name,
        report: brief.report,
      },
    },
  });
}

/** Ends the routine run `skipped` with why its report couldn't be delivered (while still open). */
async function blockRoutineRun(tx: Executor, brief: RoutineBrief, orgId: string, code: HandOffBlock) {
  await tx
    .update(routineRuns)
    .set({ status: "skipped", code, finishedAt: new Date() })
    .where(
      and(
        eq(routineRuns.id, brief.routineRunId),
        eq(routineRuns.orgId, orgId),
        inArray(routineRuns.status, ["queued", "starting", "started"]),
      ),
    );
}

const BLOCKED: Record<HandOffBlock | "stopped", string> = {
  deleted: "the routine was deleted",
  paused: "the routine was paused",
  creator_no_access: "the routine's creator can no longer post where it reports",
  handoff_blocked: "this run has no routine to report to",
  stopped: "this run was stopped or replaced, and nobody hears it",
};

/** What the resourcefulness checks need (ADR 0109): a routine's report and a question to a person. */
export interface ResourcefulDeps {
  /** Judges the call before it goes out; none: every call goes. */
  judge?: Judge | null;
  /** The run's tools as it sees them (the gateway's `list`), for the means a held call is reminded of. */
  tools?: () => { list(ctx: ToolContext): Promise<ToolDefinition[]> } | undefined;
}

export interface HandOffDeps extends ResourcefulDeps {
  pubsub?: PubSub;
}

/** The rules of this run's calls of `tool` held so far (its `continuation` steps with `held`). */
async function heldRules(db: Executor, run: { id: string; orgId: string }, tool: string) {
  const rows = await db
    .select({ rule: sql<string | null>`${schema.agentRunSteps.data}->'continuation'->>'rule'` })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, run.orgId),
        eq(schema.agentRunSteps.runId, run.id),
        eq(schema.agentRunSteps.kind, "context"),
        sql`${schema.agentRunSteps.data}->'continuation'->>'held' = ${tool}`,
      ),
    );
  return rows.map((r) => r.rule ?? "");
}

/** How many times this run's report was held as untried (its `continuation` steps with `held`). */
export async function handOffHolds(db: Executor, run: { id: string; orgId: string }) {
  return (await heldRules(db, run, HAND_OFF_TOOL)).length;
}

type RunRow = typeof agentRuns.$inferSelect;
type RunTranscript = { continuation?: { count?: number }; request?: string; harnessTried?: string[] };

/**
 * What the resourcefulness judge reads of a run (ADR 0109): the task (Continuar's request, else the message or the
 * routine's instructions that started it), its general means and every call it tried.
 */
async function runEvidence(deps: ResourcefulDeps, ctx: ToolContext, run: RunRow) {
  // Loaded here: the controller and the team pull in most of the engine, which imports this file.
  const [{ triedCalls }, { teammateMeans }] = await Promise.all([import("./continuation"), import("./team")]);
  const t = (run.transcript ?? {}) as RunTranscript;
  const listed = await deps
    .tools?.()
    ?.list(ctx)
    .catch(() => []);
  const names = new Set((listed ?? []).map((x) => x.name));
  const own = ctx.bridge ? ["your computer's own tools: shell and files"] : [];
  const means = [...turnMeans(names, await teammateMeans(ctx).catch(() => [])), ...own];
  const tried = await triedCalls(ctx.db, run, t.harnessTried);
  const [trigger] = t.request
    ? []
    : await ctx.db
        .select({ body: schema.messages.body })
        .from(schema.messages)
        .where(and(eq(schema.messages.orgId, run.orgId), eq(schema.messages.id, run.triggerMessageId)));
  return { request: t.request || (trigger?.body ?? ""), means, tried, names };
}

/**
 * A routine's report that says it couldn't while the run still had ways to try (ADR 0109): held once, before
 * anything posts (never inside the delivery's transaction), and the nudge is the tool's answer. It uses the run's one
 * extra turn (`CONTINUE.routineMaxPerRun`, shared with the turn-end controller), so the next report always posts.
 * Null: post it.
 */
async function holdUntried(deps: HandOffDeps, ctx: ToolContext, text: string): Promise<string | null> {
  if (!deps.judge) return null;
  const { CONTINUE, continuationVerdict, untriedNudge } = await import("./continuation");
  const [run] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)));
  if (!run?.background || run.status !== "running") return null;
  const t = (run.transcript ?? {}) as RunTranscript;
  const used = Math.max(t.continuation?.count ?? 0, await handOffHolds(ctx.db, run));
  if (used >= CONTINUE.routineMaxPerRun) return null;
  const { request, means, tried } = await runEvidence(deps, ctx, run);
  const verdict = await continuationVerdict(deps.judge, {
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    request,
    reply: text,
    means,
    tried,
    runKind: "routine",
  }).catch(() => "done" as const);
  if (verdict !== "untried") return null;
  await addRunStep(ctx.db, run, "context", {
    continuation: { outcome: "continue", rule: "untried", verdict, held: HAND_OFF_TOOL, count: used + 1 },
    nudged: "untried",
  });
  return `Not posted yet. ${untriedNudge(means, tried)} Then call hand_off again: that one posts.`;
}

/** What a question to a person asks for (`askVerdict`): something the run could find, a secret, or a person's own. */
export type AskVerdict = "findable" | "secret" | "person";

/**
 * One judge call on an `ask_user` question (kind `ask_check`, recorded like every judgment): `secret` at p ≥ 0.5
 * and at least the others, `findable` at p ≥ 0.5 and at least p(person), otherwise `person`. A needless hold costs
 * one more call of the agent; a findable question asked costs the person a wait.
 */
export async function askVerdict(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    question: string;
    request: string;
    means: string[];
    tried: string[];
  },
): Promise<AskVerdict> {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "ask_check",
    state: {
      question: cutText(input.question, 1000),
      request: cutText(input.request, 2000),
      means: input.means,
      tried: input.tried.slice(-20),
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "An AI agent in a team chat was asked `request` and now wants to ask a person `question`, then wait for the answer. `means`: the general ways it has (web search, browser, terminal, tool directory, teammates). `tried`: each tool call it made in this run, with its argument and outcome. What does the question ask for?",
        criteria: {
          findable:
            "Information the agent could find itself with `means` and hasn't really looked for in `tried`: an API's address or endpoints, a product's or a service's docs, what a name or a term the person used refers to (search the workspace and the web first), a public fact, something written in the workspace's messages or files.",
          secret: "A secret typed into the chat: a password, an API key, a token, a code, a private key.",
          person:
            "Something only a person can give: a decision, a preference or a priority, an approval, a payment, an access or a sign-in, a test only they can run; or a request so ambiguous that what they meant can't be found anywhere; or `tried` already shows it searched where the answer would be.",
        },
      },
    },
  });
  const a = answers.verdict;
  const p = (k: AskVerdict) => a?.probabilities?.[k] ?? (a?.choice === k ? 1 : 0);
  if (p("secret") >= 0.5 && p("secret") >= p("findable") && p("secret") >= p("person")) return "secret";
  if (p("findable") >= 0.5 && p("findable") >= p("person")) return "findable";
  return "person";
}

/** A question naming a secret, read when the judge fails: a missed one would be typed into the chat in plain text. */
const NAMES_SECRET =
  /\b(api[ _-]?keys?|chaves?|tokens?|senhas?|passwords?|secrets?|segredos?|credenciais|credentials?)\b/i;

/** What the run reads when it asked a person for a secret in a chat question. */
const SECRET_IN_CHAT = "Not asked: a secret typed in the chat stays in the conversation in plain text.";

/**
 * An `ask_user` question goes through the same resourcefulness check as giving up (ADR 0109 addendum): a question for
 * something the run could find with its means is held once (the tool answers with its means and what it tried, and
 * the next findable question is asked), and a secret asked as a chat question is refused every time and turned to
 * `request_secret` (on a judge error, a question naming a secret is refused too). Null: ask it.
 */
export async function holdAsk(deps: ResourcefulDeps, ctx: ToolContext, question: string): Promise<string | null> {
  if (!deps.judge) return null;
  const { findableNudge } = await import("./continuation");
  const [run] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)));
  if (run?.status !== "running") return null;
  const held = await heldRules(ctx.db, run, "ask_user");
  const { request, means, tried, names } = await runEvidence(deps, ctx, run);
  const verdict = await askVerdict(deps.judge, {
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    question,
    request,
    means,
    tried,
  }).catch((): AskVerdict => (NAMES_SECRET.test(question) ? "secret" : "person"));
  if (verdict === "person" || (verdict === "findable" && held.includes("findable"))) return null;
  await addRunStep(ctx.db, run, "context", {
    continuation: { outcome: "continue", rule: verdict, held: "ask_user", count: held.length + 1 },
    ...(verdict === "findable" ? { nudged: "untried" } : {}),
  });
  if (verdict === "findable") return findableNudge(means, tried);
  return names.has(REQUEST_SECRET_TOOL)
    ? `${SECRET_IN_CHAT} Ask for it with request_secret: the person types it into a secure card. Find everything else yourself first.`
    : `${SECRET_IN_CHAT} You have no secure way to receive it here: say which key you need and where it is set up, without asking for it in the chat.`;
}

/**
 * The built-in `hand_off`, offered only to background runs (a routine's, `ctx.background`): the
 * one way such a run speaks. Its message is posted where the routine reports, or with `wake_me`
 * becomes a `routine_handoff` notice there (`deliverRoutineReport`), at once and once per run (a second call is refused),
 * after checking the routine may still speak there (`routineDeliveryBlock`); when it can't, the
 * routine run is skipped with the reason and the model is told to finish.
 */
export function createHandOffToolSource(deps: HandOffDeps): ToolSource {
  const tool: ToolDefinition = {
    name: HAND_OFF_TOOL,
    description:
      "Post this routine's message where it reports, once. `message` is posted as-is as your own message to the people there: write the message itself (the greeting, the digest, the reminder, what you found and what you recommend), in their language, never about this routine or its runs. An agent it @mentions wakes and works on it (one outside that conversation gets it as a note). Set `wake_me` only when what you found needs you to act or decide in that conversation: then `message` is a note to you there (you'll be woken with it and tell the people yourself), not posted as-is. Without it nothing is posted.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: MAX_HAND_OFF },
        wake_me: { type: "boolean" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: input.wake_me === true ? "Hand off the report" : "Post the message",
      detail: String(input.message ?? "").slice(0, 500),
    }),
    async execute(input, ctx) {
      const text = String(input.message ?? "").trim();
      if (!text) return { content: "Give the report to hand off.", isError: true };
      const held = await holdUntried(deps, ctx, text);
      if (held) return { content: held, data: { held: true } };
      const handed = await ctx.db.transaction(async (tx) => {
        // Locked: two calls in one turn hand off once.
        const [run] = await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)))
          .for("update");
        if (!run?.background) return { refused: "Only background work (a routine's run) hands off: just reply." };
        if (run.status !== "running") return { refused: `Nothing was delivered: ${BLOCKED.stopped}. Finish now.` };
        const brief = await routineBriefOfRun(tx, run);
        if (!brief) return { refused: `Nothing was delivered: ${BLOCKED.handoff_blocked}. Finish now.` };
        const [already] = await tx
          .select({ id: routineRuns.id })
          .from(routineRuns)
          .where(and(eq(routineRuns.id, brief.routineRunId), eq(routineRuns.status, "reported")));
        if (already) {
          return {
            refused:
              "You already handed off this run's message; it was delivered and can't be changed. Finish now: nothing else is posted.",
          };
        }
        const block = await routineDeliveryBlock(tx, brief);
        if (block) {
          await blockRoutineRun(tx, brief, run.orgId, block);
          return { refused: `Nothing was delivered: ${BLOCKED[block]}. Finish now: nothing else is posted.` };
        }
        const delivered = await deliverRoutineReport(tx, { run, brief, text, wake: input.wake_me === true });
        if (!delivered) return { refused: `Nothing was delivered: ${BLOCKED.stopped}. Finish now.` };
        return { delivered };
      });
      if ("refused" in handed) return { content: handed.refused ?? "", isError: true };
      await publishDelivery(deps.pubsub, handed.delivered);
      return {
        content:
          input.wake_me === true
            ? "Handed off: you will tell the people in the conversation. Finish your work now and end with a short record of what you checked; nothing else is posted."
            : "Posted. Finish your work now and end with a short record of what you checked (it is not posted); nothing else is posted.",
        data: { handedOff: { messageId: handed.delivered.message.id } },
      };
    },
  };
  return { name: "hand_off", tools: async (ctx) => (ctx.background ? [tool] : []) };
}
