import {
  useApprovals,
  useChannels,
  useDms,
  useMissionList,
  useNotificationCount,
  useThreadList,
  useWorkingRuns,
} from "@agenteschat/client";
import { useMemo } from "react";
import { workingNow } from "../agents/logic";
import { waitingApprovals } from "../approvals/logic";
import { buildConversations, unreadConversationCount } from "../chats/logic";
import { useNow, useOrgId } from "./hooks";

/**
 * Reads several screens share: who is working, the conversation list, what
 * waits on you (and the tab badges).
 */

/**
 * Who works on what now: active missions, then agent runs in progress in the
 * conversations you are in (`GET …/active-runs`, for everyone).
 */
export function useWorkingNow() {
  const orgId = useOrgId();
  const runs = useWorkingRuns(orgId);
  const missions = useMissionList(orgId, { status: "active" });
  return useMemo(() => workingNow(runs.data, missions.data?.missions), [runs.data, missions.data]);
}

/** Conversas: channels, DMs and my threads and missions, newest first. */
export function useConversations() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const threads = useThreadList(orgId, { tab: "all", mine: true, limit: 50 });
  const rows = useMemo(
    () =>
      buildConversations({
        channels: channels.data ?? [],
        dms: dms.data ?? [],
        threads: threads.data?.pages.flatMap((p) => p.threads) ?? [],
      }),
    [channels.data, dms.data, threads.data],
  );
  return {
    rows,
    loading: channels.isLoading || dms.isLoading,
    refetch: () => Promise.all([channels.refetch(), dms.refetch(), threads.refetch()]),
    refreshing: channels.isRefetching || dms.isRefetching || threads.isRefetching,
  };
}

/** The badge of Conversas: channels and DMs with something unread. */
export function useUnreadConversations() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  return useMemo(
    () => unreadConversationCount({ channels: channels.data ?? [], dms: dms.data ?? [] }),
    [channels.data, dms.data],
  );
}

/** Requests you may decide now, the one closest to expiring first. */
export function useWaitingApprovals() {
  const orgId = useOrgId();
  const approvals = useApprovals(orgId);
  const now = useNow();
  return useMemo(() => waitingApprovals(approvals.data ?? [], now), [approvals.data, now]);
}

/** The badge of Atividade: what waits on you (the inbox's own count, live through `notification.counts`). */
export function useWaitingCount() {
  const orgId = useOrgId();
  return useNotificationCount(orgId).data?.waiting ?? 0;
}
