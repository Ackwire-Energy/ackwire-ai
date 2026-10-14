import type { HttpApi } from "./client";
import { ApiError, createRequester, enc, type FetchLike } from "./http";
import type {
  Agent,
  AgentUsage,
  AuthConfig,
  Channel,
  ChannelMember,
  Credential,
  Health,
  Invitation,
  InvitationPreview,
  Me,
  Member,
  Message,
  Model,
  Organization,
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
      usage: async (orgId) => {
        const res = await nullOn(403, () => request<{ usage: AgentUsage[] }>(`${org(orgId)}/usage`));
        return res ? res.usage : null;
      },
    },
    chat: {
      channels: async (orgId) => (await request<{ channels: Channel[] }>(`${org(orgId)}/channels`)).channels,
      createChannel: (orgId, input) => request<Channel>(`${org(orgId)}/channels`, { json: input }),
      join: (orgId, channelId) => request<void>(`${org(orgId)}/channels/${enc(channelId)}/join`, { json: {} }),
      members: async (orgId, channelId) =>
        (await request<{ members: ChannelMember[] }>(`${org(orgId)}/channels/${enc(channelId)}/members`)).members,
      addMember: (orgId, channelId, member) =>
        request<void>(`${org(orgId)}/channels/${enc(channelId)}/members`, { json: member }),
      messages: async (orgId, channelId, options = {}) =>
        (
          await request<{ messages: Message[] }>(`${org(orgId)}/channels/${enc(channelId)}/messages`, {
            query: { threadId: options.threadId, before: options.before, limit: options.limit },
          })
        ).messages,
      post: (orgId, channelId, input) =>
        request<Message>(`${org(orgId)}/channels/${enc(channelId)}/messages`, { json: input }),
    },
  };
}
