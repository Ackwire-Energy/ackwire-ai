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
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { toggleTask } from "@agenteschat/client/lib/wiki";
import { type DiffLine, diffLines } from "@agenteschat/ui/diff";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  DiffView,
  EmptyState,
  fieldText,
  IconButton,
  Row,
  SearchField,
  SectionHeader,
  Text,
  useToast,
} from "@/ui";
import { Note } from "../ai/parts";
import { StarCard, StarStrip } from "../constellation/Constellation";
import { aroundStar, wikiMap } from "../constellation/logic";
import { chatHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { ActionList, copyText, goBack, PushedHeader, successHaptic, Tile, useSurface } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { foldersIn, searchWiki, wikiHome } from "./logic";
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
 * The wiki, pushed from Você: the large title, the search, Fixadas as cards with relief,
 * Editadas recentemente (who, agent alive, and when), Pastas, the pages at the root and what the agents read most;
 * "Nova página" floats at the bottom. `folder`: the same screen for one folder (its folders and pages).
 */
export function WikiScreen({ folder = "" }: { folder?: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  // Writing in the wiki is `edit_wiki` (ADR 0085; the server checks it again).
  const writes = can(useOrg().org, "edit_wiki");
  const dir = useDirectory();
  const insets = useSafeAreaInsets();
  const tree = useWikiTree(orgId);
  const reads = useWikiReads(orgId, folder === "");
  const graph = useWikiGraph(orgId, folder === "");
  const [picked, setPicked] = useState<string | null>(null);
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
  const pageRow = (p: WikiPageSummary, i: number, sub?: string) => (
    <Row
      key={p.id}
      divider={i > 0}
      leading={<PageTile page={p} />}
      title={p.title}
      {...(sub ? { subtitle: sub } : {})}
      chevron
      onPress={() => openWikiPage(p.slug)}
    />
  );
  return (
    <View style={styles.fill}>
      <PushedLargeTitle title={title} bottomInset={96}>
        {folder ? null : (
          <Text variant="subhead" tone="muted" style={styles.lead}>
            {t("wiki.subtitle")}
          </Text>
        )}
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
          <EmptyState icon="file" title={t("wiki.emptyTitle")} subtitle={t("mobile.wiki.empty")} />
        ) : null}
        {search ? (
          found.length === 0 ? (
            pages.length > 0 ? (
              <EmptyState icon="search" title={t("wiki.noMatch")} />
            ) : null
          ) : (
            <>
              <SectionHeader title={t("wiki.results", { count: found.length })} />
              {found.map((p, i) => pageRow(p, i, p.folder || undefined))}
            </>
          )
        ) : home ? (
          <>
            {map && star && !folder && map.stars.length > 1 ? (
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
                onOpen={() =>
                  star.kind === "agent" ? router.push(`/agent/${star.id}`) : openWikiPage(star.id)
                }
              />
            ) : null}
            {home.pinned.length > 0 ? (
              <>
                <SectionHeader title={t("wiki.pinnedPages")} count={home.pinned.length} />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pins}>
                  {home.pinned.map((p) => (
                    <PinCard key={p.id} page={p} by={`${dir.nameOf(p.updatedBy)} · ${when(p.updatedAt)}`} />
                  ))}
                </ScrollView>
              </>
            ) : null}
            {home.recent.length > 0 ? (
              <>
                <SectionHeader title={t("wiki.recent")} />
                {home.recent.map((p, i) => (
                  <Row
                    key={p.id}
                    divider={i > 0}
                    leading={<PageTile page={p} />}
                    title={p.title}
                    below={<ByLine who={p.updatedBy} text={when(p.updatedAt)} />}
                    chevron
                    onPress={() => openWikiPage(p.slug)}
                  />
                ))}
              </>
            ) : null}
            {home.folders.length > 0 ? (
              <>
                <SectionHeader title={t("wiki.folders")} count={home.folders.length} />
                {home.folders.map((f, i) => (
                  <Row
                    key={f.path}
                    divider={i > 0}
                    leading={<Tile icon="archive" />}
                    title={f.name}
                    meta={
                      <Text variant="subhead" tone="faint">
                        {t("wiki.pageCount", { count: f.count })}
                      </Text>
                    }
                    chevron
                    onPress={() => router.push({ pathname: "/wiki", params: { folder: f.path } })}
                  />
                ))}
              </>
            ) : null}
            {home.pages.length > 0 ? (
              <>
                <SectionHeader title={folder ? t("wiki.tree") : t("wiki.root")} count={home.pages.length} />
                {home.pages.map((p, i) => pageRow(p, i, p.excerpt))}
              </>
            ) : null}
            {!folder && (reads.data ?? []).length > 0 ? (
              <>
                <SectionHeader title={t("wiki.topReads")} />
                {(reads.data ?? []).slice(0, 5).map((r, i) => (
                  <Row
                    key={r.slug}
                    divider={i > 0}
                    leading={<Tile icon="file" />}
                    title={r.title}
                    meta={
                      <Text variant="subhead" tone="faint">
                        {t("mobile.wiki.reads", { count: r.total })}
                      </Text>
                    }
                    chevron
                    onPress={() => openWikiPage(r.slug)}
                  />
                ))}
              </>
            ) : null}
          </>
        ) : tree.isSuccess && pages.length > 0 ? (
          <EmptyState icon="archive" title={t("mobile.wiki.folderGone")} />
        ) : null}
      </PushedLargeTitle>
      {writes ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("wiki.newPage")}
          onPress={() => newWikiPage(folder ? { folder } : {})}
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: c.ink, bottom: insets.bottom + 18, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text variant="title2" style={[styles.fabPlus, { color: c.bg }]}>
            +
          </Text>
          <Text variant="callout" style={[styles.fabText, { color: c.bg }]}>
            {t("wiki.newPage")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const inFolder = (p: WikiPageSummary, folder: string) => p.folder === folder || p.folder.startsWith(`${folder}/`);

/** A page's tile: a lock when only admins edit it. */
function PageTile({ page }: { page: Pick<WikiPageSummary, "locked"> }) {
  return <Tile icon={page.locked ? "lock" : "file"} />;
}

/** Who changed it last (an agent alive) and when, under a row's title. */
function ByLine({ who, text }: { who: WikiPageSummary["updatedBy"]; text: string }) {
  const dir = useDirectory();
  return (
    <View style={styles.byline}>
      <Face who={who} size={16} />
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.grow}>
        {dir.nameOf(who)} · {text}
      </Text>
    </View>
  );
}

/** A pinned page as a card with relief: title, the opening text, who and when. */
function PinCard({ page, by }: { page: WikiPageSummary; by: string }) {
  const surface = useSurface();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openWikiPage(page.slug)}
      style={({ pressed }) => [styles.pin, surface, pressed && styles.pressed]}
    >
      <Text variant="label" tone="ink" numberOfLines={1}>
        {page.title}
      </Text>
      {page.excerpt ? (
        <Text variant="footnote" tone="muted" numberOfLines={2}>
          {page.excerpt}
        </Text>
      ) : null}
      <Text variant="caption" tone="faint" numberOfLines={1}>
        {by}
      </Text>
    </Pressable>
  );
}

interface MenuItem {
  key: string;
  icon: "copy" | "pen" | "pin" | "lock" | "clock" | "x";
  label: string;
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
  const writes = can(org, "edit_wiki");
  const admin = can(org, "configure");
  const page = useWikiPage(orgId, slug);
  const tree = useWikiTree(orgId);
  const action = useWikiAction(orgId);
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
    sheet.open(
      <ActionList
        items={items.map((i) => ({
          key: i.key,
          icon: i.icon,
          label: i.label,
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
                      style={styles.barWord}
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
          <EmptyState icon="file" title={t("wiki.missingTitle")} subtitle={t("mobile.wiki.missing")} />
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
              <View style={styles.byline}>
                <Face who={p.updatedBy} size={18} />
                <Text variant="footnote" tone="faint" style={styles.grow}>
                  {by} · {relativeTime(t, i18n.language, p.updatedAt)} · v{p.version}
                </Text>
              </View>
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
  b.kind === "page"
    ? `page:${b.slug}`
    : b.kind === "message"
      ? `message:${b.messageId}`
      : b.kind === "issue"
        ? `issue:${b.number}`
        : `forum:${b.topicId}`;

/** Where a page is mentioned: another page, a conversation (opens there), a task, or a forum topic (web only). */
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
    case "issue":
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
    default:
      return <Row divider={divider} leading={<Tile icon="list" />} title={b.title} />;
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
              <View style={styles.diffWrap}>
                <Text variant="footnote" tone="faint">
                  {t("wiki.versionDiff", { version: v.version })}
                </Text>
                <DiffView lines={open.lines} />
              </View>
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
            style={[styles.chip, { backgroundColor: on ? c.ink : c.sunken }]}
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
  pins: { gap: 10, paddingHorizontal: 16, paddingBottom: 4 },
  pin: { width: 210, borderRadius: 16, padding: 14, gap: 5 },
  pressed: { opacity: 0.85 },
  byline: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  fab: {
    position: "absolute",
    right: 18,
    height: 52,
    borderRadius: 26,
    paddingLeft: 16,
    paddingRight: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  fabPlus: { lineHeight: 26 },
  barRight: { flexDirection: "row", alignItems: "center", gap: 2 },
  barWord: { paddingHorizontal: 10, height: 36, justifyContent: "center" },
  barWordText: { fontWeight: "600" },
  fabText: { fontWeight: "600" },
  page: { paddingHorizontal: 20, paddingTop: 8, gap: 4 },
  note: { paddingTop: 10 },
  body: { paddingTop: 14 },
  diffWrap: { paddingHorizontal: 20, paddingBottom: 12, gap: 6 },
  form: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40, gap: 8 },
  field: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  gapTop: { marginTop: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7, paddingVertical: 4 },
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
});
