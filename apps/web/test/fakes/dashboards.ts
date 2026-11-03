/**
 * Test fake — boards and widgets (ADR 0134), same shapes as the server's `…/dashboards/*`, `…/widgets/*` and
 * `…/widget-*` routes. Empty until a test adds boards (`fake.boards`) or calls the client; the home board is made on
 * first read. Every widget the fake makes starts as the server's would (`building` when asked of an agent, `ok` when
 * pinned) and stays so until a test changes it (`fake.finish`). Changes are logged; reads are not.
 */
import type {
  ApiClient,
  Dashboard,
  DashboardSummary,
  PinnableBlock,
  Widget,
  WidgetDetail,
  WidgetSuggestions,
  WidgetUpdate,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { chartBlockToWidgetSpec, sizeToLayout, type WidgetSpec } from "@agenteschat/ui/widgets/spec";
import { clone, mockId } from "./context";

export interface FakeDashboards {
  client: ApiClient["dashboards"];
  /** Every board, homes included (`kind: "home"`, `ownerUserId` the person). */
  boards: Dashboard[];
  history: Map<string, WidgetUpdate[]>;
  suggestions: Map<string, WidgetSuggestions>;
  pinnable: PinnableBlock[];
  /** What a cost estimate answers per run (USD). */
  perRunUsd: number;
  /** A widget's run ended: its data shows (`ok`), or it fails with `failure`. */
  finish(widgetId: string, result: { spec: WidgetSpec; title?: string } | { failure: string; detail?: string }): void;
}

const RUNS: Record<string, number> = { half: 48, hour: 24, day: 1, week: 1 / 7, manual: 0 };

export function createFakeDashboards(
  log: (method: string, ...args: unknown[]) => void,
  now: () => Date,
  me: () => string | null,
): FakeDashboards {
  const at = () => now().toISOString();
  const notFound = (what: "dashboard" | "widget") =>
    new ApiError(404, `${what}.not_found`, what === "dashboard" ? "Dashboard not found" : "Widget not found");
  const summary = (d: Dashboard): DashboardSummary => {
    const { widgets: _w, tiles: _t, ...rest } = d;
    return {
      ...rest,
      mine: d.ownerUserId === me(),
      widgetCount: d.widgets.length,
      thumbs: d.widgets.slice(0, 6).map((w) => ({ agentId: w.agentId, w: w.layout.w })),
    };
  };
  const board = (dashboardId: string) => {
    const d = fake.boards.find((x) => x.id === dashboardId);
    if (!d) throw notFound("dashboard");
    return d;
  };
  const find = (widgetId: string) => {
    for (const d of fake.boards) {
      const w = d.widgets.find((x) => x.id === widgetId);
      if (w) return { d, w };
    }
    throw notFound("widget");
  };
  const touch = (d: Dashboard) => {
    d.updatedAt = at();
    d.widgetCount = d.widgets.length;
    return clone(d);
  };
  const newBoard = (over: Partial<Dashboard>): Dashboard => ({
    id: mockId("dash"),
    kind: "board",
    title: "",
    about: "",
    audience: "private",
    roleIds: [],
    editPolicy: "owner",
    pinned: false,
    position: fake.boards.length,
    owner: null,
    ownerUserId: me(),
    mine: true,
    widgetCount: 0,
    thumbs: [],
    viewerCount: 1,
    canEdit: true,
    canManage: true,
    proposal: null,
    createdAt: at(),
    updatedAt: at(),
    widgets: [],
    tiles: [],
    ...over,
  });
  const newWidget = (d: Dashboard, over: Partial<Widget>): Widget => ({
    id: mockId("widget"),
    dashboardId: d.id,
    agentId: "",
    title: "",
    prompt: "",
    format: "auto",
    kind: null,
    spec: null,
    sources: [],
    layout: { position: d.widgets.length, w: 2, h: 1 },
    schedule: "manual",
    alert: { enabled: false, condition: "" },
    status: "building",
    failure: null,
    refreshedAt: null,
    nextRunAt: null,
    routineId: null,
    sourceMessageId: null,
    createdBy: me() ? { kind: "person", id: me() as string } : null,
    createdAt: at(),
    updatedAt: at(),
    ...over,
  });
  const home = () => {
    let d = fake.boards.find((x) => x.kind === "home" && x.ownerUserId === me());
    if (!d) {
      d = newBoard({
        kind: "home",
        tiles: [
          { key: "waiting", position: 0, w: 2, h: 1 },
          { key: "working", position: 3, w: 2, h: 1 },
        ],
      });
      fake.boards.push(d);
    }
    return d;
  };

  const fake: FakeDashboards = {
    boards: [],
    history: new Map(),
    suggestions: new Map(),
    pinnable: [],
    perRunUsd: 0.015,
    finish(widgetId, result) {
      const { w } = find(widgetId);
      if ("spec" in result) {
        Object.assign(w, {
          spec: result.spec,
          kind: result.spec.kind,
          title: result.title ?? w.title,
          status: "ok",
          failure: null,
          refreshedAt: at(),
        });
      } else {
        Object.assign(w, { status: "failed", failure: { code: result.failure, detail: result.detail ?? null } });
      }
    },
    client: {
      list: async () => {
        const mine = fake.boards.find((x) => x.kind === "home" && x.ownerUserId === me());
        return {
          home: mine ? summary(mine) : null,
          dashboards: fake.boards.filter((x) => x.kind === "board").map(summary),
        };
      },
      get: async (_orgId, dashboardId) => clone(board(dashboardId)),
      home: async () => clone(home()),
      create: async (orgId, input) => {
        log("dashboards.create", orgId, input);
        const d = newBoard({
          title: input.title,
          about: input.about ?? "",
          audience: input.audience,
          roleIds: input.roleIds ?? [],
          editPolicy: input.editPolicy,
        });
        fake.boards.push(d);
        return { ...clone(d), startedIn: input.start ? { channelId: mockId("dm") } : null };
      },
      update: async (orgId, dashboardId, patch) => {
        log("dashboards.update", orgId, dashboardId, patch);
        const d = board(dashboardId);
        Object.assign(d, patch);
        return touch(d);
      },
      share: async (orgId, dashboardId, input) => {
        log("dashboards.share", orgId, dashboardId, input);
        const d = board(dashboardId);
        const { audience, roleIds, editPolicy } = input;
        Object.assign(d, { audience, roleIds, editPolicy, proposal: null });
        return touch(d);
      },
      remove: async (orgId, dashboardId) => {
        log("dashboards.remove", orgId, dashboardId);
        board(dashboardId);
        fake.boards = fake.boards.filter((x) => x.id !== dashboardId);
      },
      saveLayout: async (orgId, dashboardId, input) => {
        log("dashboards.saveLayout", orgId, dashboardId, input);
        const d = board(dashboardId);
        for (const l of input.widgets) {
          const w = d.widgets.find((x) => x.id === l.id);
          if (w) w.layout = { position: l.position, w: l.w, h: l.h };
        }
        if (input.tiles && d.kind === "home") d.tiles = clone(input.tiles);
        d.widgets.sort((a, b) => a.layout.position - b.layout.position);
        return touch(d);
      },
      decideProposal: async (orgId, dashboardId, decision) => {
        log("dashboards.decideProposal", orgId, dashboardId, decision);
        const d = board(dashboardId);
        if (!d.proposal) throw new ApiError(409, "dashboard.proposal_none", "No request is pending");
        if (decision === "publish") Object.assign(d, { audience: d.proposal.audience, roleIds: d.proposal.roleIds });
        d.proposal = null;
        return touch(d);
      },
      createWidget: async (orgId, dashboardId, input) => {
        log("dashboards.createWidget", orgId, dashboardId, input);
        const d = board(dashboardId);
        const w = newWidget(d, {
          agentId: input.agentId,
          title: input.title ?? "",
          prompt: input.prompt,
          format: input.format,
          kind: input.format === "auto" ? null : input.format,
          schedule: input.schedule,
          alert: input.alert ?? { enabled: false, condition: "" },
          layout: { position: d.widgets.length, ...sizeToLayout(input.size ?? "m") },
        });
        d.widgets.push(w);
        touch(d);
        return clone(w);
      },
      pinWidget: async (orgId, dashboardId, input) => {
        log("dashboards.pinWidget", orgId, dashboardId, input);
        const d = board(dashboardId);
        const block = fake.pinnable.find((b) => b.messageId === input.messageId && b.block === input.block);
        const read = chartBlockToWidgetSpec(input.block);
        if (!block || !read) throw new ApiError(404, "widget.block_not_found", "That chart isn't in the message");
        const w = newWidget(d, {
          agentId: block.agentId,
          title: input.title ?? read.title,
          kind: read.spec.kind,
          spec: read.spec as Widget["spec"],
          format: read.spec.kind,
          status: "ok",
          refreshedAt: at(),
          schedule: input.schedule,
          sourceMessageId: input.messageId,
          layout: { position: d.widgets.length, ...sizeToLayout(input.size ?? "m") },
        });
        d.widgets.push(w);
        touch(d);
        return clone(w);
      },
      widget: async (_orgId, widgetId) => {
        const { d, w } = find(widgetId);
        const detail: WidgetDetail = {
          ...clone(w),
          dashboard: { id: d.id, kind: d.kind, title: d.title },
          canEdit: d.canEdit,
          history: clone(fake.history.get(widgetId) ?? []),
        };
        return detail;
      },
      updateWidget: async (orgId, widgetId, patch) => {
        log("dashboards.updateWidget", orgId, widgetId, patch);
        const { d, w } = find(widgetId);
        const { size, dashboardId, ...rest } = patch;
        Object.assign(w, rest, { updatedAt: at() });
        if (size) w.layout = { ...w.layout, ...sizeToLayout(size) };
        if (dashboardId && dashboardId !== d.id) {
          const to = board(dashboardId);
          d.widgets = d.widgets.filter((x) => x.id !== widgetId);
          w.dashboardId = to.id;
          w.layout = { ...w.layout, position: to.widgets.length };
          to.widgets.push(w);
          touch(to);
        }
        touch(d);
        return clone(w);
      },
      removeWidget: async (orgId, widgetId) => {
        log("dashboards.removeWidget", orgId, widgetId);
        const { d } = find(widgetId);
        d.widgets = d.widgets.filter((x) => x.id !== widgetId);
        touch(d);
      },
      refreshWidget: async (orgId, widgetId) => {
        log("dashboards.refreshWidget", orgId, widgetId);
        const { w } = find(widgetId);
        w.status = w.spec ? "updating" : "building";
        w.failure = null;
        return clone(w);
      },
      askWidgetChange: async (orgId, widgetId, text) => {
        log("dashboards.askWidgetChange", orgId, widgetId, text);
        const { w } = find(widgetId);
        w.status = w.spec ? "updating" : "building";
        return clone(w);
      },
      widgetCost: async (_orgId, agentId, schedule) => {
        const runsPerDay = RUNS[schedule] ?? 0;
        const perDayUsd = runsPerDay ? fake.perRunUsd * runsPerDay : null;
        return {
          agentId,
          schedule,
          runsPerDay,
          perRunUsd: fake.perRunUsd,
          perDayUsd,
          perWeekUsd: perDayUsd === null ? null : perDayUsd * 7,
          basis: "history",
          billedTo: "api",
        };
      },
      widgetSuggestions: async (_orgId, agentId) =>
        clone(fake.suggestions.get(agentId) ?? { agentId, sources: [], suggestions: [] }),
      pinnableBlocks: async (_orgId, limit) => clone(fake.pinnable.slice(0, limit ?? 20)),
    },
  };
  return fake;
}
