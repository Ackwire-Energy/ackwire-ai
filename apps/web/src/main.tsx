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
const api = createApiClient();

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
  // Page changes cross-fade where the browser has the View Transitions API (CSS fallback in layout.css).
  defaultViewTransition: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// The connector OAuth callback reports failures as `/?connector_error=…`.
const connectorError = new URLSearchParams(window.location.search).get("connector_error");
if (connectorError) {
  toasts.show(i18n.t("connectors.errorToast", { reason: connectorError }), "error");
  window.history.replaceState(null, "", window.location.pathname);
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
