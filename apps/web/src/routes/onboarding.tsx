import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { OnboardingPage, resumeOnboarding } from "@/pages/OnboardingPage";

export const Route = createFileRoute("/onboarding")({
  // `?resume=<orgId>`: back from that workspace's plan (`/org/$orgId/onboarding`, ADR 0077), `paid` after paying.
  validateSearch: (search: Record<string, unknown>): { resume?: string; paid?: true } => ({
    ...(typeof search.resume === "string" ? { resume: search.resume } : {}),
    ...(isPaidReturn(search) ? { paid: true } : {}),
  }),
  beforeLoad: ({ context, location }) => requireUser(context, location.href),
  loaderDeps: ({ search }) => ({ resume: search.resume }),
  // A workspace that can't be read back is opened as it is, never set up again from its first step.
  loader: ({ context, deps: { resume } }) =>
    resume
      ? resumeOnboarding(context.api, resume).catch(() => {
          throw redirect({ to: "/org/$orgId", params: { orgId: resume } });
        })
      : null,
  component: function Onboarding() {
    return <OnboardingPage resumed={Route.useLoaderData()} paid={Route.useSearch().paid === true} />;
  },
});
