import { type ConnectionStatus, RealtimeConnection, realtimeUrl } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { API_URL } from "@/config";
import { lastCookie, readCookie } from "@/lib/auth";
import { createSocketFactory } from "@/lib/socket";
import { useOrgMaybe } from "./org";

export interface RealtimeState {
  /** The organization's WebSocket (null while signed out, without an organization, or in the background). */
  connection: RealtimeConnection | null;
  status: ConnectionStatus;
}

const RealtimeContext = createContext<RealtimeState>({ connection: null, status: "idle" });

/**
 * One WebSocket per organization (`/api/ws?orgId=`), with the session cookie and the app header on the
 * upgrade. It closes in the background and opens again (with a fresh cookie) when the app comes back;
 * after a reconnect the screens' data is refetched (realtime is best effort, the database is the truth).
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const org = useOrgMaybe();
  const orgId = org?.orgId ?? null;
  const queryClient = useQueryClient();
  const [active, setActive] = useState(AppState.currentState === "active");
  const [state, setState] = useState<RealtimeState>({ connection: null, status: "idle" });

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!orgId || !active) {
      setState({ connection: null, status: "idle" });
      return;
    }
    let stopped = false;
    let connection: RealtimeConnection | null = null;
    const offs: (() => void)[] = [];
    void readCookie().then(() => {
      if (stopped) return;
      const c = new RealtimeConnection({
        url: realtimeUrl(API_URL, orgId),
        createSocket: createSocketFactory(lastCookie),
      });
      connection = c;
      offs.push(c.onStatus((status) => setState({ connection: c, status })));
      offs.push(c.onReconnect(() => void queryClient.invalidateQueries()));
      c.start();
      setState({ connection: c, status: c.status });
    });
    return () => {
      stopped = true;
      for (const off of offs) off();
      connection?.stop();
    };
  }, [orgId, active, queryClient]);

  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>;
}

/** `{ connection, status }`: subscribe to channels with `connection.subscribe(channelId, listener)`. */
export const useRealtime = () => useContext(RealtimeContext);
