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
  component: function Channel() {
    const { m, adjust } = Route.useSearch();
    return <ChannelPage channelId={Route.useParams().channelId} focusMessageId={m} adjustThreadId={adjust} />;
  },
});
