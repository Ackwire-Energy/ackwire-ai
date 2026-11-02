import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { TaskManagerPage } from "@/pages/TaskManagerPage";

/**
 * Gerenciador de tarefas (ADR 0127): what every agent is doing now, what each task uses, and stopping it.
 * `?agent=<id>` opens with that agent's card chosen (from its tasks' panel in a DM).
 */
export const Route = createFileRoute("/org/$orgId/task-manager")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    agent: typeof search.agent === "string" && search.agent ? search.agent : undefined,
  }),
  component: () => (
    <Main>
      <TaskManagerPage agent={Route.useSearch().agent} />
    </Main>
  ),
});
