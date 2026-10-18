import { keys, useChannels, useMissionList, useNotifications } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { EmptyState, Filters, LargeTitleScreen, SearchField, Text } from "@/ui";
import { busyAgents } from "../agents/logic";
import { SearchResults } from "../search/SearchResults";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { useConversations, useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { ConversationRowView } from "./ConversationRowView";
import { FirstAgentEmpty, GREETING_HEIGHT, PullDownGreeting } from "./Greeting";
import {
  CHAT_FILTERS,
  type ChatFilter,
  filterConversations,
  filterCounts,
  missionsWaiting,
  openQuestions,
  waitingTotal,
} from "./logic";
import { WaitingRail } from "./WaitingRail";

/** Rows of the list whose agent moves (a long list stays light). */
const LIVE_ROWS = 6;
/** How often who is working is asked again while Conversas shows (runs start in conversations it doesn't follow). */
const WORKING_POLL_MS = 20_000;

/**
 * Conversas, the home (MobileConversas.html): agents, channels, DMs, threads and missions in one list by
 * activity, under the native large title with Você and "+" (Novo) in the bar, and the search field on top of
 * the list (in the content, not the bar: anything React inside the native bar keeps the large title from
 * collapsing on iOS). "Esperando você" sits on top when something waits (requests, missions, agents' questions);
 * pulling the list down shows the old Início's sky (greeting and crew). Empty, it invites the first agent.
 */
export function ChatsScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const focused = useIsFocused();
  const header = useTabHeader();
  const list = useConversations();
  const work = useWorkingNow();
  const approvals = useWaitingApprovals();
  const waitingMissions = useMissionList(orgId, { status: "waiting_you" });
  const inbox = useNotifications(orgId, "waiting");
  const channels = useChannels(orgId);
  const [filter, setFilter] = useState<ChatFilter>("all");
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
  const busy = busyAgents(work);
  const pull = usePullRefresh(() => Promise.allSettled([list.refetch(), waitingMissions.refetch(), inbox.refetch()]));
  const counts = filterCounts(list.rows);
  const rows = filterConversations(list.rows, filter);
  const channelName = (id: string | null | undefined) =>
    (id ? channels.data?.find((c) => c.id === id)?.name : null) ?? null;
  const showResults = searching || Boolean(q.trim());
  const empty = !list.loading && list.rows.length === 0;
  const labels: Record<ChatFilter, string> = {
    all: t("mobile.chats.filter.all"),
    unread: t("mobile.chats.filter.unread"),
    dm: t("mobile.chats.filter.dm"),
    threads: t("mobile.chats.filter.threads"),
  };

  return (
    <LargeTitleScreen
      title={t("mobile.chats.title")}
      {...header}
      pullDown={showResults || empty ? undefined : <PullDownGreeting busy={busy} waiting={waiting} />}
      pullDownHeight={GREETING_HEIGHT}
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
      ) : (
        <>
          {waiting > 0 ? (
            <WaitingRail
              approvals={approvals}
              missions={missions}
              questions={questions}
              channelName={channelName}
              total={waiting}
            />
          ) : null}
          {empty ? (
            <FirstAgentEmpty />
          ) : (
            <>
              <Filters
                items={CHAT_FILTERS.map((key) => ({
                  key,
                  label: labels[key],
                  ...(key === "unread" ? { count: counts.unread } : {}),
                }))}
                value={filter}
                onChange={(key) => setFilter(key as ChatFilter)}
              />
              <View style={styles.list}>
                {list.loading ? (
                  <Text tone="faint" style={styles.center}>
                    {t("mobile.common.loading")}
                  </Text>
                ) : rows.length === 0 ? (
                  <EmptyState title={filter === "unread" ? t("mobile.chats.allRead") : t("mobile.chats.empty")} />
                ) : (
                  rows.map((r, i) => <ConversationRowView key={r.key} row={r} divider={i > 0} live={i < LIVE_ROWS} />)
                )}
              </View>
            </>
          )}
        </>
      )}
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 10 },
  list: { marginTop: 8 },
  center: { textAlign: "center", paddingVertical: 40 },
});
