import type { DashboardDeps, DashboardProposalDecision, DashboardView } from "./types";

/**
 * An agent never shows a board to more people by itself (ADR 0134 §11). Placeholder signatures: the refresh and
 * tools stage writes the bodies (see the contract).
 */

/**
 * Records the agent's request on the board (`dashboards.proposal`, replacing a pending one) and tells the person it
 * asks (the board's owner) with a waiting `dashboard_proposal` notification (group `dashboard-proposal:<id>`). A
 * narrower or equal audience isn't a proposal: callers apply it.
 */
export async function proposeDashboardAudience(
  _deps: DashboardDeps,
  _input: {
    orgId: string;
    dashboardId: string;
    agentId: string;
    runId: string | null;
    audience: "workspace" | "roles";
    roleIds: string[];
    why: string;
  },
): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Publish or Keep only for me, by the person asked (`dashboard.proposal_not_yours` otherwise; `post` needed to
 * publish): `publish` sets the audience asked for (`setDashboardAudience`), `keep` leaves it; either clears the request
 * and resolves its notification.
 */
export async function decideDashboardProposal(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
  _decision: DashboardProposalDecision,
): Promise<DashboardView> {
  throw new Error("not implemented");
}
