import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { RoutinesPage } from "@/pages/RoutinesPage";

/** Rotinas (telas/Rotinas.dc.html). */
export const Route = createFileRoute("/org/$orgId/routines")({
  component: () => (
    <Main>
      <RoutinesPage />
    </Main>
  ),
});
