import type { Artifact, ArtifactFilters, ArtifactKind } from "@agenteschat/client";
import { useArtifacts, useChannels } from "@agenteschat/client";
import { ARTIFACT_KINDS, isArtifactKind, KIND_ICON } from "@agenteschat/client/lib/artifacts";
import {
  byWho,
  DRIVE_GROUPS,
  DRIVE_SORTS,
  type DriveGroup,
  type DriveSection,
  type DriveSort,
  type DriveView,
  type DriveWho,
  groupArtifacts,
  isDriveView,
  rangeOf,
  sortArtifacts,
} from "@agenteschat/client/lib/drive";
import {
  Button,
  cx,
  EmptyState,
  FilterBar,
  FilterChip,
  type FilterOption,
  FilterToggle,
  Icon,
  Kbd,
  Menu,
  MenuRadioGroup,
  MenuSeparator,
  SearchField,
  Segmented,
  Toolbar,
} from "@agenteschat/ui";
import { type MouseEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { useArtifactDownload, useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { artifactLink, useArtifactViewer, useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { UploadButton, useDriveUpload } from "@/components/artifacts/Upload";
import { DriveDetails } from "@/components/drive/DriveDetails";
import { DriveCard, DriveRow, type ItemProps } from "@/components/drive/DriveItems";
import { DriveTrash } from "@/components/drive/DriveTrash";
import { DropOverlay, UploadProgress, useFileDrop } from "@/components/drive/DriveUploads";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useOpenParam } from "@/lib/open-param";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";

/** Authors shown on a channel's group header. */
const STACK_MAX = 5;

const typing = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
/** A menu, listbox or dialog is open: Esc and shortcuts are theirs. */
const layerOpen = () => Boolean(document.querySelector('[role="menu"], [role="listbox"], [role="dialog"]'));

/**
 * Drive: everything the viewer can see, as a
 * grid of real previews (or a list), with quick filters, grouping, a details
 * panel, multi-select with a floating bar, drop to upload and the trash.
 */
export function DrivePage({ open }: { open?: { id: string; version?: number } }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const dir = useDirectory(org.id);
  const authorName = useAuthorName();
  const channels = useChannels(org.id);
  const toast = useToast();
  const downloads = useArtifactDownload();
  const searchRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [trashOpen, setTrashOpen] = useState(false);
  const [view, setViewState] = useState<DriveView>(() => {
    const saved = storage.get(STORAGE_KEYS.driveView);
    return isDriveView(saved) ? saved : "grid";
  });
  const setView = (v: DriveView) => {
    setViewState(v);
    storage.set(STORAGE_KEYS.driveView, v);
  };
  const [who, setWho] = useState<DriveWho>("all");
  const [kinds, setKinds] = useState<ArtifactKind[]>([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [group, setGroup] = useState<DriveGroup>("date");
  const [sort, setSort] = useState<DriveSort>("recent");
  // The item whose details are open, in the URL (`?open=…`).
  const [openId, setOpenParam] = useOpenParam();
  const setOpenId = (next: string | null | ((o: string | null) => string | null)) =>
    setOpenParam(typeof next === "function" ? next(openId) : next);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [uploadsHidden, setUploadsHidden] = useState(false);

  const search = useDeferredValue(q.trim());
  // One value of a filter goes to the server; several are matched here.
  const baseFilters = useMemo<ArtifactFilters>(() => {
    const f: ArtifactFilters = {};
    if (search) f.q = search;
    if (channelIds.length === 1) f.channelId = channelIds[0];
    const [type, id] = (authors.length === 1 ? (authors[0] ?? "") : "").split(":");
    if ((type === "agent" || type === "person") && id) f.author = { type, id };
    return f;
  }, [search, channelIds, authors]);
  const filters = useMemo<ArtifactFilters>(() => {
    const k = kinds.length === 1 ? kinds[0] : undefined;
    return k && isArtifactKind(k) ? { ...baseFilters, kind: k } : baseFilters;
  }, [baseFilters, kinds]);
  const list = useArtifacts(org.id, filters);
  // Without the kind: the counts on the kind chips (the same query when no single kind is picked).
  const base = useArtifacts(org.id, baseFilters);

  const remover = useDeleteArtifact((ids) => {
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    setOpenId((o) => (o && ids.includes(o) ? null : o));
  });
  const uploader = useDriveUpload((saved) =>
    toast.show(t("files.uploaded", { name: saved.title }), "info", {
      label: t("artifacts.openFile"),
      run: () => viewer.open(saved.id),
    }),
  );
  const upload = (files: File[]) => {
    setUploadsHidden(false);
    void uploader.upload(files);
  };
  const drop = useFileDrop(upload, !trashOpen);

  // A shared link (`/drive?artifact=…&v=…`) opens the viewer.
  useEffect(() => {
    if (open?.id) viewer.open(open.id, open.version);
  }, [open?.id, open?.version, viewer]);

  const channelName = useCallback(
    (id: string | null) => {
      const c = id ? channels.data?.find((x) => x.id === id) : undefined;
      return c ? `#${c.name}` : null;
    },
    [channels.data],
  );
  const channelLabel = (id: string | null) => channelName(id) ?? t("artifacts.noChannel");

  /** The client-side filters (who made it, several channels or authors). */
  const matches = (a: Artifact) =>
    byWho(a, who) &&
    (channelIds.length < 2 || (a.channelId !== null && channelIds.includes(a.channelId))) &&
    (authors.length < 2 ||
      authors.some(
        (x) => x === `${a.createdBy.type}:${a.createdBy.id}` || x === `${a.updatedBy.type}:${a.updatedBy.id}`,
      ));
  const rows = sortArtifacts(
    (list.data ?? []).filter((a) => matches(a) && (kinds.length < 2 || kinds.includes(a.kind))),
    sort,
    i18n.language,
  );
  const sections = groupArtifacts(rows, group);
  const shown = sections.flatMap((s) => s.items);
  const counts = new Map<ArtifactKind, number>();
  for (const a of base.data ?? []) if (matches(a)) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);

  const filtered = Boolean(search) || kinds.length > 0 || channelIds.length > 0 || authors.length > 0 || who !== "all";
  const clearFilters = () => {
    setKinds([]);
    setChannelIds([]);
    setAuthors([]);
    setWho("all");
  };
  const openItem = rows.find((a) => a.id === openId);
  const picked = shown.filter((a) => selected.has(a.id));

  const toggle = (a: Artifact) => {
    anchor.current = a.id;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(a.id)) next.delete(a.id);
      else next.add(a.id);
      return next;
    });
  };
  const pick = (a: Artifact, e: MouseEvent) => {
    if (e.shiftKey) {
      const range = rangeOf(
        shown.map((x) => x.id),
        anchor.current,
        a.id,
      );
      anchor.current = a.id;
      setSelected((s) => new Set([...s, ...range]));
      return;
    }
    if (e.metaKey || e.ctrlKey || selected.size > 0) {
      toggle(a);
      return;
    }
    anchor.current = a.id;
    setOpenId((o) => (o === a.id ? null : a.id));
  };
  const openViewer = (a: Artifact) => viewer.open(a.id);

  // "/" searches, ⌘A selects what's shown, Esc clears the selection.
  const keys = useRef({ shown, selected, openId, trashOpen });
  keys.current = { shown, selected, openId, trashOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keys.current;
      if (s.trashOpen || layerOpen()) return;
      const active = document.activeElement;
      if (e.key === "Escape") {
        if (typing(active)) return;
        // The details dialog closes itself on Esc; here Esc clears the selection.
        if (s.selected.size > 0) setSelected(new Set());
        return;
      }
      if (typing(active) || e.altKey) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && s.shown.length > 0) {
        e.preventDefault();
        setSelected(new Set(s.shown.map((a) => a.id)));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const downloadPicked = async () => {
    for (const a of picked) await downloads.save(a, undefined, a.version);
  };
  const copyLinks = async () => {
    await navigator.clipboard?.writeText(
      picked.map((a) => artifactLink(window.location.origin, org.id, a.id)).join("\n"),
    );
    toast.show(t("drive.linksCopied", { count: picked.length }));
  };
  const deletable = picked.filter((a) => a.canDelete);

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
  const channelOptions: FilterOption[] = (channels.data ?? []).map((c) => ({ value: c.id, label: `#${c.name}` }));
  const clearOf = (name: string) => t("filters.clear", { name });
  const chipText = {
    searchLabel: t("filters.search"),
    searchPlaceholder: t("filters.searchPlaceholder"),
    noResults: t("filters.noResults"),
  };
  const itemProps = (a: Artifact): ItemProps => ({
    artifact: a,
    open: a.id === openId,
    selected: selected.has(a.id),
    channelName: channelLabel,
    onPick: pick,
    onToggle: toggle,
    onOpen: openViewer,
  });

  const sectionTitle = (s: DriveSection) => {
    if (group === "date")
      return t(s.key === "today" ? "drive.today" : s.key === "week" ? "drive.thisWeek" : "drive.earlier");
    if (group === "channel") return channelName(s.key || null) ?? t("drive.noChannel");
    const first = s.items[0];
    return first ? authorName(first.createdBy) : "";
  };
  const sectionHead = (s: DriveSection) => {
    if (group === "none") return null;
    const first = s.items[0];
    const people = new Map(s.items.map((a) => [`${a.createdBy.type}:${a.createdBy.id}`, a.createdBy]));
    return (
      <div className="drive-group__head">
        {group === "author" && first && (
          <ActorAvatar size="xs" actor={first.createdBy} name={authorName(first.createdBy)} />
        )}
        {group === "channel" && <Icon name={s.key ? "channel" : "drive"} size={16} />}
        <h2 className="drive-group__title">{sectionTitle(s)}</h2>
        <span className="drive-count ac-num">{s.items.length}</span>
        {group === "channel" && (
          <span className="drive-group__stack" aria-hidden="true">
            {[...people.values()].slice(0, STACK_MAX).map((p) => (
              <ActorAvatar key={`${p.type}:${p.id}`} size="xs" actor={p} name={authorName(p)} />
            ))}
          </span>
        )}
      </div>
    );
  };

  const kindChips = ARTIFACT_KINDS.filter((k) => (counts.get(k) ?? 0) > 0 || kinds.includes(k));

  return (
    <div className={cx("page drive drive-drop", drop.over && "drive-drop--over")} {...drop.props}>
      {drop.over && <DropOverlay />}
      <div className="drive__main">
        <header className="drive-head">
          <div className="drive-head__text">
            <div className="drive-head__title">
              {trashOpen && (
                <Button
                  variant="ghost"
                  iconOnly
                  icon="chevronLeft"
                  aria-label={t("artifacts.backToDrive")}
                  title={t("artifacts.backToDrive")}
                  onClick={() => setTrashOpen(false)}
                />
              )}
              <h1>{trashOpen ? t("artifacts.trashTitle") : t("drive.title")}</h1>
            </div>
            <p className="drive-head__sub">{trashOpen ? t("artifacts.trashHint") : t("drive.subtitle")}</p>
          </div>
          {!trashOpen && (
            <div className="drive-head__actions">
              <Button
                variant="ghost"
                icon="trash"
                onClick={() => {
                  setTrashOpen(true);
                  setOpenId(null);
                  setSelected(new Set());
                }}
              >
                {t("artifacts.trash")}
              </Button>
              <UploadButton
                size="md"
                label={t("files.upload")}
                busy={uploader.busy}
                multiple
                onFiles={upload}
                variant="primary"
              />
            </div>
          )}
        </header>

        {trashOpen && <DriveTrash />}
        {remover.dialog}

        {!trashOpen && (
          <>
            <Toolbar
              search={
                <SearchField
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && q) {
                      e.stopPropagation();
                      setQ("");
                    }
                  }}
                  onClear={() => setQ("")}
                  clearLabel={t("filters.clearSearch")}
                  placeholder={t("drive.search")}
                  aria-label={t("drive.search")}
                  shortcut={
                    <Kbd title={t("drive.searchHint")} aria-hidden="true">
                      /
                    </Kbd>
                  }
                />
              }
              actions={
                <>
                  <Menu
                    align="end"
                    label={t("drive.arrange")}
                    trigger={
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="layers"
                        aria-label={t("drive.arrangeValue", { group: t(`drive.group.${group}`) })}
                      >
                        {t(`drive.group.${group}`)}
                      </Button>
                    }
                  >
                    <MenuRadioGroup
                      label={t("drive.groupBy")}
                      value={group}
                      onValueChange={(v) => setGroup(v as DriveGroup)}
                      options={DRIVE_GROUPS.map((g) => ({ value: g, label: t(`drive.group.${g}`) }))}
                    />
                    <MenuSeparator />
                    <MenuRadioGroup
                      label={t("drive.sortBy")}
                      value={sort}
                      onValueChange={(v) => setSort(v as DriveSort)}
                      options={DRIVE_SORTS.map((s) => ({ value: s, label: t(`drive.sort.${s}`) }))}
                    />
                  </Menu>
                  <Segmented<DriveView>
                    size="sm"
                    label={t("drive.view")}
                    value={view}
                    onValueChange={setView}
                    className="drive-view"
                    options={[
                      {
                        value: "grid",
                        label: (
                          <>
                            <Icon name="grid" size={16} />
                            <span className="ac-visually-hidden">{t("drive.viewGrid")}</span>
                          </>
                        ),
                      },
                      {
                        value: "list",
                        label: (
                          <>
                            <Icon name="list" size={16} />
                            <span className="ac-visually-hidden">{t("drive.viewList")}</span>
                          </>
                        ),
                      },
                    ]}
                  />
                </>
              }
            >
              <Segmented<DriveWho>
                label={t("drive.who")}
                value={who}
                onValueChange={setWho}
                options={[
                  { value: "all", label: t("drive.everyone") },
                  {
                    value: "agents",
                    label: (
                      <>
                        <Icon name="agent" size={16} />
                        {t("drive.agents")}
                      </>
                    ),
                  },
                  {
                    value: "people",
                    label: (
                      <>
                        <Icon name="person" size={16} />
                        {t("drive.people")}
                      </>
                    ),
                  },
                ]}
              />
              <FilterBar
                label={t("drive.filters")}
                clearText={t("drive.clear")}
                onClear={clearFilters}
                filters={[
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
              />
            </Toolbar>

            {kindChips.length > 0 && (
              <Toolbar label={t("drive.kinds")}>
                {kindChips.map((k) => (
                  <FilterToggle
                    key={k}
                    icon={KIND_ICON[k]}
                    pressed={kinds.includes(k)}
                    count={counts.get(k) ?? 0}
                    aria-label={t("drive.kindCount", { kind: t(`drive.kindMany.${k}`), count: counts.get(k) ?? 0 })}
                    onPressedChange={() => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]))}
                  >
                    {t(`drive.kindMany.${k}`)}
                  </FilterToggle>
                ))}
              </Toolbar>
            )}

            {filtered && list.isSuccess && rows.length > 0 && (
              <div className="drive-summary">
                <span>{t("drive.count", { count: rows.length })}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  onClick={() => {
                    setQ("");
                    clearFilters();
                  }}
                >
                  {t("drive.clear")}
                </Button>
              </div>
            )}

            {list.isLoading && <LoadingList count={5} trailing />}
            {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
            {list.isSuccess && rows.length === 0 && !filtered && (
              <EmptyState sky icon="drive" title={t("drive.emptyTitle")}>
                {t("drive.emptyText")} {t("files.emptyHint")}
              </EmptyState>
            )}
            {list.isSuccess && rows.length === 0 && filtered && (
              <EmptyState
                icon="search"
                title={t("drive.noResults")}
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
                {t("drive.noResultsHint")}
              </EmptyState>
            )}

            {rows.length > 0 && view === "grid" && (
              <div className={cx("drive-sections", selected.size > 0 && "drive--selecting")}>
                {sections.map((s) => (
                  <section key={s.key || "all"} className="drive-group">
                    {sectionHead(s)}
                    <div className="drive-grid">
                      {s.items.map((a) => (
                        <DriveCard key={a.id} {...itemProps(a)} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            {rows.length > 0 && view === "list" && (
              <div className={cx("drive-table", selected.size > 0 && "drive--selecting")}>
                <div className="drive-table__head" aria-hidden="true">
                  <span />
                  <span>{t("drive.name")}</span>
                  <span>{t("drive.by")}</span>
                  <span className="drive-row__where">{t("drive.where")}</span>
                  <span>{t("drive.when")}</span>
                  <span />
                </div>
                {sections.map((s) => (
                  <section key={s.key || "all"} className="drive-group">
                    {sectionHead(s)}
                    <ul className="drive-list">
                      {s.items.map((a) => (
                        <DriveRow key={a.id} {...itemProps(a)} onDelete={(x) => remover.ask(x)} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            {picked.length > 0 && (
              <div className="drive-selbar" role="toolbar" aria-label={t("drive.selection")}>
                <span className="drive-selbar__count">{t("drive.selected", { count: picked.length })}</span>
                <Button size="sm" variant="ghost" icon="download" onClick={() => void downloadPicked()}>
                  <span className="drive-selbar__label">{t("artifacts.download")}</span>
                </Button>
                <Button size="sm" variant="ghost" icon="link" onClick={() => void copyLinks()}>
                  <span className="drive-selbar__label">{t("drive.copyLinks")}</span>
                </Button>
                {deletable.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    className="drive-selbar__danger"
                    onClick={() => remover.ask(deletable)}
                  >
                    <span className="drive-selbar__label">{t("drive.moveToTrash")}</span>
                  </Button>
                )}
                <span className="drive-selbar__sep" aria-hidden="true" />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="close"
                  aria-label={t("drive.clearSelection")}
                  title={t("drive.clearSelection")}
                  onClick={() => setSelected(new Set())}
                />
              </div>
            )}
          </>
        )}
      </div>

      {openItem && !trashOpen && (
        <DriveDetails
          key={openItem.id}
          artifact={openItem}
          channelName={channelName}
          onClose={() => setOpenId(null)}
          onDelete={(a) => remover.ask(a)}
        />
      )}
      {uploader.queue.length > 0 && !uploadsHidden && (
        <UploadProgress queue={uploader.queue} onHide={() => setUploadsHidden(true)} />
      )}
    </div>
  );
}
