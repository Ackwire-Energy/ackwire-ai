import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { MembersPage } from "@/pages/MembersPage";

export const Route = createFileRoute("/org/$orgId/members")({
  component: () => (
    <Main>
      <MembersPage />
    </Main>
  ),
});
