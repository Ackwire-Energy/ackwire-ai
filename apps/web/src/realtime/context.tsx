import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { keys } from "@/api/keys";
import { cacheMessage } from "@/api/queries";
import type { ChannelEvent } from "@/api/types";
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
  const streams = useMemo(() => createStreamsStore(), []);
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);

  useEffect(() => {
    const conn = new RealtimeConnection({ url: realtimeUrl(window.location, orgId), createSocket });
    // Catch up over HTTP after a reconnect: events sent while offline are gone.
    const offReconnect = conn.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel"] });
    });
    conn.start();
    setConnection(conn);
    return () => {
      offReconnect();
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
