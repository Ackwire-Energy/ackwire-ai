import { keys, useChannelCategories } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { waitingComputerByAgent } from "@agenteschat/client/lib/machine-outages";
import { isRightHand, rightHandOf } from "@agenteschat/client/lib/right-hand";
import { WORKING_POLL_MS } from "@agenteschat/client/lib/working";
import { useQueryClient } from "@tanstack/react-query";
import { router, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, RefreshControl, StyleSheet } from "react-native";
import { usePush } from "@/providers/push";
import { LargeTitleScreen, Text } from "@/ui";
import { workByAgent } from "../agents/logic";
import { useCategoryMenus } from "../categories/menus";
import { SetupNotice } from "../computer/SetupWait";
import { useOpenStart } from "../me/useStart";
import { useOpenDm } from "../new/useOpenDm";
import { OutageNotices } from "../outages/OutageNotice";
import { useMachineOutages } from "../outages/queries";
import { RightHandAsk } from "../right-hand/Pin";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { useActiveWork, useConversations, useHiddenAgents, useWorkingNow } from "../shared/queries";
import { SheetHostProvider } from "../shared/SheetHost";
import { useTabHeader } from "../shared/tabHeader";
import { ConversationRowView } from "./ConversationRowView";
import { FirstSteps } from "./FirstSteps";
import { FirstAgentEmpty, Greeting, GreetingSky } from "./Greeting";
import { CollapsibleSection, SeeAllRow, useHomeCollapsed } from "./HomeSection";
import { HomeServerError, HomeServerNotice } from "./HomeServerError";
import { HomeWidgets } from "./HomeWidgets";
import {
  agentStarters,
  type ConversationRow,
  categoryListKind,
  type HomeBlock,
  homeLayout,
  type ListKind,
  rightHandPin,
} from "./logic";
import { usePins } from "./pins";
import { useAgentRowStates, useFinished } from "./useHomeNow";
import { useWaitingItems, WaitingStrip } from "./WaitingStrip";

/** Rows of the home whose agent moves (a long list stays light). */
const LIVE_ROWS = 6;
/** How long Conversas shows, loaded, before our notifications sheet opens over it (past the launch). */
const PUSH_OFFER_MS = 2500;

/** A section's "Ver todos", pushed: a kind, or one channel category (ADR 0080). */
export const openKindList = (kind: ListKind | `category-${string}`) => router.push(`/conversations/${kind}`);

/**
 * Conversas, the home: the
 * large title with Você and "+" (Novo) in the bar, over a light sky, the greeting under it with what changed
 * (what an agent finished, how many work), the "Esperando você" strip (only while something waits; it opens into
 * the first item's card, and scrolling closes it), then Agentes, Canais and Pessoas by latest activity, each
 * collapsible (remembered), five rows and "Ver todos". Under the greeting, the workspace's own computer while it
 * is being prepared, and a notice per computer that went offline with agents waiting for it. Above the sections a
 * Dashboards row pushes the Dashboards list (ADR 0135 §15). An agent's row says it waits on your ok, waits
 * for its computer, or what it is doing. Search and Threads have their own tabs. Empty, it invites the first agent.
 * Our notifications sheet opens over it (never inside a conversation), once it has loaded and once more at the
 * first request to approve, while the phone wasn't asked yet (`@agenteschat/client/lib/push-offer`). When the server doesn't answer
 * it says so (`HomeServerError`), over the kept rows as a card, and tries again on its own.
 */
export function ChatsScreen() {
  return (
    <SheetHostProvider>
      <Home />
    </SheetHostProvider>
  );
}

function Home() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const focused = useIsFocused();
  // What the person chose to open when the app starts goes over Conversas, once (ADR 0108).
  useOpenStart(focused);
  const header = useTabHeader();
  const dir = useDirectory();
  const list = useConversations();
  const work = useWorkingNow();
  // A run that stops on your ok hasn't finished: "terminou" is told from all the work, waiting included.
  const active = useActiveWork();
  const waiting = useWaitingItems();
  const { collapsed, toggle } = useHomeCollapsed();
  const categories = useChannelCategories(orgId);
  const menus = useCategoryMenus();
  const [waitOpen, setWaitOpen] = useState(false);

  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: keys.working(orgId) }), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [focused, qc, orgId]);

  const outages = useMachineOutages();
  const offline = useMemo(() => waitingComputerByAgent(outages.outages), [outages.outages]);
  const { hidden } = useHiddenAgents();
  // An agent waiting for its offline computer isn't working (its run only waits), and the count matches Agentes,
  // which it opens: my lists can leave some agents out.
  const working = workByAgent(work)
    .map((w) => w.agentId)
    .filter((id) => dir.agentById.has(id) && !hidden.has(id) && !offline.has(id));
  const finished = useFinished(active, list.rows);
  const agentStates = useAgentRowStates(list.rows, work, waiting.items, offline);
  const pull = usePullRefresh(() => Promise.allSettled([list.refetch(), waiting.refetch(), outages.refetch()]));
  const openDm = useOpenDm();
  const startDm = useCallback((agentId: string) => void openDm({ agentId }), [openDm]);
  // The right hand (ADR 0137): its own field under the greeting, not one of Agentes' rows; outside its audience, none.
  const rightHand = rightHandOf(dir.agents);
  const pinned = rightHandPin(list.rows, rightHand && canTalk(rightHand) ? rightHand : undefined);
  const starters = useMemo(
    () =>
      agentStarters(
        dir.agents.filter((a) => !isRightHand(a)),
        hidden,
      ),
    [dir.agents, hidden],
  );
  const pins = usePins();
  const sections = homeLayout(pinned.rows, categories.data ?? [], undefined, starters, pins.pins);
  // A section's title: a fixed one by its key, a category by its name.
  const sectionTitle = (b: HomeBlock) =>
    b.name !== undefined ? b.name : t(`mobile.chats.section.${b.key as ListKind}`);
  // A list that failed to load isn't an empty workspace: it says the server didn't answer.
  const failed = list.failed && list.rows.length === 0;
  // Agents already in the team fill the home (Agentes) instead of the invitation to create the first one.
  const empty = !list.loading && !failed && pinned.rows.length === 0 && starters.length === 0;

  const { offer, markOffered } = usePush();
  const approvalWaits = waiting.items.some((i) => i.kind === "approval");
  const offerPush = focused && !list.loading && !empty && !failed && (offer.home || (offer.approval && approvalWaits));
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

  const ask = pinned.pin && !failed && !list.loading ? <RightHandAsk row={pinned.pin} onStart={startDm} /> : null;

  let live = 0;
  return (
    <LargeTitleScreen
      title={t("mobile.chats.title")}
      {...header}
      backdrop={empty || failed ? undefined : <GreetingSky />}
      below={
        empty || failed ? undefined : (
          <Greeting
            working={working}
            finished={finished.finished}
            onFinishedPress={(f) => finished.dismiss(f.key)}
            after={ask}
          />
        )
      }
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      onScrollBeginDrag={waitOpen ? () => setWaitOpen(false) : undefined}
    >
      <SetupNotice />
      <OutageNotices />
      {list.stale && !failed ? <HomeServerNotice retry={list.refetch} /> : null}
      {strip}
      {failed || empty || list.loading ? null : (
        <>
          {/* Início's widgets, and the way to Dashboards ("See all"), not a tab (ADR 0135 §15). */}
          <HomeWidgets />
          <FirstSteps collapsed={collapsed} onToggle={toggle} />
        </>
      )}
      {failed ? (
        <HomeServerError retry={list.refetch} />
      ) : empty ? (
        <FirstAgentEmpty />
      ) : list.loading ? (
        <Text tone="faint" style={styles.center}>
          {t("mobile.common.loading")}
        </Text>
      ) : (
        sections.map((s) => {
          const off = collapsed.includes(s.key);
          const row = (r: ConversationRow, i: number, shown: boolean) => (
            <ConversationRowView
              key={r.key}
              row={r}
              divider={i > 0}
              live={shown && live++ < LIVE_ROWS}
              agent={agentStates.get(r.key)}
              pinned={i < (s.pinned ?? 0)}
              onHold={menus.openRowMenu}
              holdLabel={t("sidebarPins.pin")}
              holdActions={menus.rowActionsOf}
              {...(r.kind === "dm" && !r.channelId ? { onStart: startDm } : {})}
            />
          );
          const hold = s.categoryId ? menus.categoryMenu(s.categoryId, s.name ?? "") : undefined;
          return (
            <CollapsibleSection
              key={s.key}
              title={sectionTitle(s)}
              count={s.total}
              collapsed={off}
              onToggle={() => toggle(s.key)}
              // A closed category keeps its unread channels in sight, as on the web.
              {...(s.categoryId && s.unread.length > 0 ? { kept: s.unread.map((r, i) => row(r, i, true)) } : {})}
              {...(hold ? { onLongPress: hold, holdLabel: t("mobile.categories.title") } : {})}
            >
              {s.rows.map((r, i) => row(r, i, !off))}
              {s.more ? (
                <SeeAllRow
                  label={s.categoryId ? t("mobile.categories.seeAll") : t(`mobile.chats.seeAll.${s.key}`)}
                  onPress={() => openKindList(s.categoryId ? categoryListKind(s.categoryId) : (s.key as ListKind))}
                />
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
