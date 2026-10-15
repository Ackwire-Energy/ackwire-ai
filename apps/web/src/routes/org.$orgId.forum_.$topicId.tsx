import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { ForumTopicPage } from "@/pages/ForumTopicPage";

/** One forum topic (not nested under the list: its own page). */
export const Route = createFileRoute("/org/$orgId/forum_/$topicId")({
  component: function Page() {
    const { topicId } = Route.useParams();
    return (
      <Main>
        <ForumTopicPage key={topicId} topicId={topicId} />
      </Main>
    );
  },
});
