import { createFileRoute } from "@tanstack/react-router";
import { NewAgentPage } from "@/pages/NewAgentPage";

/**
 * A focused flow: the org layout leaves the sidebar out while it's open (see `org.$orgId.tsx`). `?proposal=` (an
 * agent's proposal card, ADR 0080) opens it filled in with the draft, on its last step.
 */
export const Route = createFileRoute("/org/$orgId/agents/new")({
  validateSearch: (search: Record<string, unknown>): { proposal?: string } => ({
    proposal: typeof search.proposal === "string" ? search.proposal : undefined,
  }),
  component: function NewAgent() {
    return <NewAgentPage proposalId={Route.useSearch().proposal ?? null} />;
  },
});
