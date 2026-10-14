import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { keys } from "@/api/keys";
import { cacheApproval, cacheMessage } from "@/api/queries";
import type { Agent, BudgetEvent, ChannelEvent } from "@/api/types";
import { formatUsd } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { type ConnectionStatus, RealtimeConnection, realtimeUrl, type SocketFactory } from "./connection";
import { applyChannelEvent, dismissRun, emptyStreams, type StreamsState } from "./streams";

/** A small external store for live runs, shared by the channel and the sidebar. */
export function createStreamsStore(initial: StreamsState = emptyStreams) {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: StreamsState) => {
    if (next === state) return;
    state = next;
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    apply: (event: ChannelEvent) => set(applyChannelEvent(state, event)),
    dismiss: (runId: string) => set(dismissRun(state, runId)),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type StreamsStore = ReturnType<typeof createStreamsStore>;

interface RealtimeValue {
  connection: RealtimeConnection | null;
  streams: StreamsStore;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

const browserSocket: SocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<SocketFactory>;

/** Which WebSocket to open (tests provide a fake; the app uses the browser's). */
export const SocketFactoryContext = createContext<SocketFactory>(browserSocket);

/** One WebSocket per organization, opened while the org shell is mounted. */
/** Text of a budget alert for the agent's owner. */
export function budgetAlert(t: TFunction, locale: string, event: BudgetEvent, agentName: string) {
  const spent = formatUsd(t, locale, event.spentNanoUsd / 1e9);
  const budget = formatUsd(t, locale, event.budgetNanoUsd / 1e9);
  return event.type === "budget.exhausted"
    ? t("budget.exhausted", { name: agentName, budget })
    : t("budget.warning", { name: agentName, spent, budget });
}

export function RealtimeProvider({
  orgId,
  createSocket: explicit,
  children,
}: {
  orgId: string;
  createSocket?: SocketFactory;
  children: ReactNode;
}) {
  const fromContext = useContext(SocketFactoryContext);
  const createSocket = explicit ?? fromContext;
  const qc = useQueryClient();
  const toast = useToast();
  const { t, i18n } = useTranslation();
  const streams = useMemo(() => createStreamsStore(), []);
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);
  // Latest `t` without reconnecting when the language changes.
  const tRef = useRef(t);
  tRef.current = t;

  // biome-ignore lint/correctness/useExhaustiveDependencies: one socket per org; toast and language are read live
  useEffect(() => {
    const conn = new RealtimeConnection({ url: realtimeUrl(window.location, orgId), createSocket });
    // Catch up over HTTP after a reconnect: events sent while offline are gone.
    const offReconnect = conn.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel"] });
    });
    // Approvals I can decide arrive here even when I'm not in that channel (sidebar badge, Aprovações).
    const offUser = conn.onUserEvent((event) => {
      if ((event.type === "approval.created" || event.type === "approval.decided") && "approval" in event) {
        cacheApproval(qc, orgId, event.approval);
        void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
        void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
      }
      if ((event.type === "budget.warning" || event.type === "budget.exhausted") && "agentId" in event) {
        const budgetEvent = event as BudgetEvent;
        const agent = qc.getQueryData<Agent[]>(keys.agents(orgId))?.find((a) => a.id === budgetEvent.agentId);
        toast.show(budgetAlert(tRef.current, i18n.language, budgetEvent, agent?.name ?? ""), "error");
        void qc.invalidateQueries({ queryKey: keys.agentDetail(orgId, budgetEvent.agentId) });
        void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
      }
    });
    conn.start();
    setConnection(conn);
    return () => {
      offReconnect();
      offUser();
      conn.stop();
      setConnection(null);
    };
  }, [orgId, createSocket, qc]);

  return <RealtimeContext.Provider value={{ connection, streams }}>{children}</RealtimeContext.Provider>;
}

function useRealtime() {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error("useRealtime must be used inside RealtimeProvider");
  return value;
}

/** Subscribes to a channel while mounted: live runs + message cache updates. */
export function useChannelRealtime(orgId: string, channelId: string, enabled: boolean) {
  const { connection, streams } = useRealtime();
  const qc = useQueryClient();
  useEffect(() => {
    if (!connection || !enabled) return;
    return connection.subscribe(channelId, (event) => {
      streams.apply(event);
      if (event.type === "approval.created" || event.type === "approval.decided") {
        cacheApproval(qc, orgId, event.approval);
      }
      if (event.type === "message.created") {
        if (event.message) cacheMessage(qc, orgId, event.message);
        else void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
        // A new top-level message may get agent replies in its thread: start watching it.
        if (event.message && !event.message.threadId) {
          qc.setQueryData(keys.thread(orgId, channelId, event.message.id), (list: unknown) => list ?? []);
        }
      }
    });
  }, [connection, enabled, orgId, channelId, qc, streams]);
}

export function useStreams<T>(select: (state: StreamsState) => T): T {
  const { streams } = useRealtime();
  const state = useSyncExternalStore(streams.subscribe, streams.get, streams.get);
  return select(state);
}

export function useDismissRun() {
  return useRealtime().streams.dismiss;
}

export function useConnectionStatus(): ConnectionStatus {
  const { connection } = useRealtime();
  const [status, setStatus] = useState<ConnectionStatus>(connection?.status ?? "idle");
  useEffect(() => {
    if (!connection) return;
    setStatus(connection.status);
    return connection.onStatus(setStatus);
  }, [connection]);
  return status;
}
