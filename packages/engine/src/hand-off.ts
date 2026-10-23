import type { PubSub } from "@agenteschat/adapters";
import { and, eq, gte, schema, sql } from "@agenteschat/db";
import { routineOfRun } from "./background";
import { deliverNotice, publishDelivery } from "./delivery";
import { notifyRoutineRun } from "./notification-producers";
import { replyThreadOf } from "./runs";
import type { ToolDefinition, ToolSource } from "./tools/types";

export const HAND_OFF_TOOL = "hand_off";
/** A report, not a transcript: long enough for findings, why and what next. */
export const MAX_HAND_OFF = 8000;

const { agentRuns, messages, routineRuns } = schema;

/**
 * The built-in `hand_off`, offered only to background runs (a routine's,
 * `ctx.background`): the one way such a run speaks. The report becomes a
 * `routine_handoff` notice in the routine's conversation, for the same agent:
 * it joins the agent's run there or starts one, and that run tells the people
 * in the agent's voice, with the conversation's context. Delivered at once,
 * once per run (a second call is refused). Its creator hears it reported.
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
        const [already] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.orgId, run.orgId),
              eq(messages.channelId, run.channelId),
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
        const routine = await routineOfRun(tx, run);
        const refs: Record<string, string> = { runId: run.id };
        if (routine) refs.routineId = routine.routineId;
        if (routine?.routineRunId) refs.routineRunId = routine.routineRunId;
        const delivered = await deliverNotice(tx, {
          orgId: run.orgId,
          agentId: run.agentId,
          channelId: run.channelId,
          threadId: replyThreadOf(run),
          // The routine speaks for its creator, like its trigger: the conversation run answers at hop 1.
          hop: 0,
          notice: {
            kind: "routine_handoff",
            text,
            from: routine?.name ? `Routine «${routine.name}»` : "Background work",
            refs,
          },
        });
        if (routine?.routineRunId) {
          await tx
            .update(routineRuns)
            .set({ status: "reported", summary: text.slice(0, 4000) })
            .where(and(eq(routineRuns.id, routine.routineRunId), eq(routineRuns.orgId, run.orgId)));
        }
        return { delivered, routine, run };
      });
      if ("refused" in handed) return { content: handed.refused ?? "", isError: true };
      await publishDelivery(deps.pubsub, handed.delivered);
      if (handed.routine) {
        await notifyRoutineRun(
          { db: ctx.db, pubsub: deps.pubsub },
          {
            orgId: ctx.orgId,
            routineId: handed.routine.routineId,
            agentId: ctx.agentId,
            ok: true,
            runKey: ctx.runId,
            text,
          },
        ).catch(() => {});
      }
      return {
        content:
          "Handed off: you will tell the people in the conversation. Finish your work now and end with a short record of what you checked; nothing else is posted.",
        data: { handedOff: { messageId: handed.delivered.message.id } },
      };
    },
  };
  return { name: "hand_off", tools: async (ctx) => (ctx.background ? [tool] : []) };
}
