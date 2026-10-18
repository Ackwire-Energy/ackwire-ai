import { keys } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet } from "react-native";
import { LargeTitleScreen, Text } from "@/ui";
import { workByAgent } from "../agents/logic";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { useConversations, useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { ConversationRowView } from "./ConversationRowView";
import { FirstAgentEmpty, Greeting } from "./Greeting";
import { CollapsibleSection, SeeAllRow, useCollapsedSections } from "./HomeSection";
import { homeSections, type ListKind } from "./logic";
import { useAgentRowStates, useFinished } from "./useHomeNow";
import { useWaitingItems, WaitingStrip } from "./WaitingStrip";

/** Rows of the home whose agent moves (a long list stays light). */
const LIVE_ROWS = 6;
/** How often who is working is asked again while Conversas shows (runs start in conversations it doesn't follow). */
const WORKING_POLL_MS = 20_000;

/** A section's "Ver todos", pushed. */
export const openKindList = (kind: ListKind) => router.push(`/conversations/${kind}`);

/**
 * Conversas, the home (MobileHomeAgentes.html, Recomendada; MobileRefinos.html; MobileIntencional.html, A): the
 * greeting over a light sky with what changed (what an agent finished, how many work), the native large title
 * with Você and "+" (Novo) in the bar, the "Esperando você" strip (only while something waits; it opens into
 * the first item's card, and scrolling closes it), then Agentes, Canais and Pessoas by latest activity, each
 * collapsible (remembered), five rows and "Ver todos". An agent's row says it waits on your ok, or what it is
 * doing. Search and Threads have their own tabs. Empty, it invites the first agent.
 */
export function ChatsScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const focused = useIsFocused();
  const header = useTabHeader();
  const dir = useDirectory();
  const list = useConversations();
  const work = useWorkingNow();
  const waiting = useWaitingItems();
  const { collapsed, toggle } = useCollapsedSections();
  const [waitOpen, setWaitOpen] = useState(false);

  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: keys.working(orgId) }), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [focused, qc, orgId]);

  const working = workByAgent(work)
    .map((w) => w.agentId)
    .filter((id) => dir.agentById.has(id));
  const finished = useFinished(work, list.rows);
  const agentStates = useAgentRowStates(list.rows, work, waiting.items);
  const pull = usePullRefresh(() => Promise.allSettled([list.refetch(), waiting.refetch()]));
  const sections = homeSections(list.rows);
  const empty = !list.loading && list.rows.length === 0;
  const strip = <WaitingStrip items={waiting.items} open={waitOpen} onOpenChange={setWaitOpen} />;

  let live = 0;
  return (
    <LargeTitleScreen
      title={t("mobile.chats.title")}
      {...header}
      header={
        empty
          ? undefined
          : (reach) => (
              <Greeting
                working={working}
                finished={finished.finished}
                onFinishedPress={(f) => finished.dismiss(f.key)}
                reach={reach}
              />
            )
      }
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      onScrollBeginDrag={waitOpen ? () => setWaitOpen(false) : undefined}
    >
      {strip}
      {empty ? (
        <FirstAgentEmpty />
      ) : list.loading ? (
        <Text tone="faint" style={styles.center}>
          {t("mobile.common.loading")}
        </Text>
      ) : (
        sections.map((s) => {
          const off = collapsed.includes(s.key);
          return (
            <CollapsibleSection
              key={s.key}
              title={t(`mobile.chats.section.${s.key}`)}
              count={s.total}
              collapsed={off}
              onToggle={() => toggle(s.key)}
            >
              {s.rows.map((r, i) => (
                <ConversationRowView
                  key={r.key}
                  row={r}
                  divider={i > 0}
                  live={!off && live++ < LIVE_ROWS}
                  agent={agentStates.get(r.key)}
                />
              ))}
              {s.more ? (
                <SeeAllRow label={t(`mobile.chats.seeAll.${s.key}`)} onPress={() => openKindList(s.key)} />
              ) : null}
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
