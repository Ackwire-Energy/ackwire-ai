import { and, type Executor, eq, schema } from "@agenteschat/db";
import { type RoutineAccess, type RoutineBrief, routineBriefOf } from "./routine-brief";

const { agentRuns, messages } = schema;

/**
 * Who is behind a run (ADR 0053): the one gate every "who asked?" check goes through, on every brain.
 *
 * - `person`: a person asked, directly or through a chain of agents (an agent's message counts for the
 *   person behind the run that wrote it; an answer to another agent's question, for the person behind
 *   the run that asked). Tools act on their behalf, within their permissions and the agent's scopes.
 * - `routine`: a routine's background run. Nobody is behind it: its creator set it up and stays
 *   accountable (notifications, approvals), but the run never acts as them. What it may do comes only
 *   from the routine's access level (`brief.access`).
 * - `unattended`: no person at the root: the conversation run a routine's report woke, a note from
 *   another agent, an agent's own message. It may read and talk where it is, never act for anyone.
 *   One a routine's report woke works within that routine's access (`routineAccess`): the report of a
 *   routine that only looks wakes a run that only looks and proposes. A person writing into such a
 *   run (`steeredBy`) puts that person behind it from then on.
 *
 * Message metadata alone never proves a person: only authorship and server-set links (a message's run,
 * a notice's run) are followed.
 */
export type RunAuthority =
  | { kind: "person"; personId: string }
  | { kind: "routine"; personId: null; brief: RoutineBrief | null }
  | { kind: "unattended"; personId: null; reason: UnattendedReason; routineAccess?: RoutineAccess };

/** Why nobody is behind an unattended run (for its refusal reasons and its card's words). */
export type UnattendedReason = "routine_report" | "agent_note" | "agent";

/** What a message's chain roots in. */
export type MessageRoot =
  | { kind: "person"; personId: string }
  | { kind: "routine" }
  /** `backgroundRunId`: the routine's run that handed it off (the notice's `refs.runId`). */
  | { kind: "routine_report"; backgroundRunId: string | null }
  | { kind: "agent_note" }
  | { kind: "agent" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many links (message → its run → that run's trigger) a chain may have before it counts as nobody's. */
export const MAX_AUTHORITY_CHAIN = 8;

type MessageLink = {
  authorType: string;
  authorUserId: string | null;
  agentRunId: string | null;
  meta: Record<string, unknown>;
};

const noticeOf = (meta: Record<string, unknown>) =>
  meta.notice as { kind?: unknown; refs?: Record<string, unknown> } | undefined;

/**
 * What a message's chain roots in: a person (its author, or the person behind the run that wrote it),
 * a routine (its brief, or a run that is a routine's background work), a routine's report, a note
 * from another agent, or nothing (an agent's own message with no run, a broken or too long chain).
 */
export async function messageRoot(db: Executor, orgId: string, messageId: string): Promise<MessageRoot> {
  let id = messageId;
  for (let depth = 0; depth <= MAX_AUTHORITY_CHAIN; depth++) {
    const [m] = (await db
      .select({
        authorType: messages.authorType,
        authorUserId: messages.authorUserId,
        agentRunId: messages.agentRunId,
        meta: messages.meta,
      })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, id)))) as MessageLink[];
    if (!m) return { kind: "agent" };
    if (m.authorType === "person") {
      // A routine's brief is written by its creator, but nobody is behind the work it starts.
      if (routineBriefOf(m.meta) || m.meta.background === true) return { kind: "routine" };
      return m.authorUserId ? { kind: "person", personId: m.authorUserId } : { kind: "agent" };
    }
    const notice = noticeOf(m.meta);
    if (notice?.kind === "routine_handoff") {
      const runId = notice.refs?.runId;
      return { kind: "routine_report", backgroundRunId: typeof runId === "string" ? runId : null };
    }
    if (notice?.kind === "agent_note") return { kind: "agent_note" };
    // The answer to a question this agent asked, or the result it waited for: it continues the work of
    // the run that asked (its `refs.runId`), for whoever is behind that run.
    const resumes =
      (notice?.kind === "consult_reply" || notice?.kind === "wait_result") && typeof notice.refs?.runId === "string"
        ? notice.refs.runId
        : null;
    const runId = resumes ?? m.agentRunId;
    if (!runId) return { kind: "agent" };
    const [run] = await db
      .select({ triggerMessageId: agentRuns.triggerMessageId, background: agentRuns.background })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
    if (!run) return { kind: "agent" };
    if (run.background) return { kind: "routine" };
    id = run.triggerMessageId;
  }
  return { kind: "agent" };
}

/** The person behind a message (see `messageRoot`), or null. */
export async function personOfMessage(db: Executor, orgId: string, messageId: string): Promise<string | null> {
  const root = await messageRoot(db, orgId, messageId);
  return root.kind === "person" ? root.personId : null;
}

/** The run fields the gate reads. */
export type AuthorityRun = {
  id: string;
  orgId: string;
  triggerMessageId: string;
  background: boolean;
  transcript?: Record<string, unknown> | null;
};

/** The person who wrote into an unattended run while it worked (`Transcript.steeredBy`), if any. */
export const steeredByOf = (transcript: Record<string, unknown> | null | undefined) =>
  typeof transcript?.steeredBy === "string" ? transcript.steeredBy : null;

/** Who is behind a run (see `RunAuthority`). */
export async function runAuthority(db: Executor, run: AuthorityRun): Promise<RunAuthority> {
  if (run.background) {
    const [trigger] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
    return { kind: "routine", personId: null, brief: routineBriefOf(trigger?.meta) };
  }
  const root = await messageRoot(db, run.orgId, run.triggerMessageId);
  if (root.kind === "person") return { kind: "person", personId: root.personId };
  const steeredBy = steeredByOf(run.transcript);
  if (steeredBy) return { kind: "person", personId: steeredBy };
  if (root.kind === "routine_report") {
    const routineAccess = await accessOfReport(db, run.orgId, root.backgroundRunId);
    return { kind: "unattended", personId: null, reason: "routine_report", routineAccess };
  }
  return { kind: "unattended", personId: null, reason: root.kind === "agent_note" ? "agent_note" : "agent" };
}

/** The access a routine's run handed off with (its brief); `read` when it can't be told. */
async function accessOfReport(db: Executor, orgId: string, backgroundRunId: string | null): Promise<RoutineAccess> {
  if (!backgroundRunId || !UUID.test(backgroundRunId)) return "read";
  const [row] = await db
    .select({ meta: messages.meta })
    .from(agentRuns)
    .innerJoin(messages, and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId)))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, backgroundRunId), eq(agentRuns.background, true)));
  return routineBriefOf(row?.meta)?.access === "act" ? "act" : "read";
}

/** Who is behind a run, by its id (the tool context's `runId`); unattended when the run is gone. */
export async function runAuthorityById(db: Executor, orgId: string, runId: string): Promise<RunAuthority> {
  if (!UUID.test(runId)) return { kind: "unattended", personId: null, reason: "agent" };
  const [run] = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      triggerMessageId: agentRuns.triggerMessageId,
      background: agentRuns.background,
      transcript: agentRuns.transcript,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  if (!run) return { kind: "unattended", personId: null, reason: "agent" };
  return runAuthority(db, run);
}

/**
 * Who answers for a run's requests (approvals, questions, failures): the person behind it, else the
 * routine's creator. Null for other unattended runs (the caller falls back to the agent's owner).
 */
export const accountablePerson = (authority: RunAuthority): string | null =>
  authority.kind === "person"
    ? authority.personId
    : authority.kind === "routine"
      ? (authority.brief?.creatorUserId ?? null)
      : null;
