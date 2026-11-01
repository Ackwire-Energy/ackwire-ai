import type { PubSub } from "@agenteschat/adapters";
import { and, type Executor, eq, gte, inArray, isNull, schema, sql } from "@agenteschat/db";
import { routineBriefOfRun } from "./background";
import { deliverNotice, publishDelivery } from "./delivery";
import type { Message } from "./messages";
import type { RoutineBrief } from "./routine-brief";
import { personCanPost } from "./routine-state";
import type { AgentRun } from "./runs";
import { maskCredentials } from "./tool-detail";
import type { ToolDefinition, ToolSource } from "./tools/types";

export const HAND_OFF_TOOL = "hand_off";
/** A report, not a transcript: long enough for findings, why and what next. */
export const MAX_HAND_OFF = 8000;

const { agentRuns, messages, routines, routineRuns } = schema;

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
 * A routine's report reaches the conversation it reports to (`brief.deliverTo`), never its room: a
 * `routine_handoff` notice for the same agent, which joins an unattended run of the agent there or
 * starts one that tells the people in the agent's voice (never a run working for a person, ADR 0053
 * §4). Only while the routine run is still open: one stopped, replaced or given up meanwhile tells
 * nobody (null). The routine run is `reported`, with the report as its record and `code`
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

/**
 * The built-in `hand_off`, offered only to background runs (a routine's, `ctx.background`): the
 * one way such a run speaks. The report becomes a `routine_handoff` notice in the conversation the
 * routine reports to (`deliverRoutineReport`), at once and once per run (a second call is refused),
 * after checking the routine may still speak there (`routineDeliveryBlock`); when it can't, the
 * routine run is skipped with the reason and the model is told to finish.
 */
export function createHandOffToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const tool: ToolDefinition = {
    name: HAND_OFF_TOOL,
    description:
      "Hand your findings to the conversation this routine reports to: you will tell the people there, in your own words. Call it once, only when there is something they need to know or act on, with the complete report: what you found (numbers, links), why it matters, and what you recommend or already did. Without it nothing is posted.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: MAX_HAND_OFF } },
      required: ["message"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Hand off the report", detail: String(input.message ?? "").slice(0, 500) }),
    async execute(input, ctx) {
      const text = String(input.message ?? "").trim();
      if (!text) return { content: "Give the report to hand off.", isError: true };
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
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.orgId, run.orgId),
              eq(messages.channelId, brief.deliverTo.channelId),
              gte(messages.createdAt, run.createdAt),
              sql`${messages.meta} @> ${JSON.stringify({ notice: { kind: "routine_handoff", refs: { runId: run.id } } })}::jsonb`,
            ),
          )
          .limit(1);
        if (already) {
          return {
            refused:
              "You already handed off this run's report; it was delivered and can't be changed. Finish now: nothing else is posted.",
          };
        }
        const block = await routineDeliveryBlock(tx, brief);
        if (block) {
          await blockRoutineRun(tx, brief, run.orgId, block);
          return { refused: `Nothing was delivered: ${BLOCKED[block]}. Finish now: nothing else is posted.` };
        }
        const delivered = await deliverRoutineReport(tx, { run, brief, text });
        if (!delivered) return { refused: `Nothing was delivered: ${BLOCKED.stopped}. Finish now.` };
        return { delivered };
      });
      if ("refused" in handed) return { content: handed.refused ?? "", isError: true };
      await publishDelivery(deps.pubsub, handed.delivered);
      return {
        content:
          "Handed off: you will tell the people in the conversation. Finish your work now and end with a short record of what you checked; nothing else is posted.",
        data: { handedOff: { messageId: handed.delivered.message.id } },
      };
    },
  };
  return { name: "hand_off", tools: async (ctx) => (ctx.background ? [tool] : []) };
}
