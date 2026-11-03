import type { DashboardDeps, WidgetCostEstimate, WidgetSchedule } from "./types";

/**
 * What a widget's refreshes cost (ADR 0134 §7). Placeholder signature: the dashboards service stage writes the body
 * (see the contract).
 *
 * Runs a day (`scheduleRunsPerDay`) × the agent's average cost of a background (routine) run over its last 30 days,
 * from `usage_records` (at least 3 runs: `basis: "history"`); else its model's price (`@agenteschat/providers`
 * catalog) for a typical refresh of 8,000 input and 1,000 output tokens (`basis: "model"`). A computer brain's plan
 * pays (`billedTo: "plan"`): no money. The person must be able to talk to the agent. The Model Gateway's budget
 * check still holds every run.
 */
export async function estimateWidgetCost(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _agentId: string,
  _schedule: WidgetSchedule,
): Promise<WidgetCostEstimate> {
  throw new Error("not implemented");
}
