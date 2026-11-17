import type { QueryClient } from "@tanstack/react-query";
import type { RegisteredRouter } from "@tanstack/react-router";
import type { i18n as I18n } from "i18next";
import type { ToastStore } from "@/lib/toast";

/**
 * A 401 anywhere means the session ended: nothing cached of it stays, and the sign-in shows, saying why, then leads
 * back here. At the sign-in already there is nothing to do: a 401 there is an answer to what the page itself asked.
 */
export function backToSignIn(app: {
  router: RegisteredRouter;
  queryClient: QueryClient;
  toasts: ToastStore;
  i18n: I18n;
}) {
  const { pathname, search } = app.router.history.location;
  if (pathname.startsWith("/login")) return;
  app.queryClient.clear();
  void app.router.navigate({ to: "/login", search: { redirect: pathname + search } });
  app.toasts.show(app.i18n.t("common.signedOut"));
}
