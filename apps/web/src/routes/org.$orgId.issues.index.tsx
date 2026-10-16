import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { openSearch } from "@/lib/open-param";
import { IssuesPage } from "@/pages/IssuesPage";

/**
 * Issues: board and list (telas/Issues.dc.html). `?open=131` opens an issue's
 * details. The page scrolls in the main column like every non-chat page (the
 * chat layout clips its overflow: a tall column could not be reached).
 */
export const Route = createFileRoute("/org/$orgId/issues/")({
  validateSearch: openSearch,
  component: () => (
    <Main>
      <IssuesPage />
    </Main>
  ),
});
