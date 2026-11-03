import type { Executor } from "@agenteschat/db";
import type {
  AgentMaker,
  CreateDashboardInput,
  CreateWidgetInput,
  DashboardAudience,
  DashboardCreatedView,
  DashboardDeps,
  DashboardEditPolicy,
  DashboardLayoutInput,
  DashboardListView,
  DashboardRow,
  DashboardSummaryView,
  DashboardView,
  ShareDashboardInput,
  UpdateDashboardInput,
  UpdateWidgetInput,
  WidgetDetailView,
  WidgetFormat,
  WidgetRow,
  WidgetSchedule,
  WidgetSize,
  WidgetSpec,
  WidgetUpdateView,
  WidgetView,
} from "./types";

/**
 * Boards and widgets for people (ADR 0134): the HTTP layer's calls, each checking who may (`access.ts`), and the
 * internal inserts agents' tools use. Placeholder signatures: the dashboards service stage writes the bodies (see
 * the contract). Every write publishes through `events.ts`.
 */

// ── Boards ───────────────────────────────────────────────────────────────────

/** The boards the person sees, and their home board if it exists (Dashboards page, the phone's tab). */
export async function listDashboards(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
): Promise<DashboardListView> {
  throw new Error("not implemented");
}

export async function getDashboard(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
): Promise<DashboardView> {
  throw new Error("not implemented");
}

/** The person's home board, made on first use (private, `DEFAULT_HOME_TILES`). */
export async function getOrCreateHome(_deps: DashboardDeps, _actorId: string, _orgId: string): Promise<DashboardView> {
  throw new Error("not implemented");
}

/**
 * A new board owned by the person. A wider audience than `private` needs `post`; `roles` needs 1 to
 * `DASHBOARD_ROLES_MAX` custom roles. At most `DASHBOARDS_MAX` boards per workspace. With `start`, the brief is posted
 * as the person's message in their DM with that agent (`meta.dashboard: { id, title }`), which builds the widgets
 * with its tools; `startedIn` says where.
 */
export async function createDashboard(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _input: CreateDashboardInput,
): Promise<DashboardCreatedView> {
  throw new Error("not implemented");
}

/** Title and about (editors; never a home board's title), pinned (managers). */
export async function updateDashboard(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
  _patch: UpdateDashboardInput,
): Promise<DashboardView> {
  throw new Error("not implemented");
}

/** Who sees and who edits (managers; never a home board). A pending agent request is dropped (and its notice). */
export async function shareDashboard(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
  _input: ShareDashboardInput,
): Promise<DashboardView> {
  throw new Error("not implemented");
}

/** Deletes a board (managers; never a home board): soft delete, and its widgets' routines are deleted. */
export async function deleteDashboard(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
): Promise<void> {
  throw new Error("not implemented");
}

/** Order and sizes of its widgets (and a home board's tiles) after Organize (editors). Unknown ids are refused. */
export async function saveDashboardLayout(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
  _input: DashboardLayoutInput,
): Promise<DashboardView> {
  throw new Error("not implemented");
}

// ── Widgets ──────────────────────────────────────────────────────────────────

/**
 * "+ Widget": a widget the agent builds (`building`), at the end of the board (editors). The person must be able to
 * talk to the agent (`canTalkTo`), the board must have room and a scheduled one must fit `WIDGET_SCHEDULED_MAX`. Its
 * routine is made (`syncWidgetRoutine`) and its first run queued (`refreshWidgetNow`).
 */
export async function createWidget(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
  _input: CreateWidgetInput,
): Promise<WidgetView> {
  throw new Error("not implemented");
}

/**
 * Title, instructions, schedule, alert (its recipient becomes the person who changed it), size, or another board the
 * person edits (editors). A schedule change goes through `syncWidgetRoutine`.
 */
export async function updateWidget(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _widgetId: string,
  _patch: UpdateWidgetInput,
): Promise<WidgetView> {
  throw new Error("not implemented");
}

/** Takes a widget off its board (editors): the row goes with its history; its routine is deleted. */
export async function removeWidget(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _widgetId: string,
): Promise<void> {
  throw new Error("not implemented");
}

/** One widget with its board, the viewer's right to edit and its latest updates (the widget panel and screen). */
export async function getWidget(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _widgetId: string,
): Promise<WidgetDetailView> {
  throw new Error("not implemented");
}

/** A widget's latest updates, newest first (at most `WIDGET_HISTORY_KEPT`). No access check: callers check. */
export async function widgetHistory(
  _db: Executor,
  _orgId: string,
  _widgetId: string,
  _limit?: number,
): Promise<WidgetUpdateView[]> {
  throw new Error("not implemented");
}

// ── Internal: what agents' tools and the refresh stage use ───────────────────

/** A board row as the views need it, for a viewer (`listDashboards`, `getDashboard` and the tools share it). */
export async function dashboardSummary(
  _db: Executor,
  _board: DashboardRow,
  _viewerUserId: string | null,
): Promise<DashboardSummaryView> {
  throw new Error("not implemented");
}

/** A widget row as the apps see it (its routine's next run read with it). */
export async function widgetView(_db: Executor, _row: WidgetRow): Promise<WidgetView> {
  throw new Error("not implemented");
}

/** Throws `widget.scheduled_cap` when one more scheduled widget (not `excludingWidgetId`) would pass the cap. */
export async function assertScheduledRoom(_db: Executor, _orgId: string, _excludingWidgetId?: string): Promise<void> {
  throw new Error("not implemented");
}

/**
 * A board an agent makes (`create_dashboard`): owned by `maker.accountableUserId`, by the agent (`owner_agent_id`),
 * always `private` at first; a wider audience asked for becomes a proposal (`proposeDashboardAudience`).
 */
export async function insertDashboard(
  _deps: DashboardDeps,
  _orgId: string,
  _maker: AgentMaker,
  _input: { title: string; about?: string; editPolicy?: DashboardEditPolicy },
): Promise<DashboardRow> {
  throw new Error("not implemented");
}

/**
 * A widget made without a person's request in front of it (`create_widget`, a pin): the caps and the board's room are
 * checked, its routine made and, without `spec`, its first build queued. With `spec` it starts `ok` with that data.
 */
export async function insertWidget(
  _deps: DashboardDeps,
  _input: {
    orgId: string;
    dashboardId: string;
    agentId: string;
    title: string;
    prompt: string;
    format: WidgetFormat;
    schedule: WidgetSchedule;
    size?: WidgetSize;
    alert?: { enabled: boolean; condition: string; userId: string | null };
    spec?: WidgetSpec | null;
    sources?: string[];
    sourceMessageId?: string | null;
    createdByUserId: string | null;
    createdByRunId?: string | null;
  },
): Promise<WidgetRow> {
  throw new Error("not implemented");
}

/** A board's audience set by a decision (a proposal published): no permission check, publishes `wide` events. */
export async function setDashboardAudience(
  _deps: DashboardDeps,
  _board: DashboardRow,
  _audience: DashboardAudience,
  _roleIds: string[],
): Promise<DashboardRow> {
  throw new Error("not implemented");
}

/**
 * Someone left the workspace (`removeMember`): their home board and private boards are deleted with their widgets'
 * routines; boards others see stay (admins manage them).
 */
export async function dropMemberDashboards(_tx: Executor, _orgId: string, _userId: string): Promise<void> {
  throw new Error("not implemented");
}
