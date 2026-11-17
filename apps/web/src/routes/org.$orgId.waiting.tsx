import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { NotificationsPage } from "@/pages/NotificationsPage";

/** "Esperando você" (ADR 0172): the inbox showing only what waits on me. */
export const Route = createFileRoute("/org/$orgId/waiting")({
  component: () => (
    <Main>
      <NotificationsPage waitingOnly />
    </Main>
  ),
});
