import { meQuery } from "@agenteschat/client";
import { landingFor } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { showWorkspace } from "@/lib/start";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/**
 * Entry point: signed in, the last organization (opened anew: where the person chose, ADR 0108) or onboarding;
 * signed out, sign-in (the landing page is its own site, `LANDING_URL`). `?open=jev` (the desktop app's Jev row) goes
 * on to Settings › AI accounts, where the server's owner finds Jev's key, after signing in if need be.
 */
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { open?: "jev" } =>
    search.open === "jev" ? { open: "jev" as const } : {},
  beforeLoad: async ({ context, search, preload }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    if (!me)
      throw redirect({ to: "/login", ...(search.open ? { search: { redirect: `/?open=${search.open}` } } : {}) });
    const landing = landingFor(me, storage.get(STORAGE_KEYS.lastOrg));
    if ("to" in landing) throw redirect({ to: landing.to });
    if (search.open === "jev") {
      throw redirect({
        to: "/org/$orgId/settings/$section",
        params: { orgId: landing.orgId, section: "usage" },
        hash: "jev",
      });
    }
    if (!preload) showWorkspace(null);
    throw redirect({ to: "/org/$orgId", params: { orgId: landing.orgId } });
  },
});
