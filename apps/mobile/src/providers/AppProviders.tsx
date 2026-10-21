import { ApiProvider, createSnapshot } from "@agenteschat/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo } from "react";
import { I18nextProvider } from "react-i18next";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { frameClock } from "@/agent/clock";
import { createApi } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { useServer } from "@/lib/server";
import { snapshotStore } from "@/lib/snapshot";
import { ToastHost } from "@/ui/Toast";
import { ThemeProvider } from "@/ui/theme";
import { setupI18n } from "./i18n";
import { OrgProvider } from "./org";
import { PushProvider } from "./push";
import { bindFocusToAppState, createQueryClient } from "./query";
import { RealtimeProvider } from "./realtime";
import { SessionProvider } from "./session";

const i18n = setupI18n();

/**
 * Everything the screens rely on, outermost first: gestures, safe areas, the keyboard (its height and
 * position on the UI thread, for the chat), theme, i18n, React Query, the API
 * client (`useApi`), the session, the current organization (`useOrg`), realtime (`useRealtime`), push and
 * toasts (`useToast`). Living agents pause while the app is in the background.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const server = useServer();
  // Each server gets its own cache, API client and auth client, so no data or session crosses servers.
  const scope = useMemo(
    () => ({ queryClient: createQueryClient(), api: createApi(server), auth: authClient() }),
    [server],
  );

  useEffect(() => bindFocusToAppState(), []);
  // The last lists and chats saved on this phone show at once; everything revalidates as usual. Saved again
  // when the app goes to the background. Leaving a server clears its cache, and with it the saved snapshot.
  useEffect(() => {
    const { queryClient } = scope;
    const snapshot = createSnapshot(queryClient, snapshotStore);
    const stop = snapshot.start();
    void snapshot.restore();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "background") void snapshot.flush();
    });
    return () => {
      queryClient.clear();
      stop();
      sub.remove();
    };
  }, [scope]);
  useEffect(() => {
    frameClock.setPaused(AppState.currentState !== "active");
    const sub = AppState.addEventListener("change", (s) => frameClock.setPaused(s !== "active"));
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            <I18nextProvider i18n={i18n}>
              <QueryClientProvider client={scope.queryClient}>
                <ApiProvider client={scope.api}>
                  <SessionProvider auth={scope.auth}>
                    <OrgProvider>
                      <RealtimeProvider>
                        <PushProvider>
                          <ToastHost>{children}</ToastHost>
                        </PushProvider>
                      </RealtimeProvider>
                    </OrgProvider>
                  </SessionProvider>
                </ApiProvider>
              </QueryClientProvider>
            </I18nextProvider>
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
