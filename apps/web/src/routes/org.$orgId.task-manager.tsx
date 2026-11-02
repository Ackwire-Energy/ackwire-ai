import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { TaskManagerPage } from "@/pages/TaskManagerPage";

/** Gerenciador de tarefas (ADR 0125): what every agent is doing now, what each task uses, and stopping it. */
export const Route = createFileRoute("/org/$orgId/task-manager")({
  component: () => (
    <Main>
      <TaskManagerPage />
    </Main>
  ),
});
