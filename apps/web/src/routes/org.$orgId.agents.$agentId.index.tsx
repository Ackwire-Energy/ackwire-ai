import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { AgentPage } from "@/pages/AgentPage";

export const Route = createFileRoute("/org/$orgId/agents/$agentId/")({
  component: function Agent() {
    return (
      <Main>
        <AgentPage agentId={Route.useParams().agentId} />
      </Main>
    );
  },
});
