import type { DashboardDeps, WidgetSuggestionsView } from "./types";

/**
 * "+ Widget"'s suggestions for one agent (ADR 0134 §3). Placeholder signature: the dashboards service stage writes
 * the body (see the contract).
 *
 * `sources`: the names of the connections the agent may read (its connector grants). `suggestions`: three things it
 * could keep up to date, each with a kind and an alert condition, asked once of the workspace's cheap model through
 * the Model Gateway (`resolveSummaryModel`, usage recorded with the org and the agent) from its role, instructions and
 * sources, in the person's language; kept in the per-process cache for a day per agent and language. No model or no
 * `deps.context`: no suggestions (never an error). The person must be able to talk to the agent.
 */
export async function widgetSuggestions(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _agentId: string,
): Promise<WidgetSuggestionsView> {
  throw new Error("not implemented");
}
