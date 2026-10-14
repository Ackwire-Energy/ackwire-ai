import { createFileRoute } from "@tanstack/react-router";
import { IssuesPage } from "@/pages/IssuesPage";

/** Issues: board and list (telas/Issues.dc.html). */
export const Route = createFileRoute("/org/$orgId/issues/")({
  component: () => (
    <main className="shell__main shell__main--chat">
      <IssuesPage />
    </main>
  ),
});
