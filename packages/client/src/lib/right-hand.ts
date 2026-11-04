import type { ApiClient } from "../api/client";
import type { Agent } from "../api/types";
import { PRESETS } from "./onboarding";

/** The workspace's right hand (ADR 0137): every surface that treats it apart asks here. */
export const isRightHand = (agent: Pick<Agent, "builtin"> | null | undefined) => agent?.builtin === "right_hand";

/** Its one-time "Novo" is per person and workspace (`seenList` entries), gone once its DM opened. */
export const rightHandSeenKey = (userId: string, orgId: string) => `${userId}.${orgId}`;

/** The workspace's right hand among its agents, when this person may see it. */
export const rightHandOf = <A extends Pick<Agent, "builtin">>(agents: readonly A[]) => agents.find(isRightHand);

/**
 * Its name and look before the workspace exists (the onboarding's first question): the server's
 * `RIGHT_HAND_DEFAULTS` (packages/engine/src/right-hand.ts).
 */
export const RIGHT_HAND_DEFAULT = {
  name: "Lodi",
  appearance: { color: "teal", eyes: "happy", accessory: "headset" },
} as const;

/**
 * Ends a workspace's onboarding, for good, and says where it opens: its right hand's DM (ADR 0137), which takes the
 * setup on from there; the workspace itself (`agentId` null) when there is none to open.
 */
export async function finishOnboarding(api: ApiClient, orgId: string) {
  await api.orgs.saveOnboarding(orgId, { finished: true });
  const rightHand = rightHandOf(await api.agents.list(orgId).catch(() => []));
  return { orgId, agentId: rightHand?.id ?? null };
}

/** The ready-made agents not created yet, by handle. */
export const presetsLeft = (teamHandles: readonly string[]) => PRESETS.filter((p) => !teamHandles.includes(p));

/**
 * The cards under the right hand's greeting at the top of its DM (ADR 0137): Connect AI while there is none. With one,
 * how to start (for whoever may create agents): with no agent yet, or, still alone, while the team is only ready-made
 * agents and some are left, each tile its own Criar. And, the team here and nobody else yet, what next. None after.
 */
export function introCards(s: {
  noAi: boolean;
  /** The AI status has loaded. */
  aiKnown: boolean;
  /** The handles of the agents besides the right hand. */
  teamHandles: readonly string[];
  createsAgents: boolean;
  /** The person is the workspace's only member. */
  alone: boolean;
}): ("connect" | "start" | "next")[] {
  if (s.noAi) return ["connect"];
  const presets = new Set<string>(PRESETS);
  const start =
    s.aiKnown &&
    s.createsAgents &&
    (s.teamHandles.length === 0 ||
      (s.alone && presetsLeft(s.teamHandles).length > 0 && s.teamHandles.every((h) => presets.has(h))));
  const next = s.teamHandles.length > 0 && s.alone;
  return [...(start ? (["start"] as const) : []), ...(next ? (["next"] as const) : [])];
}
