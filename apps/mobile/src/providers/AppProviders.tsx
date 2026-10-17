import { ApiProvider } from "@agenteschat/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { frameClock } from "@/agent/clock";
import { api } from "@/lib/api";
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
 * Everything the screens rely on, outermost first: gestures, safe areas, theme, i18n, React Query, the API
 * client (`useApi`), the session, the current organization (`useOrg`), realtime (`useRealtime`), push and
 * toasts (`useToast`). Living agents pause while the app is in the background.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  useEffect(() => bindFocusToAppState(), []);
  useEffect(() => {
    frameClock.setPaused(AppState.currentState !== "active");
    const sub = AppState.addEventListener("change", (s) => frameClock.setPaused(s !== "active"));
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <I18nextProvider i18n={i18n}>
            <QueryClientProvider client={queryClient}>
              <ApiProvider client={api}>
                <SessionProvider>
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
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
