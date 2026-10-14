import type {
  Agent,
  AgentInput,
  AgentPermissions,
  AgentRunSummary,
  AgentUsage,
  Approval,
  AuthConfig,
  Channel,
  ChannelMember,
  Credential,
  Health,
  Invitation,
  InvitationPreview,
  Me,
  Member,
  Memory,
  Message,
  Model,
  Organization,
  Proposal,
  Role,
} from "./types";

/**
 * Everything the web app asks the backend. `createApiClient` (./index.ts)
 * wires the real HTTP implementation (./http-client.ts) for what the server
 * exposes and in-memory mocks (./mock) for what it doesn't yet. Tests pass a
 * fake. Components never call `fetch` directly.
 */
export interface ApiClient {
  system: { health(): Promise<Health> };
  account: {
    authConfig(): Promise<AuthConfig>;
    /** `null` when signed out. */
    me(): Promise<Me | null>;
  };
  orgs: {
    create(input: {
      name: string;
      context?: string;
    }): Promise<{ organization: Organization; generalChannelId: string }>;
    get(orgId: string): Promise<Organization>;
    update(orgId: string, input: { name?: string; context?: string }): Promise<void>;
    members(orgId: string): Promise<Member[]>;
    changeRole(orgId: string, userId: string, role: Role): Promise<void>;
    removeMember(orgId: string, userId: string): Promise<void>;
    invitations(orgId: string): Promise<Invitation[]>;
    invite(orgId: string, input: { email: string; role: Role }): Promise<{ invitation: Invitation; url: string }>;
    revokeInvitation(orgId: string, invitationId: string): Promise<void>;
    /** `null` when invalid or expired. */
    previewInvitation(token: string): Promise<InvitationPreview | null>;
    acceptInvitation(token: string): Promise<{ orgId: string }>;
  };
  agents: {
    list(orgId: string): Promise<Agent[]>;
    create(orgId: string, input: AgentInput): Promise<Agent>;
    update(orgId: string, agentId: string, input: Partial<Omit<AgentInput, "handle">>): Promise<Agent>;
    archive(orgId: string, agentId: string): Promise<void>;
    models(): Promise<{ models: Model[]; defaultModel: string }>;
    credentials(orgId: string): Promise<Credential[]>;
    addCredential(orgId: string, input: { provider: "anthropic"; label: string; apiKey: string }): Promise<Credential>;
    /** This month's usage per agent; `null` without the `view_usage` permission. */
    usage(orgId: string): Promise<AgentUsage[] | null>;
  };
  chat: {
    channels(orgId: string): Promise<Channel[]>;
    createChannel(
      orgId: string,
      input: { name: string; topic?: string; visibility?: "public" | "private" },
    ): Promise<Channel>;
    join(orgId: string, channelId: string): Promise<void>;
    members(orgId: string, channelId: string): Promise<ChannelMember[]>;
    addMember(orgId: string, channelId: string, member: { userId: string } | { agentId: string }): Promise<void>;
    messages(
      orgId: string,
      channelId: string,
      options?: { threadId?: string; before?: string; limit?: number },
    ): Promise<Message[]>;
    post(orgId: string, channelId: string, input: { body: string; threadId?: string | null }): Promise<Message>;
  };

  // ── Mock-backed until the backend has endpoints (see src/api/mock) ──────────
  approvals: {
    list(orgId: string): Promise<Approval[]>;
    decide(orgId: string, approvalId: string, decision: "approved" | "refused"): Promise<Approval>;
  };
  permissions: {
    get(orgId: string, agentId: string): Promise<AgentPermissions>;
    set(orgId: string, agentId: string, granted: string[]): Promise<AgentPermissions>;
    /** Connectors the organization has connected (for "Criar agente"). */
    connectors(orgId: string): Promise<AgentPermissions["connectors"]>;
  };
  runs: {
    list(orgId: string, agentId: string): Promise<{ runs: AgentRunSummary[]; total: number }>;
  };
  memory: {
    list(orgId: string, agentId: string): Promise<Memory[]>;
    edit(orgId: string, memoryId: string, text: string): Promise<Memory>;
    setPinned(orgId: string, memoryId: string, pinned: boolean): Promise<Memory>;
    setArchived(orgId: string, memoryId: string, archived: boolean): Promise<Memory>;
  };
  proposals: {
    list(orgId: string): Promise<Proposal[]>;
    accept(orgId: string, proposalId: string, finalText?: string): Promise<Proposal>;
    refuse(orgId: string, proposalId: string): Promise<Proposal>;
  };
  invites: {
    /** Org-wide link: whoever joins with it becomes a member (7 days). */
    createLink(orgId: string): Promise<{ url: string; expiresAt: string }>;
    /** Expired invitation: ask the inviter for a new one. */
    requestNew(token: string): Promise<void>;
  };
  presence: {
    /** Last activity per user id (ISO); missing = unknown. */
    list(orgId: string): Promise<Record<string, string>>;
  };
}

/** The part of the client the HTTP backend implements today. */
export type HttpApi = Pick<ApiClient, "system" | "account" | "orgs" | "agents" | "chat">;
/** The part still served by in-memory mocks. */
export type MockedApi = Omit<ApiClient, keyof HttpApi>;
