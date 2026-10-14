import type {
  Agent,
  AgentChannel,
  AgentDetail,
  AgentInput,
  AgentQuestion,
  AgentUsage,
  Approval,
  Artifact,
  ArtifactContent,
  ArtifactDetail,
  ArtifactFilters,
  ArtifactVersion,
  AuthConfig,
  BatchInviteResult,
  CalendarEvent,
  CalendarEventInput,
  CalendarRange,
  Channel,
  ChannelMember,
  Connection,
  ConnectorCatalog,
  Credential,
  CustomConnectStart,
  CustomServer,
  DirectMessage,
  DmTarget,
  Health,
  Invitation,
  InvitationPreview,
  InvitationWithStatus,
  Issue,
  IssueActivity,
  IssueInput,
  IssuePatch,
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
  Role,
  RosterMember,
  Routine,
  RoutineInput,
  RoutineRun,
  Run,
  RunStep,
  S3Input,
  ScheduleParse,
  ScopeGrant,
  SearchHit,
  SearchKind,
  StorageConfig,
  StorageMigration,
  StorageTestResult,
  ToolAccess,
  UsageReport,
} from "./types";

/**
 * Everything the web app asks the backend. `createApiClient` (./index.ts)
 * wires the HTTP implementation (./http-client.ts); tests pass a fake
 * (test/fake-api.ts). Components never call `fetch` directly.
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
    addCredential(
      orgId: string,
      input: {
        provider: string;
        label: string;
        apiKey: string;
        /** Anthropic: workspace id for keys not scoped to one. */
        workspaceId?: string | null;
        /** OpenAI: organization and project (expected; the backend is adding OpenAI). */
        organizationId?: string | null;
        projectId?: string | null;
      },
    ): Promise<Credential>;
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
    removeMember(orgId: string, channelId: string, member: { userId: string } | { agentId: string }): Promise<void>;
    messages(
      orgId: string,
      channelId: string,
      options?: { threadId?: string; before?: string; limit?: number },
    ): Promise<Message[]>;
    post(
      orgId: string,
      channelId: string,
      input: { body: string; threadId?: string | null; clientId?: string },
    ): Promise<Message>;
    reactions(orgId: string, messageId: string): Promise<ReactionCount[]>;
    react(orgId: string, messageId: string, reaction: string): Promise<ReactionCount[]>;
    unreact(orgId: string, messageId: string, reaction: string): Promise<ReactionCount[]>;
    /** Corrects an agent's reply: it becomes a lesson for that agent. */
    correct(orgId: string, messageId: string, body: string): Promise<void>;
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
  search: {
    query(orgId: string, input: { q: string; kinds?: SearchKind[]; limit?: number }): Promise<SearchHit[]>;
  };
  scopes: {
    get(orgId: string, agentId: string): Promise<ScopeGrant[]>;
    set(orgId: string, agentId: string, grants: ScopeGrant[]): Promise<ScopeGrant[]>;
  };

  memory: {
    list(orgId: string, agentId: string): Promise<Memory[]>;
    edit(orgId: string, memoryId: string, text: string): Promise<Memory>;
    setPinned(orgId: string, memoryId: string, pinned: boolean): Promise<Memory>;
    setArchived(orgId: string, memoryId: string, archived: boolean): Promise<Memory>;
    /** Undoes a change the agent made from the chat (`update.undo.path`). */
    revert(orgId: string, memoryId: string): Promise<void>;
  };
  proposals: {
    list(orgId: string): Promise<Proposal[]>;
    accept(orgId: string, proposalId: string, finalText?: string): Promise<Proposal>;
    refuse(orgId: string, proposalId: string): Promise<Proposal>;
  };
  customConnectors: {
    list(orgId: string): Promise<CustomServer[]>;
    /**
     * Connects to an https MCP server. Without `apiKey` the server tries OAuth
     * (discovery + dynamic client registration); if the MCP server doesn't
     * support it, answers `needs_key`.
     */
    connect(
      orgId: string,
      input: { serverUrl: string; apiKey?: string; label?: string; returnTo: string },
    ): Promise<CustomConnectStart>;
    /** Lists the server's tools again; new ones come back unclassified. */
    refresh(orgId: string, serverId: string): Promise<CustomServer>;
    /** Saves the classification; only classified tools become available to agents. */
    saveTools(
      orgId: string,
      serverId: string,
      input: { label: string; tools: { name: string; access: ToolAccess; label: string }[] },
    ): Promise<CustomServer>;
    disconnect(orgId: string, serverId: string): Promise<void>;
  };
  dms: {
    /** My direct conversations, with unread counts. */
    list(orgId: string): Promise<DirectMessage[]>;
    /** The DM channel with a person or an agent, created on first use. */
    open(orgId: string, target: DmTarget): Promise<{ channelId: string }>;
    /** Marks a channel or DM read up to now. */
    markRead(orgId: string, channelId: string): Promise<void>;
  };
  questions: {
    /** Answers an agent's question with a choice or free text. */
    answer(orgId: string, questionId: string, input: { choice?: string; text?: string }): Promise<AgentQuestion>;
  };
  issues: {
    list(orgId: string, filters?: { q?: string }): Promise<Issue[]>;
    get(orgId: string, number: number): Promise<Issue>;
    create(orgId: string, input: IssueInput): Promise<Issue>;
    update(orgId: string, id: string, patch: IssuePatch): Promise<Issue>;
    setCriterion(orgId: string, id: string, criterionId: string, done: boolean): Promise<Issue>;
    activity(orgId: string, id: string): Promise<IssueActivity[]>;
    comment(orgId: string, id: string, text: string): Promise<IssueActivity>;
    /** "Pedir à Ada para implementar": assigns the agent and starts a run on the issue. */
    askAgent(orgId: string, id: string, agentId: string): Promise<Issue>;
  };
  routines: {
    list(orgId: string): Promise<Routine[]>;
    parseSchedule(orgId: string, phrase: string): Promise<ScheduleParse>;
    create(orgId: string, input: RoutineInput): Promise<Routine>;
    setActive(orgId: string, id: string, active: boolean): Promise<Routine>;
    runNow(orgId: string, id: string): Promise<Routine>;
    runs(orgId: string, id: string): Promise<RoutineRun[]>;
  };
  calendar: {
    /** Events, routine runs, issue deadlines and proposals between `from` and `to` (ISO). */
    range(orgId: string, from: string, to: string): Promise<CalendarRange>;
    create(orgId: string, input: CalendarEventInput): Promise<CalendarEvent>;
    /** Confirms an agent's proposal: creates the event and invites the people. */
    confirmProposal(orgId: string, id: string): Promise<CalendarEvent>;
    dismissProposal(orgId: string, id: string): Promise<void>;
  };
  artifacts: {
    /** Everything the viewer can see, newest update first. */
    list(orgId: string, filters?: ArtifactFilters): Promise<Artifact[]>;
    /** One artifact at `version` (default: latest), with content. */
    get(orgId: string, id: string, version?: number): Promise<ArtifactDetail>;
    versions(orgId: string, id: string): Promise<ArtifactVersion[]>;
    /** Short-lived signed URL for the stored file. */
    download(orgId: string, id: string, version?: number): Promise<{ url: string; expiresAt: string }>;
    /** Same-origin URL of the file as an attachment, optionally converted (CSV, .patch, PDF). */
    fileUrl(orgId: string, id: string, options?: { version?: number; format?: "csv" | "patch" | "pdf" }): string;
    create(
      orgId: string,
      input: { title: string; channelId?: string | null; content: ArtifactContent },
    ): Promise<ArtifactDetail>;
    /** Always a new version. `baseVersion` stale → 409. */
    update(
      orgId: string,
      id: string,
      input: { content: ArtifactContent; note?: string | null; baseVersion: number; title?: string },
    ): Promise<ArtifactDetail>;
    remove(orgId: string, id: string): Promise<void>;
  };
  storage: {
    get(orgId: string): Promise<StorageConfig>;
    /** Checks a bucket: write, read, list and delete a test object. */
    test(orgId: string, input: S3Input): Promise<StorageTestResult>;
    /** Switches storage. `s3` requires a passing test of the same settings. */
    save(orgId: string, input: { kind: "agentes" } | { kind: "s3"; s3: S3Input }): Promise<StorageConfig>;
    /** Starts (or resumes) copying existing files to the bucket. */
    migrate(orgId: string): Promise<StorageMigration>;
    migration(orgId: string): Promise<StorageMigration | null>;
  };
  invites: {
    /** Org-wide link: whoever joins with it becomes a member (7 days). */
    createLink(orgId: string): Promise<{ url: string; expiresAt: string }>;
    /** Expired invitation: ask the inviter for a new one. */
    requestNew(token: string): Promise<void>;
  };
}

/** Everything is served by the HTTP backend (apps/server/src/routes/app). */
export type HttpApi = ApiClient;
