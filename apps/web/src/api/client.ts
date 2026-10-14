import type {
  Agent,
  AgentChannel,
  AgentDetail,
  AgentInput,
  AgentUsage,
  Approval,
  AuthConfig,
  BatchInviteResult,
  Channel,
  ChannelMember,
  Connection,
  ConnectorCatalog,
  Credential,
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
  Role,
  RosterMember,
  Run,
  RunStep,
  ScopeGrant,
  UsageReport,
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
    settings(orgId: string): Promise<OrgSettings>;
    updateSettings(orgId: string, input: Partial<Omit<OrgSettings, "name">> & { name?: string }): Promise<OrgSettings>;
    overview(orgId: string): Promise<OrgOverview>;
    /** Members with presence. */
    people(orgId: string): Promise<Person[]>;
    /** Invitations not accepted yet, pending or expired. */
    allInvitations(orgId: string): Promise<InvitationWithStatus[]>;
    inviteMany(orgId: string, input: { emails: string[]; role: Role }): Promise<BatchInviteResult[]>;
    /** New link (the old one stops working), 7 more days. */
    resendInvitation(orgId: string, invitationId: string): Promise<{ url: string; expiresAt: string }>;
    usageReport(orgId: string, since?: string): Promise<UsageReport>;
  };
  agents: {
    list(orgId: string): Promise<Agent[]>;
    create(orgId: string, input: AgentInput): Promise<Agent>;
    update(orgId: string, agentId: string, input: Partial<Omit<AgentInput, "handle">>): Promise<Agent>;
    archive(orgId: string, agentId: string): Promise<void>;
    models(): Promise<{ models: Model[]; defaultModel: string }>;
    credentials(orgId: string): Promise<Credential[]>;
    addCredential(orgId: string, input: { provider: "anthropic"; label: string; apiKey: string }): Promise<Credential>;
    /** Replaces the key, keeping the id (agents keep using it). */
    rotateCredential(
      orgId: string,
      credentialId: string,
      input: { apiKey: string; label?: string },
    ): Promise<Credential>;
    /** Revokes, or deletes for good with `purge` (refused while an agent uses it). */
    removeCredential(orgId: string, credentialId: string, purge?: boolean): Promise<void>;
    /** Whether this server offers the platform key (Cloud). */
    platformKeyAvailable(orgId: string): Promise<boolean>;
    detail(orgId: string, agentId: string): Promise<AgentDetail>;
    channels(orgId: string, agentId: string): Promise<AgentChannel[]>;
    setChannels(
      orgId: string,
      agentId: string,
      channels: { channelId: string; autoReply?: boolean }[],
    ): Promise<AgentChannel[]>;
    runs(
      orgId: string,
      filter?: { agentId?: string; status?: string; before?: string; since?: string; limit?: number },
    ): Promise<Run[]>;
    run(orgId: string, runId: string): Promise<{ run: Run; steps: RunStep[] }>;
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
    update(
      orgId: string,
      channelId: string,
      input: { name?: string; topic?: string; visibility?: "public" | "private" },
    ): Promise<Channel>;
    /** Members with names; agents carry `autoReply`. */
    roster(orgId: string, channelId: string): Promise<RosterMember[]>;
    members(orgId: string, channelId: string): Promise<ChannelMember[]>;
    addMember(orgId: string, channelId: string, member: { userId: string } | { agentId: string }): Promise<void>;
    messages(
      orgId: string,
      channelId: string,
      options?: { threadId?: string; before?: string; limit?: number },
    ): Promise<Message[]>;
    post(orgId: string, channelId: string, input: { body: string; threadId?: string | null }): Promise<Message>;
  };

  approvals: {
    list(orgId: string, filter?: { status?: "pending" | "decided"; agentId?: string }): Promise<Approval[]>;
    get(orgId: string, approvalId: string): Promise<Approval>;
    approve(orgId: string, approvalId: string, reason?: string): Promise<Approval>;
    refuse(orgId: string, approvalId: string, reason?: string): Promise<Approval>;
  };
  connectors: {
    /** Connectors agentes.chat knows, with their scopes, plus the built-in scopes. */
    catalog(): Promise<ConnectorCatalog>;
    /** The organization's connections (no secrets). */
    list(orgId: string): Promise<Connection[]>;
    connectWithKey(
      orgId: string,
      input: { connector: string; apiKey: string; serverUrl?: string; label?: string },
    ): Promise<Connection>;
    /** Returns the provider URL to open; the server redirects back to `returnTo`. */
    startOAuth(orgId: string, connector: string, input: { returnTo: string; serverUrl?: string }): Promise<string>;
    disconnect(orgId: string, connectionId: string): Promise<void>;
  };
  scopes: {
    get(orgId: string, agentId: string): Promise<ScopeGrant[]>;
    set(orgId: string, agentId: string, grants: ScopeGrant[]): Promise<ScopeGrant[]>;
  };

  // ── Mock-backed until the backend has endpoints (see src/api/mock) ──────────
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
}

/** The part of the client the HTTP backend implements today. */
export type HttpApi = Pick<
  ApiClient,
  "system" | "account" | "orgs" | "agents" | "chat" | "approvals" | "connectors" | "scopes"
>;
/** The part still served by in-memory mocks. */
export type MockedApi = Omit<ApiClient, keyof HttpApi>;
