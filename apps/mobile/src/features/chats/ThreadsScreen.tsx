import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet } from "react-native";
import { STORED } from "@/lib/storage";
import { EmptyState, LargeTitleScreen, Text } from "@/ui";
import { usePullRefresh } from "../shared/hooks";
import { useConversations } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { ConversationRowView } from "./ConversationRowView";
import { CollapsibleSection, useCollapsedSections } from "./HomeSection";
import { THREAD_SECTIONS, threadRows, threadSections } from "./logic";
import { useWaitingItems, WaitingStrip } from "./WaitingStrip";
import { waitingInThreads } from "./waiting";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Threads, the second tab (MobileRefinos.html, Threads C): like the home, under the native large title with
 * Você and "+" in the bar, the "Esperando você" strip with only what waits in missions and threads, then the
 * sections Missões and Threads (collapsible, remembered) in Conversas' rows.
 */
export function ThreadsScreen() {
  const { t } = useTranslation();
  const header = useTabHeader();
  const list = useConversations();
  const waiting = useWaitingItems();
  const { collapsed, toggle } = useCollapsedSections(STORED.threadsCollapsed, THREAD_SECTIONS);
  const [waitOpen, setWaitOpen] = useState(false);
  const rows = threadRows(list.rows);
  const sections = threadSections(rows);
  const threadIds = new Set(rows.flatMap((r) => (r.kind === "thread" || r.kind === "mission" ? [r.threadId] : [])));
  const items = waitingInThreads(waiting.items, threadIds);
  const pull = usePullRefresh(() => Promise.allSettled([list.refetch(), waiting.refetch()]));
  let live = 0;
  return (
    <LargeTitleScreen
      title={t("mobile.threads.title")}
      {...header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      onScrollBeginDrag={waitOpen ? () => setWaitOpen(false) : undefined}
    >
      <WaitingStrip items={items} open={waitOpen} onOpenChange={setWaitOpen} />
      {list.loading ? (
        <Text tone="faint" style={styles.center}>
          {t("mobile.common.loading")}
        </Text>
      ) : rows.length === 0 ? (
        <EmptyState title={t("mobile.threads.empty")} subtitle={t("mobile.threads.emptyHint")} />
      ) : (
        sections.map((s) => {
          const off = collapsed.includes(s.key);
          return (
            <CollapsibleSection
              key={s.key}
              title={t(`mobile.threads.section.${s.key}`)}
              count={s.rows.length}
              collapsed={off}
              onToggle={() => toggle(s.key)}
            >
              {s.rows.map((r, i) => (
                <ConversationRowView key={r.key} row={r} divider={i > 0} live={!off && live++ < LIVE_ROWS} />
              ))}
            </CollapsibleSection>
          );
        })
      )}
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: "center", paddingVertical: 40 },
});
