import { createFileRoute } from "@tanstack/react-router";
import { DmPage } from "@/pages/DmPage";

/** Direct message with an agent (sidebar "Agentes"). */
export const Route = createFileRoute("/org/$orgId/dm/agent/$agentId")({
  component: function AgentDm() {
    const { agentId } = Route.useParams();
    return <DmPage key={agentId} target={{ agentId }} />;
  },
});
