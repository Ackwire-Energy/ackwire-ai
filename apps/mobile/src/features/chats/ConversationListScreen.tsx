import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, Text } from "@/ui";
import { useColors, usePullRefresh } from "../shared/hooks";
import { FocusLive, PushedHeader } from "../shared/parts";
import { useConversations } from "../shared/queries";
import { ConversationRowView } from "./ConversationRowView";
import { type ListKind, rowsOfKind } from "./logic";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Every conversation of one kind, pushed from a section's "Ver todos" on Conversas (agents, channels,
 * people), by latest activity, in Conversas' rows.
 */
export function ConversationListScreen({ kind }: { kind: ListKind }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const list = useConversations();
  const rows = rowsOfKind(list.rows, kind);
  const pull = usePullRefresh(list.refetch);
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={t(`mobile.chats.section.${kind}`)} solid={false} />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 24 }}
        >
          {list.loading ? (
            <Text tone="faint" style={styles.center}>
              {t("mobile.common.loading")}
            </Text>
          ) : rows.length === 0 ? (
            <EmptyState title={t("mobile.chats.empty")} />
          ) : (
            rows.map((r, i) => <ConversationRowView key={r.key} row={r} divider={i > 0} live={i < LIVE_ROWS} />)
          )}
        </ScrollView>
      </FocusLive>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { textAlign: "center", paddingVertical: 40 },
});
