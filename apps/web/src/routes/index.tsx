import { meQuery } from "@agenteschat/client";
import { landingFor } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/**
 * Entry point: signed in, the last organization or onboarding; signed out,
 * sign-in. The landing page is its own site (agentes.chat, repo lp-agentes.chat).
 */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    if (!me) throw redirect({ to: "/login" });
    const landing = landingFor(me, storage.get(STORAGE_KEYS.lastOrg));
    if ("to" in landing) throw redirect({ to: landing.to });
    throw redirect({ to: "/org/$orgId", params: { orgId: landing.orgId } });
  },
});
