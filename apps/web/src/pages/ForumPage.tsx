import { Button, EmptyState, Segmented } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForumTopics } from "@/api/queries";
import type { ForumFilter, ForumTopic } from "@/api/types";
import { ForumTopicCard, NewTopicDialog } from "@/components/Forum";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";

/** Em discussão / Concluídos (done or canceled) / Meus (opened by me or I'm notified). */
export function filterTopics(topics: ForumTopic[], filter: ForumFilter, myUserId: string) {
  if (filter === "open") return topics.filter((t) => t.status === "open");
  if (filter === "done") return topics.filter((t) => t.status !== "open");
  return topics.filter(
    (t) => (t.createdBy.type === "person" && t.createdBy.id === myUserId) || t.userIds.includes(myUserId),
  );
}

/** Fórum: topics where agents discuss a question in rounds. */
export function ForumPage() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const topics = useForumTopics(org.id);
  const [filter, setFilter] = useState<ForumFilter>("open");
  const [creating, setCreating] = useState(false);
  const all = topics.data ?? [];
  const shown = filterTopics(all, filter, me.user.id).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return (
    <div className="page page--mid">
      <header
        className="page__header page__header--row"
        style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}
      >
        <div className="stack-4" style={{ flex: "1 1 320px", gap: 4 }}>
          <h1 className="page-title">{t("forum.title")}</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "64ch" }}>
            {t("forum.subtitle")}
          </p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          {t("forum.new")}
        </Button>
      </header>
      <Segmented
        label={t("forum.filters")}
        value={filter}
        onValueChange={setFilter}
        options={(["open", "done", "mine"] as const).map((f) => ({ value: f, label: t(`forum.filter.${f}`) }))}
      />
      {topics.isLoading && <LoadingCards count={3} />}
      {topics.isError && !topics.data && <ErrorState error={topics.error} onRetry={() => void topics.refetch()} />}
      {topics.isSuccess && all.length === 0 && (
        <EmptyState
          icon="message"
          actions={
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              {t("forum.new")}
            </Button>
          }
        >
          {t("forum.empty")}
        </EmptyState>
      )}
      {topics.isSuccess && all.length > 0 && shown.length === 0 && <p className="muted">{t("forum.emptyFilter")}</p>}
      <div className="forum-list">
        {shown.map((topic) => (
          <ForumTopicCard key={topic.id} topic={topic} />
        ))}
      </div>
      <NewTopicDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
