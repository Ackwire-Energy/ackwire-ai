import type { RoutineRunEndStatus } from "../routine-ledger";
import type { DashboardDeps, WidgetUpdateInput, WidgetView } from "./types";

/**
 * How a widget is redone (ADR 0134 §4–§6): a routine of its own (`routines.target` `{ type: "widget", widgetId,
 * dashboardId }`) whose background run reads, then hands its data to `update_widget`, posting nothing in chat.
 * Placeholder signatures: the refresh stage writes the bodies (see the contract).
 */

/** The tool a widget's refresh run reports through (the only way it speaks). */
export const UPDATE_WIDGET_TOOL = "update_widget";

/** A widget routine's target. */
export interface WidgetRoutineTarget {
  type: "widget";
  widgetId: string;
  dashboardId: string;
}

/**
 * Makes the widget's routine match its row (at most one per widget: name = its title, prompt = its instructions,
 * created by `options.creatorUserId` ?? the widget's creator, access `act`, report `when_new`, trigger `schedule`). A
 * schedule other than `manual` sets `cron` = `WIDGET_SCHEDULE_CRON[schedule]` in its creator's time zone
 * (`routineTimezone`) and its next run. A `manual` widget keeps an existing routine with no next run (`cron` and `rule`
 * null), and gets none until a run is asked (`options.ensure`, as `refreshWidgetNow` does). Returns the routine's id
 * (written to `dashboard_widgets.routine_id`), or null when it has none. Widget routines don't count in
 * `MAX_ACTIVE_ROUTINES` (the workspace's `WIDGET_SCHEDULED_MAX` holds them).
 */
export async function syncWidgetRoutine(
  _deps: DashboardDeps,
  _orgId: string,
  _widgetId: string,
  _options?: { creatorUserId?: string; ensure?: boolean },
): Promise<string | null> {
  throw new Error("not implemented");
}

/** Deletes the widget's routine (the widget is removed, or its board deleted); stops a run in progress quietly. */
export async function dropWidgetRoutine(_deps: DashboardDeps, _orgId: string, _widgetId: string): Promise<void> {
  throw new Error("not implemented");
}

/**
 * "Update now" and "Resolve": queues a manual run of the widget's routine (made first when missing; one whose creator
 * left or can no longer talk to the agent is taken over by `actorId`, and a routine paused by failures is resumed).
 * The widget turns `updating` (`building` while it has no data) and its event goes out. A run already queued or
 * working answers with the widget as it is. `actorId` null: a first build queued by the server (no checks).
 */
export async function refreshWidgetNow(
  _deps: DashboardDeps,
  _actorId: string | null,
  _orgId: string,
  _widgetId: string,
): Promise<WidgetView> {
  throw new Error("not implemented");
}

/**
 * "Ask for a change": queues a manual run carrying the person's words (`routine_runs.event` `{ type:
 * "widget.change", text, byUserId }`); that run may change the widget's title, kind (when the format is `auto` or the
 * change asks for another one) and instructions through `update_widget`. Editors only.
 */
export async function askWidgetChange(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _widgetId: string,
  _text: string,
): Promise<WidgetView> {
  throw new Error("not implemented");
}

/**
 * `update_widget` from a widget's refresh run: checks the spec (`validateWidgetSpec`; the kind may change only on a
 * first build with `auto` or a change request), writes the widget (`ok`, `refreshed_at`, sources, title and
 * instructions when allowed) and a `dashboard_widget_updates` row (keeping `WIDGET_HISTORY_KEPT`), closes the routine
 * run as `reported` with the summary, raises an alert (`widget_alert` to `alert_user_id`) when one is given and the
 * widget's alert is on, resolves an open `widget_failed`, and publishes. With `failed`, the widget fails with
 * `agent_reported` and those words.
 */
export async function applyWidgetUpdate(
  _deps: DashboardDeps,
  _input: { orgId: string; widgetId: string; routineRunId: string; agentRunId: string; update: WidgetUpdateInput },
): Promise<WidgetView> {
  throw new Error("not implemented");
}

/**
 * Called from the routine ledger when a widget routine's run ends (`afterRoutineRunEnded`), in place of the routine's
 * own notifications: an end without an update fails the widget (`no_update`, or the run's code: `budget_exceeded`,
 * `waiting_computer`, `creator_left`…) with one `widget_failed` per failure streak, records a failed history row, and
 * publishes. A `reported` end already applied its update.
 */
export async function widgetRoutineEnded(
  _deps: DashboardDeps,
  _end: {
    orgId: string;
    routineId: string;
    routineRunId: string;
    agentRunId: string | null;
    status: RoutineRunEndStatus;
    code: string | null;
  },
): Promise<void> {
  throw new Error("not implemented");
}
