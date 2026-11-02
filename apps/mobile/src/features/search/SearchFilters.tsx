import { useSearch } from "@agenteschat/client";
import {
  groupByChannel,
  SEARCH_HAS,
  SEARCH_OPS,
  SEARCH_SORTS,
  type SearchChip,
  type SearchDirectory,
  type SearchSort,
  type SearchWords,
  searchChipKey,
  searchChipLabel,
  searchFilterInput,
  suggestActors,
  suggestPlaces,
  typingOperator,
} from "@agenteschat/client/lib/search-filters";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, Filters, Icon, Text } from "@/ui";
import { Note } from "../ai/parts";
import { chatHref } from "../links/logic";
import { Face } from "../shared/Face";
import { useColors, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { ActionList, Tile } from "../shared/parts";

/** The filters on the box (ADR 0123): each a pill with its ×. */
export function FilterChips({ chips, onRemove }: { chips: SearchChip[]; onRemove: (chip: SearchChip) => void }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.chips}
    >
      {chips.map((chip) => {
        const label = searchChipLabel(t, i18n.language, chip);
        return (
          <Pressable
            key={searchChipKey(chip)}
            onPress={() => onRemove(chip)}
            accessibilityRole="button"
            accessibilityLabel={t("searchPage.removeFilter", { filter: label })}
            style={[styles.chip, { backgroundColor: c.sunken }]}
          >
            <Text variant="subhead">{label}</Text>
            <Icon name="x" size={14} color={c.muted} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** With nothing typed: the operators to start a filter with (`from:`, `in:`…), and the recent searches. */
export function SearchOptions({
  words,
  onInsert,
  recent,
  onPickRecent,
  onClearRecent,
}: {
  words: SearchWords;
  onInsert: (word: string) => void;
  recent: string[];
  onPickRecent: (search: string) => void;
  onClearRecent: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View>
      <Text variant="label" accessibilityRole="header" style={styles.head}>
        {t("searchPage.options")}
      </Text>
      <Filters
        items={SEARCH_OPS.map((op) => ({ key: op, label: `${words.ops[op]}:` }))}
        value=""
        onChange={(op) => onInsert(`${words.ops[op as keyof SearchWords["ops"]]}:`)}
      />
      {recent.length > 0 ? (
        <View style={[styles.res, styles.group]}>
          <View style={styles.groupTitle}>
            <Text variant="label" accessibilityRole="header">
              {t("searchPage.recent")}
            </Text>
            <Pressable onPress={onClearRecent} accessibilityRole="button" hitSlop={8}>
              <Text tone="faint">{t("searchPage.clearRecent")}</Text>
            </Pressable>
          </View>
          <ActionList
            items={recent.map((r) => ({ key: r, icon: "clock", label: r, onPress: () => onPickRecent(r) }))}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The picker of the operator being typed: people and agents with their faces, channels and DMs, kinds. */
export function OperatorPicker({
  text,
  directory,
  words,
  onPick,
}: {
  text: string;
  directory: SearchDirectory;
  words: SearchWords;
  /** The chip, and the box's text without the operator. */
  onPick: (chip: SearchChip, rest: string) => void;
}) {
  const { t } = useTranslation();
  const typing = typingOperator(text, words);
  if (!typing) return null;
  const rest = text.slice(0, typing.start);
  const op = typing.op;
  const items =
    op === "from" || op === "mentions"
      ? suggestActors(typing.value, directory.actors).map((a) => ({
          key: `${a.type}:${a.id}`,
          leading: <Face who={a} size={30} live={false} />,
          label: a.name,
          ...(a.handle ? { hint: `@${a.handle}` } : {}),
          onPress: () => onPick({ op, actor: a }, rest),
        }))
      : op === "in"
        ? suggestPlaces(typing.value, directory.places).map((p) => ({
            key: p.id,
            leading: <Tile icon={p.dm ? "chat" : "hash"} size={30} />,
            label: p.dm ? t("searchPage.dm", { name: p.name }) : p.name,
            onPress: () => onPick({ op, place: p }, rest),
          }))
        : op === "has"
          ? SEARCH_HAS.map((h) => ({
              key: h,
              label: t(`searchPage.hasLabel.${h}`),
              onPress: () => onPick({ op, value: h }, rest),
            }))
          : op === "author"
            ? (["person", "agent"] as const).map((a) => ({
                key: a,
                label: t(`searchPage.authorLabel.${a}`),
                onPress: () => onPick({ op, value: a }, rest),
              }))
            : op === "pinned"
              ? [
                  {
                    key: "pinned",
                    icon: "pin" as const,
                    label: t("searchPage.pinnedChip"),
                    onPress: () => onPick({ op }, rest),
                  },
                ]
              : // Dates are typed (`before:2026-10-01`), the format is the hint.
                [];
  return (
    <View style={styles.group}>
      <Text variant="label" accessibilityRole="header" style={styles.head}>
        {t(`searchPage.option.${op}`)}
      </Text>
      {items.length > 0 ? (
        <ActionList items={items} />
      ) : (
        <Text tone="faint" style={styles.head}>
          {op === "in"
            ? t("searchPage.noPlace")
            : op === "from" || op === "mentions"
              ? t("searchPage.noMatch")
              : t("searchPage.dateHint")}
        </Text>
      )}
    </View>
  );
}

/** Messages that pass the filters (ADR 0123), by channel, with the sort; a tap opens the conversation (a reply its thread). */
export function FilteredResults({
  chips,
  text,
  directory,
  sort,
  onSort,
  onClear,
  onOpen,
}: {
  chips: SearchChip[];
  text: string;
  directory: SearchDirectory;
  sort: SearchSort;
  onSort: (sort: SearchSort) => void;
  /** Removes every chip. */
  onClear: () => void;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const when = useWhen();
  const hits = useSearch(useOrgId(), text, ["message"], searchFilterInput(chips, sort));
  const list = hits.data ?? [];
  const place = (id: string) => directory.places.find((p) => p.id === id);
  return (
    <View>
      <Filters
        items={SEARCH_SORTS.map((s) => ({ key: s, label: t(`searchPage.sort.${s}`) }))}
        value={sort}
        onChange={(s) => onSort(s as SearchSort)}
      />
      <View style={styles.res}>
        <View style={styles.bar}>
          <Text tone="faint" accessibilityRole="text">
            {list.length >= 100
              ? t("searchPage.countMore", { count: 100 })
              : list.length > 0
                ? t("searchPage.count", { count: list.length })
                : ""}
          </Text>
          <Pressable onPress={onClear} accessibilityRole="button" hitSlop={8} style={styles.clear}>
            <Text tone="faint">{t("searchPage.filtersApplied", { count: chips.length })}</Text>
            <Icon name="x" size={14} color={c.muted} />
          </Pressable>
        </View>
        {hits.isLoading ? <ActivityIndicator color={c.muted} style={styles.empty} /> : null}
        {hits.isError && !hits.data ? (
          <View style={styles.group}>
            <Note icon="x">{t("common.loadFailed")}</Note>
            <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void hits.refetch()} />
          </View>
        ) : null}
        {groupByChannel(list).map(([channelId, inChannel]) => {
          const p = place(channelId);
          return (
            <View key={channelId} style={styles.group}>
              <Text variant="label" accessibilityRole="header" style={styles.groupTitle}>
                {p ? (p.dm ? t("searchPage.dm", { name: p.name }) : `#${p.name}`) : ""}
              </Text>
              <ActionList
                items={inChannel.map((h) => ({
                  key: h.sourceId,
                  leading: h.author ? <Face who={h.author} size={34} live={false} /> : <Tile icon="chat" size={34} />,
                  label: previewOf(h.snippet),
                  hint: [h.author?.name, when.short(h.createdAt)].filter(Boolean).join(" · "),
                  onPress: () => {
                    onOpen();
                    router.push(chatHref(channelId, h.threadId, h.messageId));
                  },
                }))}
              />
            </View>
          );
        })}
        {hits.isSuccess && list.length === 0 ? (
          <Text tone="faint" style={styles.empty}>
            {t("mobile.find.nothing", {
              q: text.trim() || chips.map((c) => searchChipLabel(t, i18n.language, c)).join(" "),
            })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { gap: 6, paddingHorizontal: 16, paddingBottom: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingHorizontal: 12, borderRadius: 999 },
  head: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 6 },
  res: { paddingHorizontal: 16, paddingTop: 2 },
  group: { marginTop: 14, gap: 8 },
  groupTitle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 4,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 4,
    paddingTop: 8,
  },
  clear: { flexDirection: "row", alignItems: "center", gap: 4 },
  empty: { textAlign: "center", paddingVertical: 40 },
});
