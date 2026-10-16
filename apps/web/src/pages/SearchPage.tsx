import { EmptyState, List, SearchField, TabPanel, Tabs } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannels, useSearch } from "@/api/queries";
import type { SearchHit, SearchKind } from "@/api/types";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { relativeTime } from "@/lib/format";

type Filter = "all" | "message" | "context_item";
const KINDS: Record<Filter, SearchKind[]> = {
  all: ["message", "context_item"],
  message: ["message"],
  context_item: ["context_item"],
};

/** Hits grouped by kind, in the order the server ranked them. */
export function groupHits(hits: SearchHit[]) {
  const groups = new Map<SearchKind, SearchHit[]>();
  for (const h of hits) groups.set(h.kind, [...(groups.get(h.kind) ?? []), h]);
  return [...groups.entries()];
}

/** "Buscar no workspace" (`GET …/search`): messages and context items, grouped, linking to the source. */
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
                  const meta = [
                    h.title,
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
  return (
    <span className="list-col">
      <span>{snippet}</span>
      <span className="small muted">{meta}</span>
    </span>
  );
}
