import { keys } from "@agenteschat/client";
import { waitingComputerByAgent } from "@agenteschat/client/lib/machine-outages";
import { useQueryClient } from "@tanstack/react-query";
import { router, useIsFocused } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, RefreshControl, StyleSheet } from "react-native";
import { usePush } from "@/providers/push";
import { LargeTitleScreen, Text } from "@/ui";
import { workByAgent } from "../agents/logic";
import { SetupNotice } from "../computer/SetupWait";
import { OutageNotices } from "../outages/OutageNotice";
import { useMachineOutages } from "../outages/queries";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { useActiveWork, useConversations, useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { ConversationRowView } from "./ConversationRowView";
import { FirstAgentEmpty, Greeting, GreetingSky } from "./Greeting";
import { CollapsibleSection, SeeAllRow, useCollapsedSections } from "./HomeSection";
import { homeSections, type ListKind } from "./logic";
import { useAgentRowStates, useFinished } from "./useHomeNow";
import { useWaitingItems, WaitingStrip } from "./WaitingStrip";

/** Rows of the home whose agent moves (a long list stays light). */
const LIVE_ROWS = 6;
/** How often who is working is asked again while Conversas shows (runs start in conversations it doesn't follow). */
const WORKING_POLL_MS = 20_000;
/** How long Conversas shows, loaded, before our notifications sheet opens over it (past the launch). */
const PUSH_OFFER_MS = 2500;

/** A section's "Ver todos", pushed. */
export const openKindList = (kind: ListKind) => router.push(`/conversations/${kind}`);

/**
 * Conversas, the home: the
 * large title with Você and "+" (Novo) in the bar, over a light sky, the greeting under it with what changed
 * (what an agent finished, how many work), the "Esperando você" strip (only while something waits; it opens into
 * the first item's card, and scrolling closes it), then Agentes, Canais and Pessoas by latest activity, each
 * collapsible (remembered), five rows and "Ver todos". Under the greeting, the workspace's own computer while it
 * is being prepared, and a notice per computer that went offline with agents waiting for it. An agent's row says it waits on your ok, waits
 * for its computer, or what it is doing. Search and Threads have their own tabs. Empty, it invites the first agent.
 * Our notifications sheet opens over it (never inside a conversation), once it has loaded and once more at the
 * first request to approve, while the phone wasn't asked yet (`lib/push-offer.ts`).
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
  // A run that stops on your ok hasn't finished: "terminou" is told from all the work, waiting included.
  const active = useActiveWork();
  const waiting = useWaitingItems();
  const { collapsed, toggle } = useCollapsedSections();
  const [waitOpen, setWaitOpen] = useState(false);

  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: keys.working(orgId) }), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [focused, qc, orgId]);

  const outages = useMachineOutages();
  const offline = useMemo(() => waitingComputerByAgent(outages.outages), [outages.outages]);
  // An agent waiting for its offline computer isn't working (its run only waits).
  const working = workByAgent(work)
    .map((w) => w.agentId)
    .filter((id) => dir.agentById.has(id) && !offline.has(id));
  const finished = useFinished(active, list.rows);
  const agentStates = useAgentRowStates(list.rows, work, waiting.items, offline);
  const pull = usePullRefresh(() => Promise.allSettled([list.refetch(), waiting.refetch(), outages.refetch()]));
  const sections = homeSections(list.rows);
  const empty = !list.loading && list.rows.length === 0;

  const { offer, markOffered } = usePush();
  const approvalWaits = waiting.items.some((i) => i.kind === "approval");
  const offerPush = focused && !list.loading && !empty && (offer.home || (offer.approval && approvalWaits));
  useEffect(() => {
    if (!offerPush) return;
    const timer = setTimeout(() => {
      if (AppState.currentState !== "active") return;
      markOffered();
      router.push("/push-ask");
    }, PUSH_OFFER_MS);
    return () => clearTimeout(timer);
  }, [offerPush, markOffered]);
  const strip = <WaitingStrip items={waiting.items} open={waitOpen} onOpenChange={setWaitOpen} />;

  let live = 0;
  return (
    <LargeTitleScreen
      title={t("mobile.chats.title")}
      {...header}
      backdrop={empty ? undefined : <GreetingSky />}
      below={
        empty ? undefined : (
          <Greeting working={working} finished={finished.finished} onFinishedPress={(f) => finished.dismiss(f.key)} />
        )
      }
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      onScrollBeginDrag={waitOpen ? () => setWaitOpen(false) : undefined}
    >
      <SetupNotice />
      <OutageNotices />
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
