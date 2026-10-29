import { safeRedirect } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { DesktopRedeemPage } from "@/pages/DesktopRedeemPage";

const KEY = /^[A-Za-z0-9_-]{43}$/;

/**
 * The Mac app's window lands here once signed in (ADR 0036): loading it brings the window to the front
 * (main_window.rs), then on to `to`. With `code`, the app opened it with what the browser handed it
 * (`agenteschat://desktop/sign-in`, deep_link.rs): the window redeems the code first.
 */
export const Route = createFileRoute("/desktop/signed-in")({
  validateSearch: (search: Record<string, unknown>): { to?: string; code?: string } => ({
    to: safeRedirect(search.to),
    code: typeof search.code === "string" && KEY.test(search.code) ? search.code : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (!search.code) throw redirect({ to: search.to ?? "/" });
  },
  component: function DesktopSignedIn() {
    const { code } = Route.useSearch();
    return code ? <DesktopRedeemPage code={code} /> : null;
  },
});
