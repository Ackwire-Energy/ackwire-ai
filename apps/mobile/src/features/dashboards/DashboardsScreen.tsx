import { type DashboardSummary, dashboardGroups, useDashboards } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, RefreshControl, StyleSheet, View } from "react-native";
import { Button, GroupedFooter, GroupedHeader, GroupedList, LargeTitleScreen, Text, useTheme } from "@/ui";
import { boardHref } from "../links/logic";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { useSearchAction, useTabHeader } from "../shared/tabHeader";
import { HOME } from "./logic";
import { BoardRow, useBoardByline } from "./parts";

/** Opens "New dashboard". */
export const openNewBoard = () => router.push("/board-new");

/**
 * Dashboards, a tab between Chats and Threads (ADR 0134): My Home on top (the person's own widgets), then the boards
 * of the whole workspace, of the person's roles and only theirs, each with a thumbnail of its widgets. A row pushes
 * the board; "+" in the bar makes a new one. With only My Home, a line under it says where the others will be (no
 * empty state: My Home is a board).
 */
export function DashboardsScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const orgId = useOrgId();
  const header = useTabHeader();
  const search = useSearchAction();
  const list = useDashboards(orgId);
  const pull = usePullRefresh(list.refetch);
  const byline = useBoardByline();
  const groups = dashboardGroups(list.data?.dashboards ?? []);
  const any = groups.workspace.length + groups.roles.length + groups.mine.length > 0;
  const row = (board: DashboardSummary) => (
    <BoardRow
      key={board.id}
      board={board}
      title={board.title}
      sub={byline(board)}
      locked={board.audience !== "workspace"}
      onPress={() => router.push(boardHref(board.id))}
    />
  );
  const group = (title: string, boards: DashboardSummary[]) =>
    boards.length > 0 ? (
      <View key={title}>
        <GroupedHeader>{title}</GroupedHeader>
        <GroupedList>{boards.map(row)}</GroupedList>
      </View>
    ) : null;
  return (
    <LargeTitleScreen
      title={t("dashboards.title")}
      left={header.left}
      actions={[
        ...(search ? [search] : []),
        { icon: "plus", sf: "plus", label: t("dashboards.new"), onPress: openNewBoard },
      ]}
      grouped
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <View style={styles.in}>
        <GroupedList>
          <BoardRow
            board={{ thumbs: list.data?.home?.thumbs ?? [] }}
            title={t("dashboards.home")}
            sub={t("mobile.dashboards.homeRow")}
            locked={false}
            onPress={() => router.push(boardHref(HOME))}
          />
        </GroupedList>
        {list.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={c.muted} />
          </View>
        ) : list.isError && !list.data ? (
          <View style={styles.center}>
            <Text tone="muted" style={styles.centerText}>
              {t("mobile.dashboards.loadFailed")}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.common.retry")}
              onPress={() => void list.refetch()}
            />
          </View>
        ) : any ? (
          <>
            {group(t("dashboards.groups.workspace"), groups.workspace)}
            {group(t("dashboards.groups.roles"), groups.roles)}
            {group(t("dashboards.groups.mine"), groups.mine)}
          </>
        ) : list.data ? (
          <GroupedFooter>{t("mobile.dashboards.onlyHome")}</GroupedFooter>
        ) : null}
      </View>
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  in: { paddingHorizontal: 16, paddingTop: 4 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
});
