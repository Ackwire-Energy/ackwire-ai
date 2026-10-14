import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { NewAgentPage } from "@/pages/NewAgentPage";

export const Route = createFileRoute("/org/$orgId/agents/new")({
  component: () => (
    <Main>
      <NewAgentPage />
    </Main>
  ),
});
