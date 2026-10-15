import { Button, EmptyState, Icon, SearchInput, Select, type SelectOption } from "@agenteschat/ui";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useArtifacts, useChannels } from "@/api/queries";
import type { ArtifactFilters, ArtifactKind } from "@/api/types";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useArtifactViewer, useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { ARTIFACT_KINDS, isArtifactKind, KIND_ICON } from "@/lib/artifacts";
import { relativeTime } from "@/lib/format";

const ALL = "all";

/** Drive: every artifact the viewer can see, with search and filters; opens the shared viewer. */
export function DrivePage({ open }: { open?: { id: string; version?: number } }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const dir = useDirectory(org.id);
  const authorName = useAuthorName();
  const channels = useChannels(org.id);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>(ALL);
  const [channelId, setChannelId] = useState<string>(ALL);
  const [author, setAuthor] = useState<string>(ALL);
  const search = useDeferredValue(q.trim());
  const filters = useMemo<ArtifactFilters>(() => {
    const f: ArtifactFilters = {};
    if (search) f.q = search;
    if (isArtifactKind(kind)) f.kind = kind;
    if (channelId !== ALL) f.channelId = channelId;
    const [type, id] = author.split(":");
    if ((type === "agent" || type === "person") && id) f.author = { type, id };
    return f;
  }, [search, kind, channelId, author]);
  const list = useArtifacts(org.id, filters);
  const filtered = Object.keys(filters).length > 0;

  // A shared link (`/drive?artifact=…&v=…`) opens the viewer.
  useEffect(() => {
    if (open?.id) viewer.open(open.id, open.version);
  }, [open?.id, open?.version, viewer]);

  const channelName = (id: string | null) => {
    const c = id ? channels.data?.find((x) => x.id === id) : undefined;
    return c ? `#${c.name}` : t("artifacts.noChannel");
  };
  const kindOptions: SelectOption[] = [
    { value: ALL, label: t("drive.allKinds") },
    ...ARTIFACT_KINDS.map((k) => ({ value: k, label: t(`artifacts.kind.${k}`) })),
  ];
  const channelOptions: SelectOption[] = [
    { value: ALL, label: t("drive.allChannels") },
    ...(channels.data ?? []).map((c) => ({ value: c.id, label: `#${c.name}` })),
  ];
  const authorOptions: SelectOption[] = [
    { value: ALL, label: t("drive.allAuthors") },
    ...dir.agents.map((a) => ({ value: `agent:${a.id}`, label: a.name, group: t("drive.agents") })),
    ...dir.members.map((m) => ({ value: `person:${m.userId}`, label: m.name, group: t("drive.people") })),
  ];
  const rows = list.data ?? [];

  return (
    <div className="page page--xwide">
      <header className="page__header">
        <h1 className="page-title">{t("drive.title")}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {t("drive.subtitle")}
        </p>
      </header>
      <div className="drive-filters">
        <SearchInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("drive.search")}
          aria-label={t("drive.search")}
          className="drive-filters__search"
        />
        <Select value={kind} onValueChange={setKind} options={kindOptions} aria-label={t("drive.kind")} size="sm" />
        <Select
          value={channelId}
          onValueChange={setChannelId}
          options={channelOptions}
          aria-label={t("drive.channel")}
          size="sm"
        />
        <Select
          value={author}
          onValueChange={setAuthor}
          options={authorOptions}
          aria-label={t("drive.author")}
          size="sm"
        />
      </div>
      {list.isLoading && <LoadingList count={5} trailing />}
      {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && rows.length === 0 && !filtered && (
        <EmptyState icon="drive" title={t("drive.emptyTitle")}>
          {t("drive.emptyText")}
        </EmptyState>
      )}
      {list.isSuccess && rows.length === 0 && filtered && (
        <EmptyState
          icon="search"
          actions={
            <Button
              onClick={() => {
                setQ("");
                setKind(ALL);
                setChannelId(ALL);
                setAuthor(ALL);
              }}
            >
              {t("drive.clear")}
            </Button>
          }
        >
          {t("drive.noResults")}
        </EmptyState>
      )}
      {rows.length > 0 && (
        <div className="drive-table">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("drive.name")}</th>
                <th scope="col">{t("drive.type")}</th>
                <th scope="col">{t("drive.by")}</th>
                <th scope="col">{t("drive.where")}</th>
                <th scope="col">{t("drive.when")}</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
