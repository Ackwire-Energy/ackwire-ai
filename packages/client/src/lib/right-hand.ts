import type { ApiClient } from "../api/client";
import type { Agent } from "../api/types";

/** The workspace's right hand (ADR 0134): every surface that treats it apart asks here. */
export const isRightHand = (agent: Pick<Agent, "builtin"> | null | undefined) => agent?.builtin === "right_hand";

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
 * Ends a workspace's onboarding, for good, and says where it opens: its right hand's DM (ADR 0134), which takes the
 * setup on from there; the workspace itself (`agentId` null) when there is none to open.
 */
export async function finishOnboarding(api: ApiClient, orgId: string) {
  await api.orgs.saveOnboarding(orgId, { finished: true });
  const rightHand = rightHandOf(await api.agents.list(orgId).catch(() => []));
  return { orgId, agentId: rightHand?.id ?? null };
}

/**
 * The card under the right hand's greeting at the top of its DM (ADR 0134): Connect AI while there is none, how to
 * start once there is one and no agent besides it (for whoever may create agents), then, the team here and nobody
 * else yet, what next; none after that.
 */
export function introCard(s: {
  noAi: boolean;
  /** The AI status has loaded. */
  aiKnown: boolean;
  /** Agents besides the right hand. */
  team: number;
  createsAgents: boolean;
  /** The person is the workspace's only member. */
  alone: boolean;
}): "connect" | "start" | "next" | null {
  if (s.noAi) return "connect";
  if (s.aiKnown && s.team === 0 && s.createsAgents) return "start";
  return s.team > 0 && s.alone ? "next" : null;
}
