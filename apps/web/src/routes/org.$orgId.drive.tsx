import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { DrivePage } from "@/pages/DrivePage";

/** Drive: every artifact the viewer can see. `?artifact=…&v=…` opens one (shared links). */
export const Route = createFileRoute("/org/$orgId/drive")({
  validateSearch: (search: Record<string, unknown>): { artifact?: string; v?: number } => ({
    artifact: typeof search.artifact === "string" ? search.artifact : undefined,
    v: typeof search.v === "number" && search.v > 0 ? search.v : undefined,
  }),
  component: function Page() {
    const { artifact, v } = Route.useSearch();
    return (
      <Main>
        <DrivePage open={artifact ? { id: artifact, version: v } : undefined} />
      </Main>
    );
  },
});
