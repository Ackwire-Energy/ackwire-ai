import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { upsertMessage } from "@/chat/timeline";
import type { ApiClient } from "./client";
import { useApi } from "./context";
import { keys } from "./keys";
import type {
  AccessInput,
  AgentComputer,
  AgentInput,
  ApiRule,
  Approval,
  ArtifactContent,
  ArtifactDetail,
  ArtifactFilters,
  CalendarEventInput,
  CalendarEventPatch,
  ForumParticipantsInput,
  ForumSuggestedIssue,
  ForumTopicDetail,
  ForumTopicInput,
  IssueInput,
  IssuePatch,
  Machine,
  Message,
  OrgSettings,
  Role,
  RoutineInput,
  RoutinePatch,
  S3Input,
  SandboxSettingsInput,
  ScopeGrant,
  SearchKind,
  SeriesScope,
  SkillInput,
  SkillPatch,
  ToolDecision,
  WikiPage,
  WikiPageInput,
  WikiUpdateInput,
} from "./types";

/**
 * React Query hooks over the `ApiClient`. Reads are cached per organization;
 * writes invalidate what they change. Mutation errors become toasts in
 * `createQueryClient` (src/app/query-client.ts).
 */

// ── Shared query options (also used by route guards) ─────────────────────────

export const meQuery = (api: ApiClient) =>
  queryOptions({ queryKey: keys.me, queryFn: () => api.account.me(), staleTime: 30_000 });
export const authConfigQuery = (api: ApiClient) =>
  queryOptions({ queryKey: keys.authConfig, queryFn: () => api.account.authConfig(), staleTime: 60_000 });
export const channelsQuery = (api: ApiClient, orgId: string) =>
  queryOptions({ queryKey: keys.channels(orgId), queryFn: () => api.chat.channels(orgId), staleTime: 30_000 });

// ── Account ─────────────────────────────────────────────────────────────────

export const useMe = () => useQuery(meQuery(useApi()));
export const useAuthConfig = () => useQuery(authConfigQuery(useApi()));
export const useHealth = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.health, queryFn: () => api.system.health(), staleTime: 5 * 60_000 });
};

export function useCreateOrganization() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; context?: string }) => api.orgs.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useUpdateOrganization(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; context?: string }) => api.orgs.update(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.org(orgId) });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

// ── Organization ────────────────────────────────────────────────────────────

export const useOrganization = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: [...keys.org(orgId), "detail"], queryFn: () => api.orgs.get(orgId) });
};

export const useMembers = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.members(orgId), queryFn: () => api.orgs.members(orgId), staleTime: 30_000 });
};

export function useChangeRole(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => api.orgs.changeRole(orgId, userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.members(orgId) }),
  });
}

export const useInvitations = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.invitations(orgId), queryFn: () => api.orgs.invitations(orgId), enabled });
};

export function useInvite(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: Role }) => api.orgs.invite(orgId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

export function useRevokeInvitation(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.orgs.revokeInvitation(orgId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

// ── Agents ──────────────────────────────────────────────────────────────────

export const useAgents = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.agents(orgId), queryFn: () => api.agents.list(orgId), staleTime: 30_000 });
};

export const useModels = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.models, queryFn: () => api.agents.models(), staleTime: 10 * 60_000 });
};

export const useCredentials = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.credentials(orgId), queryFn: () => api.agents.credentials(orgId), enabled });
};

/** `data` is null when the person can't see usage (members). */
export const useUsage = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.usage(orgId), queryFn: () => api.agents.usage(orgId), staleTime: 30_000 });
};

export function useCreateAgent(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AgentInput) => api.agents.create(orgId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.agents(orgId) }),
  });
}

export function useUpdateAgent(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<Omit<AgentInput, "handle">>) => api.agents.update(orgId, agentId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      void qc.invalidateQueries({ queryKey: keys.agentDetail(orgId, agentId) });
    },
  });
}

export function useAddCredential(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<ApiClient["agents"]["addCredential"]>[1]) => api.agents.addCredential(orgId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.credentials(orgId) }),
  });
}

// ── Chat ────────────────────────────────────────────────────────────────────

export const useChannels = (orgId: string) => useQuery(channelsQuery(useApi(), orgId));

export const useChannelMembers = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.channelMembers(orgId, channelId),
    queryFn: () => api.chat.members(orgId, channelId),
    enabled,
    staleTime: 30_000,
  });
};

/** Messages per page: the latest page, then older pages on scroll-up. */
export const MESSAGES_PAGE = 100;

/**
 * The latest page of a conversation. Cached per channel and fresh for 30 s
 * (real-time events keep it current), so switching back is instant; then it
 * revalidates in the background.
 */
export const messagesQuery = (api: ApiClient, orgId: string, channelId: string) =>
  queryOptions({
    queryKey: keys.messages(orgId, channelId),
    queryFn: () => api.chat.messages(orgId, channelId, { limit: MESSAGES_PAGE }),
    staleTime: 30_000,
  });

export const useMessages = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ ...messagesQuery(api, orgId, channelId), enabled });
};

/** Sidebar hover/focus: load a conversation before the click. */
export function usePrefetchMessages(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useCallback(
    (channelId: string) => {
      void qc.prefetchQuery(messagesQuery(api, orgId, channelId));
    },
    [api, qc, orgId],
  );
}

export function useThreads(orgId: string, channelId: string, rootIds: string[]) {
  const api = useApi();
  return useQueries({
    queries: rootIds.map((rootId) => ({
      queryKey: keys.thread(orgId, channelId, rootId),
      queryFn: () => api.chat.messages(orgId, channelId, { threadId: rootId, limit: 200 }),
      staleTime: 60_000,
    })),
  });
}

export function useJoinChannel(orgId: string, channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.chat.join(orgId, channelId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
    },
  });
}

export function useAddChannelMember(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, member }: { channelId: string; member: { userId: string } | { agentId: string } }) =>
      api.chat.addMember(orgId, channelId, member),
    onSuccess: (_v, { channelId }) => qc.invalidateQueries({ queryKey: keys.channelMembers(orgId, channelId) }),
  });
}

/** Puts a message in the right cache: the channel list, or its thread. Replaces the optimistic copy (same `clientId`). */
export function cacheMessage(qc: ReturnType<typeof useQueryClient>, orgId: string, message: Message) {
  const key = message.threadId
    ? keys.thread(orgId, message.channelId, message.threadId)
    : keys.messages(orgId, message.channelId);
  qc.setQueryData<Message[]>(key, (list) => {
    const rest = message.clientId ? list?.filter((m) => !(m.local && m.clientId === message.clientId)) : list;
    return upsertMessage(rest, message);
  });
}

const newClientId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Sends a message optimistically: it appears at once (`local: "pending"`),
 * is replaced by the server's copy (matched by `clientId`, from the response
 * or the WebSocket, whichever comes first), or turns `failed` with a retry.
 */
export function usePostMessage(
  orgId: string,
  channelId: string,
  options: {
    me: { id: string };
    /** Agents the text mentions (client-side guess, for the instant "pensando…" row). */
    mentioned?: (body: string) => string[];
    onSent?: (message: Message, local: Message) => void;
    onOptimistic?: (local: Message) => void;
  },
) {
  const api = useApi();
  const qc = useQueryClient();
  const key = keys.messages(orgId, channelId);
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ body, clientId, threadId }: { body: string; clientId: string; threadId?: string | null }) =>
      api.chat.post(orgId, channelId, { body, clientId, ...(threadId ? { threadId } : {}) }),
    onMutate: ({ body, clientId, threadId }) => {
      const local: Message = {
        id: `local-${clientId}`,
        channelId,
        threadId: threadId ?? null,
        author: { type: "person", id: options.me.id },
        body,
        mentionedAgentIds: options.mentioned?.(body) ?? [],
        agentRunId: null,
        meta: {},
        clientId,
        local: "pending",
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<Message[]>(key, (list) =>
        upsertMessage(
          list?.filter((m) => m.id !== local.id),
          local,
        ),
      );
      options.onOptimistic?.(local);
      return { local };
    },
    onSuccess: (message, { clientId }, ctx) => {
      const echoed = { ...message, clientId: message.clientId ?? clientId };
      cacheMessage(qc, orgId, echoed);
      if (ctx?.local) options.onSent?.(echoed, ctx.local);
    },
    onError: (_error, { clientId }) => {
      qc.setQueryData<Message[]>(key, (list) =>
        list?.map((m) => (m.local && m.clientId === clientId ? { ...m, local: "failed" as const } : m)),
      );
    },
  });
}

/** `send(body)` for a new message; `retry(local)` for one that failed. */
export function sendHelpers(mutation: ReturnType<typeof usePostMessage>) {
  return {
    send: (body: string, threadId?: string | null) => mutation.mutate({ body, clientId: newClientId(), threadId }),
    retry: (local: Message) =>
      mutation.mutate({ body: local.body, clientId: local.clientId ?? newClientId(), threadId: local.threadId }),
  };
}

// ── Approvals ───────────────────────────────────────────────────────────────

/** Every approval you can see (pending and decided); `canDecide` says if you may act. */
export const useApprovals = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.approvals(orgId), queryFn: () => api.approvals.list(orgId), staleTime: 15_000 });
};

/** One approval (inline card when it isn't in the list yet). */
export const useApproval = (orgId: string, approvalId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.approval(orgId, approvalId),
    queryFn: () => api.approvals.get(orgId, approvalId),
    enabled,
  });
};

/** Puts a fresh approval in the caches (decision responses, WebSocket events). */
export function cacheApproval(qc: ReturnType<typeof useQueryClient>, orgId: string, approval: Approval) {
  qc.setQueryData<Approval[]>(keys.approvals(orgId), (list) => {
    if (!list) return list;
    const previous = list.find((a) => a.id === approval.id);
    // Channel events don't know who is asking: keep our own `canDecide` until it's decided.
    const merged =
      previous && approval.status === "pending" ? { ...approval, canDecide: previous.canDecide } : approval;
    return previous ? list.map((a) => (a.id === approval.id ? merged : a)) : [merged, ...list];
  });
  qc.setQueryData<Approval>(keys.approval(orgId, approval.id), (prev) =>
    prev && approval.status === "pending" ? { ...approval, canDecide: prev.canDecide } : approval,
  );
}

export function useDecideApproval(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, reason }: { id: string; decision: "approve" | "refuse"; reason?: string }) =>
      decision === "approve" ? api.approvals.approve(orgId, id, reason) : api.approvals.refuse(orgId, id, reason),
    onSuccess: (approval) => {
      cacheApproval(qc, orgId, approval);
      void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
    },
  });
}

// ── Connectors and agent scopes ─────────────────────────────────────────────

export const useCatalog = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.catalog, queryFn: () => api.connectors.catalog(), staleTime: 10 * 60_000 });
};

export const useConnections = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.connections(orgId), queryFn: () => api.connectors.list(orgId), staleTime: 30_000 });
};

export function useConnectWithKey(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { connector: string; apiKey: string; serverUrl?: string; label?: string }) =>
      api.connectors.connectWithKey(orgId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connections(orgId) }),
  });
}

export function useStartOAuth(orgId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: ({ connector, returnTo, serverUrl }: { connector: string; returnTo: string; serverUrl?: string }) =>
      api.connectors.startOAuth(orgId, connector, { returnTo, serverUrl }),
  });
}

export function useDisconnect(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => api.connectors.disconnect(orgId, connectionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.connections(orgId) });
      // Agents lose the scopes of that connection.
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[4] === "scopes" });
    },
  });
}

export const useAgentScopes = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.scopes(orgId, agentId), queryFn: () => api.scopes.get(orgId, agentId) });
};

export function useSetAgentScopes(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grants: ScopeGrant[]) => api.scopes.set(orgId, agentId, grants),
    onSuccess: (grants) => qc.setQueryData(keys.scopes(orgId, agentId), grants),
  });
}

// ── Management (phase 4) ────────────────────────────────────────────────────

export const useOverview = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.overview(orgId), queryFn: () => api.orgs.overview(orgId), staleTime: 30_000 });
};

export const useSettings = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.settings(orgId), queryFn: () => api.orgs.settings(orgId) });
};

export function useUpdateSettings(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<OrgSettings>) => api.orgs.updateSettings(orgId, input),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings(orgId), settings);
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
    },
  });
}

export const usePeople = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.people(orgId), queryFn: () => api.orgs.people(orgId), staleTime: 30_000 });
};

export const useAllInvitations = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.allInvitations(orgId), queryFn: () => api.orgs.allInvitations(orgId), enabled });
};

export function useInviteMany(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { emails: string[]; role: Role }) => api.orgs.inviteMany(orgId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

export function useResendInvitation(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => api.orgs.resendInvitation(orgId, invitationId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

export const useUsageReport = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.usageReport(orgId), queryFn: () => api.orgs.usageReport(orgId), enabled });
};

export const usePlatformKey = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.platformKey(orgId),
    queryFn: () => api.agents.platformKeyAvailable(orgId),
    staleTime: 10 * 60_000,
  });
};

export function useRotateCredential(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, apiKey }: { id: string; apiKey: string }) => api.agents.rotateCredential(orgId, id, { apiKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.credentials(orgId) }),
  });
}

export function useRemoveCredential(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, purge }: { id: string; purge?: boolean }) => api.agents.removeCredential(orgId, id, purge),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.credentials(orgId) }),
  });
}

export const useAgentDetail = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentDetail(orgId, agentId),
    queryFn: () => api.agents.detail(orgId, agentId),
    staleTime: 15_000,
  });
};

/** An agent's runs this month (newest first). */
export const useRuns = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.runs(orgId, agentId),
    queryFn: () => api.agents.runs(orgId, { agentId, limit: 200 }),
    enabled,
  });
};

export const useRun = (orgId: string, runId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.run(orgId, runId ?? ""),
    queryFn: () => api.agents.run(orgId, runId ?? ""),
    enabled: runId !== null,
  });
};

export const useRoster = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.roster(orgId, channelId),
    queryFn: () => api.chat.roster(orgId, channelId),
    enabled,
    staleTime: 30_000,
  });
};

export function useUpdateChannel(orgId: string, channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; topic?: string }) => api.chat.update(orgId, channelId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.channels(orgId) }),
  });
}

// ── Direct messages ─────────────────────────────────────────────────────────

export const useDms = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.dms(orgId), queryFn: () => api.dms.list(orgId), staleTime: 30_000 });
};

// ── Knowledge (phase 5) ─────────────────────────────────────────────────────

export const useSearch = (orgId: string, q: string, kinds: SearchKind[]) => {
  const api = useApi();
  const text = q.trim();
  return useQuery({
    queryKey: keys.search(orgId, text, kinds.join(",")),
    queryFn: () => api.search.query(orgId, { q: text, kinds, limit: 50 }),
    enabled: text.length > 0,
    placeholderData: (previous) => previous,
  });
};

/** Reactions on one message, loaded when its actions are shown or used. */
export const useReactions = (orgId: string, messageId: string, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.reactions(orgId, messageId),
    queryFn: () => api.chat.reactions(orgId, messageId),
    enabled,
    staleTime: 30_000,
  });
};

export function useToggleReaction(orgId: string, messageId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ reaction, on }: { reaction: string; on: boolean }) =>
      on ? api.chat.react(orgId, messageId, reaction) : api.chat.unreact(orgId, messageId, reaction),
    onSuccess: (reactions) => qc.setQueryData(keys.reactions(orgId, messageId), reactions),
  });
}

export function useCorrectMessage(orgId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: ({ messageId, body }: { messageId: string; body: string }) => api.chat.correct(orgId, messageId, body),
  });
}

// ── Invites, custom MCP ─────────────────────────────────────────────────────

export const useCustomServers = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.customServers(orgId), queryFn: () => api.customConnectors.list(orgId) });
};

export function useCustomServerAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: keys.customServers(orgId) });
  return {
    connect: useMutation({
      mutationFn: (input: { serverUrl: string; apiKey?: string; label?: string; returnTo: string }) =>
        api.customConnectors.connect(orgId, input),
      onSuccess: done,
    }),
    refresh: useMutation({ mutationFn: (id: string) => api.customConnectors.refresh(orgId, id), onSuccess: done }),
    save: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        label: string;
        tools: { name: string; access: ToolDecision; label: string }[];
      }) => api.customConnectors.saveTools(orgId, id, input),
      onSuccess: done,
    }),
    disconnect: useMutation({
      mutationFn: (id: string) => api.customConnectors.disconnect(orgId, id),
      onSuccess: done,
    }),
  };
}

// ── Memory and proposals (phase 5) ──────────────────────────────────────────

export const useMemory = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.memory(orgId, agentId), queryFn: () => api.memory.list(orgId, agentId) });
};

export function useMemoryAction(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "edit"; id: string; text: string }
        | { type: "pin"; id: string; pinned: boolean }
        | { type: "archive"; id: string; archived: boolean },
    ) => {
      if (action.type === "edit") return api.memory.edit(orgId, action.id, action.text);
      if (action.type === "pin") return api.memory.setPinned(orgId, action.id, action.pinned);
      return api.memory.setArchived(orgId, action.id, action.archived);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.memory(orgId, agentId) }),
  });
}

export const useProposals = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.proposals(orgId), queryFn: () => api.proposals.list(orgId) });
};

export function useDecideProposal(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: "accept" | "refuse"; text?: string }) =>
      input.decision === "accept"
        ? api.proposals.accept(orgId, input.id, input.text)
        : api.proposals.refuse(orgId, input.id),
    // The page explains a stale proposal (409) itself.
    meta: { silent: true },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.proposals(orgId) }),
  });
}

export const useStorage = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.storage(orgId), queryFn: () => api.storage.get(orgId), enabled });
};

export function useTestStorage(orgId: string) {
  const api = useApi();
  return useMutation({ mutationFn: (input: S3Input) => api.storage.test(orgId, input) });
}

export function useSaveStorage(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: "agentes" } | { kind: "s3"; s3: S3Input }) => api.storage.save(orgId, input),
    onSuccess: (config) => {
      qc.setQueryData(keys.storage(orgId), config);
      qc.removeQueries({ queryKey: keys.storageMigration(orgId) });
    },
  });
}

/** Copy status; polls while the copy runs. */
export const useStorageMigration = (orgId: string, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.storageMigration(orgId),
    queryFn: () => api.storage.migration(orgId),
    enabled,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
    refetchIntervalInBackground: true,
  });
};

export function useStartMigration(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.storage.migrate(orgId),
    onSuccess: (m) => qc.setQueryData(keys.storageMigration(orgId), m),
  });
}

export const useArtifacts = (orgId: string, filters: ArtifactFilters) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifactList(orgId, filters),
    queryFn: () => api.artifacts.list(orgId, filters),
    placeholderData: (prev) => prev,
  });
};

/** One artifact at a version (latest when omitted). */
/** `GET …/artifacts-trash`: deleted files (30 days). */
export const useArtifactTrash = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.artifacts(orgId), "trash"] as const,
    queryFn: () => api.artifacts.trash(orgId),
  });
};

export const useArtifact = (orgId: string, id: string | null, version?: number) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifact(orgId, id ?? "", version),
    queryFn: () => api.artifacts.get(orgId, id ?? "", version),
    enabled: Boolean(id),
    // Old versions never change.
    staleTime: version ? Number.POSITIVE_INFINITY : 0,
  });
};

export const useArtifactVersions = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifactVersions(orgId, id ?? ""),
    queryFn: () => api.artifacts.versions(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

export function useSaveArtifact(orgId: string, id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: ArtifactContent; note?: string | null; baseVersion: number }) =>
      api.artifacts.update(orgId, id, input),
    // The viewer explains a stale version (409) itself.
    meta: { silent: true },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
}

/** Uploads a file to the Drive, or a new version of `artifactId`. Errors are shown by the caller. */
export function useUploadFile(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      file: File;
      title?: string;
      channelId?: string | null;
      artifactId?: string;
      note?: string;
    }): Promise<ArtifactDetail> =>
      input.artifactId
        ? api.artifacts.uploadVersion(orgId, input.artifactId, input.file, { note: input.note })
        : api.artifacts.upload(orgId, input.file, { title: input.title, channelId: input.channelId }),
    meta: { silent: true },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
}

/** The bytes of a file version as an object URL (previews); never refetched (versions don't change). */
export const useArtifactBlob = (orgId: string, id: string, version: number, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifactBlob(orgId, id, version),
    queryFn: () => api.artifacts.fileBlob(orgId, id, version),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
    retry: false,
    meta: { quiet: true },
  });
};

// ── Issues ───────────────────────────────────────────────────────────────────

export const useIssues = (orgId: string, q = "") => {
  const api = useApi();
  return useQuery({
    queryKey: keys.issueList(orgId, q),
    queryFn: () => api.issues.list(orgId, q ? { q } : {}),
    placeholderData: (prev) => prev,
  });
};

export const useIssue = (orgId: string, number: number) => {
  const api = useApi();
  return useQuery({ queryKey: keys.issue(orgId, number), queryFn: () => api.issues.get(orgId, number) });
};

export const useIssueActivity = (orgId: string, id: string | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.issueActivity(orgId, id ?? ""),
    queryFn: () => api.issues.activity(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

export function useIssueAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "create"; input: IssueInput }
        | { type: "update"; id: string; patch: IssuePatch }
        | { type: "criterion"; id: string; criterionId: string; done: boolean }
        | { type: "comment"; id: string; text: string }
        | { type: "ask"; id: string; agentId: string },
    ): Promise<unknown> => {
      switch (action.type) {
        case "create":
          return api.issues.create(orgId, action.input);
        case "update":
          return api.issues.update(orgId, action.id, action.patch);
        case "criterion":
          return api.issues.setCriterion(orgId, action.id, action.criterionId, action.done);
        case "comment":
          return api.issues.comment(orgId, action.id, action.text);
        case "ask":
          return api.issues.askAgent(orgId, action.id, action.agentId);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.issues(orgId) });
      void qc.invalidateQueries({ queryKey: keys.calendar(orgId) });
    },
  });
}

// ── Routines ─────────────────────────────────────────────────────────────────

export const useRoutines = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.routines(orgId), queryFn: () => api.routines.list(orgId) });
};

export const useRoutineRuns = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.routineRuns(orgId, id ?? ""),
    queryFn: () => api.routines.runs(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

export const useScheduleParse = (orgId: string, phrase: string, enabled: boolean, timezone?: string) => {
  const api = useApi();
  return useQuery({
    queryKey: ["org", orgId, "routines", "parse", phrase, timezone ?? ""] as const,
    queryFn: () => api.routines.parseSchedule(orgId, phrase, timezone),
    enabled,
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
  });
};

/** `POST …/routines/parse-rule`: a phrase → rule (fills the picker). */
export const useRuleParse = (orgId: string, phrase: string, enabled: boolean, timezone?: string) => {
  const api = useApi();
  return useQuery({
    queryKey: ["org", orgId, "routines", "parse-rule", phrase, timezone ?? ""] as const,
    queryFn: () => api.routines.parseRule(orgId, phrase, timezone),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
};

/** `POST …/routines/describe-rule`: the picker's sentence and next runs. */
export const useRuleDescribe = (orgId: string, rule: ApiRule | null) => {
  const api = useApi();
  const key = rule ? JSON.stringify(rule) : "";
  return useQuery({
    queryKey: ["org", orgId, "routines", "describe-rule", key] as const,
    queryFn: () => api.routines.describeRule(orgId, rule as ApiRule),
    enabled: Boolean(rule),
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
  });
};

export function useRoutineAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "create"; input: RoutineInput }
        | { type: "active"; id: string; active: boolean }
        | { type: "run"; id: string }
        | { type: "update"; id: string; patch: RoutinePatch }
        | { type: "delete"; id: string }
        | { type: "duplicate"; id: string },
    ): Promise<unknown> => {
      if (action.type === "create") return api.routines.create(orgId, action.input);
      if (action.type === "update") return api.routines.update(orgId, action.id, action.patch);
      if (action.type === "delete") return api.routines.remove(orgId, action.id);
      if (action.type === "duplicate") return api.routines.duplicate(orgId, action.id);
      if (action.type === "active") return api.routines.setActive(orgId, action.id, action.active);
      return api.routines.runNow(orgId, action.id);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
      void qc.invalidateQueries({ queryKey: keys.calendar(orgId) });
    },
  });
}

// ── Calendar ─────────────────────────────────────────────────────────────────

export const useCalendar = (orgId: string, from: string, to: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.calendarRange(orgId, from),
    queryFn: () => api.calendar.range(orgId, from, to),
    placeholderData: (prev) => prev,
  });
};

export function useCalendarAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "create"; input: CalendarEventInput }
        | { type: "confirm" | "dismiss"; id: string }
        | {
            type: "update";
            id: string;
            patch: CalendarEventPatch;
            series?: { scope: SeriesScope; occurrenceStart: string };
          }
        | { type: "remove"; id: string; series?: { scope: SeriesScope; occurrenceStart: string } },
    ): Promise<unknown> => {
      if (action.type === "create") return api.calendar.create(orgId, action.input);
      if (action.type === "update") return api.calendar.update(orgId, action.id, action.patch, action.series);
      if (action.type === "remove") return api.calendar.remove(orgId, action.id, action.series);
      if (action.type === "confirm") return api.calendar.confirmProposal(orgId, action.id);
      return api.calendar.dismissProposal(orgId, action.id);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.calendar(orgId) }),
  });
}

// ── Agent access (tool tree) ─────────────────────────────────────────────────

/** The agent's tool tree. `retry: false`: a 404 means the backend doesn't have it yet. */
export const useAgentAccess = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentAccess(orgId, agentId),
    queryFn: () => api.access.get(orgId, agentId),
    enabled,
    retry: false,
  });
};

export const useAccessMatrix = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.accessMatrix(orgId),
    queryFn: () => api.access.matrix(orgId),
    enabled,
    retry: false,
  });
};

export function useSetAgentAccess(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, input }: { agentId: string; input: AccessInput }) => api.access.set(orgId, agentId, input),
    onSuccess: (saved, { agentId }) => {
      qc.setQueryData(keys.agentAccess(orgId, agentId), saved);
      void qc.invalidateQueries({ queryKey: keys.accessMatrix(orgId) });
      void qc.invalidateQueries({ queryKey: keys.scopes(orgId, agentId) });
    },
  });
}

// ── Skills ───────────────────────────────────────────────────────────────────

/** The org library. `retry: false`: a 404 means the server doesn't have skills. */
export const useSkills = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.skills(orgId), queryFn: () => api.skills.list(orgId), enabled, retry: false });
};

export const useSkill = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.skill(orgId, id ?? ""),
    queryFn: () => api.skills.get(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

export const useAgentSkills = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentSkills(orgId, agentId),
    queryFn: () => api.skills.forAgent(orgId, agentId),
    enabled,
    retry: false,
  });
};

/** Which agents use each skill (the API lists skills per agent): skillId → agents. */
export function useSkillUsage(orgId: string, enabled: boolean) {
  const api = useApi();
  const agents = useAgents(orgId);
  const list = enabled ? (agents.data ?? []) : [];
  const per = useQueries({
    queries: list.map((a) => ({
      queryKey: keys.agentSkills(orgId, a.id),
      queryFn: () => api.skills.forAgent(orgId, a.id),
      retry: false,
    })),
  });
  const usage = new Map<string, { id: string; name: string }[]>();
  per.forEach((q, i) => {
    const agent = list[i];
    if (!agent) return;
    for (const s of q.data ?? []) {
      if (!s.enabled) continue;
      usage.set(s.id, [...(usage.get(s.id) ?? []), { id: agent.id, name: agent.name }]);
    }
  });
  return usage;
}

export function useSkillAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "import"; input: { url: string } | { zipBase64: string } }
        | { type: "create"; input: SkillInput }
        | { type: "update"; id: string; patch: SkillPatch }
        | { type: "reimport"; id: string }
        | { type: "remove"; id: string }
        | { type: "assign"; agentId: string; skills: { skillId: string; enabled: boolean }[] },
    ): Promise<unknown> => {
      switch (action.type) {
        case "import":
          return api.skills.import(orgId, action.input);
        case "create":
          return api.skills.create(orgId, action.input);
        case "update":
          return api.skills.update(orgId, action.id, action.patch);
        case "reimport":
          return api.skills.reimport(orgId, action.id);
        case "remove":
          return api.skills.remove(orgId, action.id);
        case "assign":
          return api.skills.setForAgent(orgId, action.agentId, action.skills);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.skills(orgId) }),
  });
}

// ── PC do agente (sandbox) ───────────────────────────────────────────────────

/** `retry: false`: 404 = no sandbox on this server (the UI hides it). */
export const useSandboxSettings = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.sandboxSettings(orgId),
    queryFn: () => api.sandbox.settings(orgId),
    enabled,
    retry: false,
  });
};

export function useSaveSandboxSettings(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SandboxSettingsInput) => api.sandbox.saveSettings(orgId, input),
    onSuccess: (saved) => qc.setQueryData(keys.sandboxSettings(orgId), saved),
  });
}

/** `pollMs`: refetch this often (while starting or stopping); `false` = no polling. */
export const useComputer = (orgId: string, agentId: string, enabled = true, pollMs: number | false = false) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.computer(orgId, agentId),
    queryFn: () => api.sandbox.computer(orgId, agentId),
    enabled,
    retry: false,
    refetchInterval: pollMs,
    // Polling doesn't show the top progress bar.
    meta: { quiet: true },
  });
};

export function useComputerAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, action }: { agentId: string; action: "start" | "stop" | "remove" }): Promise<unknown> =>
      action === "start"
        ? api.sandbox.start(orgId, agentId)
        : action === "stop"
          ? api.sandbox.stop(orgId, agentId)
          : api.sandbox.remove(orgId, agentId),
    onSuccess: (result, { agentId, action }) => {
      if (action === "remove") {
        qc.setQueryData<AgentComputer>(keys.computer(orgId, agentId), (old) =>
          old ? { ...old, status: "none", diskUsedGib: 0, createdAt: null, lastUsedAt: null } : old,
        );
      } else if (result && typeof result === "object" && "status" in result) {
        qc.setQueryData(keys.computer(orgId, agentId), result as AgentComputer);
      }
    },
  });
}

/** Cloud or a connected machine for the agent; the computer view follows the answer. */
export function useSetComputerTarget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, machineId }: { agentId: string; machineId: string | null }) =>
      api.sandbox.setTarget(orgId, agentId, machineId),
    meta: { silent: true },
    onSuccess: (target, { agentId }) => {
      qc.setQueryData<AgentComputer>(keys.computer(orgId, agentId), (old) => (old ? { ...old, target } : old));
      void qc.invalidateQueries({ queryKey: keys.computer(orgId, agentId) });
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
    },
  });
}

// ── Connected computers ─────────────────────────────────────────────────────

/** `pollMs`: also refetch this often (while waiting for a new machine to pair); events keep it live otherwise. */
export const useMachines = (orgId: string, enabled = true, pollMs: number | false = false) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.machines(orgId),
    queryFn: () => api.machines.list(orgId),
    enabled,
    retry: false,
    refetchInterval: pollMs,
    meta: { quiet: true },
  });
};

export function useCreatePairing(orgId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (name: string) => api.machines.createPairing(orgId, { name }),
    meta: { silent: true },
  });
}

export function useMachineAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: { machineId: string; action: "rename"; name: string } | { machineId: string; action: "remove" },
    ) =>
      input.action === "rename"
        ? api.machines.rename(orgId, input.machineId, input.name).then(() => undefined)
        : api.machines.remove(orgId, input.machineId),
    meta: { silent: true },
    onSuccess: (_r, input) => {
      qc.setQueryData<Machine[]>(keys.machines(orgId), (list) =>
        input.action === "remove"
          ? list?.filter((m) => m.id !== input.machineId)
          : list?.map((m) => (m.id === input.machineId ? { ...m, name: input.name } : m)),
      );
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
      // Agents on a removed machine go back to the cloud; a renamed one shows its new name.
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
    },
  });
}

// ── Forum ────────────────────────────────────────────────────────────────────

export const useForumTopics = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.forum(orgId),
    queryFn: () => api.forum.list(orgId),
    enabled,
    staleTime: 15_000,
  });
};

/** A topic with its posts; refreshed every few seconds while the discussion is on. */
export const useForumTopic = (orgId: string, topicId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.forumTopic(orgId, topicId ?? ""),
    queryFn: () => api.forum.get(orgId, topicId ?? ""),
    enabled: topicId !== null,
    refetchInterval: (q) => (q.state.data?.status === "open" ? 5000 : false),
    meta: { quiet: true },
  });
};

export function useForumAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "create"; input: ForumTopicInput }
        | { type: "post"; topicId: string; body: string }
        | { type: "conclude"; topicId: string }
        | { type: "cancel"; topicId: string }
        | { type: "participants"; topicId: string; input: ForumParticipantsInput }
        | { type: "issues"; topicId: string; items: ForumSuggestedIssue[] },
    ): Promise<unknown> => {
      switch (action.type) {
        case "create":
          return api.forum.create(orgId, action.input);
        case "post":
          return api.forum.post(orgId, action.topicId, action.body);
        case "conclude":
          return api.forum.conclude(orgId, action.topicId);
        case "cancel":
          return api.forum.cancel(orgId, action.topicId);
        case "participants":
          return api.forum.participants(orgId, action.topicId, action.input);
        case "issues":
          return api.forum.createIssues(orgId, action.topicId, action.items);
      }
    },
    onSuccess: (result, action) => {
      if (
        action.type !== "issues" &&
        action.type !== "post" &&
        result &&
        typeof result === "object" &&
        "id" in result
      ) {
        qc.setQueryData(keys.forumTopic(orgId, (result as ForumTopicDetail).id), result);
      }
    },
    onSettled: (_r, _e, action) => {
      void qc.invalidateQueries({ queryKey: keys.forum(orgId) });
      if (action.type === "issues") void qc.invalidateQueries({ queryKey: ["org", orgId, "issues"] });
    },
  });
}

// ── Wiki ─────────────────────────────────────────────────────────────────────

/** Every page (titles, folders, tags): the tree, `[[link]]` resolution, ⌘K. */
export const useWikiTree = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiTree(orgId),
    queryFn: () => api.wiki.tree(orgId),
    enabled,
    staleTime: 30_000,
  });
};

export const useWikiPage = (orgId: string, slug: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiPage(orgId, slug ?? ""),
    queryFn: () => api.wiki.get(orgId, slug ?? ""),
    enabled: slug !== null && slug !== "",
    retry: false,
  });
};

export const useWikiHistory = (orgId: string, slug: string, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiHistory(orgId, slug),
    queryFn: () => api.wiki.history(orgId, slug),
    enabled,
  });
};

export const useWikiGraph = (orgId: string, enabled: boolean) => {
  const api = useApi();
  return useQuery({ queryKey: keys.wikiGraph(orgId), queryFn: () => api.wiki.graph(orgId), enabled });
};

export function useWikiAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (
      action:
        | { type: "create"; input: WikiPageInput }
        | { type: "update"; slug: string; input: WikiUpdateInput }
        | { type: "rename"; slug: string; title: string }
        | {
            type: "append";
            slug: string;
            text: string;
            source: { kind: "message"; channelId: string; messageId: string } | { kind: "forum"; topicId: string };
          },
    ): Promise<WikiPage> => {
      switch (action.type) {
        case "create":
          return api.wiki.create(orgId, action.input);
        case "update":
          return api.wiki.update(orgId, action.slug, action.input);
        case "rename":
          return api.wiki.rename(orgId, action.slug, action.title);
        case "append":
          return api.wiki.append(orgId, action.slug, { text: action.text, source: action.source });
      }
    },
    onSuccess: (page) => {
      qc.setQueryData(keys.wikiPage(orgId, page.slug), page);
      void qc.invalidateQueries({ queryKey: keys.wiki(orgId) });
    },
  });
}
