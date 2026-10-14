import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { MemoryPage } from "@/pages/MemoryPage";

export const Route = createFileRoute("/org/$orgId/agents/$agentId/memory")({
  component: function Memory() {
    return (
      <Main>
        <MemoryPage agentId={Route.useParams().agentId} />
      </Main>
    );
  },
});
