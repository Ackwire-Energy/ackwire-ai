import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { DashboardsPage } from "@/pages/DashboardsPage";

/** Dashboards: the boards of widgets agents keep up to date, grouped by who sees them (ADR 0134). */
export const Route = createFileRoute("/org/$orgId/dashboards/")({
  component: () => (
    <Main>
      <DashboardsPage />
    </Main>
  ),
});
