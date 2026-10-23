import { and, type Executor, eq, schema } from "@agenteschat/db";
import { personOfMessage, runAuthority } from "./authority";
import type { ToolContext } from "./tools/types";

const { agentRuns } = schema;

/**
 * The person a tool call acts for (ADR 0053): the person behind its run (`authority.ts`), or null when
 * nobody is (a routine's run, an unattended one). A call without a run (a mission task's) acts for the
 * person behind the message it was given, if any. It never grants anything: the tool still checks
 * that person's permissions and the agent's own scopes.
 */
export async function personBehindCall(
  ctx: Pick<ToolContext, "orgId" | "runId" | "triggerMessageId"> & { db: Executor },
): Promise<string | null> {
  const [run] = ctx.runId
    ? await ctx.db
        .select({
          id: agentRuns.id,
          orgId: agentRuns.orgId,
          triggerMessageId: agentRuns.triggerMessageId,
          background: agentRuns.background,
          transcript: agentRuns.transcript,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.id, ctx.runId)))
    : [];
  if (run) return (await runAuthority(ctx.db, run)).personId;
  return ctx.triggerMessageId ? personOfMessage(ctx.db, ctx.orgId, ctx.triggerMessageId) : null;
}

/** The person behind a message (`personOfMessage`): its author, or the person behind the run that wrote it. */
export const personBehindRun = (db: Executor, orgId: string, triggerMessageId: string): Promise<string | null> =>
  personOfMessage(db, orgId, triggerMessageId);
