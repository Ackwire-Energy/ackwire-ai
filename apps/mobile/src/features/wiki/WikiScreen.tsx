import {
  keys,
  useApi,
  useWikiAction,
  useWikiGraph,
  useWikiHistory,
  useWikiPage,
  useWikiReads,
  useWikiTree,
  type WikiBacklink,
  type WikiPageSummary,
  type WikiVersion,
} from "@agenteschat/client";
import { capitalize, relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { titleOfSlug, toggleTask, wikiImportOf } from "@agenteschat/client/lib/wiki";
import { type DiffLine, diffLines } from "@agenteschat/ui/diff";
import { useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  DiffView,
  EmptyState,
  fieldText,
  Icon,
  IconButton,
  LineIcon,
  ListRow,
  Locked,
  Row,
  SearchField,
  SectionHeader,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { StarCard, StarStrip } from "../constellation/Constellation";
import { aroundStar, wikiMap } from "../constellation/logic";
import { chatHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { chooseAction } from "../settings/parts";
import { Face } from "../shared/Face";
import { FirstUse, useEmptyLook } from "../shared/FirstUse";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { ActionList, copyText, goBack, PushedHeader, successHaptic, Tile } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { foldersIn, searchWiki, wikiHome } from "./logic";
import { openWikiAgents, openWikiTrash, useWikiBulkDelete } from "./WikiBulk";
import { WikiDoc } from "./WikiDoc";

/** Opens a page of the wiki (its slug in the path, encoded: a slug may carry its folder). */
export const openWikiPage = (slug: string) => router.push(`/wiki/${encodeURIComponent(slug)}`);
/** "Nova página" (a short sheet), with a title already (a link to a page that doesn't exist yet) or a folder. */
export const newWikiPage = (params: { title?: string; folder?: string } = {}) =>
  router.push({ pathname: "/wiki-new", params });
/** Writing a page: an existing one by slug, or a new one with its title and folder. */
export const writeWikiPage = (params: { slug: string } | { title: string; folder: string }) =>
  router.push({ pathname: "/wiki-write", params });

/** A page by the `[[title]]` of a link: opens it, or offers to create it. */
export const openWikiLink = (title: string, page: WikiPageSummary | undefined) =>
  page ? openWikiPage(page.slug) : newWikiPage({ title });

/**
 * The wiki, pushed from Você, as Tarefas and Rotinas: the large title and the search, "+" (Nova página) in the bar
 * and "…" for the rest (who sees it, the map of the pages, choosing pages, the trash). One list, each page once:
 * Fixadas, Pastas (with how many pages), Páginas; every row a tile of 52 with its text at 80, who changed it last and
 * when. `folder`: the same screen for one folder (its folders and pages).
 */
export function WikiScreen({ folder = "" }: { folder?: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  // Writing in the wiki is `edit_wiki` (ADR 0085; the server checks it again).
  const { org } = useOrg();
  const writes = can(org, "edit_wiki");
  const choosesAudience = writes && can(org, "manage_roles");
  const dir = useDirectory();
  const insets = useSafeAreaInsets();
  const tree = useWikiTree(orgId);
  const reads = useWikiReads(orgId, folder === "");
  const graph = useWikiGraph(orgId, folder === "");
  const [picked, setPicked] = useState<string | null>(null);
  // The map of the pages, asked for from "…": the home is the list, the map is there when wanted.
  const [showMap, setShowMap] = useState(false);
  // Choosing pages to delete them or set their agents at once.
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const bulkDelete = useWikiBulkDelete();
  const stopSelecting = () => {
    setSelecting(false);
    setChosen(new Set());
  };
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  const pages = useMemo(() => tree.data ?? [], [tree.data]);
  const home = useMemo(() => wikiHome(pages, folder), [pages, folder]);
  const found = useMemo(
    () => searchWiki(folder ? pages.filter((p) => inFolder(p, folder)) : pages, search),
    [pages, folder, search],
  );
  const map = useMemo(
    () => (graph.data ? wikiMap(graph.data, reads.data ?? [], dir.agents) : null),
    [graph.data, reads.data, dir.agents],
  );
  const star =
    map?.stars.find((s) => s.id === picked) ??
    map?.stars.find((s) => s.id === home?.pinned[0]?.slug) ??
    map?.stars.find((s) => s.kind === "page");
  const when = (iso: string) => relativeTime(t, i18n.language, iso);
  const title = folder ? (folder.split("/").pop() ?? folder) : t("wiki.title");
  // The home and the search's results cross-fade as a search starts and ends, and fade in when they load.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  // Who changed it last and when; a pinned page says what it is about instead.
  const byLine = (p: WikiPageSummary) => `${dir.nameOf(p.updatedBy)} · ${when(p.updatedAt)}`;
  const pageRow = (p: WikiPageSummary, i: number, sub: string, icon?: "pin") => {
    const on = chosen.has(p.id);
    return (
      <ListRow
        key={p.id}
        divider={i > 0}
        leading={<PageTile page={p} icon={icon} />}
        title={p.title}
        sub={sub}
        subLines={1}
        {...(selecting
          ? {
              trailing: <Icon name={on ? "checkc" : "circle"} size={22} color={on ? c.ink : c.faint} />,
              accessibilityState: { selected: on },
              onPress: () => {
                const next = new Set(chosen);
                if (on) next.delete(p.id);
                else next.add(p.id);
                setChosen(next);
              },
            }
          : { onPress: () => openWikiPage(p.slug) })}
      />
    );
  };
  const inThisFolder = folder ? pages.filter((p) => inFolder(p, folder)).length : 0;
  // Each page once: a pinned page is under Fixadas only.
  const pinnedIds = new Set((home?.pinned ?? []).map((p) => p.id));
  const loose = (home?.pages ?? []).filter((p) => !pinnedIds.has(p.id));
  const choosable = search ? found : (home?.pages ?? []);
  const hasMap = Boolean(map && star && !folder && map.stars.length > 1);
  // "…": what the home no longer shows, each a line of the system's list.
  const menu = [
    ...(choosesAudience
      ? [
          {
            label: folder ? t("wiki.audience") : t("wiki.audienceRootTitle"),
            onPress: () =>
              router.push({ pathname: "/wiki-audience", params: folder ? { folder } : { root: "1" } }),
          },
        ]
      : []),
    ...(hasMap ? [{ label: t("mobile.wiki.map"), onPress: () => setShowMap((v) => !v) }] : []),
    ...(writes && pages.length > 0 ? [{ label: t("wiki.bulk.select"), onPress: () => setSelecting(true) }] : []),
    ...(!folder && writes ? [{ label: t("wiki.trash.title"), onPress: openWikiTrash }] : []),
    ...(folder && writes
      ? [
          {
            label: t("wiki.bulk.deleteFolder", { folder }),
            destructive: true,
            onPress: () =>
              bulkDelete.ask(
                { folder },
                inThisFolder,
                t("wiki.bulk.deleteFolderTitle", { folder, count: inThisFolder }),
                goBack,
              ),
          },
        ]
      : []),
  ];
  return (
    <View style={styles.fill}>
      <PushedLargeTitle
        title={title}
        bottomInset={selecting ? 96 : 24}
        right={
          selecting ? (
            <Button variant="secondary" size="sm" label={t("common.cancel")} onPress={stopSelecting} />
          ) : writes || menu.length > 0 ? (
            <View style={styles.headActs}>
              {writes ? (
                <IconButton
                  icon="plus"
                  label={t("wiki.newPage")}
                  onPress={() => newWikiPage(folder ? { folder } : {})}
                />
              ) : null}
              {menu.length > 0 ? (
                <IconButton
                  icon="more"
                  label={t("mobile.wiki.more")}
                  disabled={bulkDelete.pending}
                  onPress={() => chooseAction(title, menu, t("common.cancel"))}
                />
              ) : null}
            </View>
          ) : undefined
        }
      >
        <View style={styles.search}>
          <SearchField
            value={q}
            onChangeText={setQ}
            placeholder={t("wiki.searchPlaceholder")}
            accessibilityLabel={t("wiki.searchPlaceholder")}
            returnKeyType="search"
          />
        </View>
        {tree.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
        {tree.isError && !tree.data ? (
          <View style={styles.center}>
            <Text tone="muted" style={styles.centerText}>
              {t("common.loadFailed")}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.common.retry")}
              onPress={() => void tree.refetch()}
            />
          </View>
        ) : null}
        {tree.isSuccess && pages.length === 0 ? (
          <FirstUse
            place="wiki"
            size="panel"
            acts={writes}
            label={t("wiki.newPage")}
            onPress={() => newWikiPage(folder ? { folder } : {})}
          />
        ) : null}
        {selecting ? (
          <>
            <SectionHeader
              title={chosen.size ? t("wiki.bulk.selected", { count: chosen.size }) : t("wiki.bulk.select")}
              count={choosable.length}
            />
            <Locked when={bulkDelete.pending}>
              {choosable.map((p, i) => pageRow(p, i, p.folder || byLine(p)))}
            </Locked>
          </>
        ) : search ? (
          found.length === 0 ? (
            pages.length > 0 ? (
              <EmptyState
                size="inline"
                title={t("wiki.noMatch")}
                action={
                  <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
                }
              />
            ) : null
          ) : (
            <Animated.View key="found" {...fade}>
              <SectionHeader title={t("wiki.results", { count: found.length })} />
              {found.map((p, i) => pageRow(p, i, p.folder || byLine(p)))}
            </Animated.View>
          )
        ) : home ? (
          <Animated.View key="home" {...fade}>
            {showMap && hasMap && map && star ? (
              <StarCard
                label={t("mobile.wiki.map")}
                count={pages.length}
                map={map}
                selected={star.id}
                onSelect={setPicked}
                title={star.title}
                subtitle={
                  star.kind === "agent"
                    ? t("mobile.wiki.mapAgent")
                    : [star.folder, t("mobile.wiki.reads", { count: star.weight })].filter(Boolean).join(" · ")
                }
                onOpen={() => (star.kind === "agent" ? router.push(`/agent/${star.id}`) : openWikiPage(star.id))}
              />
            ) : null}
            {home.pinned.length > 0 ? (
              <>
                <SectionHeader title={t("wiki.pinnedPages")} count={home.pinned.length} />
                {home.pinned.map((p, i) => pageRow(p, i, p.excerpt || byLine(p), "pin"))}
              </>
            ) : null}
            {home.folders.length > 0 ? (
              <>
                <SectionHeader title={t("wiki.folders")} count={home.folders.length} />
                {home.folders.map((f, i) => (
                  <ListRow
                    key={f.path}
                    divider={i > 0}
                    leading={<Tile icon="archive" size={ROW_TILE} />}
                    title={f.name}
                    sub={t("wiki.pageCount", { count: f.count })}
                    subLines={1}
                    onPress={() => router.push({ pathname: "/wiki", params: { folder: f.path } })}
                  />
                ))}
              </>
            ) : null}
            {loose.length > 0 ? (
              <>
                <SectionHeader title={t("wiki.tree")} count={loose.length} />
                {loose.map((p, i) => pageRow(p, i, byLine(p)))}
              </>
            ) : null}
          </Animated.View>
        ) : tree.isSuccess && pages.length > 0 ? (
          <EmptyState icon="archive" title={t("mobile.wiki.folderGone")} />
        ) : null}
      </PushedLargeTitle>
      {selecting ? (
        <View
          style={[styles.pickBar, { paddingBottom: insets.bottom + 12, backgroundColor: c.bg, borderColor: c.line }]}
        >
          {choosesAudience ? (
            <Button
              variant="secondary"
              label={t("wiki.bulk.agents")}
              disabled={chosen.size === 0}
              onPress={() => {
                openWikiAgents([...chosen]);
                stopSelecting();
              }}
            />
          ) : null}
          <View style={styles.grow}>
            <Button
              variant="primary"
              wide
              label={chosen.size ? t("wiki.bulk.deleteGo", { count: chosen.size }) : t("wiki.bulk.delete")}
              loading={bulkDelete.pending}
              disabled={chosen.size === 0 || bulkDelete.pending}
              onPress={() =>
                bulkDelete.ask(
                  { ids: [...chosen] },
                  chosen.size,
                  t("wiki.bulk.deleteTitle", { count: chosen.size }),
                  stopSelecting,
                )
              }
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The rows' tile, in the 52 column of a list row (the text at 80). */
const ROW_TILE = 52;

const inFolder = (p: WikiPageSummary, folder: string) => p.folder === folder || p.folder.startsWith(`${folder}/`);

/** A page's tile: a lock when only admins edit it, a pin under Fixadas. */
function PageTile({ page, icon }: { page: Pick<WikiPageSummary, "locked">; icon?: "pin" | undefined }) {
  return <Tile icon={page.locked ? "lock" : (icon ?? "file")} size={ROW_TILE} />;
}

interface MenuItem {
  key: string;
  icon: "copy" | "pen" | "pin" | "eye" | "lock" | "clock" | "x" | "agent" | "trash";
  label: string;
  /** What it does, under the label. */
  hint?: string;
  danger?: boolean;
  run: () => void;
}

/**
 * A page: its folder, the title, who wrote it (and at whose request) with the version, the text
 * (links open or create; tasks check with a tap for whoever may edit), "Mencionada em" and the history. The bar:
 * "Editar" (writing, the B layout) and ⋯ (Copiar link, Renomear ou mover, Fixar, Trancar, Histórico, Lixeira).
 */
export function WikiPageScreen({ slug }: { slug: string }) {
  return (
    <SheetHostProvider>
      <WikiPage slug={slug} />
    </SheetHostProvider>
  );
}

function WikiPage({ slug }: { slug: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useFailed();
  const sheet = useSheet();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  // Writing is `edit_wiki`; a locked page, and locking, only for who configures the workspace (ADR 0085).
  const page = useWikiPage(orgId, slug);
  const writes = can(org, "edit_wiki") && page.data?.canEdit !== false;
  const look = useEmptyLook();
  const admin = can(org, "configure");
  // Who sees a page: anyone who edits it (the server checks the same); agents and editors, who manages roles too.
  const choosesAudience = writes;
  const tree = useWikiTree(orgId);
  const action = useWikiAction(orgId);
  const bulkDelete = useWikiBulkDelete();
  const graph = useWikiGraph(orgId, true);
  const insets = useSafeAreaInsets();
  const p = page.data;
  const editable = p ? writes && (!p.locked || admin) : false;
  const pages = useMemo(() => tree.data ?? [], [tree.data]);
  const readers = useMemo(() => p?.reads?.agents ?? [], [p?.reads?.agents]);
  const around = useMemo(() => {
    if (!graph.data || !p) return null;
    const near = aroundStar(
      wikiMap(graph.data, [{ slug: p.slug, total: p.reads?.total ?? 0, agents: readers }], dir.agents),
      p.slug,
    );
    return near.stars.length > 1 ? near : null;
  }, [graph.data, p, readers, dir.agents]);

  const toggle = (line: number) => {
    if (!p) return;
    const body = toggleTask(p.body, line);
    if (body === p.body) return;
    action.mutate(
      { type: "update", slug: p.slug, input: { body, baseVersion: p.version } },
      {
        onError: (e) => {
          if ((e as { code?: string }).code === "version_conflict") {
            void page.refetch();
            toast({ title: t("mobile.wiki.taskConflict"), icon: "x" });
          } else failed(e);
        },
      },
    );
  };

  const remove = () => {
    if (!p) return;
    Alert.alert(t("wiki.deleteTitle", { title: p.title }), t("wiki.deleteText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("wiki.delete"),
        style: "destructive",
        onPress: () =>
          void api.wiki
            .remove(orgId, p.slug)
            .then(() => {
              successHaptic();
              void qc.invalidateQueries({ queryKey: keys.wiki(orgId) });
              toast({ title: t("wiki.deleted", { title: p.title }) });
              goBack();
            })
            .catch(failed),
      },
    ]);
  };

  const openMenu = () => {
    if (!p) return;
    const items: MenuItem[] = [
      {
        key: "copy",
        icon: "copy",
        label: t("wiki.copyLink"),
        run: () =>
          void copyText(`[[${p.title}]]`).then((ok) =>
            toast(
              ok ? { title: t("wiki.linkCopied", { title: p.title }) } : { title: t("mobile.app.failed"), icon: "x" },
            ),
          ),
      },
    ];
    if (editable)
      items.push({
        key: "move",
        icon: "pen",
        label: t("wiki.renameOrMove"),
        run: () => router.push({ pathname: "/wiki-move", params: { slug: p.slug } }),
      });
    if (writes)
      items.push({
        key: "pin",
        icon: "pin",
        label: p.pinned ? t("wiki.unpin") : t("wiki.pin"),
        run: () =>
          action.mutate(
            { type: "pin", slug: p.slug, pinned: !p.pinned },
            { onSuccess: (x) => toast({ title: x.pinned ? t("wiki.pinned") : t("wiki.unpinned") }), onError: failed },
          ),
      });
    if (writes)
      items.push({
        key: "context",
        icon: "agent",
        label: p.agentContext ? t("wiki.context.off") : t("wiki.context.on"),
        hint: t("wiki.context.hint"),
        run: () =>
          action.mutate(
            { type: "context", slug: p.slug, on: !p.agentContext },
            {
              onSuccess: (x) => toast({ title: x.agentContext ? t("wiki.context.added") : t("wiki.context.removed") }),
              onError: failed,
            },
          ),
      });
    if (choosesAudience)
      items.push({
        key: "audience",
        icon: "eye",
        label: t("wiki.audience"),
        run: () => router.push({ pathname: "/who-sees", params: { slug: p.slug } }),
      });
    if (admin)
      items.push({
        key: "lock",
        icon: "lock",
        label: p.locked ? t("wiki.unlock") : t("wiki.lock"),
        run: () =>
          action.mutate(
            { type: "lock", slug: p.slug, locked: !p.locked },
            {
              onSuccess: (x) => toast({ title: x.locked ? t("wiki.lockedDone") : t("wiki.unlockedDone") }),
              onError: failed,
            },
          ),
      });
    items.push({
      key: "history",
      icon: "clock",
      label: t("wiki.history"),
      run: () => router.push({ pathname: "/wiki-history", params: { slug: p.slug } }),
    });
    if (editable) items.push({ key: "delete", icon: "x", label: t("wiki.delete"), danger: true, run: remove });
    const imported = writes ? wikiImportOf(pages, p) : null;
    if (imported)
      items.push({
        key: "delete-import",
        icon: "trash",
        label: t("wiki.bulk.deleteImport", { name: imported.name, count: imported.pages.length }),
        danger: true,
        run: () =>
          bulkDelete.ask(
            imported.target,
            imported.pages.length,
            t("wiki.bulk.deleteImportTitle", { name: imported.name, count: imported.pages.length }),
            goBack,
          ),
      });
    sheet.open(
      <ActionList
        items={items.map((i) => ({
          key: i.key,
          icon: i.icon,
          label: i.label,
          ...(i.hint ? { hint: i.hint } : {}),
          ...(i.danger ? { danger: true } : {}),
          onPress: () => {
            sheet.close();
            i.run();
          },
        }))}
      />,
    );
  };

  const person = p?.updatedBy.onBehalfOf ? dir.memberById.get(p.updatedBy.onBehalfOf)?.name : undefined;
  const by = p
    ? person
      ? t("wiki.byFor", { name: dir.nameOf(p.updatedBy), person })
      : t("wiki.by", { name: dir.nameOf(p.updatedBy) })
    : "";
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        solid={false}
        {...(p
          ? {
              right: (
                <View style={styles.barRight}>
                  {editable ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("wiki.edit")}
                      onPress={() => writeWikiPage({ slug: p.slug })}
                      hitSlop={6}
                      style={({ pressed }) => [styles.barWord, pressed && styles.pressedWord]}
                    >
                      <Text variant="callout" style={[styles.barWordText, { color: c.agent }]}>
                        {t("wiki.edit")}
                      </Text>
                    </Pressable>
                  ) : null}
                  <IconButton icon="more" label={t("wiki.more")} onPress={openMenu} />
                </View>
              ),
            }
          : {})}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        {page.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
        {page.isError && !p ? (
          (page.error as { code?: string } | null)?.code === "wiki.no_access" ? (
            <EmptyState icon="lock" title={t("wiki.noAccessTitle")} subtitle={t("wiki.noAccessText")} />
          ) : (page.error as { status?: number } | null)?.status === 404 ? (
            <EmptyState
              size="panel"
              agent={look}
              title={t("wiki.missingTitle")}
              subtitle={t(writes ? "wiki.missingText" : "wiki.missingViewer")}
              {...(writes
                ? {
                    action: (
                      <Button
                        variant="primary"
                        size="sm"
                        icon="plus"
                        label={t("wiki.createPage")}
                        onPress={() => newWikiPage({ title: capitalize(titleOfSlug(slug), i18n.language) })}
                      />
                    ),
                  }
                : {})}
            />
          ) : (
            <View style={styles.center}>
              <Text tone="muted" style={styles.centerText}>
                {t("common.loadFailed")}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                label={t("mobile.common.retry")}
                onPress={() => void page.refetch()}
              />
            </View>
          )
        ) : null}
        {p ? (
          <>
            {around ? <StarStrip map={around} selected={p.slug} /> : null}
            <View style={styles.page}>
              {p.folder ? (
                <Text variant="subhead" tone="faint">
                  {p.folder}
                </Text>
              ) : null}
              <Text variant="display2" accessibilityRole="header">
                {p.title}
              </Text>
              {/* Top-aligned, the face on the first line: a long "by … for …" line wraps under it. */}
              <View style={[styles.byline, styles.top]}>
                <LineIcon variant="footnote" size={18}>
                  <Face who={p.updatedBy} size={18} />
                </LineIcon>
                <Text variant="footnote" tone="faint" style={styles.grow}>
                  {by} · {relativeTime(t, i18n.language, p.updatedAt)} · v{p.version}
                </Text>
              </View>
              {p.audience || p.agentIds ? (
                <View style={styles.note}>
                  <Note icon="eye">{p.audience ? t("wiki.restrictedHint") : t("wiki.audienceAgentsOnlyHint")}</Note>
                </View>
              ) : null}
              {p.canEdit === false ? (
                <View style={styles.note}>
                  <Note icon="eye">{t("wiki.readOnlyHint")}</Note>
                </View>
              ) : null}
              {p.locked ? (
                <View style={styles.note}>
                  <Note icon="lock">{t("wiki.lockedHint")}</Note>
                </View>
              ) : null}
              <View style={styles.body}>
                {p.body.trim() ? (
                  <WikiDoc
                    body={p.body}
                    pages={pages}
                    onOpenLink={openWikiLink}
                    onToggleTask={editable ? toggle : undefined}
                  />
                ) : (
                  <Text variant="body" tone="faint">
                    {t("mobile.wiki.blank")}
                  </Text>
                )}
              </View>
            </View>
            {readers.length > 0 ? (
              <>
                <SectionHeader title={t("mobile.wiki.usedBy")} />
                <Row
                  leading={<Face who={{ type: "agent", id: readers[0]?.agentId ?? null }} size={36} live={false} />}
                  title={readers.map((r) => dir.nameOf({ type: "agent", id: r.agentId })).join(", ")}
                  subtitle={t("mobile.wiki.readsWeek", { count: p.reads?.total ?? 0 })}
                />
              </>
            ) : null}
            <SectionHeader title={t("wiki.backlinks")} count={p.backlinks.length} />
            {p.backlinks.length === 0 ? (
              <Text variant="footnote" tone="faint" style={styles.lead}>
                {t("wiki.noBacklinksHint", { title: p.title })}
              </Text>
            ) : (
              p.backlinks.map((b, i) => <BacklinkRow key={backlinkKey(b)} link={b} divider={i > 0} />)
            )}
            <SectionHeader title={t("wiki.history")} />
            <Row
              leading={<Tile icon="clock" />}
              title={t("wiki.allVersions", { count: p.version })}
              subtitle={t("wiki.historyText")}
              subtitleLines={2}
              chevron
              onPress={() => router.push({ pathname: "/wiki-history", params: { slug: p.slug } })}
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const backlinkKey = (b: WikiBacklink) =>
  b.kind === "page" ? `page:${b.slug}` : b.kind === "message" ? `message:${b.messageId}` : `issue:${b.number}`;

/** Where a page is mentioned: another page, a conversation (opens there) or a task. */
function BacklinkRow({ link: b, divider }: { link: WikiBacklink; divider: boolean }) {
  switch (b.kind) {
    case "page":
      return (
        <Row
          divider={divider}
          leading={<Tile icon="file" />}
          title={b.title}
          {...(b.excerpt ? { subtitle: b.excerpt, subtitleLines: 2 } : {})}
          chevron
          onPress={() => openWikiPage(b.slug)}
        />
      );
    case "message":
      return (
        <Row
          divider={divider}
          leading={<Tile icon="chat" />}
          title={`#${b.channelName}`}
          subtitle={b.excerpt}
          subtitleLines={2}
          chevron
          onPress={() => router.push(chatHref(b.channelId))}
        />
      );
    default:
      return (
        <Row
          divider={divider}
          leading={<Tile icon="checkc" />}
          title={b.title}
          meta={
            <Text variant="subhead" tone="faint">
              #{b.number}
            </Text>
          }
          chevron
          onPress={() => router.push(`/issues/${b.number}`)}
        />
      );
  }
}

/**
 * The page's history (the web's dialog as a screen): every version with who made it, at whose request and
 * what changed; a version opens what it changed from the one before.
 */
export function WikiHistoryScreen({ slug }: { slug: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const api = useApi();
  const failed = useFailed();
  const page = useWikiPage(orgId, slug);
  const history = useWikiHistory(orgId, slug, true);
  const [open, setOpen] = useState<{ version: number; lines: DiffLine[] } | null>(null);
  const show = async (version: number) => {
    if (open?.version === version) {
      setOpen(null);
      return;
    }
    try {
      const after = await api.wiki.version(orgId, slug, version);
      const before = version > 1 ? await api.wiki.version(orgId, slug, version - 1) : { body: "" };
      setOpen({ version, lines: diffLines(before.body.split("\n"), after.body.split("\n")) });
    } catch (e) {
      failed(e);
    }
  };
  const reduced = useReducedMotion();
  const noteOf = (v: WikiVersion) =>
    v.noteCode ? t(`wiki.note.${v.noteCode}`, v.noteParams ?? {}) : (v.note ?? undefined);
  return (
    <PushedLargeTitle title={t("wiki.history")}>
      <Text variant="subhead" tone="muted" style={styles.lead}>
        {page.data ? t("wiki.historyTitle", { title: page.data.title }) : t("wiki.historyText")}
      </Text>
      {history.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {(history.data ?? []).map((v, i) => {
        const person = v.author.onBehalfOf ? dir.memberById.get(v.author.onBehalfOf)?.name : undefined;
        const who = person ? t("wiki.byFor", { name: dir.nameOf(v.author), person }) : dir.nameOf(v.author);
        const note = noteOf(v);
        return (
          <View key={v.version}>
            <Row
              divider={i > 0}
              leading={<Face who={v.author} size={36} />}
              title={`v${v.version} · ${who}`}
              {...(note ? { subtitle: note, subtitleLines: 2 } : {})}
              meta={
                <Text variant="subhead" tone="faint">
                  {relativeTime(t, i18n.language, v.at)}
                </Text>
              }
              onPress={() => void show(v.version)}
            />
            {open?.version === v.version ? (
              <Animated.View entering={reduced ? undefined : FadeIn.duration(160)} style={styles.diffWrap}>
                <Text variant="footnote" tone="faint">
                  {t("wiki.versionDiff", { version: v.version })}
                </Text>
                <DiffView lines={open.lines} />
              </Animated.View>
            ) : null}
          </View>
        );
      })}
    </PushedLargeTitle>
  );
}

/**
 * "Renomear ou mover": the title (links to it follow) and the folder, with the folders in use as shortcuts and
 * "Raiz". Salvar renames and moves, then shows the page at its new address.
 */
export function WikiMoveScreen({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const page = useWikiPage(orgId, slug);
  const tree = useWikiTree(orgId);
  const action = useWikiAction(orgId);
  const p = page.data;
  const [title, setTitle] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nextTitle = (title ?? p?.title ?? "").trim();
  const nextFolder = cleanFolder(folder ?? p?.folder ?? "");
  const folders = foldersIn(tree.data ?? []);
  const save = async () => {
    if (!p || saving) return;
    if (!nextTitle) {
      toast({ title: t("wiki.form.required"), icon: "x" });
      return;
    }
    setSaving(true);
    try {
      let current = p;
      if (nextFolder !== p.folder)
        current = await action.mutateAsync({ type: "move", slug: p.slug, folder: nextFolder });
      if (nextTitle !== p.title)
        current = await action.mutateAsync({ type: "rename", slug: current.slug, title: nextTitle });
      successHaptic();
      toast({ title: nextTitle !== p.title ? t("wiki.renamed") : t("wiki.saved") });
      router.dismissTo(`/wiki/${encodeURIComponent(current.slug)}`);
    } catch (e) {
      failed(e);
    } finally {
      setSaving(false);
    }
  };
  const field = [styles.field, fieldText("body"), { backgroundColor: c.sunken, color: c.ink }];
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={t("wiki.renameOrMove")}
        solid={false}
        action={{ label: t("common.save"), onPress: () => void save(), disabled: saving || !p }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.form}
      >
        <Locked when={saving} style={styles.formFields}>
          <Text variant="footnote" tone="faint">
            {t("wiki.form.title")}
          </Text>
          <TextInput
            value={title ?? p?.title ?? ""}
            onChangeText={setTitle}
            placeholder={t("wiki.form.titlePlaceholder")}
            placeholderTextColor={c.faint}
            style={field}
          />
          <Text variant="footnote" tone="faint">
            {t("wiki.renameHelp")}
          </Text>
          <Text variant="footnote" tone="faint" style={styles.gapTop}>
            {t("wiki.form.folder")}
          </Text>
          <TextInput
            value={folder ?? p?.folder ?? ""}
            onChangeText={setFolder}
            placeholder={t("wiki.form.folderPlaceholder")}
            placeholderTextColor={c.faint}
            autoCapitalize="words"
            style={field}
          />
          <FolderChips folders={folders} value={nextFolder} onPick={setFolder} />
          <Text variant="footnote" tone="faint">
            {t("wiki.form.folderHelp")}
          </Text>
        </Locked>
      </ScrollView>
    </View>
  );
}

/** A folder as typed: no slashes at its ends. */
export const cleanFolder = (folder: string) => folder.trim().replace(/^\/+|\/+$/g, "");

/** The folders in use as one-tap choices, "Raiz" first. */
export function FolderChips({
  folders,
  value,
  onPick,
}: {
  folders: string[];
  value: string;
  onPick: (folder: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.chips}>
      {["", ...folders].map((f) => {
        const on = f === value;
        return (
          <Pressable
            key={f || "root"}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onPick(f)}
            hitSlop={4}
            style={({ pressed }) => [
              styles.chip,
              { backgroundColor: on ? c.ink : c.sunken },
              pressed && styles.pressedWord,
            ]}
          >
            <Text variant="subhead" style={{ color: on ? c.bg : c.ink2 }}>
              {f || t("wiki.root")}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  lead: { paddingHorizontal: 20, marginTop: -4 },
  search: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  loading: { marginVertical: 24 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  pressed: { opacity: 0.85 },
  pressedWord: { opacity: 0.6 },
  byline: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  top: { alignItems: "flex-start" },
  barRight: { flexDirection: "row", alignItems: "center", gap: 2 },
  barWord: { paddingHorizontal: 10, height: 36, justifyContent: "center" },
  barWordText: { fontWeight: "600" },
  headActs: { flexDirection: "row", gap: 4 },
  pickBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  page: { paddingHorizontal: 20, paddingTop: 8, gap: 4 },
  note: { paddingTop: 10 },
  body: { paddingTop: 14 },
  diffWrap: { paddingHorizontal: 20, paddingBottom: 12, gap: 6 },
  form: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40, gap: 8 },
  formFields: { gap: 8 },
  field: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  gapTop: { marginTop: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 4 },
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
});
