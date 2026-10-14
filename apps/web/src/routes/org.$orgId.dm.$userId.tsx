import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMembers } from "@/api/queries";
import { EmptyPage } from "@/components/EmptyPage";
import { Main } from "@/components/Main";

/** Direct messages (sidebar). No backend yet. */
export const Route = createFileRoute("/org/$orgId/dm/$userId")({
  component: function Dm() {
    const { t } = useTranslation();
    const { orgId, userId } = Route.useParams();
    const members = useMembers(orgId);
    const name = members.data?.find((m) => m.userId === userId)?.name ?? "";
    return (
      <Main>
        <EmptyPage icon="person" title={t("empty.dm.title", { name })} text={t("empty.dm.text", { name })} />
      </Main>
    );
  },
});
