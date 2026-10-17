import { focusManager, QueryClient } from "@tanstack/react-query";
import { AppState, type AppStateStatus } from "react-native";

/** One query client for the app; refetches when the app comes back to the foreground. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
      mutations: { retry: 0 },
    },
  });
}

/** React Query's "window focus" is the app being active. Returns the unsubscribe. */
export function bindFocusToAppState(): () => void {
  const onChange = (s: AppStateStatus) => focusManager.setFocused(s === "active");
  const sub = AppState.addEventListener("change", onChange);
  return () => sub.remove();
}
