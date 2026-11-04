import { keys, useMe } from "@agenteschat/client";
import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { finishOnboarding } from "@agenteschat/client/lib/right-hand";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { useServerLocale } from "@/i18n";
import { OnboardingPage } from "@/pages/OnboardingPage";

export const Route = createFileRoute("/onboarding")({
  // `?resume=<orgId>`: back from that workspace's plan (`/org/$orgId/onboarding`, ADR 0079), `paid` after paying;
  // `?delete=1`: its dialog that deletes the workspace.
  validateSearch: (search: Record<string, unknown>): { resume?: string; paid?: true; delete?: 1 } => ({
    ...(typeof search.resume === "string" ? { resume: search.resume } : {}),
    ...(isPaidReturn(search) ? { paid: true } : {}),
    ...(search.delete === undefined ? {} : { delete: 1 as const }),
  }),
  beforeLoad: ({ context, location }) => requireUser(context, location.href),
  loaderDeps: ({ search }) => ({ resume: search.resume, paid: search.paid }),
  // Back from its plan, the workspace is set up already: its right hand's DM opens (ADR 0137), the payment still
  // said as being confirmed there. One that can't be finished from here opens as it is.
  loader: async ({ context, deps: { resume, paid } }) => {
    if (!resume) return;
    const at = await finishOnboarding(context.api, resume).catch(() => null);
    await context.queryClient.refetchQueries({ queryKey: keys.me });
    const search = paid ? { paid: true as const } : {};
    if (at?.agentId)
      throw redirect({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: resume, agentId: at.agentId }, search });
    throw redirect({ to: "/org/$orgId", params: { orgId: resume }, search });
  },
  component: function Onboarding() {
    useServerLocale(useMe().data?.user);
    return <OnboardingPage />;
  },
});
