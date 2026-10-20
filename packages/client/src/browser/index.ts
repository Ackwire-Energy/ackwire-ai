import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type { AgentBrowserSettings, BrowserHandoff } from "../api/types";
import type { LiveWork } from "../realtime/streams";
import { noteHandoffPlace } from "./held";

export * from "./held";
export * from "./input";
export * from "./live";
export * from "./trail";
export * from "./watches";

/**
 * The agent browser on connected computers (ADR 0040), shared by the web and
 * the phone app: settings, a person's turn in the browser (the request the
 * agent made, or a take over) and the live view.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The scope that lets an agent use its browser (not covered by "all tools"). */
export const BROWSER_TOOL_SCOPE = "browser:use";

/** The request on an agent's chat card (`meta.browserHandoff`), checked. */
export function browserHandoffOf(meta: unknown): BrowserHandoff | null {
  if (!isObject(meta)) return null;
  const h = meta.browserHandoff;
  if (!isObject(h)) return null;
  return typeof h.id === "string" && typeof h.agentId === "string" && typeof h.status === "string"
    ? (h as unknown as BrowserHandoff)
    : null;
}

/** Still waiting for someone, or someone is in it now. */
export const isOpenHandoff = (h: Pick<BrowserHandoff, "status">) => h.status === "pending" || h.status === "active";

/** Waiting for someone to open it, not yet expired. */
export function isWaitingHandoff(h: Pick<BrowserHandoff, "status" | "expiresAt">, now = Date.now()): boolean {
  if (h.status !== "pending") return false;
  return !h.expiresAt || new Date(h.expiresAt).getTime() > now;
}

/** Whole minutes left before a waiting request expires (at least 1 while it lasts); null without a deadline. */
export function handoffMinutesLeft(h: Pick<BrowserHandoff, "expiresAt">, now = Date.now()): number | null {
  if (!h.expiresAt) return null;
  const ms = new Date(h.expiresAt).getTime() - now;
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** How much of a waiting request's time is left, 0–1 (the card's fuse). */
export function handoffFuse(h: Pick<BrowserHandoff, "createdAt" | "expiresAt">, now = Date.now()): number {
  if (!h.expiresAt) return 0;
  const start = new Date(h.createdAt).getTime();
  const end = new Date(h.expiresAt).getTime();
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (end - now) / (end - start)));
}

/** A tool of the agent browser (`browser_open`, `browser_click`, …). */
export const isBrowserTool = (tool: string | null | undefined) =>
  Boolean(tool?.replace(/^mcp__agentes__/, "").startsWith("browser_"));

/**
 * The agent is in its browser now: its current tool, or its latest call, is a browser tool
 * (the progress bar then says so and opens the live view).
 */
export function usesBrowser(run: { tool?: string | null; work?: LiveWork[] }): boolean {
  if (isBrowserTool(run.tool)) return true;
  const work = run.work ?? [];
  for (let i = work.length - 1; i >= 0; i--) {
    const w = work[i];
    if (w?.kind === "call") return isBrowserTool(w.tool);
  }
  return false;
}

/** One line of "what the agent is doing in its browser", from its run's live work. */
export interface BrowserStep {
  id: string;
  tool: string;
  detail: string | null;
  running: boolean;
  since?: number;
}

/** The browser calls of a run, in order (the watching card's log). */
export function browserSteps(work: LiveWork[] | undefined): BrowserStep[] {
  return (work ?? []).flatMap((w) =>
    w.kind === "call" && isBrowserTool(w.tool)
      ? [
          {
            id: w.id,
            // A computer brain's call carries the bridge's prefix (`mcp__agentes__browser_open`).
            tool: w.tool.replace(/^mcp__agentes__/, ""),
            detail: w.detail,
            running: w.running,
            ...(w.since ? { since: w.since } : {}),
          },
        ]
      : [],
  );
}

/**
 * The page the agent's browser is on, as best known: the live frame's address, else the
 * site of its latest open (or new tab). Null before either exists.
 */
export function browserSiteUrl(frameUrl: string | null | undefined, steps: BrowserStep[]): string | null {
  if (frameUrl && !/^about:/i.test(frameUrl)) return frameUrl;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && (s.tool === "browser_open" || s.tool === "browser_tabs") && s.detail) return s.detail;
  }
  return null;
}

/**
 * A request changed (an action's answer, `browser.handoff.updated`): every cached view of it follows.
 * `place`: the conversation the event came in (a take over's run lives there: its held card).
 */
export function applyBrowserHandoff(
  qc: QueryClient,
  orgId: string,
  handoff: BrowserHandoff,
  place?: { channelId: string; threadId: string | null },
) {
  if (place) noteHandoffPlace(handoff, place.channelId, place.threadId);
  qc.setQueryData(keys.browserHandoff(orgId, handoff.id), handoff);
  qc.setQueryData<BrowserHandoff | null>(keys.agentBrowserHandoff(orgId, handoff.agentId), (old) =>
    isOpenHandoff(handoff) ? handoff : old?.id === handoff.id || old === undefined ? null : old,
  );
}

export const useAgentBrowserSettings = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentBrowser(orgId, agentId),
    queryFn: () => api.browser.settings(orgId, agentId),
    enabled,
    retry: false,
  });
};

/** Saves the sites an agent's browser may open (null: any site). */
export function useUpdateAgentBrowserSettings(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (allowedDomains: string[] | null) => api.browser.setDomains(orgId, agentId, allowedDomains),
    meta: { silent: true },
    onSuccess: (saved: AgentBrowserSettings) => qc.setQueryData(keys.agentBrowser(orgId, agentId), saved),
  });
}

/**
 * The agent's open request or take over (who is in control), if any. `staleTime`: how long a
 * fetched answer is trusted (the realtime event keeps it current meanwhile).
 */
export const useAgentBrowserHandoff = (orgId: string, agentId: string, enabled = true, staleTime = 0) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentBrowserHandoff(orgId, agentId),
    queryFn: () => api.browser.agentHandoff(orgId, agentId),
    enabled,
    retry: false,
    staleTime,
  });
};

export const useBrowserHandoff = (orgId: string, handoffId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.browserHandoff(orgId, handoffId ?? ""),
    queryFn: () => api.browser.handoff(orgId, handoffId ?? ""),
    enabled: Boolean(handoffId),
    retry: false,
  });
};

/** "Assumir" from a run's card: the run it is bound to (its card stays in that conversation). */
export interface TakeoverInput {
  agentId: string;
  runId?: string;
}

/**
 * "Abrir" (take control), "Pronto", "Não consegui", cancel, "Assumir" while watching,
 * and "Parar" (close the agent's browser), as React Query mutations (`.mutate`,
 * `.isPending`). Each answer updates the cached request.
 */
export function useBrowserHandoffMutations(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const apply = (h: BrowserHandoff) => applyBrowserHandoff(qc, orgId, h);
  return {
    takeControl: useMutation({
      mutationFn: (handoffId: string) => api.browser.takeControl(orgId, handoffId),
      meta: { silent: true },
      onSuccess: apply,
    }),
    done: useMutation({
      mutationFn: (handoffId: string) => api.browser.done(orgId, handoffId),
      meta: { silent: true },
      onSuccess: apply,
    }),
    failed: useMutation({
      mutationFn: ({ handoffId, note }: { handoffId: string; note?: string }) =>
        api.browser.failed(orgId, handoffId, note),
      meta: { silent: true },
      onSuccess: apply,
    }),
    cancel: useMutation({
      mutationFn: (handoffId: string) => api.browser.cancel(orgId, handoffId),
      meta: { silent: true },
      onSuccess: apply,
    }),
    takeover: useMutation({
      mutationFn: (v: string | TakeoverInput) =>
        typeof v === "string" ? api.browser.takeover(orgId, v) : api.browser.takeover(orgId, v.agentId, v.runId),
      meta: { silent: true },
      onSuccess: apply,
    }),
    stop: useMutation({
      mutationFn: (agentId: string) => api.browser.stop(orgId, agentId),
      meta: { silent: true },
    }),
  };
}

/**
 * The same actions as plain functions returning promises (the phone app's
 * shape): each rejects with the API error (409 when someone else has it).
 * `pending` is true while any of them runs.
 */
export function useBrowserHandoffActions(orgId: string) {
  const m = useBrowserHandoffMutations(orgId);
  return {
    takeControl: (handoffId: string) => m.takeControl.mutateAsync(handoffId),
    done: (handoffId: string) => m.done.mutateAsync(handoffId),
    failed: (handoffId: string, note?: string) => m.failed.mutateAsync({ handoffId, ...(note ? { note } : {}) }),
    cancel: (handoffId: string) => m.cancel.mutateAsync(handoffId),
    takeover: (agentId: string, runId?: string) => m.takeover.mutateAsync(runId ? { agentId, runId } : agentId),
    stop: (agentId: string) => m.stop.mutateAsync(agentId),
    pending:
      m.takeControl.isPending ||
      m.done.isPending ||
      m.failed.isPending ||
      m.cancel.isPending ||
      m.takeover.isPending ||
      m.stop.isPending,
  };
}
