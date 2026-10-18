import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet } from "react-native";
import { EmptyState, LargeTitleScreen, Text } from "@/ui";
import { usePullRefresh } from "../shared/hooks";
import { useConversations } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { ConversationRowView } from "./ConversationRowView";
import { threadRows } from "./logic";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Threads, the second tab: my threads and missions by latest activity, in Conversas' rows (a mission says
 * where it runs and how far its plan is), under the native large title with Você and "+" in the bar.
 */
export function ThreadsScreen() {
  const { t } = useTranslation();
  const header = useTabHeader();
  const list = useConversations();
  const rows = threadRows(list.rows);
  const pull = usePullRefresh(list.refetch);
  return (
    <LargeTitleScreen
      title={t("mobile.threads.title")}
      {...header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {list.loading ? (
        <Text tone="faint" style={styles.center}>
          {t("mobile.common.loading")}
        </Text>
      ) : rows.length === 0 ? (
        <EmptyState title={t("mobile.threads.empty")} subtitle={t("mobile.threads.emptyHint")} />
      ) : (
        rows.map((r, i) => <ConversationRowView key={r.key} row={r} divider={i > 0} live={i < LIVE_ROWS} />)
      )}
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: "center", paddingVertical: 40 },
});
