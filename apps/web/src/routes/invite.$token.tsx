import { createFileRoute } from "@tanstack/react-router";
import { InvitePage } from "@/pages/InvitePage";

/** The server builds invitation links as `${PUBLIC_URL}/invite/${token}`. */
export const Route = createFileRoute("/invite/$token")({
  component: function Invite() {
    return <InvitePage token={Route.useParams().token} />;
  },
});
