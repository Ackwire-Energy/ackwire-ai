import { useIssueColumns, useIssues } from "@agenteschat/client";
import { router } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Fragment, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, Filters, IconButton, Text } from "@/ui";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { FocusLive, PushedHeader } from "../shared/parts";
import { type BoardColumn, issueBoard } from "./logic";
import { BoardCard, ColumnHeader, useColumnLabel } from "./parts";

/** Cards whose agent moves (a long column stays light). */
const LIVE_CARDS = 8;
const COLUMN_GAP = 12;
/** How much of the next column shows at the edge. */
const PEEK = 41;

/**
 * Tasks, pushed from Você, as the board in the pocket: the stages side by side, swiped one at a time with the next
 * one showing at the edge, the tabs on top with their counts. In a column, what waits on someone comes first; custom
 * board columns show as headers. "+" opens "Nova tarefa". Columns are edited on the web only.
 */
export function IssuesScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const headerHeight = useHeaderHeight();
  const { width } = useWindowDimensions();
  const issues = useIssues(orgId);
  const columns = useIssueColumns(orgId);
  const pull = usePullRefresh(issues.refetch);
  const pager = useRef<ScrollView>(null);
  const [tab, setTab] = useState(0);
  // A tab tapped: where the pager is going, so the columns it passes on the way don't light up.
  const going = useRef<number | null>(null);
  const board = useMemo(() => issueBoard(issues.data ?? [], columns.data ?? []), [issues.data, columns.data]);
  const openNew = () => router.push("/issues/new");
  const columnWidth = width - PEEK - 16;
  const step = columnWidth + COLUMN_GAP;
  const columnAt = (x: number) => Math.max(0, Math.min(board.length - 1, Math.round(x / step)));
  const onPagerScroll = (x: number) => {
    const at = columnAt(x);
    if (going.current === null) setTab(at);
    else if (at === going.current && Math.abs(x - at * step) < 1) going.current = null;
  };
  const go = (index: number) => {
    going.current = index === tab ? null : index;
    setTab(index);
    pager.current?.scrollTo({ x: index * step, animated: true });
  };
  const empty = issues.isSuccess && (issues.data ?? []).length === 0;
  return (
    <View style={[styles.screen, { backgroundColor: c.bg, paddingTop: Platform.OS === "ios" ? headerHeight : 0 }]}>
      <PushedHeader
        solid={false}
        right={<IconButton icon="plus" label={t("mobile.issues.new")} onPress={openNew} />}
      />
      <Text variant="display" accessibilityRole="header" numberOfLines={1} style={styles.title}>
        {t("mobile.issues.title")}
      </Text>
      {issues.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      ) : issues.isError && !issues.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.issues.loadFailed")}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.common.retry")}
            onPress={() => void issues.refetch()}
          />
        </View>
      ) : empty ? (
        <EmptyState
          sky
          crew={dir.agents.slice(0, 3).map((a) => ({ ...agentLook(a), id: a.id }))}
          title={t("mobile.issues.empty")}
          subtitle={t("mobile.issues.emptyOpen")}
          action={<Button variant="primary" size="sm" icon="plus" label={t("mobile.issues.new")} onPress={openNew} />}
        />
      ) : (
        <>
          <Filters
            items={board.map((b) => ({
              key: b.stage,
              label: t(`mobile.issues.section.${b.stage}`),
              count: b.count,
            }))}
            value={board[tab]?.stage ?? ""}
            onChange={(k) => go(board.findIndex((b) => b.stage === k))}
          />
          <FocusLive>
            <ScrollView
              ref={pager}
              horizontal
              showsHorizontalScrollIndicator={false}
              snapToInterval={step}
              decelerationRate="fast"
              disableIntervalMomentum
              contentContainerStyle={styles.pager}
              scrollEventThrottle={32}
              onScrollBeginDrag={() => {
                going.current = null;
              }}
              onScroll={(e) => onPagerScroll(e.nativeEvent.contentOffset.x)}
            >
              {board.map((b) => (
                <Column key={b.stage} column={b} width={columnWidth} pull={pull} />
              ))}
            </ScrollView>
          </FocusLive>
        </>
      )}
    </View>
  );
}

function Column({
  column: b,
  width,
  pull,
}: {
  column: BoardColumn;
  width: number;
  pull: ReturnType<typeof usePullRefresh>;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const columnLabel = useColumnLabel();
  let card = 0;
  return (
    <ScrollView
      style={[styles.column, { width, backgroundColor: c.sunken }]}
      contentContainerStyle={[styles.columnBody, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {b.count === 0 ? (
        <Text variant="subhead" tone="faint" style={styles.none}>
          {t("mobile.issues.columnEmpty")}
        </Text>
      ) : null}
      {b.groups.map((g) => (
        <Fragment key={g.key}>
          {b.showColumns && g.column ? <ColumnHeader label={columnLabel(g.column)} count={g.items.length} /> : null}
          {g.items.map((i) => {
            card += 1;
            return <BoardCard key={i.id} issue={i} live={card <= LIVE_CARDS} />;
          })}
        </Fragment>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: { paddingHorizontal: 20, paddingTop: 4 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  pager: { paddingLeft: 16, paddingRight: PEEK - COLUMN_GAP, paddingTop: 8, gap: COLUMN_GAP },
  column: { borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  columnBody: { padding: 10, gap: 9 },
  none: { padding: 10, textAlign: "center" },
});
