import {
  Button,
  EmptyState,
  FilterBar,
  FilterChip,
  type FilterOption,
  Icon,
  List,
  MenuItem,
  SearchInput,
} from "@agenteschat/ui";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useArtifacts, useArtifactTrash, useChannels } from "@/api/queries";
import type { ArtifactFilters, ArtifactKind } from "@/api/types";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { ArtifactMoreMenu, useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { useArtifactViewer, useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { ARTIFACT_KINDS, isArtifactKind, KIND_ICON } from "@/lib/artifacts";
import { relativeTime } from "@/lib/format";

/** Drive: every artifact the viewer can see, with search and filters; opens the shared viewer. */
export function DrivePage({ open }: { open?: { id: string; version?: number } }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const dir = useDirectory(org.id);
  const authorName = useAuthorName();
  const channels = useChannels(org.id);
  const [q, setQ] = useState("");
  const [trashOpen, setTrashOpen] = useState(false);
  const remover = useDeleteArtifact();
  const [kind, setKind] = useState<string[]>([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const search = useDeferredValue(q.trim());
  const filters = useMemo<ArtifactFilters>(() => {
    const f: ArtifactFilters = {};
    if (search) f.q = search;
    const k = kind[0];
    if (k && isArtifactKind(k)) f.kind = k;
    // One value goes to the server; several are matched here.
    if (channelIds.length === 1) f.channelId = channelIds[0];
    const [type, id] = (authors.length === 1 ? (authors[0] ?? "") : "").split(":");
    if ((type === "agent" || type === "person") && id) f.author = { type, id };
    return f;
  }, [search, kind, channelIds, authors]);
  const list = useArtifacts(org.id, filters);
  const filtered = Object.keys(filters).length > 0 || channelIds.length > 1 || authors.length > 1;
  const clearFilters = () => {
    setKind([]);
    setChannelIds([]);
    setAuthors([]);
  };

  // A shared link (`/drive?artifact=…&v=…`) opens the viewer.
  useEffect(() => {
    if (open?.id) viewer.open(open.id, open.version);
  }, [open?.id, open?.version, viewer]);

  const channelName = (id: string | null) => {
    const c = id ? channels.data?.find((x) => x.id === id) : undefined;
    return c ? `#${c.name}` : t("artifacts.noChannel");
  };
  const kindOptions: FilterOption[] = ARTIFACT_KINDS.map((k) => ({
    value: k,
    label: t(`artifacts.kind.${k}`),
    leading: <Icon name={KIND_ICON[k]} size={16} />,
  }));
  const channelOptions: FilterOption[] = (channels.data ?? []).map((c) => ({ value: c.id, label: `#${c.name}` }));
  const authorOptions: FilterOption[] = [
    ...dir.agents.map((a) => ({
      value: `agent:${a.id}`,
      label: a.name,
      group: t("drive.agents"),
      leading: <AgentAvatar agentId={a.id} size="xs" name={a.name} />,
    })),
    ...dir.members.map((m) => ({
      value: `person:${m.userId}`,
      label: m.name,
      group: t("drive.people"),
      leading: <ActorAvatar actor={{ type: "person", id: m.userId }} size="xs" name={m.name} />,
    })),
  ];
  const rows = (list.data ?? []).filter(
    (a) =>
      (channelIds.length < 2 || (a.channelId !== null && channelIds.includes(a.channelId))) &&
      (authors.length < 2 ||
        authors.some(
          (x) => x === `${a.createdBy.type}:${a.createdBy.id}` || x === `${a.updatedBy.type}:${a.updatedBy.id}`,
        )),
  );
  const clearOf = (name: string) => t("filters.clear", { name });
  const chipText = {
    searchLabel: t("filters.search"),
    searchPlaceholder: t("filters.searchPlaceholder"),
    noResults: t("filters.noResults"),
  };

  return (
    <div className="page page--xwide">
      <header
        className="page__header page__header--row"
        style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}
      >
        <div className="stack-4" style={{ flex: "1 1 320px", gap: 4 }}>
          <h1 className="page-title">{trashOpen ? t("artifacts.trashTitle") : t("drive.title")}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {trashOpen ? t("artifacts.trashHint") : t("drive.subtitle")}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={trashOpen ? "chevronLeft" : "trash"}
          aria-pressed={trashOpen}
          onClick={() => setTrashOpen((o) => !o)}
        >
          {trashOpen ? t("artifacts.backToDrive") : t("artifacts.trash")}
        </Button>
      </header>
      {trashOpen && <DriveTrash />}
      {remover.dialog}
      {!trashOpen && (
        <FilterBar
          label={t("drive.filters")}
          className="drive-filters"
          clearText={t("drive.clear")}
          onClear={clearFilters}
          filters={[
            {
              key: "kind",
              active: kind.length > 0,
              node: (
                <FilterChip
                  label={t("drive.kind")}
                  icon="document"
                  options={kindOptions}
                  value={kind}
                  onChange={setKind}
                  clearLabel={clearOf(t("drive.kind"))}
                  {...chipText}
                />
              ),
            },
            {
              key: "channel",
              active: channelIds.length > 0,
              node: (
                <FilterChip
                  label={t("drive.channel")}
                  icon="channel"
                  multiple
                  options={channelOptions}
                  value={channelIds}
                  onChange={setChannelIds}
                  valueText={(o) => o.label}
                  countText={(count) => t("filters.channels", { count })}
                  clearLabel={clearOf(t("drive.channel"))}
                  {...chipText}
                />
              ),
            },
            {
              key: "author",
              active: authors.length > 0,
              node: (
                <FilterChip
                  label={t("drive.author")}
                  icon="person"
                  multiple
                  options={authorOptions}
                  value={authors}
                  onChange={setAuthors}
                  valueText={(o) => o.label}
                  countText={(count) => t("filters.people", { count })}
                  clearLabel={clearOf(t("drive.author"))}
                  {...chipText}
                />
              ),
            },
          ]}
        >
          <SearchInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("drive.search")}
            aria-label={t("drive.search")}
            className="drive-filters__search"
          />
        </FilterBar>
      )}
      {!trashOpen && list.isLoading && <LoadingList count={5} trailing />}
      {!trashOpen && list.isError && !list.data && (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      )}
      {!trashOpen && list.isSuccess && rows.length === 0 && !filtered && (
        <EmptyState sky icon="drive" title={t("drive.emptyTitle")}>
          {t("drive.emptyText")}
        </EmptyState>
      )}
      {!trashOpen && list.isSuccess && rows.length === 0 && filtered && (
        <EmptyState
          icon="search"
          actions={
            <Button
              onClick={() => {
                setQ("");
                clearFilters();
              }}
            >
              {t("drive.clear")}
            </Button>
          }
        >
          {t("drive.noResults")}
        </EmptyState>
      )}
      {!trashOpen && rows.length > 0 && (
        <div className="drive-table">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("drive.name")}</th>
                <th scope="col">{t("drive.type")}</th>
                <th scope="col">{t("drive.by")}</th>
                <th scope="col">{t("drive.where")}</th>
                <th scope="col">{t("drive.when")}</th>
                <th scope="col">
                  <span className="ac-visually-hidden">{t("artifacts.moreShort")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} data-kind={a.kind}>
                  <td>
                    <button type="button" className="drive-table__open" onClick={() => viewer.open(a.id)}>
                      <Icon name={KIND_ICON[a.kind as ArtifactKind]} />
                      <span>{a.title}</span>
                    </button>
                  </td>
                  <td>{t(`artifacts.kind.${a.kind}`)}</td>
                  <td>
                    <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <ActorAvatar size="xs" actor={a.createdBy} name={authorName(a.createdBy)} />
                      {authorName(a.createdBy)}
                    </span>
                  </td>
                  <td>{channelName(a.channelId)}</td>
                  <td className="tabular">
                    <time dateTime={a.updatedAt}>{relativeTime(t, i18n.language, a.updatedAt)}</time>
                  </td>
                  <td className="drive-table__more">
                    <ArtifactMoreMenu
                      artifact={a}
                      onDelete={() => remover.ask(a)}
                      extra={
                        <MenuItem icon="document" onSelect={() => viewer.open(a.id)}>
                          {t("artifacts.openFile")}
                        </MenuItem>
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** "Lixeira": deleted files for 30 days, with Restaurar. */
function DriveTrash() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const trash = useArtifactTrash(org.id);
  const remover = useDeleteArtifact();
  const list = trash.data ?? [];
  if (trash.isLoading) return <LoadingList count={3} trailing />;
  if (trash.isError && !trash.data) return <ErrorState error={trash.error} onRetry={() => void trash.refetch()} />;
  if (list.length === 0) return <EmptyState icon="trash">{t("artifacts.trashEmpty")}</EmptyState>;
  return (
    <List>
      {list.map((a) => (
        <div key={a.id} className="ac-list__row" data-kind={a.kind}>
          <Icon name={KIND_ICON[a.kind as ArtifactKind]} />
          <span className="list-col" style={{ flex: 1 }}>
            <span style={{ fontWeight: 600 }}>{a.title}</span>
            <span className="small muted">
              {t("artifacts.trashRow", {
                when: relativeTime(t, i18n.language, a.deletedAt),
                date: new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(
                  new Date(a.purgeAt),
                ),
              })}
            </span>
          </span>
          <Button size="sm" onClick={() => void remover.restore(a.id).then(() => void trash.refetch())}>
            {t("artifacts.restore")}
          </Button>
        </div>
      ))}
    </List>
  );
}
