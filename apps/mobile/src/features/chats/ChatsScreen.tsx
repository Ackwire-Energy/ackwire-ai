import { keys, useMissionList, useNotifications } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { LargeTitleScreen, SearchField, Text } from "@/ui";
import { workByAgent } from "../agents/logic";
import { SearchResults } from "../search/SearchResults";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { useConversations, useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { ConversationRowView } from "./ConversationRowView";
import { FirstAgentEmpty, Greeting } from "./Greeting";
import { CollapsibleSection, SeeAllRow, useCollapsedSections } from "./HomeSection";
import {
  homeSections,
  type ListKind,
  missionsWaiting,
  openQuestions,
  threadsShortcut,
  type WaitingPreview,
  waitingPreview,
  waitingTotal,
} from "./logic";
import { type ShortcutItem, Shortcuts } from "./Shortcuts";

/** Rows of the home whose agent moves (a long list stays light). */
const LIVE_ROWS = 6;
/** How often who is working is asked again while Conversas shows (runs start in conversations it doesn't follow). */
const WORKING_POLL_MS = 20_000;

/** A list of one kind, pushed (threads and missions, or a section's "Ver todos"). */
export const openKindList = (kind: ListKind) => router.push(`/conversations/${kind}`);

/**
 * Conversas, the home (MobileHomeAgentes.html, Recomendada): the one-line greeting over a light sky, the native
 * large title with Você and "+" (Novo) in the bar, the search field (results in place), the shortcuts
 * "Esperando você" (only while something waits; opens Atividade on Esperando) and "Threads e missões" (opens
 * their list), then Agentes, Canais and Pessoas by latest activity, each collapsible (remembered), five rows
 * and "Ver todos". Empty, it invites the first agent.
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
  const approvals = useWaitingApprovals();
  const waitingMissions = useMissionList(orgId, { status: "waiting_you" });
  const inbox = useNotifications(orgId, "waiting");
  const { collapsed, toggle } = useCollapsedSections();
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: keys.working(orgId) }), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [focused, qc, orgId]);

  const missions = missionsWaiting(waitingMissions.data?.missions ?? []);
  const questions = openQuestions(inbox.data?.pages.flatMap((p) => p.items) ?? []);
  const waiting = waitingTotal({ approvals: approvals.length, missions, questions: questions.length });
  const working = workByAgent(work)
    .map((w) => w.agentId)
    .filter((id) => dir.agentById.has(id));
  const pull = usePullRefresh(() => Promise.allSettled([list.refetch(), waitingMissions.refetch(), inbox.refetch()]));
  const sections = homeSections(list.rows);
  const threads = threadsShortcut(list.rows);
  const showResults = searching || Boolean(q.trim());
  const empty = !list.loading && list.rows.length === 0;

  const previewText = (p: WaitingPreview | null) => {
    if (!p) return null;
    const name = p.agentId ? (dir.agentById.get(p.agentId)?.name ?? "") : "";
    if (!name) return p.title || null;
    return t(`mobile.chats.waitPreview.${p.kind}`, { name, title: p.title });
  };
  const shortcuts: ShortcutItem[] = [];
  if (waiting > 0)
    shortcuts.push({
      key: "waiting",
      icon: "shield",
      title: t("mobile.home.waiting"),
      count: waiting,
      preview: previewText(waitingPreview({ approvals, missions, questions })),
      hot: true,
      onPress: () => router.navigate({ pathname: "/activity", params: { filter: "waiting", at: String(Date.now()) } }),
    });
  if (threads.count > 0)
    shortcuts.push({
      key: "threads",
      icon: "target",
      title: t("mobile.chats.section.threads"),
      count: threads.count,
      preview: threads.preview,
      onPress: () => openKindList("threads"),
    });

  let live = 0;
  return (
    <LargeTitleScreen
      title={t("mobile.chats.title")}
      {...header}
      header={showResults || empty ? undefined : (reach) => <Greeting working={working} reach={reach} />}
      refreshControl={
        showResults ? undefined : <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
      }
    >
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.find.short")}
          onFocus={() => setSearching(true)}
          onBlur={() => setSearching(false)}
          autoCapitalize="none"
        />
      </View>
      {showResults ? (
        <SearchResults q={q} />
      ) : empty ? (
        <>
          <Shortcuts items={shortcuts} />
          <FirstAgentEmpty />
        </>
      ) : (
        <>
          <Shortcuts items={shortcuts} />
          {list.loading ? (
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
                    <ConversationRowView key={r.key} row={r} divider={i > 0} live={!off && live++ < LIVE_ROWS} />
                  ))}
                  {s.more ? (
                    <SeeAllRow label={t(`mobile.chats.seeAll.${s.key}`)} onPress={() => openKindList(s.key)} />
                  ) : null}
                </CollapsibleSection>
              );
            })
          )}
        </>
      )}
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 10 },
  center: { textAlign: "center", paddingVertical: 40 },
});
