import { and, type Executor, eq, schema } from "@agenteschat/db";
import { fedByRoutine, personOfMessage, type RunAuthority, runAuthority, runAuthorityById } from "./authority";
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

/**
 * Whose rooms and agents a routine set to act reaches (ADR 0053 §2, amended 2026-10-31): its creator's. It posts
 * only where they can post and wakes only agents they can talk to, and still never acts as them (no files of
 * theirs, nothing in their name). The same for a run its work or report woke (`fedByRoutine`: a tell_agent's
 * run in the agents' DM, the run its report wakes), so one hop never reaches further. Null for any other run and
 * for a routine that only looks.
 */
export const routineCreatorOf = (authority: RunAuthority): string | null =>
  actingRoutineOf(authority)?.creatorUserId ?? null;

/** The brief of a routine set to act whose creator is still there (whose reach it has); null otherwise. */
const actingRoutineOf = (authority: RunAuthority) => {
  const brief = authority.kind !== "person" && fedByRoutine(authority) ? (authority.brief ?? null) : null;
  return brief?.access === "act" && brief.creatorUserId ? brief : null;
};

/** `actingRoutineOf` for a call's run. */
export async function actingRoutineOfCall(ctx: Pick<ToolContext, "orgId" | "runId"> & { db: Executor }) {
  return ctx.runId ? actingRoutineOf(await runAuthorityById(ctx.db, ctx.orgId, ctx.runId)) : null;
}

/** `routineCreatorOf` for a call's run. */
export async function routineCreatorOfCall(ctx: Pick<ToolContext, "orgId" | "runId"> & { db: Executor }) {
  return (await actingRoutineOfCall(ctx))?.creatorUserId ?? null;
}
