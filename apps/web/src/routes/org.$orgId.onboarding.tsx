import { createFileRoute, redirect } from "@tanstack/react-router";

/** Where the billing service sends people back after the onboarding's computer step (ADR 0077): its AI step. */
export const Route = createFileRoute("/org/$orgId/onboarding")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/onboarding", search: { resume: params.orgId } });
  },
});
