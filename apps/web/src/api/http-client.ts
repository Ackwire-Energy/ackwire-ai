import type { HttpApi } from "./client";
import { ApiError, createRequester, enc, type FetchLike } from "./http";
import type {
  Agent,
  AgentChannel,
  AgentDetail,
  AgentQuestion,
  AgentUsage,
  Approval,
  AuthConfig,
  BatchInviteResult,
  Channel,
  ChannelMember,
  Connection,
  ConnectorCatalog,
  Credential,
  DirectMessage,
  Health,
  Invitation,
  InvitationPreview,
  InvitationWithStatus,
  Me,
  Member,
  Memory,
  Message,
  Model,
  Organization,
  OrgOverview,
  OrgSettings,
  Person,
  Proposal,
  ReactionCount,
  RosterMember,
  Run,
  RunStep,
  ScopeGrant,
  SearchHit,
  UsageReport,
} from "./types";

const org = (orgId: string) => `/api/app/organizations/${enc(orgId)}`;

/** The real backend: `/api/health` and `/api/app/*` (apps/server/src/routes/app). */
export function createHttpApi(fetchImpl?: FetchLike): HttpApi {
  const request = createRequester(fetchImpl);
  const nullOn = async <T>(status: number, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiError && error.status === status) return null;
      throw error;
    }
  };

  return {
    system: {
      health: async () => {
        try {
          return await request<Health>("/api/health");
        } catch (error) {
          // 503 still carries the edition; anything else: assume Cloud.
          if (error instanceof ApiError) return { status: "degraded", version: "", edition: "cloud" };
          throw error;
        }
      },
    },
    account: {
      authConfig: () => request<AuthConfig>("/api/app/auth-config"),
      me: () => nullOn(401, () => request<Me>("/api/app/me")),
    },
    orgs: {
      create: (input) =>
        request<{ organization: Organization; generalChannelId: string }>("/api/app/organizations", { json: input }),
      get: (orgId) => request<Organization>(org(orgId)),
      update: (orgId, input) => request<void>(org(orgId), { method: "PATCH", json: input }),
      members: async (orgId) => (await request<{ members: Member[] }>(`${org(orgId)}/members`)).members,
      changeRole: (orgId, userId, role) =>
        request<void>(`${org(orgId)}/members/${enc(userId)}`, { method: "PATCH", json: { role } }),
      removeMember: (orgId, userId) => request<void>(`${org(orgId)}/members/${enc(userId)}`, { method: "DELETE" }),
      invitations: async (orgId) =>
        (await request<{ invitations: Invitation[] }>(`${org(orgId)}/invitations`)).invitations,
      invite: (orgId, input) =>
        request<{ invitation: Invitation; url: string }>(`${org(orgId)}/invitations`, { json: input }),
      revokeInvitation: (orgId, id) => request<void>(`${org(orgId)}/invitations/${enc(id)}`, { method: "DELETE" }),
      previewInvitation: (token) => nullOn(404, () => request<InvitationPreview>(`/api/app/invitations/${enc(token)}`)),
      acceptInvitation: (token) =>
        request<{ orgId: string }>(`/api/app/invitations/${enc(token)}/accept`, { json: {} }),
      settings: (orgId) => request<OrgSettings>(`${org(orgId)}/settings`),
      updateSettings: (orgId, input) =>
        request<OrgSettings>(`${org(orgId)}/settings`, { method: "PATCH", json: input }),
      overview: (orgId) => request<OrgOverview>(`${org(orgId)}/overview`),
      people: async (orgId) => (await request<{ people: Person[] }>(`${org(orgId)}/people`)).people,
      allInvitations: async (orgId) =>
        (await request<{ invitations: InvitationWithStatus[] }>(`${org(orgId)}/invitations/all`)).invitations,
      inviteMany: async (orgId, input) =>
        (await request<{ results: BatchInviteResult[] }>(`${org(orgId)}/invitations/batch`, { json: input })).results,
      resendInvitation: (orgId, id) =>
        request<{ url: string; expiresAt: string }>(`${org(orgId)}/invitations/${enc(id)}/resend`, { json: {} }),
      usageReport: (orgId, since) => request<UsageReport>(`${org(orgId)}/usage/report`, { query: { since } }),
    },
    agents: {
      list: async (orgId) => (await request<{ agents: Agent[] }>(`${org(orgId)}/agents`)).agents,
      create: (orgId, input) => request<Agent>(`${org(orgId)}/agents`, { json: input }),
      update: (orgId, agentId, input) =>
        request<Agent>(`${org(orgId)}/agents/${enc(agentId)}`, { method: "PATCH", json: input }),
      archive: (orgId, agentId) => request<void>(`${org(orgId)}/agents/${enc(agentId)}`, { method: "DELETE" }),
      models: () => request<{ models: Model[]; defaultModel: string }>("/api/app/models"),
      credentials: async (orgId) =>
        (await request<{ credentials: Credential[] }>(`${org(orgId)}/credentials`)).credentials,
      addCredential: (orgId, input) => request<Credential>(`${org(orgId)}/credentials`, { json: input }),
      rotateCredential: (orgId, id, input) =>
        request<Credential>(`${org(orgId)}/credentials/${enc(id)}/rotate`, { json: input }),
      removeCredential: (orgId, id, purge) =>
        request<void>(`${org(orgId)}/credentials/${enc(id)}`, {
          method: "DELETE",
          query: { purge: purge ? "true" : undefined },
        }),
      platformKeyAvailable: async (orgId) =>
        (await request<{ available: boolean }>(`${org(orgId)}/credentials/platform`)).available,
      detail: (orgId, agentId) => request<AgentDetail>(`${org(orgId)}/agents/${enc(agentId)}`),
      channels: async (orgId, agentId) =>
        (await request<{ channels: AgentChannel[] }>(`${org(orgId)}/agents/${enc(agentId)}/channels`)).channels,
      setChannels: async (orgId, agentId, channels) =>
        (
          await request<{ channels: AgentChannel[] }>(`${org(orgId)}/agents/${enc(agentId)}/channels`, {
            method: "PUT",
            json: { channels },
          })
        ).channels,
      runs: async (orgId, filter = {}) =>
        (await request<{ runs: Run[] }>(`${org(orgId)}/runs`, { query: filter })).runs,
      run: (orgId, runId) => request<{ run: Run; steps: RunStep[] }>(`${org(orgId)}/runs/${enc(runId)}`),
      usage: async (orgId) => {
        const res = await nullOn(403, () => request<{ usage: AgentUsage[] }>(`${org(orgId)}/usage`));
        return res ? res.usage : null;
      },
    },
    chat: {
      channels: async (orgId) => (await request<{ channels: Channel[] }>(`${org(orgId)}/channels`)).channels,
      createChannel: (orgId, input) => request<Channel>(`${org(orgId)}/channels`, { json: input }),
      join: (orgId, channelId) => request<void>(`${org(orgId)}/channels/${enc(channelId)}/join`, { json: {} }),
      update: (orgId, channelId, input) =>
        request<Channel>(`${org(orgId)}/channels/${enc(channelId)}`, { method: "PATCH", json: input }),
      reactions: async (orgId, messageId) =>
        (await request<{ reactions: ReactionCount[] }>(`${org(orgId)}/messages/${enc(messageId)}/reactions`)).reactions,
      react: async (orgId, messageId, reaction) =>
        (
          await request<{ reactions: ReactionCount[] }>(`${org(orgId)}/messages/${enc(messageId)}/reactions`, {
            json: { reaction },
          })
        ).reactions,
      unreact: async (orgId, messageId, reaction) =>
        (
          await request<{ reactions: ReactionCount[] }>(`${org(orgId)}/messages/${enc(messageId)}/reactions`, {
            method: "DELETE",
            query: { reaction },
          })
        ).reactions,
      correct: async (orgId, messageId, body) => {
        await request<unknown>(`${org(orgId)}/messages/${enc(messageId)}/correction`, { json: { body } });
      },
      roster: async (orgId, channelId) =>
        (await request<{ members: RosterMember[] }>(`${org(orgId)}/channels/${enc(channelId)}/roster`)).members,
      members: async (orgId, channelId) =>
        (await request<{ members: ChannelMember[] }>(`${org(orgId)}/channels/${enc(channelId)}/members`)).members,
      addMember: (orgId, channelId, member) =>
        request<void>(`${org(orgId)}/channels/${enc(channelId)}/members`, { json: member }),
      removeMember: (orgId, channelId, member) =>
        request<void>(
          "agentId" in member
            ? `${org(orgId)}/channels/${enc(channelId)}/members/agents/${enc(member.agentId)}`
            : `${org(orgId)}/channels/${enc(channelId)}/members/people/${enc(member.userId)}`,
          { method: "DELETE" },
        ),
      messages: async (orgId, channelId, options = {}) =>
        (
          await request<{ messages: Message[] }>(`${org(orgId)}/channels/${enc(channelId)}/messages`, {
            query: { threadId: options.threadId, before: options.before, limit: options.limit },
          })
        ).messages,
      post: (orgId, channelId, input) =>
        request<Message>(`${org(orgId)}/channels/${enc(channelId)}/messages`, { json: input }),
    },
    approvals: {
      list: async (orgId, filter = {}) =>
        (await request<{ approvals: Approval[] }>(`${org(orgId)}/approvals`, { query: filter })).approvals,
      get: (orgId, id) => request<Approval>(`${org(orgId)}/approvals/${enc(id)}`),
      approve: (orgId, id, reason) =>
        request<Approval>(`${org(orgId)}/approvals/${enc(id)}/approve`, { json: reason ? { reason } : {} }),
      refuse: (orgId, id, reason) =>
        request<Approval>(`${org(orgId)}/approvals/${enc(id)}/refuse`, { json: reason ? { reason } : {} }),
    },
    connectors: {
      catalog: () => request<ConnectorCatalog>("/api/app/connectors/catalog"),
      list: async (orgId) => (await request<{ connections: Connection[] }>(`${org(orgId)}/connectors`)).connections,
      connectWithKey: (orgId, input) => request<Connection>(`${org(orgId)}/connectors`, { json: input }),
      startOAuth: async (orgId, connector, input) =>
        (
          await request<{ authorizeUrl: string }>(`${org(orgId)}/connectors/${enc(connector)}/oauth/start`, {
            json: input,
          })
        ).authorizeUrl,
      disconnect: (orgId, connectionId) =>
        request<void>(`${org(orgId)}/connectors/${enc(connectionId)}`, { method: "DELETE" }),
    },
    search: {
      query: async (orgId, input) =>
        (
          await request<{ hits: SearchHit[] }>(`${org(orgId)}/search`, {
            query: { q: input.q, kinds: input.kinds?.join(","), limit: input.limit },
          })
        ).hits,
    },
    memory: {
      list: async (orgId, agentId) =>
        (await request<{ memories: Memory[] }>(`${org(orgId)}/agents/${enc(agentId)}/memories`)).memories,
      edit: (orgId, id, text) =>
        request<Memory>(`${org(orgId)}/memories/${enc(id)}`, { method: "PATCH", json: { text } }),
      setPinned: (orgId, id, pinned) =>
        request<Memory>(`${org(orgId)}/memories/${enc(id)}`, { method: "PATCH", json: { pinned } }),
      setArchived: (orgId, id, archived) =>
        request<Memory>(`${org(orgId)}/memories/${enc(id)}`, { method: "PATCH", json: { archived } }),
      revert: async (orgId, id) => {
        await request<unknown>(`${org(orgId)}/memories/${enc(id)}/revert`, { json: {} });
      },
    },
    dms: {
      list: async (orgId) => (await request<{ dms: DirectMessage[] }>(`${org(orgId)}/dms`)).dms,
      open: (orgId, target) => request<{ channelId: string }>(`${org(orgId)}/dms`, { json: target }),
      markRead: (orgId, channelId) => request<void>(`${org(orgId)}/channels/${enc(channelId)}/read`, { json: {} }),
    },
    questions: {
      answer: (orgId, questionId, input) =>
        request<AgentQuestion>(`${org(orgId)}/questions/${enc(questionId)}/answer`, { json: input }),
    },
    proposals: {
      list: async (orgId) => (await request<{ proposals: Proposal[] }>(`${org(orgId)}/proposals`)).proposals,
      accept: (orgId, id, text) =>
        request<Proposal>(`${org(orgId)}/proposals/${enc(id)}/accept`, { json: text === undefined ? {} : { text } }),
      refuse: (orgId, id) => request<Proposal>(`${org(orgId)}/proposals/${enc(id)}/refuse`, { json: {} }),
    },
    scopes: {
      get: async (orgId, agentId) =>
        (await request<{ scopes: ScopeGrant[] }>(`${org(orgId)}/agents/${enc(agentId)}/scopes`)).scopes,
      set: async (orgId, agentId, grants) =>
        (
          await request<{ scopes: ScopeGrant[] }>(`${org(orgId)}/agents/${enc(agentId)}/scopes`, {
            method: "PUT",
            json: { scopes: grants },
          })
        ).scopes,
    },
  };
}
