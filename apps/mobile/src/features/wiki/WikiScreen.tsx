import { useWikiPage, useWikiTree, type WikiBacklink, type WikiPageSummary } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { resolveWikiLink, wikiLinksIn } from "@agenteschat/client/lib/wiki";
import { router } from "expo-router";
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SearchField } from "@/ui";
import { Note } from "../ai/parts";
import { MessageText } from "../chat/MessageText";
import { chatHref } from "../links/logic";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { Gap, SettingsPage } from "../settings/parts";
import { isWikiSlug, plainWikiText, searchWiki, type WikiGroup, wikiGroups } from "./logic";

/** Opens a page of the wiki (its slug in the path, encoded: a slug may carry its folder). */
export const openWikiPage = (slug: string) => router.push(`/wiki/${encodeURIComponent(slug)}`);

/**
 * The wiki, pushed from Você, as the web's home: the search, then Fixadas, Editadas recentemente and every
 * folder with its pages (the root first). A page opens its own screen. Writing pages stays on the web for now.
 */
export function WikiScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const tree = useWikiTree(orgId);
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  const pages = tree.data ?? [];
  const groups = useMemo(() => wikiGroups(pages), [pages]);
  const found = useMemo(() => searchWiki(pages, search), [pages, search]);
  const heading = (g: WikiGroup) =>
    g.kind === "pinned" ? t("wiki.pinnedPages") : g.kind === "recent" ? t("wiki.recent") : g.folder || t("wiki.root");
  return (
    <SettingsPage title={t("wiki.title")}>
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
        <View style={styles.note}>
          <Note icon="x">{t("common.loadFailed")}</Note>
        </View>
      ) : null}
      {tree.isSuccess && pages.length === 0 ? (
        <>
          <GroupedHeader>{t("wiki.emptyTitle")}</GroupedHeader>
          <GroupedFooter>{t("mobile.wiki.empty")}</GroupedFooter>
        </>
      ) : null}
      {search ? (
        found.length === 0 ? (
          pages.length > 0 ? (
            <GroupedFooter>{t("wiki.noMatch")}</GroupedFooter>
          ) : null
        ) : (
          <>
            <GroupedHeader>{t("wiki.results", { count: found.length })}</GroupedHeader>
            <PageRows pages={found} withFolder />
          </>
        )
      ) : (
        groups.map((g) => (
          <View key={g.key}>
            <GroupedHeader>{heading(g)}</GroupedHeader>
            <PageRows pages={g.pages} withFolder={g.kind !== "folder"} />
          </View>
        ))
      )}
    </SettingsPage>
  );
}

/** Pages as rows: the title, the folder (outside a folder's own group) and the opening text. */
function PageRows({ pages, withFolder }: { pages: WikiPageSummary[]; withFolder: boolean }) {
  return (
    <GroupedList>
      {pages.map((p) => (
        <GroupedRow
          key={p.id}
          icon={p.locked ? "lock" : p.pinned ? "pin" : "doc"}
          label={p.title}
          {...(withFolder && p.folder ? { value: p.folder } : {})}
          {...(p.excerpt ? { sub: p.excerpt, subLines: 2 } : {})}
          chevron
          onPress={() => openWikiPage(p.slug)}
        />
      ))}
    </GroupedList>
  );
}

/**
 * A page of the wiki: its folder, who changed it last and when under the title; the text drawn (its `[[links]]` as
 * words); "Links nesta página" (to the pages they name, or "ainda não existe"); and "Mencionada em" (pages and
 * conversations that point here).
 */
export function WikiPageScreen({ slug }: { slug: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const orgId = useOrgId();
  const page = useWikiPage(orgId, slug);
  const tree = useWikiTree(orgId);
  const p = page.data;
  const body = useMemo(() => (p ? plainWikiText(p.body) : ""), [p]);
  const links = useMemo(() => {
    if (!p) return [];
    const pages = tree.data ?? [];
    return wikiLinksIn(p.body).map((title) => ({ title, page: resolveWikiLink(pages, title) }));
  }, [p, tree.data]);
  const subtitle = p
    ? [
        p.folder || null,
        t("wiki.by", { name: dir.nameOf(p.updatedBy) }),
        t("wiki.updated", { when: relativeTime(t, i18n.language, p.updatedAt), version: p.version }),
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  return (
    <SettingsPage title={p?.title ?? t("wiki.title")} subtitle={subtitle}>
      {page.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {page.isError && !p ? (
        <View style={styles.note}>
          <Note icon="x">{t("mobile.wiki.missing")}</Note>
        </View>
      ) : null}
      {p ? (
        <>
          {p.locked ? <GroupedFooter>{t("wiki.lockedHint")}</GroupedFooter> : null}
          <Gap />
          <GroupedList>
            <View style={styles.page}>
              {body.trim() ? (
                <MessageText body={body} />
              ) : (
                <MessageText body={`_${t("mobile.wiki.blank")}_`} muted />
              )}
            </View>
          </GroupedList>
          {links.length > 0 ? (
            <>
              <GroupedHeader>{t("mobile.wiki.links")}</GroupedHeader>
              <GroupedList>
                {links.map((l) => (
                  <GroupedRow
                    key={l.title}
                    icon="doc"
                    label={l.page?.title ?? l.title}
                    {...(l.page ? { chevron: true, onPress: () => openWikiPage(l.page?.slug ?? "") } : {})}
                    {...(l.page ? {} : { value: t("mobile.wiki.notYet"), disabled: true })}
                  />
                ))}
              </GroupedList>
            </>
          ) : null}
          <GroupedHeader>{t("wiki.backlinks")}</GroupedHeader>
          {p.backlinks.length === 0 ? (
            <GroupedFooter>{t("wiki.noBacklinks")}</GroupedFooter>
          ) : (
            <GroupedList>
              {p.backlinks.map((b) => (
                <BacklinkRow key={backlinkKey(b)} link={b} />
              ))}
            </GroupedList>
          )}
        </>
      ) : null}
    </SettingsPage>
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
function BacklinkRow({ link: b }: { link: WikiBacklink }) {
  switch (b.kind) {
    case "page":
      return (
        <GroupedRow
          icon="doc"
          label={b.title}
          {...(b.excerpt ? { sub: b.excerpt } : {})}
          chevron
          onPress={() => openWikiPage(b.slug)}
        />
      );
    case "message":
      return (
        <GroupedRow
          icon="chat"
          label={`#${b.channelName}`}
          sub={b.excerpt}
          chevron
          onPress={() => router.push(chatHref(b.channelId))}
        />
      );
    case "issue":
      return (
        <GroupedRow
          icon="checkc"
          label={b.title}
          value={`#${b.number}`}
          chevron
          onPress={() => router.push(`/issues/${b.number}`)}
        />
      );
    default:
      return <GroupedRow icon="list" label={b.title} />;
  }
}

/** The route's slug, decoded, or null when it isn't one. */
export function wikiSlugOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const slug = decodeURIComponent(raw);
    return isWikiSlug(slug) ? slug : null;
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  search: { paddingTop: 14, paddingBottom: 8 },
  loading: { marginVertical: 16 },
  note: { paddingHorizontal: 4, paddingTop: 10 },
  page: { paddingHorizontal: 16, paddingVertical: 14 },
});
