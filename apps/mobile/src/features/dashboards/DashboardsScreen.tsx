import { type DashboardSummary, dashboardGroups, useDashboards } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { Button, GroupedFooter, GroupedHeader, GroupedList, IconButton, SkeletonList, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { boardHref } from "../links/logic";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { HOME } from "./logic";
import { BoardRow, useBoardByline } from "./parts";

/** Opens "New dashboard". */
export const openNewBoard = () => router.push("/board-new");

/**
 * Dashboards, pushed from "See all" over the home's widgets (ADR 0135; the tab bar stays as it is): My Home on top (the
 * person's own widgets), then the boards of the whole workspace, of the person's roles and only theirs, each with a
 * thumbnail of its widgets (the one on Início says "On Home"). A row pushes the board; "+" in the bar makes a new one.
 * With only My Home, a line under it says where the others will be (no empty state: My Home is a board).
 */
export function DashboardsScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const list = useDashboards(orgId);
  const pull = usePullRefresh(list.refetch);
  const byline = useBoardByline();
  const groups = dashboardGroups(list.data?.dashboards ?? []);
  // The board on Início ("Use on Home", ADR 0135 §18) says so first on its line.
  const onHome = list.data?.homeDashboardId ?? null;
  const any = groups.workspace.length + groups.roles.length + groups.mine.length > 0;
  const row = (board: DashboardSummary) => (
    <BoardRow
      key={board.id}
      board={board}
      title={board.title}
      sub={board.id === onHome ? [t("dashboards.onHome"), byline(board)].filter(Boolean).join(" · ") : byline(board)}
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
    <PushedLargeTitle
      title={t("dashboards.title")}
      right={<IconButton icon="plus" label={t("dashboards.new")} onPress={openNewBoard} />}
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
          // Loading: the rows' own shape, never a spinner.
          <SkeletonList rows={4} />
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
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  in: { paddingHorizontal: 16, paddingTop: 4 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
});
