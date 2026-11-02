import { createFileRoute } from "@tanstack/react-router";
import { DmPage } from "@/pages/DmPage";

/** Direct message with an agent (sidebar "Agentes"). */
export const Route = createFileRoute("/org/$orgId/dm/agent/$agentId")({
  // `?m=<message>` opens the DM at that message (a search hit).
  validateSearch: (search: Record<string, unknown>): { m?: string } =>
    typeof search.m === "string" && search.m ? { m: search.m } : {},
  component: function AgentDm() {
    const { agentId } = Route.useParams();
    return <DmPage key={agentId} target={{ agentId }} focusMessageId={Route.useSearch().m} />;
  },
});
