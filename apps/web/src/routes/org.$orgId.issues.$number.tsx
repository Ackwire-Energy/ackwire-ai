import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { IssuePage } from "@/pages/IssuePage";

/** One issue. */
export const Route = createFileRoute("/org/$orgId/issues/$number")({
  component: function Page() {
    const { number } = Route.useParams();
    return (
      <Main>
        <IssuePage key={number} number={Number(number)} />
      </Main>
    );
  },
});
