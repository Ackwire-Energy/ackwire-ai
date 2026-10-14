import { SearchInput } from "@agenteschat/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { EmptyPage } from "@/components/EmptyPage";
import { Main } from "@/components/Main";

/** "Buscar no workspace" (sidebar). Not built yet: the search box is shown, disabled. */
export const Route = createFileRoute("/org/$orgId/search")({
  component: function Search() {
    const { t } = useTranslation();
    return (
      <Main>
        <EmptyPage icon="search" title={t("empty.search.title")} text={t("empty.search.text")}>
          <SearchInput aria-label={t("empty.search.title")} placeholder={t("empty.search.placeholder")} disabled />
        </EmptyPage>
      </Main>
    );
  },
});
