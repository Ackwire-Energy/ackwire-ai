import type { SearchHit, SearchKind } from "@agenteschat/client";
import { useChannels, useSearch } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { EmptyState, List, SearchField, TabPanel, Tabs } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";

type Filter = "all" | "message" | "context_item" | "action";
const KINDS: Record<Filter, SearchKind[]> = {
  all: ["action", "message", "context_item"],
  message: ["message"],
  context_item: ["context_item"],
  action: ["action"],
};
/** The team's outside actions (ADR 0064) come first: "has anyone already…?" is what they answer. */
const ORDER: SearchKind[] = ["action", "message", "context_item"];

/** Hits grouped by kind (the team's actions first), each group in the order the server ranked it. */
export function groupHits(hits: SearchHit[]) {
  const groups = new Map<SearchKind, SearchHit[]>();
  for (const h of hits) groups.set(h.kind, [...(groups.get(h.kind) ?? []), h]);
  const rank = (k: SearchKind) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

/** "Buscar no workspace" (`GET …/search`): the team's actions, messages and context items, grouped, linking to the source. */
export function SearchPage() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Search as you type, a beat after the last key.
  useEffect(() => {
    const timer = setTimeout(() => setQ(input), 250);
    return () => clearTimeout(timer);
  }, [input]);
  const search = useSearch(org.id, q, KINDS[filter]);
  const hits = search.data ?? [];
  const channel = (id: string | undefined) => channels.data?.find((c) => c.id === id);

  return (
    <div className="page page--mid">
      <header className="page__header">
        <h1 className="page-title">{t("searchPage.title")}</h1>
      </header>
      <SearchField
        aria-label={t("searchPage.label")}
        placeholder={t("searchPage.placeholder")}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onClear={() => setInput("")}
        clearLabel={t("filters.clearSearch")}
        autoFocus
      />
      <Tabs
        value={filter}
        onValueChange={setFilter}
        label={t("searchPage.filter")}
        items={[
          { value: "all", label: t("searchPage.all") },
          { value: "action", label: t("searchPage.kinds.action") },
          { value: "message", label: t("searchPage.kinds.message") },
          { value: "context_item", label: t("searchPage.kinds.context_item") },
        ]}
      >
        <TabPanel value={filter}>
          {!q.trim() && <EmptyState icon="search">{t("searchPage.hint")}</EmptyState>}
          {q.trim() && search.isLoading && <LoadingList count={4} avatar={false} />}
          {q.trim() && search.isError && !search.data && (
            <ErrorState error={search.error} onRetry={() => void search.refetch()} />
          )}
          {q.trim() && search.isSuccess && hits.length === 0 && (
            <EmptyState icon="search">{t("searchPage.empty", { q })}</EmptyState>
          )}
          {hits.length > 0 && (
            <p className="small muted" style={{ margin: 0 }} role="status">
              {t("searchPage.count", { count: hits.length })}
            </p>
          )}
          {groupHits(hits).map(([kind, list]) => (
            <section
              key={kind}
              className="section section--tight"
              aria-label={t(`searchPage.kinds.${kind as "message"}`)}
            >
              <h2 className="ac-eyebrow" style={{ margin: 0 }}>
                {t(`searchPage.kinds.${kind as "message"}`)}
              </h2>
              <List>
                {list.map((h) => {
                  const c = channel(h.channelIds[0]);
                  // An action's title is the tool's id: people see who did it instead.
                  const meta = [
                    h.kind === "action" ? (h.author?.name ?? null) : h.title,
                    c ? t("searchPage.inChannel", { channel: c.name }) : null,
                    relativeTime(t, i18n.language, h.createdAt),
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return c ? (
                    <Link
                      key={`${h.kind}-${h.sourceId}`}
                      to="/org/$orgId/c/$channelId"
                      params={{ orgId: org.id, channelId: c.id }}
                      className="ac-list__row"
                    >
                      <HitBody snippet={h.snippet} meta={meta} />
                    </Link>
                  ) : (
                    <div key={`${h.kind}-${h.sourceId}`} className="ac-list__row">
                      <HitBody snippet={h.snippet} meta={meta} />
                    </div>
                  );
                })}
              </List>
            </section>
          ))}
        </TabPanel>
      </Tabs>
    </div>
  );
}

function HitBody({ snippet, meta }: { snippet: string; meta: string }) {
  const { t } = useTranslation();
  return (
    <span className="list-col">
      {/* A voice message comes with no snippet: it is found by its words, and shows as audio (ADR 0094). */}
      <span>{snippet || t("voice.word")}</span>
      <span className="small muted">{meta}</span>
    </span>
  );
}
