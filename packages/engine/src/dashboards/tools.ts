import type { ToolSource } from "../tools/types";
import type { DashboardDeps } from "./types";

/**
 * Agents' dashboard tools (ADR 0134 §10). Placeholder signature: the refresh and tools stage writes the body (see the
 * contract).
 *
 * - `list_dashboards`: the boards the person behind the run edits (and their home), with their widgets' titles.
 * - `create_dashboard` `{ title, about?, audience?, roles?, why? }`: a board for the person behind the run (else the
 *   accountable person), private; a wider `audience` becomes a proposal to them.
 * - `create_widget` `{ dashboard_id?, title, prompt, kind?, schedule, alert?, size?, data? }`: on a board that person
 *   edits (default: the board the run was asked for in `meta.dashboard`, else their home); `data` (a `WidgetSpec`)
 *   shows at once, else the first build is queued.
 * - `share_dashboard` `{ dashboard_id, audience, roles?, why }`: narrower applies (on a board the agent made), wider is
 *   a proposal; a routine's or unattended run only ever proposes.
 * - `update_widget` `{ data?, summary, sources?, title?, prompt?, alert?, failed? }`: listed only on a widget's refresh
 *   run (its brief's `widget`), once per run.
 */
export function createDashboardToolSource(_deps: DashboardDeps): ToolSource {
  throw new Error("not implemented");
}
