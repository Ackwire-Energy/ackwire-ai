import { keys, meQuery, useMe } from "@agenteschat/client";
import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { settingUp } from "@agenteschat/client/lib/guards";
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
  // Paid, the workspace opens in #general, where the team says hi once the plan starts (ADR 0158), the payment said as
  // being confirmed until then; else its right hand's DM, or the workspace as it is. Back without paying, the
  // onboarding resumes on its plan step, unless the workspace was set up meanwhile (another tab): it opens as it is.
  loader: async ({ context, deps: { resume, paid } }) => {
    if (!resume) return;
    const me = await context.queryClient.fetchQuery(meQuery(context.api)).catch(() => null);
    const org = me?.organizations.find((o) => o.id === resume);
    if (!paid) {
      if (org && !settingUp(org)) throw redirect({ to: "/org/$orgId", params: { orgId: resume } });
      return;
    }
    const general = org?.onboarding?.generalChannelId;
    const at = await finishOnboarding(context.api, resume).catch(() => null);
    await context.queryClient.refetchQueries({ queryKey: keys.me });
    const search = { paid: true as const };
    if (general)
      throw redirect({ to: "/org/$orgId/c/$channelId", params: { orgId: resume, channelId: general }, search });
    if (at?.agentId)
      throw redirect({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: resume, agentId: at.agentId }, search });
    throw redirect({ to: "/org/$orgId", params: { orgId: resume }, search });
  },
  component: function Onboarding() {
    useServerLocale(useMe().data?.user);
    return <OnboardingPage />;
  },
});
