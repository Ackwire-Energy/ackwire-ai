import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { NotificationsPage } from "@/pages/NotificationsPage";

/** Notificações: one inbox for everything that involves me. */
export const Route = createFileRoute("/org/$orgId/notifications")({
  component: () => (
    <Main>
      <NotificationsPage />
    </Main>
  ),
});
