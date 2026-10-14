import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { createApiClient } from "./api";
import { AppProviders, type AppServices } from "./app/providers";
import { createQueryClient } from "./app/query-client";
import { createBetterAuthClient } from "./auth/better-auth";
import { createI18n, savedLocale } from "./i18n";
import { createToastStore } from "./lib/toast";
import { routeTree } from "./routeTree.gen";

const i18n = createI18n(savedLocale());
document.documentElement.lang = i18n.language;
const toasts = createToastStore();
// Demo data for the mock-backed features only in development (src/api/mock).
const api = createApiClient({ seed: import.meta.env.DEV });

/** A 401 anywhere means the session ended: back to sign-in, then here again. */
function onUnauthorized() {
  if (window.location.pathname.startsWith("/login")) return;
  const redirect = window.location.pathname + window.location.search;
  queryClient.clear();
  void router.navigate({ to: "/login", search: { redirect } });
  toasts.show(i18n.t("common.signedOut"));
}

const queryClient = createQueryClient({
  onUnauthorized,
  onMutationError: (message) => toasts.show(message, "error"),
  unknownError: () => i18n.t("common.unknownError"),
});

const router = createRouter({
  routeTree,
  context: { queryClient, api },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const services: AppServices = { api, auth: createBetterAuthClient(), queryClient, i18n, toasts };

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <AppProviders services={services}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
