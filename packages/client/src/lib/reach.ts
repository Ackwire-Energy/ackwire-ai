import type { Agent, RoutineAccess } from "../api/types";
import { audienceAdmits, canTalk, modeOf } from "./audience";
import { MENTION } from "./markdown";

/**
 * Why an agent's message didn't wake an agent it named (the server's `meta.reach`, `reach.ts`): `not_in_channel`, it
 * went to it as a note instead; `audience`, the person behind it can't talk to it; `routine_creator_reach`, a
 * routine's creator can't (or the routine only looks and tells).
 */
export type ReachReason = "not_in_channel" | "audience" | "routine_creator_reach";

export interface ReachEntry {
  agentId: string;
  handle: string;
  reason: ReachReason;
  /** Delivered as a hand-off note: its consultation (opens the two agents' conversation). */
  consultationId?: string;
  /** Not a member of the conversation either. */
  outside?: true;
  /** `not_in_channel` from a private conversation: not forwarded, so what's said there stays there. */
  private?: true;
  /** `not_in_channel` to an agent with no AI connected: nothing could answer it. */
  noAi?: true;
  /** Whose reach fell short: the agent's owner may let them talk to it. */
  userId?: string;
  routine?: { id: string; name: string; creatorUserId: string | null; access: RoutineAccess };
}

/** `meta.reach`, read safely. */
export function reachOf(meta: Record<string, unknown> | null | undefined): ReachEntry[] {
  const list = meta?.reach;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is ReachEntry =>
      !!e && typeof e === "object" && typeof e.agentId === "string" && typeof e.handle === "string",
  );
}

/** The routine only looks and tells: its access, not anyone's audience, keeps the agent out. */
export const reachByAccess = (e: ReachEntry) => e.reason === "routine_creator_reach" && e.routine?.access === "read";

/** The line's text key: handed, no AI, kept private, the routine only looks, or who couldn't call it. */
export const reachKey = (e: ReachEntry) =>
  e.consultationId
    ? ("reach.handed" as const)
    : e.noAi
      ? ("reach.noAi" as const)
      : e.private
        ? ("reach.private" as const)
        : reachByAccess(e)
          ? ("reach.routineRead" as const)
          : ("reach.blocked" as const);

/**
 * The agents a routine's prompt names that it won't be able to call, for its dialog (a warning, never a block): set to
 * act, the ones its creator can't talk to (`creatorUserId` when someone else's routine is being edited, else the
 * viewer); set to only look and tell, the ones not open to everyone. Never the routine's own agent.
 */
export function routineReachWarnings(
  prompt: string,
  agents: readonly Agent[],
  options: { access: RoutineAccess; agentId: string | null; creatorUserId?: string | null },
): { agent: Agent; kind: "blocked" | "read" }[] {
  const handles = new Set([...prompt.matchAll(MENTION)].map((m) => (m[2] ?? "").toLowerCase()));
  // ponytail: "read" ignores agents outside the report channel (their note is refused too); add once the dialog knows members.
  return agents.flatMap((agent): { agent: Agent; kind: "blocked" | "read" }[] => {
    if (agent.id === options.agentId || !handles.has(agent.handle.toLowerCase())) return [];
    if (options.access === "read") return modeOf(agent) === "everyone" ? [] : [{ agent, kind: "read" }];
    const reaches = options.creatorUserId ? audienceAdmits(agent, options.creatorUserId) : canTalk(agent);
    return reaches ? [] : [{ agent, kind: "blocked" }];
  });
}
