import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type {
  CreateDashboardInput,
  CreateWidgetInput,
  Dashboard,
  DashboardLayoutInput,
  DashboardProposalDecision,
  PinWidgetInput,
  ShareDashboardInput,
  UpdateDashboardInput,
  UpdateWidgetInput,
  Widget,
  WidgetDetail,
  WidgetSchedule,
} from "./types";

/**
 * React Query hooks for boards and widgets (ADR 0134). Every write puts what came back in the cache and refreshes the
 * list; `dashboard.changed` and `dashboard.widget` events (`applyDashboardEvent`) keep everything live. Errors are the
 * caller's to say (`meta.silent`), translated by code.
 */

/** A board came back: the one, the home board when it is it, and the list. */
export function cacheDashboard(qc: QueryClient, orgId: string, board: Dashboard) {
  qc.setQueryData(keys.dashboard(orgId, board.id), board);
  if (board.kind === "home") qc.setQueryData(keys.dashboardHome(orgId), board);
  void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
}

/** A widget came back: put it on its board (wherever that board is cached) and in its detail. */
export function cacheWidget(qc: QueryClient, orgId: string, widget: Widget) {
  const put = (board: Dashboard | undefined) => {
    if (!board) return board;
    const others = board.widgets.filter((w) => w.id !== widget.id);
    // Moved to another board: it leaves this one.
    if (board.id !== widget.dashboardId) {
      return others.length === board.widgets.length ? board : { ...board, widgets: others, widgetCount: others.length };
    }
    const widgets = board.widgets.some((w) => w.id === widget.id)
      ? board.widgets.map((w) => (w.id === widget.id ? widget : w))
      : [...board.widgets, widget];
    return { ...board, widgets, widgetCount: widgets.length };
  };
  for (const [key, board] of qc.getQueriesData<Dashboard>({ queryKey: [...keys.dashboards(orgId), "one"] })) {
    qc.setQueryData(key, put(board));
  }
  qc.setQueryData<Dashboard>(keys.dashboardHome(orgId), (board) => put(board));
  qc.setQueryData<WidgetDetail>(keys.widget(orgId, widget.id), (old) => (old ? { ...old, ...widget } : old));
  void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
}

/** A widget was taken off: out of every cached board, its detail dropped. */
export function dropWidget(qc: QueryClient, orgId: string, widgetId: string) {
  const drop = (board: Dashboard | undefined) => {
    if (!board?.widgets.some((w) => w.id === widgetId)) return board;
    const widgets = board.widgets.filter((w) => w.id !== widgetId);
    return { ...board, widgets, widgetCount: widgets.length };
  };
  for (const [key, board] of qc.getQueriesData<Dashboard>({ queryKey: [...keys.dashboards(orgId), "one"] })) {
    qc.setQueryData(key, drop(board));
  }
  qc.setQueryData<Dashboard>(keys.dashboardHome(orgId), (board) => drop(board));
  qc.removeQueries({ queryKey: keys.widget(orgId, widgetId) });
  void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The Dashboards page and the phone's tab. */
export function useDashboards(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.dashboardList(orgId),
    queryFn: () => api.dashboards.list(orgId),
    enabled,
    staleTime: 30_000,
  });
}

export function useDashboard(orgId: string, dashboardId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.dashboard(orgId, dashboardId ?? ""),
    queryFn: () => api.dashboards.get(orgId, dashboardId ?? ""),
    enabled: Boolean(dashboardId),
    staleTime: 30_000,
  });
}

/** My home board (the Início mural, "My Home"), made on first use. */
export function useHomeDashboard(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.dashboardHome(orgId),
    queryFn: () => api.dashboards.home(orgId),
    enabled,
    staleTime: 30_000,
  });
}

/** One widget with its history (the side panel, the phone's widget screen). */
export function useWidget(orgId: string, widgetId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widget(orgId, widgetId ?? ""),
    queryFn: () => api.dashboards.widget(orgId, widgetId ?? ""),
    enabled: Boolean(widgetId),
    staleTime: 15_000,
  });
}

/** The cost line of "New widget" for an agent and a schedule. */
export function useWidgetCost(
  orgId: string,
  agentId: string | null | undefined,
  schedule: WidgetSchedule,
  enabled = true,
) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widgetCost(orgId, agentId ?? "", schedule),
    queryFn: () => api.dashboards.widgetCost(orgId, agentId ?? "", schedule),
    enabled: Boolean(agentId) && enabled && schedule !== "manual",
    staleTime: 5 * 60_000,
  });
}

/** What the agent reads and its suggestions ("New widget"). */
export function useWidgetSuggestions(orgId: string, agentId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widgetSuggestions(orgId, agentId ?? ""),
    queryFn: () => api.dashboards.widgetSuggestions(orgId, agentId ?? ""),
    enabled: Boolean(agentId) && enabled,
    staleTime: 60 * 60_000,
  });
}

/** "Pin from chat": the charts agents sent where I read. */
export function usePinnableBlocks(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widgetPinnable(orgId),
    queryFn: () => api.dashboards.pinnableBlocks(orgId),
    enabled,
    staleTime: 30_000,
  });
}

// ── Boards ───────────────────────────────────────────────────────────────────

export function useCreateDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (input: CreateDashboardInput) => api.dashboards.create(orgId, input),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

export function useUpdateDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...patch }: UpdateDashboardInput & { dashboardId: string }) =>
      api.dashboards.update(orgId, dashboardId, patch),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

export function useShareDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: ShareDashboardInput & { dashboardId: string }) =>
      api.dashboards.share(orgId, dashboardId, input),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

export function useDeleteDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (dashboardId: string) => api.dashboards.remove(orgId, dashboardId),
    onSuccess: (_, dashboardId) => {
      qc.removeQueries({ queryKey: keys.dashboard(orgId, dashboardId) });
      void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
    },
  });
}

/**
 * "Organize": the new order and sizes show at once (`optimistic`), the server's answer replaces them, and a failure
 * puts the board back as it was.
 */
export function useSaveLayout(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: DashboardLayoutInput & { dashboardId: string; home?: boolean }) =>
      api.dashboards.saveLayout(orgId, dashboardId, { widgets: input.widgets, tiles: input.tiles }),
    onMutate: ({ dashboardId, home, widgets, tiles }) => {
      const key = home ? keys.dashboardHome(orgId) : keys.dashboard(orgId, dashboardId);
      const before = qc.getQueryData<Dashboard>(key);
      if (before) {
        const at = new Map(widgets.map((w) => [w.id, w]));
        qc.setQueryData<Dashboard>(key, {
          ...before,
          widgets: before.widgets.map((w) => {
            const next = at.get(w.id);
            return next ? { ...w, layout: { position: next.position, w: next.w, h: next.h } } : w;
          }),
          tiles: tiles ?? before.tiles,
        });
      }
      return { key, before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) qc.setQueryData(context.key, context.before);
    },
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

/** Publish or Keep only for me, on an agent's request. */
export function useDecideDashboardProposal(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, decision }: { dashboardId: string; decision: DashboardProposalDecision }) =>
      api.dashboards.decideProposal(orgId, dashboardId, decision),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

// ── Widgets ──────────────────────────────────────────────────────────────────

export function useCreateWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: CreateWidgetInput & { dashboardId: string }) =>
      api.dashboards.createWidget(orgId, dashboardId, input),
    onSuccess: (widget) => cacheWidget(qc, orgId, widget),
  });
}

export function usePinWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: PinWidgetInput & { dashboardId: string }) =>
      api.dashboards.pinWidget(orgId, dashboardId, input),
    onSuccess: (widget) => cacheWidget(qc, orgId, widget),
  });
}

export function useUpdateWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ widgetId, ...patch }: UpdateWidgetInput & { widgetId: string }) =>
      api.dashboards.updateWidget(orgId, widgetId, patch),
    onSuccess: (widget) => cacheWidget(qc, orgId, widget),
  });
}

export function useRemoveWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (widgetId: string) => api.dashboards.removeWidget(orgId, widgetId),
    onSuccess: (_, widgetId) => dropWidget(qc, orgId, widgetId),
  });
}

/** "Update now" and "Resolve". */
export function useRefreshWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (widgetId: string) => api.dashboards.refreshWidget(orgId, widgetId),
    onSuccess: (widget) => cacheWidget(qc, orgId, widget),
  });
}

/** "Ask for a change" (the widget panel's composer). */
export function useAskWidgetChange(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ widgetId, text }: { widgetId: string; text: string }) =>
      api.dashboards.askWidgetChange(orgId, widgetId, text),
    onSuccess: (widget) => {
      cacheWidget(qc, orgId, widget);
      void qc.invalidateQueries({ queryKey: keys.widget(orgId, widget.id) });
    },
  });
}
