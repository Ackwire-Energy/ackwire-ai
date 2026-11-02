import { type ConnectionStatus, keys, type Me, RealtimeConnection, realtimeUrl } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AppState } from "react-native";
import { lastCookie, readCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
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
  const { i18n } = useTranslation();
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
        url: realtimeUrl(serverUrl(), orgId),
        createSocket: createSocketFactory(lastCookie),
      });
      connection = c;
      offs.push(c.onStatus((status) => setState({ connection: c, status })));
      offs.push(c.onReconnect(() => void queryClient.invalidateQueries()));
      // Taken out of the workspace: said plainly, then `me` without it opens another one (or the first run).
      offs.push(
        c.onError((code) => {
          if (code !== "membership_revoked") return;
          const name = queryClient.getQueryData<Me>(keys.me)?.organizations.find((o) => o.id === orgId)?.name ?? "";
          Alert.alert(i18n.t("members.remove.goneTitle", { org: name }), i18n.t("members.remove.goneText"));
          void queryClient.invalidateQueries({ queryKey: keys.me });
        }),
      );
      c.start();
      setState({ connection: c, status: c.status });
    });
    return () => {
      stopped = true;
      for (const off of offs) off();
      connection?.stop();
    };
  }, [orgId, active, queryClient, i18n]);

  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>;
}

/** `{ connection, status }`: subscribe to channels with `connection.subscribe(channelId, listener)`. */
export const useRealtime = () => useContext(RealtimeContext);
