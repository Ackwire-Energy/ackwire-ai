import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { ApprovalsPage } from "@/pages/ApprovalsPage";

export const Route = createFileRoute("/org/$orgId/approvals")({
  component: () => (
    <Main>
      <ApprovalsPage />
    </Main>
  ),
});
