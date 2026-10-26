import { createFileRoute } from "@tanstack/react-router";
import { openSearch } from "@/lib/open-param";
import { CalendarPage } from "@/pages/CalendarPage";

/** Calendário; `?open={eventId}&day={YYYY-MM-DD}` (an invitation's email) opens that event on its week. */
export const Route = createFileRoute("/org/$orgId/calendar")({
  validateSearch: (search: Record<string, unknown>): { open?: string | number; day?: string } => ({
    ...openSearch(search),
    ...(typeof search.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.day) ? { day: search.day } : {}),
  }),
  component: () => (
    <main className="shell__main shell__main--chat">
      <CalendarPage />
    </main>
  ),
});
