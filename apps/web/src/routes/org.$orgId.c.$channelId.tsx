import { channelMembersQuery, channelThreadsQuery, messagesQuery } from "@agenteschat/client";
import { createFileRoute } from "@tanstack/react-router";
import { ChannelPage } from "@/pages/ChannelPage";

/**
 * A channel; `?m={messageId}` (from "Copiar link") opens it at that message;
 * `?adjust={threadId}` opens "Ajustar trecho" for that thread's range.
 */
export const Route = createFileRoute("/org/$orgId/c/$channelId")({
  validateSearch: (search: Record<string, unknown>): { m?: string; adjust?: string } => ({
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
    ...(typeof search.adjust === "string" && search.adjust ? { adjust: search.adjust } : {}),
  }),
  // What the channel opens with, all at once instead of one after another; a hover on a link starts it
  // too (`defaultPreload: "intent"`). Not awaited: the page shows at once and fills in.
  loader: ({ context: { queryClient, api }, params: { orgId, channelId } }) => {
    void queryClient.prefetchQuery(messagesQuery(api, orgId, channelId));
    void queryClient.prefetchQuery(channelMembersQuery(api, orgId, channelId));
    void queryClient.prefetchQuery(channelThreadsQuery(api, orgId, channelId, "all"));
    void queryClient.prefetchQuery(channelThreadsQuery(api, orgId, channelId, "archived"));
  },
  component: function Channel() {
    const { m, adjust } = Route.useSearch();
    return <ChannelPage channelId={Route.useParams().channelId} focusMessageId={m} adjustThreadId={adjust} />;
  },
});
