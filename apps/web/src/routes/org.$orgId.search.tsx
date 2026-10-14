import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SearchPage } from "@/pages/SearchPage";

/** "Buscar no workspace" (sidebar). */
export const Route = createFileRoute("/org/$orgId/search")({
  component: () => (
    <Main>
      <SearchPage />
    </Main>
  ),
});
