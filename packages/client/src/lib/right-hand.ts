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
