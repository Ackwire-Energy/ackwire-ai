import { createFileRoute } from "@tanstack/react-router";
import { DmPage } from "@/pages/DmPage";

/** Direct message with a person (sidebar "Mensagens diretas"). */
export const Route = createFileRoute("/org/$orgId/dm/person/$userId")({
  component: function PersonDm() {
    const { userId } = Route.useParams();
    return <DmPage key={userId} target={{ userId }} />;
  },
});
