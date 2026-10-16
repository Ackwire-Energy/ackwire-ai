import { createFileRoute } from "@tanstack/react-router";
import { ThreadPage } from "@/pages/ThreadPage";

/** A thread: its context, its conversation and its controls (ADR 0029). `?reply=true` focuses the composer. */
export const Route = createFileRoute("/org/$orgId/threads/$threadId")({
  validateSearch: (search: Record<string, unknown>): { reply?: boolean } =>
    search.reply === true || search.reply === "true" ? { reply: true } : {},
  component: function Thread() {
    const { reply } = Route.useSearch();
    return <ThreadPage threadId={Route.useParams().threadId} reply={reply} />;
  },
});
