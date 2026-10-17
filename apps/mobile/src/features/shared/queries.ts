import {
  type Run,
  useApi,
  useApprovals,
  useChannels,
  useDms,
  useMissionList,
  useNotificationCount,
  useThreadList,
} from "@agenteschat/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { workingNow } from "../agents/logic";
import { waitingApprovals } from "../approvals/logic";
import { buildConversations, unreadConversations } from "../chats/logic";
import { useNow, useOrgId } from "./hooks";

/**
 * Reads several screens share: runs in progress, the conversation list,
 * what waits on you (and the tab badges).
 */

/**
 * Runs in progress in the organization. The runs endpoint answers admins
 * (and owners for their agents); for anyone else it is refused and the
 * list is empty, so only missions show as "working".
 */
export function useActiveRuns() {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: ["org", orgId, "runs", "active"],
    queryFn: async (): Promise<Run[]> => {
      const lists = await Promise.all(
        (["running", "queued", "waiting_approval"] as const).map((status) =>
          api.agents.runs(orgId, { status, limit: 50 }).catch(() => [] as Run[]),
        ),
      );
      return lists.flat();
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/** Who works on what now: active missions, then runs in progress. */
export function useWorkingNow() {
  const orgId = useOrgId();
  const runs = useActiveRuns();
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

/** The badge of Conversas: conversations with something unread. */
export function useUnreadConversations() {
  const orgId = useOrgId();
  const dms = useDms(orgId);
  return useMemo(
    () => unreadConversations(buildConversations({ channels: [], dms: dms.data ?? [], threads: [] })),
    [dms.data],
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
