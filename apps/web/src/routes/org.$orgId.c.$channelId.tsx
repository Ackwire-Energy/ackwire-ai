import { createFileRoute } from "@tanstack/react-router";
import { ChannelPage } from "@/pages/ChannelPage";

/** A channel; `?m={messageId}` (from "Copiar link") opens it at that message. */
export const Route = createFileRoute("/org/$orgId/c/$channelId")({
  validateSearch: (search: Record<string, unknown>): { m?: string } =>
    typeof search.m === "string" && search.m ? { m: search.m } : {},
  component: function Channel() {
    const { m } = Route.useSearch();
    return <ChannelPage channelId={Route.useParams().channelId} focusMessageId={m} />;
  },
});
