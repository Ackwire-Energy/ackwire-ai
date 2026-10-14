import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { EmptyPage } from "@/components/EmptyPage";
import { Main } from "@/components/Main";

/** Thread view. The channel shows agent replies inline; a dedicated thread view comes later. */
export const Route = createFileRoute("/org/$orgId/threads/$threadId")({
  component: function Thread() {
    const { t } = useTranslation();
    return (
      <Main>
        <EmptyPage icon="message" title={t("empty.thread.title")} text={t("empty.thread.text")} />
      </Main>
    );
  },
});
