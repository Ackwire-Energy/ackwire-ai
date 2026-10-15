import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "@/api/queries";
import { landingFor } from "@/lib/guards";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { LandingPage } from "@/pages/landing/LandingPage";

/** Entry point: signed in, the last organization or onboarding; signed out, the landing page. */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    if (!me) return;
    const landing = landingFor(me, storage.get(STORAGE_KEYS.lastOrg));
    if ("to" in landing) throw redirect({ to: landing.to });
    throw redirect({ to: "/org/$orgId", params: { orgId: landing.orgId } });
  },
  component: LandingPage,
});
