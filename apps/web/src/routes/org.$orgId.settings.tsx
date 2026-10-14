import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { EmptyPage } from "@/components/EmptyPage";
import { Main } from "@/components/Main";

/** Linked from the sidebar; not built yet. Designed empty state. */
export const Route = createFileRoute("/org/$orgId/settings")({
  component: function Page() {
    const { t } = useTranslation();
    return (
      <Main>
        <EmptyPage icon="settings" title={t("empty.settings.title")} text={t("empty.settings.text")} />
      </Main>
    );
  },
});
