import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { landingFor } from "@/lib/guards";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/** Entry point: the last organization, onboarding, or sign-in. */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context, location }) => {
    const me = await requireUser(context, location.href);
    const landing = landingFor(me, storage.get(STORAGE_KEYS.lastOrg));
    if ("to" in landing) throw redirect({ to: landing.to });
    throw redirect({ to: "/org/$orgId", params: { orgId: landing.orgId } });
  },
});
