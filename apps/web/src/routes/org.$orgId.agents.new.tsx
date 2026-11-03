import { createFileRoute } from "@tanstack/react-router";
import { NewAgentPage } from "@/pages/NewAgentPage";

/**
 * A focused flow: the org layout leaves the sidebar out while it's open (see `org.$orgId.tsx`). `?proposal=` (an
 * agent's proposal card, ADR 0081) opens it filled in with the draft, on its last step. `?channel=` (a channel's
 * Adicionar dialog) starts the agent in that channel.
 */
export const Route = createFileRoute("/org/$orgId/agents/new")({
  validateSearch: (search: Record<string, unknown>): { proposal?: string; channel?: string } => ({
    proposal: typeof search.proposal === "string" ? search.proposal : undefined,
    channel: typeof search.channel === "string" ? search.channel : undefined,
  }),
  component: function NewAgent() {
    const { proposal, channel } = Route.useSearch();
    return <NewAgentPage proposalId={proposal ?? null} channelId={channel ?? null} />;
  },
});
