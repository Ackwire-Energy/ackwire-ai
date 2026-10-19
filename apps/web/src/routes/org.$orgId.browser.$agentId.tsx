import { createFileRoute } from "@tanstack/react-router";
import { BrowserLiveView } from "@/components/browser/BrowserLiveView";

/** `?h=` the request it was opened for; `?watch=1` just watching (someone else is helping). */
function browserSearch(search: Record<string, unknown>): { h?: string; watch?: 1 } {
  return {
    ...(typeof search.h === "string" && search.h ? { h: search.h } : {}),
    ...(search.watch === 1 || search.watch === "1" ? { watch: 1 as const } : {}),
  };
}

/** The live view of an agent's browser (ADR 0040): helping it sign in, or watching it work. */
export const Route = createFileRoute("/org/$orgId/browser/$agentId")({
  validateSearch: browserSearch,
  component: function AgentBrowserLive() {
    const { agentId } = Route.useParams();
    const { h, watch } = Route.useSearch();
    return <BrowserLiveView key={agentId} agentId={agentId} handoffId={h} watch={watch === 1} />;
  },
});
