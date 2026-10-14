import { createFileRoute } from "@tanstack/react-router";
import { ChannelPage } from "@/pages/ChannelPage";

export const Route = createFileRoute("/org/$orgId/c/$channelId")({
  component: function Channel() {
    return <ChannelPage channelId={Route.useParams().channelId} />;
  },
});
