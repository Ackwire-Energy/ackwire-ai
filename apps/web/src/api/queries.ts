import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { upsertMessage } from "@/chat/timeline";
import type { ApiClient } from "./client";
import { useApi } from "./context";
import { keys } from "./keys";
import type { AgentInput, Message, Role } from "./types";

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

export const usePresence = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.presence(orgId), queryFn: () => api.presence.list(orgId), staleTime: 60_000 });
};

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
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.agents(orgId) }),
  });
}

export function useAddCredential(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: "anthropic"; label: string; apiKey: string }) =>
      api.agents.addCredential(orgId, input),
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

/** Which channels each agent belongs to (only channels the person is in can be listed). */
export function useAgentChannels(orgId: string, channelIds: string[]) {
  const api = useApi();
  return useQueries({
    queries: channelIds.map((channelId) => ({
      queryKey: keys.channelMembers(orgId, channelId),
      queryFn: () => api.chat.members(orgId, channelId),
      staleTime: 30_000,
    })),
  });
}

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

/** Puts a message in the right cache: the channel list, or its thread. */
export function cacheMessage(qc: ReturnType<typeof useQueryClient>, orgId: string, message: Message) {
  if (message.threadId) {
    qc.setQueryData<Message[]>(keys.thread(orgId, message.channelId, message.threadId), (list) =>
      upsertMessage(list, message),
    );
  } else {
    qc.setQueryData<Message[]>(keys.messages(orgId, message.channelId), (list) => upsertMessage(list, message));
  }
}

export function usePostMessage(orgId: string, channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.chat.post(orgId, channelId, { body }),
    onSuccess: (message) => cacheMessage(qc, orgId, message),
  });
}

// ── Mock-backed features ────────────────────────────────────────────────────

export const useApprovals = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.approvals(orgId), queryFn: () => api.approvals.list(orgId), staleTime: 15_000 });
};

export function useDecideApproval(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "refused" }) =>
      api.approvals.decide(orgId, id, decision),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.approvals(orgId) }),
  });
}

export const usePermissions = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.permissions(orgId, agentId), queryFn: () => api.permissions.get(orgId, agentId) });
};

export const useConnectors = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.connectors(orgId), queryFn: () => api.permissions.connectors(orgId) });
};

export function useSetPermissions(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (granted: string[]) => api.permissions.set(orgId, agentId, granted),
    onSuccess: (data) => qc.setQueryData(keys.permissions(orgId, agentId), data),
  });
}

export const useRuns = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.runs(orgId, agentId), queryFn: () => api.runs.list(orgId, agentId), enabled });
};

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
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.proposals(orgId) }),
  });
}
