import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { upsertMessage } from "@/chat/timeline";
import type { ApiClient } from "./client";
import { useApi } from "./context";
import { keys } from "./keys";
import type { AgentInput, Approval, Message, OrgSettings, Role, ScopeGrant, SearchKind, ToolAccess } from "./types";

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

export const useMessages = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.messages(orgId, channelId),
    queryFn: () => api.chat.messages(orgId, channelId, { limit: 100 }),
    enabled,
  });
};

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
    mutationFn: ({ body, clientId }: { body: string; clientId: string }) =>
      api.chat.post(orgId, channelId, { body, clientId }),
    onMutate: ({ body, clientId }) => {
      const local: Message = {
        id: `local-${clientId}`,
        channelId,
        threadId: null,
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
    send: (body: string) => mutation.mutate({ body, clientId: newClientId() }),
    retry: (local: Message) => mutation.mutate({ body: local.body, clientId: local.clientId ?? newClientId() }),
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

// ── Mock-backed features ────────────────────────────────────────────────────

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
        tools: { name: string; access: ToolAccess; label: string }[];
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
