import type { SearchHit, SearchKind, SearchSort } from "@agenteschat/client";
import { useChannels, useDms, useSearch } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import {
  formatSearch,
  groupByChannel,
  hasSearch,
  parseSearch,
  rememberSearch,
  SEARCH_SORTS,
  type SearchChip,
  type SearchDirectory,
  type SearchPlace,
  searchFilterInput,
  searchWords,
} from "@agenteschat/client/lib/search-filters";
import { Button, EmptyState, List, Select, TabPanel, Tabs } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { SearchBox } from "@/components/search/SearchBox";
import { useDirectory } from "@/hooks/useDirectory";
import { STORAGE_KEYS, storage, storedStrings } from "@/lib/storage";

type Filter = "all" | "message" | "context_item" | "action";
const KINDS: Record<Filter, SearchKind[]> = {
  all: ["action", "message", "context_item"],
  message: ["message"],
  context_item: ["context_item"],
  action: ["action"],
};
/** The team's outside actions (ADR 0064) come first: "has anyone already…?" is what they answer. */
const ORDER: SearchKind[] = ["action", "message", "context_item"];
/** The server's most per filtered search: a full page reads "100+". */
const PAGE = 100;

/** Hits grouped by kind (the team's actions first), each group in the order the server ranked it. */
export function groupHits(hits: SearchHit[]) {
  const groups = new Map<SearchKind, SearchHit[]>();
  for (const h of hits) groups.set(h.kind, [...(groups.get(h.kind) ?? []), h]);
  const rank = (k: SearchKind) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

/**
 * "Buscar no workspace" (`GET …/search`, ADR 0123): words and filter chips (`from:`, `in:`, `has:`, `mentions:`,
 * dates, author type, pinned), recent searches, results by channel with a sort, each opening at its message.
 * Without chips it also finds the team's actions and context items, by kind. `scope`: opened from a channel or DM,
 * which starts as an `in:` chip.
 */
export function SearchPage({ scope }: { scope?: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const dir = useDirectory(org.id);
  const words = useMemo(() => searchWords(t), [t]);
  const places = useMemo<SearchPlace[]>(
    () => [
      ...(channels.data ?? []).filter((c) => c.isMember).map((c) => ({ id: c.id, name: c.name })),
      ...(dms.data ?? []).map((d) => ({ id: d.channelId, name: d.with.name, dm: true })),
    ],
    [channels.data, dms.data],
  );
  const directory = useMemo<SearchDirectory>(
    () => ({
      actors: [
        ...dir.members.map((m) => ({ type: "person" as const, id: m.userId, name: m.name, handle: m.handle })),
        ...dir.agents.map((a) => ({ type: "agent" as const, id: a.id, name: a.name, handle: a.handle })),
      ],
      places,
    }),
    [dir.members, dir.agents, places],
  );

  const recentKey = `${STORAGE_KEYS.searchRecent}.${me.user.id}.${org.id}`;
  const [recent, setRecent] = useState(() => storedStrings(recentKey));
  const saveRecent = (list: string[]) => {
    setRecent(list);
    if (list.length) storage.set(recentKey, JSON.stringify(list));
    else storage.remove(recentKey);
  };

  const [chips, setChips] = useState<SearchChip[]>([]);
  // The channel or DM it was opened from, once its name is known.
  useEffect(() => {
    const place = scope ? places.find((p) => p.id === scope) : undefined;
    if (place) setChips((cs) => (cs.some((c) => c.op === "in") ? cs : [{ op: "in", place }, ...cs]));
  }, [scope, places]);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Null: by relevance with words, newest first without.
  const [sort, setSort] = useState<SearchSort | null>(null);
  // Search as you type, a beat after the last key; an operator still being typed isn't searched as words.
  useEffect(() => {
    const timer = setTimeout(() => setQ(parseSearch(input, directory, words).text), 250);
    return () => clearTimeout(timer);
  }, [input, directory, words]);
  const filtered = chips.length > 0;
  const effectiveSort = sort ?? (q.trim() ? "relevance" : "newest");
  const search = useSearch(
    org.id,
    q,
    filtered ? ["message"] : KINDS[filter],
    filtered || sort ? searchFilterInput(chips, effectiveSort) : undefined,
  );
  const hits = search.data ?? [];
  const active = hasSearch(chips, q);
  const placeOf = (id: string | undefined) => places.find((p) => p.id === id);
  const remember = () => {
    const text = formatSearch(chips, parseSearch(input, directory, words).text);
    if (text) saveRecent(rememberSearch(recent, text));
  };
  const pickRecent = (text: string) => {
    const parsed = parseSearch(text, directory, words);
    setChips(parsed.chips);
    setInput(parsed.text);
    saveRecent(rememberSearch(recent, text));
  };

  const results = (
    <>
      {!active && <EmptyState icon="search">{t("searchPage.hint")}</EmptyState>}
      {active && search.isLoading && <LoadingList count={4} avatar={false} />}
      {active && search.isError && !search.data && (
        <ErrorState error={search.error} onRetry={() => void search.refetch()} />
      )}
      {active && search.isSuccess && hits.length === 0 && (
        <EmptyState icon="search">{t("searchPage.empty", { q: formatSearch(chips, q) })}</EmptyState>
      )}
      {active && hits.length > 0 && (
        <div className="search-results__bar">
          <p className="small muted" style={{ margin: 0 }} role="status">
            {hits.length >= PAGE
              ? t("searchPage.countMore", { count: PAGE })
              : t("searchPage.count", { count: hits.length })}
          </p>
          {filtered && (
            <Button size="sm" variant="ghost" icon="close" onClick={() => setChips([])}>
              {t("searchPage.filtersApplied", { count: chips.length })}
            </Button>
          )}
          <Select
            size="sm"
            aria-label={t("searchPage.sort.label")}
            value={effectiveSort}
            onValueChange={setSort}
            options={SEARCH_SORTS.map((s) => ({ value: s, label: t(`searchPage.sort.${s}`) }))}
          />
        </div>
      )}
      {groupHits(hits).map(([kind, list]) =>
        kind === "message" ? (
          groupByChannel(list).map(([channelId, inChannel]) => {
            const place = placeOf(channelId);
            const heading = place ? (place.dm ? t("searchPage.dm", { name: place.name }) : `#${place.name}`) : "";
            return (
              <section key={`message-${channelId}`} className="section section--tight" aria-label={heading}>
                <h2 className="ac-eyebrow" style={{ margin: 0 }}>
                  {heading}
                </h2>
                <List>
                  {inChannel.map((h) => (
                    <HitRow
                      key={h.sourceId}
                      orgId={org.id}
                      hit={h}
                      channelId={place ? channelId : undefined}
                      onOpen={remember}
                    />
                  ))}
                </List>
              </section>
            );
          })
        ) : (
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
                const c = placeOf(h.channelIds[0]);
                return (
                  <HitRow
                    key={`${h.kind}-${h.sourceId}`}
                    orgId={org.id}
                    hit={h}
                    channelId={c?.id}
                    channel={c?.name}
                    onOpen={remember}
                  />
                );
              })}
            </List>
          </section>
        ),
      )}
    </>
  );

  return (
    <div className="page page--full">
      <header className="page__header">
        <h1 className="page-title">{t("searchPage.title")}</h1>
      </header>
      <SearchBox
        chips={chips}
        onChipsChange={setChips}
        text={input}
        onTextChange={setInput}
        onSubmit={remember}
        directory={directory}
        words={words}
        recent={recent}
        onPickRecent={pickRecent}
        onClearRecent={() => saveRecent([])}
      />
      {filtered ? (
        results
      ) : (
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
          <TabPanel value={filter}>{results}</TabPanel>
        </Tabs>
      )}
    </div>
  );
}

/** One hit: its author's face and name, when, the text; a message opens at itself (a reply at its thread). */
function HitRow({
  orgId,
  hit,
  channelId,
  channel,
  onOpen,
}: {
  orgId: string;
  hit: SearchHit;
  channelId?: string;
  /** Shown in the line (hits not grouped by channel). */
  channel?: string;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  // An action's title is the tool's id: people see who did it instead.
  const meta = [
    hit.kind === "message" || hit.kind === "action" ? (hit.author?.name ?? null) : hit.title,
    channel ? t("searchPage.inChannel", { channel }) : null,
    relativeTime(t, i18n.language, hit.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  const body = (
    <span className="search-hit">
      {hit.kind === "message" && hit.author && <ActorAvatar actor={hit.author} name={hit.author.name} size="sm" />}
      <span className="list-col">
        <span className="small muted">{meta}</span>
        <span>{hit.snippet}</span>
      </span>
    </span>
  );
  if (!channelId) return <div className="ac-list__row">{body}</div>;
  const m = hit.kind === "message" ? (hit.threadId ?? hit.messageId ?? undefined) : undefined;
  return (
    <Link
      to="/org/$orgId/c/$channelId"
      params={{ orgId, channelId }}
      search={m ? { m } : {}}
      onClick={onOpen}
      className="ac-list__row"
    >
      {body}
    </Link>
  );
}
