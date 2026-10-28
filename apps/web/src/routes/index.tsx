import { authConfigQuery, meQuery } from "@agenteschat/client";
import { landingFor } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { inDesktopApp } from "@/lib/desktop";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { LandingPage } from "@/pages/landing/LandingPage";

/**
 * Entry point: signed in, the last organization or onboarding; signed out, the
 * landing page where the server shows it (LANDING_PAGE), else sign-in. The Mac
 * app always goes to sign-in: it never shows the landing page. `?open=jev` (the
 * desktop app's Jev row) goes on to Settings › AI accounts, where the server's
 * owner finds Jev's key, after signing in if need be.
 */
export const Route = createFileRoute("/")({
  // `?confirm=` comes from the waiting list's confirmation email.
  validateSearch: (search: Record<string, unknown>): { confirm?: string; open?: "jev" } => ({
    ...(typeof search.confirm === "string" ? { confirm: search.confirm } : {}),
    ...(search.open === "jev" ? { open: "jev" as const } : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    const back = search.open ? { search: { redirect: `/?open=${search.open}` } } : {};
    if (!me) {
      if (inDesktopApp()) throw redirect({ to: "/login", ...back });
      const config = await context.queryClient.ensureQueryData(authConfigQuery(context.api));
      if (!config.landing) throw redirect({ to: "/login", ...back });
      return;
    }
    const landing = landingFor(me, storage.get(STORAGE_KEYS.lastOrg));
    if ("to" in landing) throw redirect({ to: landing.to });
    if (search.open === "jev") {
      throw redirect({
        to: "/org/$orgId/settings/$section",
        params: { orgId: landing.orgId, section: "keys" },
        hash: "jev",
      });
    }
    throw redirect({ to: "/org/$orgId", params: { orgId: landing.orgId } });
  },
  component: LandingPage,
});
