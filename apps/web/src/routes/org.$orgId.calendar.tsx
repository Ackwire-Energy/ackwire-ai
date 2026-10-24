import { createFileRoute } from "@tanstack/react-router";
import { CalendarPage } from "@/pages/CalendarPage";

/** Calendário. */
export const Route = createFileRoute("/org/$orgId/calendar")({
  component: () => (
    <main className="shell__main shell__main--chat shell__main--desk">
      <CalendarPage />
    </main>
  ),
});
