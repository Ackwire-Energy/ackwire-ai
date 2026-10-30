import { useChannelCategories } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, Text } from "@/ui";
import { useColors, useOrgId, usePullRefresh } from "../shared/hooks";
import { FocusLive, PushedHeader } from "../shared/parts";
import { useConversations, useWorkingNow } from "../shared/queries";
import { ConversationRowView } from "./ConversationRowView";
import { type ConversationRow, type ListKind, rowsOfKind } from "./logic";
import { useAgentRowStates } from "./useHomeNow";
import { useWaitingItems } from "./WaitingStrip";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Every conversation of one kind, pushed from a section's "Ver todos" on Conversas (agents, channels,
 * people), by latest activity, in Conversas' rows (an agent's says it waits on you, or what it is doing).
 */
export function ConversationListScreen({ kind, categoryId }: { kind: ListKind; categoryId?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const list = useConversations();
  const categories = useChannelCategories(useOrgId());
  // One channel category's "Ver todos": its channels, titled with its name.
  const category = categoryId ? categories.data?.find((x) => x.id === categoryId) : undefined;
  const inCategory = (r: ConversationRow) => r.kind === "channel" && r.categoryId === categoryId;
  const rows = categoryId ? rowsOfKind(list.rows, "channels").filter(inCategory) : rowsOfKind(list.rows, kind);
  const work = useWorkingNow();
  const waiting = useWaitingItems();
  const agentStates = useAgentRowStates(list.rows, work, waiting.items);
  const pull = usePullRefresh(list.refetch);
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={categoryId ? (category?.name ?? "") : t(`mobile.chats.section.${kind}`)} solid={false} />
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
            <EmptyState icon="chat" title={t("mobile.chats.empty")} />
          ) : (
            rows.map((r, i) => (
              <ConversationRowView
                key={r.key}
                row={r}
                divider={i > 0}
                live={i < LIVE_ROWS}
                agent={agentStates.get(r.key)}
              />
            ))
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
