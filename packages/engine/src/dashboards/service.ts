import { and, type Database, desc, type Executor, eq, inArray, isNull, ne, schema, sql } from "@agenteschat/db";
import {
  DASHBOARDS_MAX,
  defaultSize,
  isWidgetFormat,
  isWidgetKind,
  isWidgetSchedule,
  isWidgetSize,
  sizeToLayout,
  validateWidgetSpec,
  WIDGET_HISTORY_KEPT,
  WIDGET_SCHEDULED_MAX,
  WIDGET_STATUSES,
  WIDGETS_PER_DASHBOARD_MAX,
  widgetSpecOf,
} from "@agenteschat/ui/widgets/spec";
import { type Agent, getAgent } from "../agents";
import { canTalkTo, speakerOf } from "../audience";
import { openDm } from "../dms";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { postPersonMessage } from "../messages";
import { resolveDashboardProposal, resolveWidgetNotices } from "../notification-producers";
import { getMembership, type Membership, requireActiveMembership } from "../organizations";
import {
  type AudienceMember,
  audienceMembers,
  countViewers,
  type DashboardViewer,
  dashboardRights,
  dashboardSeerSql,
  dashboardViewerCount,
  requireDashboard,
  requireWidget,
  viewerOf,
} from "./access";
import { publishDashboardChanged, publishWidgetChanged } from "./events";
import { dropWidgetRoutine, refreshWidgetNow, syncWidgetRoutine } from "./refresh";
import {
  type AgentMaker,
  type CreateDashboardInput,
  type CreateWidgetInput,
  DASHBOARD_ABOUT_MAX,
  DASHBOARD_AUDIENCES,
  DASHBOARD_EDIT_POLICIES,
  DASHBOARD_ERRORS,
  DASHBOARD_ROLES_MAX,
  DASHBOARD_TITLE_MAX,
  type DashboardAudience,
  type DashboardCreatedView,
  type DashboardDeps,
  type DashboardEditPolicy,
  type DashboardLayoutInput,
  type DashboardListView,
  type DashboardRow,
  type DashboardSummaryView,
  type DashboardView,
  DEFAULT_HOME_TILES,
  type HomeTile,
  type ShareDashboardInput,
  type UpdateDashboardInput,
  type UpdateWidgetInput,
  WIDGET_ALERT_CONDITION_MAX,
  WIDGET_FAILURES,
  WIDGET_PROMPT_MAX,
  WIDGET_TITLE_MAX,
  type WidgetDetailView,
  type WidgetFormat,
  type WidgetRow,
  type WidgetSchedule,
  type WidgetSize,
  type WidgetSpec,
  type WidgetStatus,
  type WidgetUpdateView,
  type WidgetView,
} from "./types";

const { dashboards, dashboardWidgets, dashboardWidgetUpdates, agents, users, routines, orgRoles } = schema;

/**
 * Boards and widgets for people (ADR 0134): the HTTP layer's calls, each checking who may (`access.ts`), and the
 * internal inserts agents' tools use. Every write publishes through `events.ts`.
 */

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();
const publishForbidden = () =>
  new ForbiddenError("Showing a dashboard to others needs permission to post", DASHBOARD_ERRORS.publishForbidden);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Checks shared by the calls ───────────────────────────────────────────────

function boardTitle(raw: string | undefined): string {
  const title = oneLine(raw ?? "").slice(0, DASHBOARD_TITLE_MAX).trim();
  if (!title) throw new ValidationError("A dashboard needs a title", DASHBOARD_ERRORS.titleRequired);
  return title;
}

const boardAbout = (raw: string | undefined) => (raw ?? "").trim().slice(0, DASHBOARD_ABOUT_MAX).trim();

function audienceOf(raw: unknown): DashboardAudience {
  if (!DASHBOARD_AUDIENCES.includes(raw as DashboardAudience)) throw new ValidationError("Unknown audience");
  return raw as DashboardAudience;
}

function editPolicyOf(raw: unknown): DashboardEditPolicy {
  if (!DASHBOARD_EDIT_POLICIES.includes(raw as DashboardEditPolicy)) throw new ValidationError("Unknown edit policy");
  return raw as DashboardEditPolicy;
}

/**
 * The roles a `roles` board is shown to, checked as a channel's (ADR 0125): 1 to `DASHBOARD_ROLES_MAX` custom roles
 * of the workspace (never `everyone`, which is `workspace`). Any other audience takes none.
 */
export async function dashboardRoleIds(
  db: Executor,
  orgId: string,
  audience: DashboardAudience,
  roleIds: readonly string[] | undefined,
): Promise<string[]> {
  if (audience !== "roles") return [];
  const wanted = [...new Set(roleIds ?? [])];
  if (wanted.length === 0) throw new ValidationError("Pick at least one role", DASHBOARD_ERRORS.rolesRequired);
  if (wanted.length > DASHBOARD_ROLES_MAX) {
    throw new ValidationError(`At most ${DASHBOARD_ROLES_MAX} roles`, "invalid_request", { max: DASHBOARD_ROLES_MAX });
  }
  const unknown = () => new ValidationError("Every role must be one of the workspace's", DASHBOARD_ERRORS.roleUnknown);
  if (wanted.some((id) => !UUID.test(id))) throw unknown();
  const known = await db
    .select({ id: orgRoles.id })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, wanted)));
  if (known.length !== wanted.length) throw unknown();
  return wanted;
}

/**
 * Whether going from one audience to another shows the board to anyone who didn't see it (ADR 0134 §8, §11):
 * private → anything else, roles → workspace, or roles gaining a role. Narrowing (or the same) is not.
 */
export function widensDashboardAudience(
  from: { audience: string; roleIds: readonly string[] },
  to: { audience: string; roleIds: readonly string[] },
): boolean {
  if (to.audience === "private" || from.audience === "workspace") return false;
  if (to.audience === "workspace" || from.audience === "private") return true;
  return to.roleIds.some((id) => !from.roleIds.includes(id));
}

/**
 * The agent a widget is asked of: in the team (`widget.agent_archived` otherwise) and one the person can talk to
 * (`widget.agent_unreachable`, its audience as for a message, ADR 0085).
 */
export async function requireReachableAgent(
  db: Database,
  orgId: string,
  agentId: string,
  actorId: string,
  membership: Membership,
): Promise<Agent> {
  const agent = UUID.test(agentId) ? await getAgent(db, orgId, agentId) : null;
  if (!agent) throw new NotFoundError("Agent not found");
  if (agent.archivedAt) {
    throw new ValidationError(`${agent.name} is archived`, DASHBOARD_ERRORS.agentArchived, { agentName: agent.name });
  }
  if (!canTalkTo(agent, actorId, speakerOf(membership))) {
    throw new ForbiddenError(`You can't talk to ${agent.name}`, DASHBOARD_ERRORS.agentUnreachable, {
      agentName: agent.name,
    });
  }
  return agent;
}

async function assertBoardRoom(db: Executor, orgId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dashboards)
    .where(and(eq(dashboards.orgId, orgId), eq(dashboards.kind, "board"), isNull(dashboards.deletedAt)));
  if (Number(row?.n ?? 0) >= DASHBOARDS_MAX) {
    throw new ValidationError(`A workspace keeps at most ${DASHBOARDS_MAX} dashboards`, DASHBOARD_ERRORS.tooMany, {
      max: DASHBOARDS_MAX,
    });
  }
}

/** Where a new board goes in the list: after the others. */
async function nextBoardPosition(db: Executor, orgId: string) {
  const [row] = await db
    .select({ top: sql<number | null>`max(${dashboards.position})` })
    .from(dashboards)
    .where(and(eq(dashboards.orgId, orgId), eq(dashboards.kind, "board"), isNull(dashboards.deletedAt)));
  return row?.top == null ? 0 : Number(row.top) + 1;
}

const tooManyWidgets = () =>
  new ValidationError("Too many widgets on this dashboard", DASHBOARD_ERRORS.widgetTooMany, {
    max: WIDGETS_PER_DASHBOARD_MAX,
  });

/** How many widgets a board holds and the position after its last one (and a home board's tiles). */
async function boardFill(db: Executor, board: Pick<DashboardRow, "id" | "kind" | "homeTiles">) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int`, top: sql<number | null>`max(${dashboardWidgets.position})` })
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, board.id));
  const tiles = board.kind === "home" ? tilesOf(board.homeTiles) : [];
  const top = Math.max(row?.top == null ? -1 : Number(row.top), ...tiles.map((t) => t.position));
  return { count: Number(row?.n ?? 0), next: Math.floor(top) + 1 };
}

/** A home board's tiles as stored, cleaned (unknown keys and repeats dropped). */
function tilesOf(raw: unknown): HomeTile[] {
  if (!Array.isArray(raw)) return [];
  const out: HomeTile[] = [];
  for (const t of raw as Partial<HomeTile>[]) {
    if (!t || (t.key !== "waiting" && t.key !== "working") || out.some((o) => o.key === t.key)) continue;
    out.push({
      key: t.key,
      position: typeof t.position === "number" && Number.isFinite(t.position) ? t.position : 0,
      w: t.w === 2 ? 2 : 1,
      h: t.h === 2 ? 2 : 1,
    });
  }
  return out;
}

const span = (n: number): 1 | 2 => (n >= 2 ? 2 : 1);

// ── Views ────────────────────────────────────────────────────────────────────

const isStatus = (v: string): v is WidgetStatus => (WIDGET_STATUSES as readonly string[]).includes(v);

function toWidgetView(row: WidgetRow, nextRunAt: Date | null): WidgetView {
  const schedule: WidgetSchedule = isWidgetSchedule(row.schedule) ? row.schedule : "manual";
  const status: WidgetStatus = isStatus(row.status) ? row.status : "building";
  return {
    id: row.id,
    dashboardId: row.dashboardId,
    agentId: row.agentId,
    title: row.title,
    prompt: row.prompt,
    format: isWidgetFormat(row.format) ? row.format : "auto",
    kind: isWidgetKind(row.kind) ? row.kind : null,
    spec: row.spec ? widgetSpecOf(row.spec) : null,
    sources: row.sources,
    layout: { position: row.position, w: span(row.w), h: span(row.h) },
    schedule,
    alert: { enabled: row.alertEnabled, condition: row.alertCondition },
    status,
    failure:
      status === "failed"
        ? { code: row.failureCode ?? WIDGET_FAILURES.error, detail: row.failureDetail ?? null }
        : null,
    refreshedAt: row.refreshedAt?.toISOString() ?? null,
    nextRunAt: schedule !== "manual" && nextRunAt ? nextRunAt.toISOString() : null,
    routineId: row.routineId,
    sourceMessageId: row.sourceMessageId,
    createdBy: row.createdByUserId
      ? { kind: "person", id: row.createdByUserId }
      : row.createdByRunId
        ? { kind: "agent", id: row.agentId }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Widget rows as the apps see them, their routines' next runs read in one query. */
export async function widgetViews(db: Executor, rows: readonly WidgetRow[]): Promise<WidgetView[]> {
  const routineIds = [...new Set(rows.flatMap((r) => (r.routineId && r.schedule !== "manual" ? [r.routineId] : [])))];
  const next = new Map<string, Date | null>();
  if (routineIds.length > 0) {
    for (const r of await db
      .select({ id: routines.id, nextRunAt: routines.nextRunAt })
      .from(routines)
      .where(and(inArray(routines.id, routineIds), isNull(routines.deletedAt), eq(routines.active, true))))
      next.set(r.id, r.nextRunAt);
  }
  return rows.map((r) => toWidgetView(r, r.routineId ? (next.get(r.routineId) ?? null) : null));
}

/** A widget row as the apps see it (its routine's next run read with it). */
export async function widgetView(db: Executor, row: WidgetRow): Promise<WidgetView> {
  const [view] = await widgetViews(db, [row]);
  if (!view) throw new Error("widget view missing");
  return view;
}

/** Each board's widgets, in board order. */
async function widgetsOf(db: Executor, boardIds: readonly string[]): Promise<Map<string, WidgetRow[]>> {
  const out = new Map<string, WidgetRow[]>(boardIds.map((id) => [id, []]));
  if (boardIds.length === 0) return out;
  const rows = await db
    .select()
    .from(dashboardWidgets)
    .where(inArray(dashboardWidgets.dashboardId, [...boardIds]))
    .orderBy(dashboardWidgets.position, dashboardWidgets.createdAt, dashboardWidgets.id);
  for (const r of rows) out.get(r.dashboardId)?.push(r);
  return out;
}

const ownOnly = (b: Pick<DashboardRow, "kind" | "audience">) => b.kind === "home" || b.audience === "private";

/** Summaries of `boards` for `viewer` (null: the server, which decides nothing), with names and counts batched. */
async function summarize(
  db: Executor,
  boards: readonly DashboardRow[],
  viewer: DashboardViewer | null,
  widgets: Map<string, WidgetRow[]>,
): Promise<DashboardSummaryView[]> {
  if (boards.length === 0) return [];
  const orgId = boards[0]?.orgId ?? "";
  const agentIds = [...new Set(boards.flatMap((b) => (b.ownerAgentId ? [b.ownerAgentId] : [])))];
  const userIds = [...new Set(boards.flatMap((b) => (b.ownerUserId ? [b.ownerUserId] : [])))];
  const roleIds = [...new Set(boards.flatMap((b) => b.audienceRoleIds))];
  const [agentRows, userRows, roleRows] = await Promise.all([
    agentIds.length
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [],
    userIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    roleIds.length
      ? db
          .select({ id: orgRoles.id })
          .from(orgRoles)
          .where(and(eq(orgRoles.orgId, orgId), inArray(orgRoles.id, roleIds)))
      : [],
  ]);
  const agentNames = new Map(agentRows.map((a) => [a.id, a.name]));
  const userNames = new Map(userRows.map((u) => [u.id, u.name]));
  const liveRoles = new Set(roleRows.map((r) => r.id));
  // Members are read once for every board shown to more than its owner.
  const members: AudienceMember[] | null = boards.some((b) => !ownOnly(b))
    ? boards.length === 1
      ? null
      : await audienceMembers(db, orgId)
    : [];
  const out: DashboardSummaryView[] = [];
  for (const b of boards) {
    const list = widgets.get(b.id) ?? [];
    const rights = viewer ? dashboardRights(b, viewer) : { see: true, edit: false, manage: false };
    const viewerCount = ownOnly(b)
      ? b.ownerUserId
        ? 1
        : 0
      : members
        ? countViewers(b, members)
        : await dashboardViewerCount(db, b);
    const refreshed = list.reduce((t, w) => Math.max(t, w.refreshedAt?.getTime() ?? 0), 0);
    const agentName = b.ownerAgentId ? agentNames.get(b.ownerAgentId) : undefined;
    const userName = b.ownerUserId ? userNames.get(b.ownerUserId) : undefined;
    const p = b.proposal;
    out.push({
      id: b.id,
      kind: b.kind === "home" ? "home" : "board",
      title: b.title,
      about: b.about,
      audience: DASHBOARD_AUDIENCES.includes(b.audience as DashboardAudience)
        ? (b.audience as DashboardAudience)
        : "private",
      roleIds: b.audienceRoleIds.filter((id) => liveRoles.has(id)),
      editPolicy: b.editPolicy === "viewers" ? "viewers" : "owner",
      pinned: b.pinned,
      position: b.position,
      owner:
        b.ownerAgentId && agentName !== undefined
          ? { kind: "agent", id: b.ownerAgentId, name: agentName }
          : b.ownerUserId && userName !== undefined
            ? { kind: "person", id: b.ownerUserId, name: userName }
            : null,
      ownerUserId: b.ownerUserId,
      mine: !!viewer && b.ownerUserId === viewer.userId,
      widgetCount: list.length,
      thumbs: list.slice(0, 6).map((w) => ({ agentId: w.agentId, w: span(w.w) })),
      viewerCount,
      canEdit: rights.edit,
      canManage: rights.manage,
      proposal:
        p && rights.see
          ? {
              audience: p.audience,
              roleIds: p.roleIds,
              agentId: p.agentId,
              why: p.why,
              at: p.at,
              canDecide: !!viewer && b.ownerUserId === viewer.userId,
            }
          : null,
      createdAt: b.createdAt.toISOString(),
      updatedAt: new Date(Math.max(b.updatedAt.getTime(), refreshed)).toISOString(),
    });
  }
  return out;
}

/** The viewer behind a user id (null when they aren't a member). */
async function viewerFor(db: Executor, orgId: string, userId: string | null): Promise<DashboardViewer | null> {
  if (!userId) return null;
  const membership = await getMembership(db, userId, orgId);
  return membership ? viewerOf(membership, userId) : null;
}

/**
 * A board row as the views need it, for a viewer (`listDashboards`, `getDashboard` and the tools share it). `viewer`:
 * the viewer already read (skips reading their membership again).
 */
export async function dashboardSummary(
  db: Executor,
  board: DashboardRow,
  viewerUserId: string | null,
  viewer?: DashboardViewer | null,
): Promise<DashboardSummaryView> {
  const who = viewer !== undefined ? viewer : await viewerFor(db, board.orgId, viewerUserId);
  const [summary] = await summarize(db, [board], who, await widgetsOf(db, [board.id]));
  if (!summary) throw new Error("dashboard summary missing");
  return summary;
}

/** A whole board for a viewer: its summary, widgets and (home) tiles. */
export async function dashboardView(
  db: Executor,
  board: DashboardRow,
  viewer: DashboardViewer | null,
): Promise<DashboardView> {
  const widgets = await widgetsOf(db, [board.id]);
  const [summary] = await summarize(db, [board], viewer, widgets);
  if (!summary) throw new Error("dashboard view missing");
  return {
    ...summary,
    widgets: await widgetViews(db, widgets.get(board.id) ?? []),
    tiles: board.kind === "home" ? tilesOf(board.homeTiles) : [],
  };
}

const byListOrder = (a: DashboardSummaryView, b: DashboardSummaryView) =>
  Number(b.pinned) - Number(a.pinned) || a.position - b.position || a.title.localeCompare(b.title);

async function loadBoard(db: Executor, orgId: string, dashboardId: string): Promise<DashboardRow> {
  const [board] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.orgId, orgId), eq(dashboards.id, dashboardId), isNull(dashboards.deletedAt)));
  if (!board) throw new NotFoundError("Dashboard not found", DASHBOARD_ERRORS.notFound);
  return board;
}

async function loadWidgetRow(db: Executor, widgetId: string): Promise<WidgetRow> {
  const [row] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId));
  if (!row) throw new NotFoundError("Widget not found", DASHBOARD_ERRORS.widgetNotFound);
  return row;
}

/** An open request or alert about a board or its widgets is done once they are gone (ADR 0134 §6, §11). */
async function resolveBoardNotices(deps: DashboardDeps, orgId: string, dashboardId: string, widgetIds: string[]) {
  const n = { db: deps.db, pubsub: deps.pubsub, now: deps.now };
  // Proposal and failure keys carry a suffix per request/streak, so they are matched by prefix.
  await resolveDashboardProposal(n, orgId, dashboardId);
  for (const id of widgetIds) await resolveWidgetNotices(n, orgId, id);
}

// ── Boards ───────────────────────────────────────────────────────────────────

/** The boards the person sees, and their home board if it exists (Dashboards page, the phone's tab). */
export async function listDashboards(deps: DashboardDeps, actorId: string, orgId: string): Promise<DashboardListView> {
  const membership = await requireActiveMembership(deps.db, actorId, orgId);
  const viewer = viewerOf(membership, actorId);
  const rows = await deps.db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.orgId, orgId), dashboardSeerSql("dashboards", actorId, viewer.admin)));
  const widgets = await widgetsOf(deps.db, rows.map((r) => r.id));
  const views = await summarize(deps.db, rows, viewer, widgets);
  const home = views.find((v) => v.kind === "home" && v.ownerUserId === actorId) ?? null;
  return { home, dashboards: views.filter((v) => v.kind === "board").sort(byListOrder) };
}

export async function getDashboard(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  dashboardId: string,
): Promise<DashboardView> {
  const { board, viewer } = await requireDashboard(deps.db, actorId, orgId, dashboardId, "see");
  return dashboardView(deps.db, board, viewer);
}

/** A person's home board, made the first time it is asked for (no access check: callers check). */
export async function ensureHomeBoard(deps: DashboardDeps, orgId: string, userId: string): Promise<DashboardRow> {
  const find = async () =>
    (
      await deps.db
        .select()
        .from(dashboards)
        .where(
          and(
            eq(dashboards.orgId, orgId),
            eq(dashboards.ownerUserId, userId),
            eq(dashboards.kind, "home"),
            isNull(dashboards.deletedAt),
          ),
        )
    )[0];
  const found = await find();
  if (found) return found;
  // One home per person (`dashboards_one_home`): a second request racing this one finds the first's row.
  const [made] = await deps.db
    .insert(dashboards)
    .values({
      orgId,
      kind: "home",
      title: "",
      ownerUserId: userId,
      audience: "private",
      editPolicy: "owner",
      homeTiles: DEFAULT_HOME_TILES.map((t) => ({ ...t })),
    })
    .onConflictDoNothing()
    .returning();
  if (made) {
    await publishDashboardChanged(deps.pubsub, made);
    return made;
  }
  const raced = await find();
  if (!raced) throw new Error("home board missing");
  return raced;
}

/** The person's home board, made on first use (private, `DEFAULT_HOME_TILES`). */
export async function getOrCreateHome(deps: DashboardDeps, actorId: string, orgId: string): Promise<DashboardView> {
  const membership = await requireActiveMembership(deps.db, actorId, orgId);
  const board = await ensureHomeBoard(deps, orgId, actorId);
  return dashboardView(deps.db, board, viewerOf(membership, actorId));
}

/**
 * A new board owned by the person. A wider audience than `private` needs `post`; `roles` needs 1 to
 * `DASHBOARD_ROLES_MAX` custom roles. At most `DASHBOARDS_MAX` boards per workspace. With `start`, the brief is posted
 * as the person's message in their DM with that agent (`meta.dashboard: { id, title }`), which builds the widgets
 * with its tools; `startedIn` says where.
 */
export async function createDashboard(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  input: CreateDashboardInput,
): Promise<DashboardCreatedView> {
  const membership = await requireActiveMembership(deps.db, actorId, orgId);
  const viewer = viewerOf(membership, actorId);
  const title = boardTitle(input.title);
  const audience = audienceOf(input.audience);
  const editPolicy = editPolicyOf(input.editPolicy);
  if (audience !== "private" && !viewer.mayPublish) {
    throw publishForbidden();
  }
  const roleIds = await dashboardRoleIds(deps.db, orgId, audience, input.roleIds);
  const brief = input.start ? input.start.brief.trim().slice(0, WIDGET_PROMPT_MAX).trim() : "";
  if (input.start) {
    if (!brief) throw new ValidationError("Say what the dashboard should show", DASHBOARD_ERRORS.promptRequired);
    await requireReachableAgent(deps.db, orgId, input.start.agentId, actorId, membership);
  }
  await assertBoardRoom(deps.db, orgId);
  const [board] = await deps.db
    .insert(dashboards)
    .values({
      orgId,
      kind: "board",
      title,
      about: boardAbout(input.about),
      ownerUserId: actorId,
      audience,
      audienceRoleIds: roleIds,
      editPolicy,
      position: await nextBoardPosition(deps.db, orgId),
    })
    .returning();
  if (!board) throw new Error("dashboard insert failed");
  await publishDashboardChanged(deps.pubsub, board);
  let startedIn: DashboardCreatedView["startedIn"] = null;
  if (input.start) {
    // "Ask an agent" (ADR 0134 §10): the brief goes to the agent in the person's DM, where it builds the widgets.
    const dm = await openDm(deps.db, actorId, orgId, { agentId: input.start.agentId });
    await postPersonMessage({ db: deps.db, pubsub: deps.pubsub, judge: deps.context?.judge }, actorId, orgId, dm.id, {
      body: brief,
      meta: { dashboard: { id: board.id, title: board.title } },
    });
    startedIn = { channelId: dm.id };
  }
  return { ...(await dashboardView(deps.db, board, viewer)), startedIn };
}

/** Title and about (editors; never a home board's title), pinned (managers). */
export async function updateDashboard(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  dashboardId: string,
  patch: UpdateDashboardInput,
): Promise<DashboardView> {
  const need = patch.pinned !== undefined ? "manage" : "edit";
  const { board, viewer } = await requireDashboard(deps.db, actorId, orgId, dashboardId, need);
  if (board.kind === "home" && (patch.title !== undefined || patch.pinned !== undefined)) {
    throw new ValidationError("Your home is always yours", DASHBOARD_ERRORS.homeFixed);
  }
  const set: Partial<typeof dashboards.$inferInsert> = {};
  if (patch.title !== undefined) set.title = boardTitle(patch.title);
  if (patch.about !== undefined) set.about = boardAbout(patch.about);
  if (patch.pinned !== undefined) set.pinned = patch.pinned;
  if (Object.keys(set).length === 0) return dashboardView(deps.db, board, viewer);
  const [updated] = await deps.db
    .update(dashboards)
    .set({ ...set, updatedAt: nowOf(deps) })
    .where(eq(dashboards.id, board.id))
    .returning();
  const next = updated ?? board;
  await publishDashboardChanged(deps.pubsub, next);
  return dashboardView(deps.db, next, viewer);
}

/** Who sees and who edits (managers; never a home board). A pending agent request is dropped (and its notice). */
export async function shareDashboard(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  dashboardId: string,
  input: ShareDashboardInput,
): Promise<DashboardView> {
  const { board, viewer } = await requireDashboard(deps.db, actorId, orgId, dashboardId, "manage");
  if (board.kind === "home") throw new ValidationError("Your home is always yours", DASHBOARD_ERRORS.homeFixed);
  const audience = audienceOf(input.audience);
  const editPolicy = editPolicyOf(input.editPolicy);
  const roleIds = await dashboardRoleIds(deps.db, orgId, audience, input.roleIds);
  if (
    widensDashboardAudience({ audience: board.audience, roleIds: board.audienceRoleIds }, { audience, roleIds }) &&
    !viewer.mayPublish
  ) {
    throw publishForbidden();
  }
  const [updated] = await deps.db
    .update(dashboards)
    .set({ audience, audienceRoleIds: roleIds, editPolicy, proposal: null, updatedAt: nowOf(deps) })
    .where(eq(dashboards.id, board.id))
    .returning();
  const next = updated ?? board;
  if (board.proposal) {
    await resolveDashboardProposal({ db: deps.db, pubsub: deps.pubsub, now: deps.now }, orgId, board.id);
  }
  // Wide: people who saw it before may not anymore, and new people may now (ADR 0134 §13).
  await publishDashboardChanged(deps.pubsub, next, { wide: true });
  return dashboardView(deps.db, next, viewer);
}

/** Deletes a board (managers; never a home board): soft delete, and its widgets' routines are deleted. */
export async function deleteDashboard(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  dashboardId: string,
): Promise<void> {
  const { board } = await requireDashboard(deps.db, actorId, orgId, dashboardId, "manage");
  if (board.kind === "home") throw new ValidationError("Your home is always yours", DASHBOARD_ERRORS.homeFixed);
  const widgets = await deps.db
    .select({ id: dashboardWidgets.id })
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, board.id));
  for (const w of widgets) await dropWidgetRoutine(deps, orgId, w.id);
  const at = nowOf(deps);
  await deps.db
    .update(dashboards)
    .set({ deletedAt: at, updatedAt: at, proposal: null, pinned: false })
    .where(eq(dashboards.id, board.id));
  await resolveBoardNotices(deps, orgId, board.id, widgets.map((w) => w.id));
  await publishDashboardChanged(deps.pubsub, board, { deleted: true });
}

function layoutSpan(v: unknown): 1 | 2 {
  if (v !== 1 && v !== 2) throw new ValidationError("A widget is 1 or 2 cells wide and tall");
  return v;
}

function layoutPosition(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError("A position is a number");
  return v;
}

/** Order and sizes of its widgets (and a home board's tiles) after Organize (editors). Unknown ids are refused. */
export async function saveDashboardLayout(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  dashboardId: string,
  input: DashboardLayoutInput,
): Promise<DashboardView> {
  const { board, viewer } = await requireDashboard(deps.db, actorId, orgId, dashboardId, "edit");
  if (input.tiles !== undefined && board.kind !== "home") {
    throw new ValidationError("Only your home has fixed tiles", DASHBOARD_ERRORS.homeFixed);
  }
  const items = input.widgets.map((w) => ({
    id: w.id,
    position: layoutPosition(w.position),
    w: layoutSpan(w.w),
    h: layoutSpan(w.h),
  }));
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new ValidationError("A widget appears twice");
  let tiles: HomeTile[] | undefined;
  if (input.tiles !== undefined) {
    tiles = input.tiles.map((t) => {
      if (t.key !== "waiting" && t.key !== "working") throw new ValidationError("Unknown tile");
      return { key: t.key, position: layoutPosition(t.position), w: layoutSpan(t.w), h: layoutSpan(t.h) };
    });
    if (new Set(tiles.map((t) => t.key)).size !== tiles.length) throw new ValidationError("A tile appears twice");
  }
  const own = new Set(
    (
      await deps.db
        .select({ id: dashboardWidgets.id })
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.dashboardId, board.id))
    ).map((r) => r.id),
  );
  if (items.some((i) => !own.has(i.id))) {
    throw new NotFoundError("That widget isn't on this dashboard", DASHBOARD_ERRORS.widgetNotFound);
  }
  const at = nowOf(deps);
  const next = await deps.db.transaction(async (tx) => {
    for (const i of items) {
      await tx
        .update(dashboardWidgets)
        .set({ position: i.position, w: i.w, h: i.h, updatedAt: at })
        .where(and(eq(dashboardWidgets.id, i.id), eq(dashboardWidgets.dashboardId, board.id)));
    }
    const [row] = await tx
      .update(dashboards)
      .set({ ...(tiles ? { homeTiles: tiles } : {}), updatedAt: at })
      .where(eq(dashboards.id, board.id))
      .returning();
    return row ?? board;
  });
  await publishDashboardChanged(deps.pubsub, next);
  return dashboardView(deps.db, next, viewer);
}

// ── Widgets ──────────────────────────────────────────────────────────────────

function widgetTitle(raw: string | undefined): string {
  return oneLine(raw ?? "").slice(0, WIDGET_TITLE_MAX).trim();
}

function widgetPrompt(raw: string | undefined): string {
  const prompt = (raw ?? "").trim().slice(0, WIDGET_PROMPT_MAX).trim();
  if (!prompt) throw new ValidationError("Say what the widget should show", DASHBOARD_ERRORS.promptRequired);
  return prompt;
}

function scheduleOf(raw: unknown): WidgetSchedule {
  if (!isWidgetSchedule(raw)) throw new ValidationError("Unknown schedule");
  return raw;
}

function sizeOf(raw: unknown): WidgetSize | undefined {
  if (raw === undefined) return undefined;
  if (!isWidgetSize(raw)) throw new ValidationError("Unknown size");
  return raw;
}

const alertCondition = (raw: string | undefined) => (raw ?? "").trim().slice(0, WIDGET_ALERT_CONDITION_MAX).trim();

/**
 * "+ Widget": a widget the agent builds (`building`), at the end of the board (editors). The person must be able to
 * talk to the agent (`canTalkTo`), the board must have room and a scheduled one must fit `WIDGET_SCHEDULED_MAX`. Its
 * routine is made (`syncWidgetRoutine`) and its first run queued (`refreshWidgetNow`).
 */
export async function createWidget(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  dashboardId: string,
  input: CreateWidgetInput,
): Promise<WidgetView> {
  const { board, membership } = await requireDashboard(deps.db, actorId, orgId, dashboardId, "edit");
  const prompt = widgetPrompt(input.prompt);
  if (!isWidgetFormat(input.format)) throw new ValidationError("Unknown format");
  const schedule = scheduleOf(input.schedule);
  const size = sizeOf(input.size);
  const agent = await requireReachableAgent(deps.db, orgId, input.agentId, actorId, membership);
  const alertOn = input.alert?.enabled === true;
  const row = await insertWidget(deps, {
    orgId,
    dashboardId: board.id,
    agentId: agent.id,
    // Until the agent names it on its first run: the person's words.
    title: widgetTitle(input.title) || widgetTitle(prompt),
    prompt,
    format: input.format,
    schedule,
    ...(size ? { size } : {}),
    alert: { enabled: alertOn, condition: alertCondition(input.alert?.condition), userId: alertOn ? actorId : null },
    createdByUserId: actorId,
  });
  return widgetView(deps.db, row);
}

/** Throws `widget.scheduled_cap` when one more scheduled widget (not `excludingWidgetId`) would pass the cap. */
export async function assertScheduledRoom(db: Executor, orgId: string, excludingWidgetId?: string): Promise<void> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(
      and(
        eq(dashboardWidgets.orgId, orgId),
        ne(dashboardWidgets.schedule, "manual"),
        isNull(dashboards.deletedAt),
        excludingWidgetId ? ne(dashboardWidgets.id, excludingWidgetId) : undefined,
      ),
    );
  if (Number(row?.n ?? 0) >= WIDGET_SCHEDULED_MAX) {
    throw new ValidationError(
      `A workspace keeps at most ${WIDGET_SCHEDULED_MAX} widgets updating on a schedule`,
      DASHBOARD_ERRORS.scheduledCap,
      { max: WIDGET_SCHEDULED_MAX },
    );
  }
}

/**
 * A widget made without a person's request in front of it (`create_widget`, a pin): the caps and the board's room are
 * checked, its routine made and, without `spec`, its first build queued. With `spec` it starts `ok` with that data.
 * `routineCreatorUserId`: who its routine runs for (ADR 0053 §1); default its creator, else the board's owner.
 */
export async function insertWidget(
  deps: DashboardDeps,
  input: {
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
    routineCreatorUserId?: string | null;
  },
): Promise<WidgetRow> {
  const { orgId } = input;
  const board = await loadBoard(deps.db, orgId, input.dashboardId);
  let spec: WidgetSpec | null = null;
  if (input.spec) {
    const checked = validateWidgetSpec(input.spec);
    if (!checked.ok) throw new ValidationError(checked.error);
    spec = checked.spec;
  }
  const format: WidgetFormat = isWidgetFormat(input.format) ? input.format : "auto";
  const schedule = scheduleOf(input.schedule);
  const layout = sizeToLayout(input.size ?? defaultSize(format === "auto" ? (spec?.kind ?? null) : format));
  const at = nowOf(deps);
  const title = widgetTitle(input.title) || widgetTitle(input.prompt);
  const row = await deps.db.transaction(async (tx) => {
    // One insert at a time per board, so two can't both take its last place.
    await tx.execute(sql`select id from dashboards where id = ${board.id}::uuid for update`);
    const fill = await boardFill(tx, board);
    if (fill.count >= WIDGETS_PER_DASHBOARD_MAX) throw tooManyWidgets();
    if (schedule !== "manual") await assertScheduledRoom(tx, orgId);
    const [made] = await tx
      .insert(dashboardWidgets)
      .values({
        orgId,
        dashboardId: board.id,
        agentId: input.agentId,
        title,
        prompt: input.prompt.trim().slice(0, WIDGET_PROMPT_MAX),
        format,
        kind: spec ? spec.kind : format === "auto" ? null : format,
        spec: spec ? (spec as unknown as Record<string, unknown>) : null,
        sources: (input.sources ?? []).slice(0, 20),
        position: fill.next,
        w: layout.w,
        h: layout.h,
        schedule,
        alertEnabled: input.alert?.enabled === true,
        alertCondition: alertCondition(input.alert?.condition),
        alertUserId: input.alert?.enabled ? (input.alert.userId ?? null) : null,
        status: spec ? "ok" : "building",
        sourceMessageId: input.sourceMessageId ?? null,
        createdByUserId: input.createdByUserId,
        createdByRunId: input.createdByRunId ?? null,
        refreshedAt: spec ? at : null,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!made) throw new Error("widget insert failed");
    await tx.update(dashboards).set({ updatedAt: at }).where(eq(dashboards.id, board.id));
    return made;
  });
  await publishWidgetChanged(deps.pubsub, board, { id: row.id, status: row.status as WidgetStatus });
  await publishDashboardChanged(deps.pubsub, board);
  const creator = input.routineCreatorUserId ?? input.createdByUserId ?? board.ownerUserId;
  // A scheduled widget gets its routine now; one without data gets one for its first build (ADR 0134 §4).
  const routineId = await syncWidgetRoutine(deps, orgId, row.id, {
    ...(creator ? { creatorUserId: creator } : {}),
    ensure: !spec,
  });
  if (routineId && routineId !== row.routineId) {
    await deps.db.update(dashboardWidgets).set({ routineId }).where(eq(dashboardWidgets.id, row.id));
  }
  if (!spec) await refreshWidgetNow(deps, null, orgId, row.id);
  return loadWidgetRow(deps.db, row.id);
}

/**
 * Title, instructions, schedule, alert (its recipient becomes the person who changed it), size, or another board the
 * person edits (editors). A schedule change goes through `syncWidgetRoutine`.
 */
export async function updateWidget(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  widgetId: string,
  patch: UpdateWidgetInput,
): Promise<WidgetView> {
  const { widget, board, membership } = await requireWidget(deps.db, actorId, orgId, widgetId, "edit");
  const set: Partial<typeof dashboardWidgets.$inferInsert> = {};
  let routineChanged = false;
  if (patch.title !== undefined) {
    const title = widgetTitle(patch.title);
    if (!title) throw new ValidationError("A widget needs a title", DASHBOARD_ERRORS.titleRequired);
    if (title !== widget.title) {
      set.title = title;
      routineChanged = true;
    }
  }
  if (patch.prompt !== undefined) {
    const prompt = widgetPrompt(patch.prompt);
    if (prompt !== widget.prompt) {
      // New instructions are words to its agent: only from someone who may talk to it (ADR 0085).
      await requireReachableAgent(deps.db, orgId, widget.agentId, actorId, membership);
      set.prompt = prompt;
      routineChanged = true;
    }
  }
  if (patch.schedule !== undefined) {
    const schedule = scheduleOf(patch.schedule);
    if (schedule !== widget.schedule) {
      if (schedule !== "manual" && widget.schedule === "manual") await assertScheduledRoom(deps.db, orgId, widget.id);
      set.schedule = schedule;
      routineChanged = true;
    }
  }
  if (patch.alert !== undefined) {
    set.alertEnabled = patch.alert.enabled === true;
    set.alertCondition = alertCondition(patch.alert.condition);
    // Who hears it: whoever turned it on or last changed it (ADR 0134 §6).
    set.alertUserId = patch.alert.enabled ? actorId : null;
  }
  const size = sizeOf(patch.size);
  if (size) {
    const layout = sizeToLayout(size);
    set.w = layout.w;
    set.h = layout.h;
  }
  let target: DashboardRow | null = null;
  if (patch.dashboardId !== undefined && patch.dashboardId !== widget.dashboardId) {
    target = (await requireDashboard(deps.db, actorId, orgId, patch.dashboardId, "edit")).board;
    const fill = await boardFill(deps.db, target);
    if (fill.count >= WIDGETS_PER_DASHBOARD_MAX) throw tooManyWidgets();
    set.dashboardId = target.id;
    set.position = fill.next;
    routineChanged = true;
  }
  if (Object.keys(set).length === 0) return widgetView(deps.db, widget);
  const at = nowOf(deps);
  const [updated] = await deps.db
    .update(dashboardWidgets)
    .set({ ...set, updatedAt: at })
    .where(eq(dashboardWidgets.id, widget.id))
    .returning();
  let row = updated ?? widget;
  if (routineChanged && (row.routineId || row.schedule !== "manual")) {
    const routineId = await syncWidgetRoutine(deps, orgId, row.id);
    if (routineId !== row.routineId) {
      const [synced] = await deps.db
        .update(dashboardWidgets)
        .set({ routineId })
        .where(eq(dashboardWidgets.id, row.id))
        .returning();
      row = synced ?? row;
    } else row = await loadWidgetRow(deps.db, row.id);
  }
  const status = row.status as WidgetStatus;
  if (target) {
    await deps.db.update(dashboards).set({ updatedAt: at }).where(inArray(dashboards.id, [board.id, target.id]));
    await publishWidgetChanged(deps.pubsub, board, { id: row.id, status: "removed" });
    await publishDashboardChanged(deps.pubsub, board);
    await publishWidgetChanged(deps.pubsub, target, { id: row.id, status });
    await publishDashboardChanged(deps.pubsub, target);
  } else {
    await publishWidgetChanged(deps.pubsub, board, { id: row.id, status });
  }
  return widgetView(deps.db, row);
}

/** Takes a widget off its board (editors): the row goes with its history; its routine is deleted. */
export async function removeWidget(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  widgetId: string,
): Promise<void> {
  const { widget, board } = await requireWidget(deps.db, actorId, orgId, widgetId, "edit");
  await dropWidgetRoutine(deps, orgId, widget.id);
  await deps.db.delete(dashboardWidgets).where(eq(dashboardWidgets.id, widget.id));
  await deps.db.update(dashboards).set({ updatedAt: nowOf(deps) }).where(eq(dashboards.id, board.id));
  await resolveWidgetNotices({ db: deps.db, pubsub: deps.pubsub, now: deps.now }, orgId, widget.id);
  await publishWidgetChanged(deps.pubsub, board, { id: widget.id, status: "removed" });
  await publishDashboardChanged(deps.pubsub, board);
}

/** One widget with its board, the viewer's right to edit and its latest updates (the widget panel and screen). */
export async function getWidget(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  widgetId: string,
): Promise<WidgetDetailView> {
  const { widget, board, viewer } = await requireWidget(deps.db, actorId, orgId, widgetId, "see");
  const [view, history] = await Promise.all([
    widgetView(deps.db, widget),
    widgetHistory(deps.db, orgId, widget.id),
  ]);
  return {
    ...view,
    dashboard: { id: board.id, kind: board.kind === "home" ? "home" : "board", title: board.title },
    canEdit: dashboardRights(board, viewer).edit,
    history,
  };
}

/** A widget's latest updates, newest first (at most `WIDGET_HISTORY_KEPT`). No access check: callers check. */
export async function widgetHistory(
  db: Executor,
  orgId: string,
  widgetId: string,
  limit = WIDGET_HISTORY_KEPT,
): Promise<WidgetUpdateView[]> {
  const rows = await db
    .select()
    .from(dashboardWidgetUpdates)
    .where(and(eq(dashboardWidgetUpdates.orgId, orgId), eq(dashboardWidgetUpdates.widgetId, widgetId)))
    .orderBy(desc(dashboardWidgetUpdates.createdAt), desc(dashboardWidgetUpdates.id))
    .limit(Math.max(1, Math.min(limit, WIDGET_HISTORY_KEPT)));
  return rows.map(
    (r): WidgetUpdateView => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      status: r.status === "failed" ? "failed" : "ok",
      summary: r.summary,
      alert: r.alert,
      failureCode: r.failureCode,
      change: r.change,
      costUsd: r.costNanoUsd > 0 ? r.costNanoUsd / 1e9 : null,
    }),
  );
}

// ── Internal: what agents' tools and the refresh stage use ───────────────────

/**
 * A board an agent makes (`create_dashboard`): owned by `maker.accountableUserId`, by the agent (`owner_agent_id`),
 * always `private` at first; a wider audience asked for becomes a proposal (`proposeDashboardAudience`).
 */
export async function insertDashboard(
  deps: DashboardDeps,
  orgId: string,
  maker: AgentMaker,
  input: { title: string; about?: string; editPolicy?: DashboardEditPolicy },
): Promise<DashboardRow> {
  const title = boardTitle(input.title);
  await assertBoardRoom(deps.db, orgId);
  const [board] = await deps.db
    .insert(dashboards)
    .values({
      orgId,
      kind: "board",
      title,
      about: boardAbout(input.about),
      ownerUserId: maker.accountableUserId,
      ownerAgentId: maker.agentId,
      createdByRunId: maker.runId,
      audience: "private",
      editPolicy: input.editPolicy ? editPolicyOf(input.editPolicy) : "owner",
      position: await nextBoardPosition(deps.db, orgId),
    })
    .returning();
  if (!board) throw new Error("dashboard insert failed");
  await publishDashboardChanged(deps.pubsub, board);
  return board;
}

/** A board's audience set by a decision (a proposal published): no permission check, publishes `wide` events. */
export async function setDashboardAudience(
  deps: DashboardDeps,
  board: DashboardRow,
  audience: DashboardAudience,
  roleIds: string[],
): Promise<DashboardRow> {
  const [updated] = await deps.db
    .update(dashboards)
    .set({
      audience,
      audienceRoleIds: audience === "roles" ? [...new Set(roleIds)] : [],
      updatedAt: nowOf(deps),
    })
    .where(eq(dashboards.id, board.id))
    .returning();
  const next = updated ?? board;
  await publishDashboardChanged(deps.pubsub, next, { wide: true });
  return next;
}

/**
 * Someone left the workspace (`removeMember`): their home board and private boards are deleted with their widgets'
 * routines; boards others see stay (admins manage them).
 */
export async function dropMemberDashboards(tx: Executor, orgId: string, userId: string): Promise<void> {
  const at = new Date();
  const gone = await tx
    .update(dashboards)
    .set({ deletedAt: at, updatedAt: at, proposal: null, pinned: false })
    .where(
      and(
        eq(dashboards.orgId, orgId),
        eq(dashboards.ownerUserId, userId),
        isNull(dashboards.deletedAt),
        sql`(${dashboards.kind} = 'home' or ${dashboards.audience} = 'private')`,
      ),
    )
    .returning({ id: dashboards.id });
  if (gone.length === 0) return;
  const ids = gone.map((b) => b.id);
  // Their widgets' routines never fire again (as `dropRoutine` leaves a routine): nobody sees those boards.
  await tx
    .update(routines)
    .set({ active: false, nextRunAt: null, deletedAt: at, updatedAt: at })
    .where(
      and(
        eq(routines.orgId, orgId),
        isNull(routines.deletedAt),
        inArray(
          routines.id,
          tx
            .select({ id: sql<string>`${dashboardWidgets.routineId}` })
            .from(dashboardWidgets)
            .where(and(inArray(dashboardWidgets.dashboardId, ids), sql`${dashboardWidgets.routineId} is not null`)),
        ),
      ),
    );
}
