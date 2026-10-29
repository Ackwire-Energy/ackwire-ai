import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { createFileRoute, redirect } from "@tanstack/react-router";

/** Where the billing service sends people back after the onboarding's computer step (ADR 0078): its AI step. */
export const Route = createFileRoute("/org/$orgId/onboarding")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/onboarding",
      search: { resume: params.orgId, ...(isPaidReturn(search) ? { paid: true } : {}) },
    });
  },
});
