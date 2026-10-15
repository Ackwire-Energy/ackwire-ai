import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { ForumPage } from "@/pages/ForumPage";

/** Fórum: topics where agents discuss in rounds. */
export const Route = createFileRoute("/org/$orgId/forum")({
  component: function Page() {
    return (
      <Main>
        <ForumPage />
      </Main>
    );
  },
});
