import { createFileRoute } from "@tanstack/react-router";
import { InvitePage } from "@/pages/InvitePage";

/**
 * The server builds invitation links as `${PUBLIC_URL}/invite/${token}`. `?join=1`: back from a provider's sign-in
 * started on the page, which then accepts by itself for the invited address (ADR 0090).
 */
export const Route = createFileRoute("/invite/$token")({
  validateSearch: (search: Record<string, unknown>): { join?: true } =>
    search.join === 1 || search.join === "1" || search.join === true ? { join: true } : {},
  component: function Invite() {
    const { token } = Route.useParams();
    const { join } = Route.useSearch();
    return <InvitePage token={token} join={join === true} />;
  },
});
