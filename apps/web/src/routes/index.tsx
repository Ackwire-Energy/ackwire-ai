import { authConfigQuery, meQuery } from "@agenteschat/client";
import { landingFor } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { LandingPage } from "@/pages/landing/LandingPage";

/**
 * Entry point: signed in, the last organization or onboarding; signed out, the
 * landing page where the server shows it (LANDING_PAGE), else sign-in.
 */
export const Route = createFileRoute("/")({
  // `?confirm=` comes from the waiting list's confirmation email.
  validateSearch: (search: Record<string, unknown>): { confirm?: string } =>
    typeof search.confirm === "string" ? { confirm: search.confirm } : {},
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    if (!me) {
      const config = await context.queryClient.ensureQueryData(authConfigQuery(context.api));
      if (!config.landing) throw redirect({ to: "/login" });
      return;
    }
    const landing = landingFor(me, storage.get(STORAGE_KEYS.lastOrg));
    if ("to" in landing) throw redirect({ to: landing.to });
    throw redirect({ to: "/org/$orgId", params: { orgId: landing.orgId } });
  },
  component: LandingPage,
});
