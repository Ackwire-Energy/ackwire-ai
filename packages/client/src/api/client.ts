import type { OnboardingStepId } from "../lib/onboarding";
import type {
  AccessInput,
  AccountDeletionPlan,
  AccountLoginStart,
  AccountLoginStatus,
  ActiveRun,
  Agent,
  AgentAccess,
  AgentAction,
  AgentBrain,
  AgentBrainInput,
  AgentBrowserSettings,
  AgentChannel,
  AgentComputer,
  AgentDatabase,
  AgentDatabaseInput,
  AgentDetail,
  AgentForYou,
  AgentGroup,
  AgentInput,
  AgentMailbox,
  AgentMailboxInput,
  AgentPlanUsage,
  AgentProposal,
  AgentQuestion,
  AgentSecret,
  AgentSetup,
  AgentSetupResult,
  AgentSkill,
  AgentStatus,
  AgentUsage,
  AiAccounts,
  AiStatus,
  ApiRule,
  AppNotification,
  Approval,
  ApprovalRule,
  Artifact,
  ArtifactContent,
  ArtifactDetail,
  ArtifactFilters,
  ArtifactVersion,
  AskToJoinResult,
  AuditPage,
  AuditQuery,
  AuthConfig,
  BatchInviteResult,
  BillingFrom,
  BrainKind,
  BrainMachine,
  BrowserHandoff,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarRange,
  Channel,
  ChannelCard,
  ChannelCategory,
  ChannelMember,
  CodeSent,
  CommandApproval,
  ComputerSetup,
  ComputerTarget,
  Connection,
  ConnectorCatalog,
  ConsultationConversation,
  Credential,
  CustomConnectStart,
  CustomServer,
  DatabaseActionName,
  DatabaseConnection,
  DatabaseConnectionInput,
  DatabaseTable,
  DeletionProofInput,
  DesktopRelease,
  DesktopStatus,
  DeviceRequest,
  DirectMessage,
  DmRead,
  DmTarget,
  FormerAgent,
  ForumParticipantsInput,
  ForumPost,
  ForumPostInput,
  ForumSuggestedIssue,
  ForumSuggestion,
  ForumSuggestionOverrides,
  ForumTopic,
  ForumTopicDetail,
  ForumTopicInput,
  GifKey,
  GifPage,
  GifQuery,
  GitHubAppInstallation,
  GitHubRepositories,
  Health,
  HostComputer,
  ImportedFile,
  ImportedSource,
  ImportFileInput,
  ImportInput,
  ImportPlan,
  Instance,
  Invitation,
  InvitationPreview,
  InvitationState,
  InvitationWithStatus,
  InviteBatch,
  InviteLink,
  Issue,
  IssueActivity,
  IssueColumn,
  IssueInput,
  IssuePatch,
  IssueStatus,
  JevKey,
  JoinApproval,
  JoinClaim,
  JoinRequest,
  Machine,
  MachineAccess,
  MachineAccessReduce,
  MachineAccount,
  MachineAccountKind,
  MachineOutages,
  MachineTask,
  MailAccount,
  MailAccountUpdate,
  MailFolder,
  MailImapInput,
  MailProviders,
  Me,
  Member,
  Memory,
  Message,
  MessagePin,
  Mission,
  MissionBrain,
  MissionCommand,
  MissionCommandRule,
  MissionControl,
  MissionCreateInput,
  MissionDecision,
  MissionDelivery,
  MissionEligibleAgent,
  MissionExecutor,
  MissionFiles,
  MissionJoinRequest,
  MissionList,
  MissionListQuery,
  MissionParticipantRole,
  MissionParticipants,
  MissionPlan,
  MissionReview,
  MissionSettings,
  MissionSummary,
  Model,
  ModelTier,
  MoveAgentsInput,
  MoveAgentsResult,
  MySuggestion,
  NewAgentSetup,
  NoticeCategory,
  NoticePrefs,
  NotificationCount,
  NotificationFilter,
  NotificationPage,
  Organization,
  OrgOverview,
  OrgPlanUsage,
  OrgRoles,
  OrgSettings,
  Person,
  PhoneSignIn,
  PostMedia,
  Proposal,
  PushDeviceInput,
  ReactionCount,
  ReadOnlyOrgSettings,
  Reminder,
  ReminderInput,
  Role,
  RoleInput,
  RosterMember,
  Routine,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  RuleInfo,
  Run,
  RunConsultation,
  RunStep,
  S3Input,
  SandboxSettings,
  SandboxSettingsInput,
  ScheduleParse,
  ScopeGrant,
  ScreenKind,
  SearchHit,
  SearchKind,
  SecretBox,
  SecretRequest,
  SeriesScope,
  ServerTelemetry,
  SidebarItem,
  SidebarItems,
  SidebarPlace,
  SignInOptions,
  Skill,
  SkillDetail,
  SkillInput,
  SkillPatch,
  SkillPick,
  StatusInput,
  StorageConfig,
  StorageMigration,
  StorageTestResult,
  SuggestedAi,
  TaskOutput,
  Team,
  ThreadAction,
  ThreadCreateInput,
  ThreadFilters,
  ThreadFollow,
  ThreadInfo,
  ThreadPage,
  ThreadPatch,
  ToolDecision,
  TrashedArtifact,
  UndoAllResult,
  UsageReport,
  WikiGraph,
  WikiImportInput,
  WikiImportResult,
  WikiPage,
  WikiPageInput,
  WikiPageSummary,
  WikiTopRead,
  WikiUpdateInput,
  WikiVersion,
  WorkingRun,
  WorkspaceLimits,
} from "./types";

/**
 * Everything the web app asks the backend. `createApiClient` (./index.ts)
 * wires the HTTP implementation (./http-client.ts); tests pass a fake
 * (test/fake-api.ts). Components never call `fetch` directly.
 */
export interface ApiClient {
  system: {
    health(): Promise<Health>;
    instance(): Promise<Instance>;
    /** `null` unless I am the installation's owner (and not on agentes.chat itself). */
    telemetry(): Promise<ServerTelemetry | null>;
    setTelemetry(enabled: boolean): Promise<ServerTelemetry>;
    /** `null` unless I am the installation's owner on a self-hosted server. */
    jev(): Promise<JevKey | null>;
    /** Checked with TypeSafe first: `jev_key_invalid` (422) when it refuses, `jev_key_env` (409) with an env key. */
    saveJev(apiKey: string): Promise<JevKey>;
    checkJev(): Promise<JevKey>;
    removeJev(): Promise<JevKey>;
    /** The GIPHY key (ADR 0091): `null` unless I am the installation's owner on a self-hosted server. */
    gifKey(): Promise<GifKey | null>;
    /** Checked with GIPHY first: `gif_key_invalid` (422) when it refuses, `gif_key_env` (409) with an env key. */
    saveGifKey(apiKey: string): Promise<GifKey>;
    removeGifKey(): Promise<GifKey>;
  };
  account: {
    authConfig(): Promise<AuthConfig>;
    /**
     * Whether the e-mail has an account and how it signs in (rate limited: `rate_limited` 429). `access`: the
     * early-access link's token, when the page has one. `humanCheck`: the bot check's token, when the server has one
     * (`human_check` 403 without it).
     */
    signInOptions(input: { email: string; access?: string }, humanCheck?: string): Promise<SignInOptions>;
    /** `null` when signed out. */
    me(): Promise<Me | null>;
    /** My app language (emails and pushes are written in it). */
    updateMe(input: { locale: "pt-BR" | "en" }): Promise<void>;
    /** A one-time sign-in for the phone app, shown as a QR code. */
    phoneSignIn(): Promise<PhoneSignIn>;
    /**
     * A password for an account that has none (`password_set` 409 when it has one). `reauth.sign_in` (403) without a
     * sign-in in the last 10 minutes.
     */
    addPassword(password: string): Promise<void>;
    /** What deleting my account would close, leave and remove. */
    deletionPlan(): Promise<AccountDeletionPlan>;
    /**
     * Emails me the code that deleting my account takes (`reauth.code_wait` 429 with `retryIn` right after another,
     * `reauth.no_email` 409 on a server that sends none). `sole_owner` (409) while a workspace needs me.
     */
    deletionCode(): Promise<CodeSent>;
    /**
     * Deletes my account at once, with the emailed `code`, or `password` on a server that sends no email (`reauth.*`
     * when refused, 429 after 5 passwords). `sole_owner` (409, `params.orgIds`) while a workspace needs me.
     */
    delete(input?: DeletionProofInput): Promise<void>;
  };
  /** Where my pushes go: phones (ADR 0035) and browsers (ADR 0071). Per person, not per organization. */
  push: {
    /** The server's Web Push public key (base64url); `null` when this server has Web Push off (`web_push_off` 404). */
    webKey(): Promise<string | null>;
    /** Registers (or refreshes, or moves to me) a phone's token or a browser's subscription. Rate limited (429). */
    register(input: PushDeviceInput): Promise<void>;
    /**
     * Stops pushes to a phone's token or a browser's endpoint (only my own; anything else is a no-op). In the
     * body, not the path: an endpoint's encoded slashes don't survive every proxy.
     */
    unregister(token: string): Promise<void>;
    /**
     * Of these notification ids (at most 100), the ones no longer open and unread for me (read, done, snoozed or
     * gone): a browser closes the notifications it still shows for them (clear on read, ADR 0071).
     */
    stale(ids: string[]): Promise<string[]>;
  };
  orgs: {
    create(input: {
      name: string;
      context?: string;
    }): Promise<{ organization: Organization; generalChannelId: string }>;
    /**
     * Its owner's progress in setting it up: the furthest step reached (it only moves forward), or `finished`. Null
     * from a server that doesn't keep it.
     */
    saveOnboarding(
      orgId: string,
      input: { step: OnboardingStepId } | { finished: true },
    ): Promise<{ step: OnboardingStepId; finished: boolean } | null>;
    get(orgId: string): Promise<Organization>;
    update(orgId: string, input: { name?: string; context?: string }): Promise<void>;
    /** Owners: emails me the code that deleting this workspace takes (as `account.deletionCode`). */
    deletionCode(orgId: string): Promise<CodeSent>;
    /**
     * Owners: closes the workspace for everyone now and deletes it for good 7 days later (`dueAt`); already being
     * deleted, its date. Proof as `account.delete`'s; 429 after 3 deletions of it in a day.
     */
    deleteWorkspace(orgId: string, input?: DeletionProofInput): Promise<{ dueAt: string }>;
    /** Owners, before its date: it opens again. `org.not_restorable` (409) once the date passed. */
    restore(orgId: string): Promise<void>;
    /** My handle and time zone in this organization (`timezone: null` = the organization's). */
    updateMe(orgId: string, input: { handle?: string; timezone?: string | null }): Promise<Person>;
    /** Your availability (auto, busy, hidden) and what you are doing (ADR 0084). */
    setStatus(orgId: string, input: StatusInput): Promise<Person>;
    /** Where I put the tools at the top of my sidebar here (only the ones I moved). */
    sidebarItems(orgId: string): Promise<SidebarItems>;
    /** Moves one tool (`null`: back on its default), my others as the server has them. Answers with every choice. */
    setSidebarItem(orgId: string, item: SidebarItem, place: SidebarPlace | null): Promise<SidebarItems>;
    /** Replaces my choices (`{}`: every tool back on its default). */
    setSidebarItems(orgId: string, items: SidebarItems): Promise<SidebarItems>;
    /** My profile photo: a square image (JSON only: base64), already cropped. */
    setAvatar(orgId: string, input: { imageBase64: string; contentType: string }): Promise<{ avatarUrl: string }>;
    removeAvatar(orgId: string): Promise<void>;
    /** The workspace logo (admins): a square image (JSON only: base64), already cropped. */
    setLogo(orgId: string, input: { imageBase64: string; contentType: string }): Promise<{ logo: string }>;
    removeLogo(orgId: string): Promise<void>;
    /**
     * A signed link that opens the workspace's plan and billing on the billing service (owners and admins; ADR
     * 0079). Navigate to it at once and keep it nowhere else: it lasts 5 minutes and opens once. `billing.off` 404
     * on a server without billing.
     */
    billingLink(orgId: string, from: BillingFrom): Promise<{ url: string; expiresAt: string }>;
    /** People, files and today's uploads against the workspace's limits (any member; ADR 0079). */
    limits(orgId: string): Promise<WorkspaceLimits>;
    members(orgId: string): Promise<Member[]>;
    /** Makes a member an owner or not (owners only). What anyone may do is their roles (`roles.setFor`). */
    changeRole(orgId: string, userId: string, role: Role): Promise<void>;
    removeMember(orgId: string, userId: string): Promise<void>;
    invitations(orgId: string): Promise<Invitation[]>;
    invite(
      orgId: string,
      input: { email: string; role?: Role; roleIds?: string[] },
    ): Promise<{ invitation: Invitation; url: string }>;
    revokeInvitation(orgId: string, invitationId: string): Promise<void>;
    /** `null` when invalid or expired. */
    previewInvitation(token: string): Promise<InvitationPreview | null>;
    /** An email invitation that no longer opens: accepted or expired (ADR 0090); null for any other token. */
    invitationState(token: string): Promise<InvitationState | null>;
    /** `mail`: the proof on its own email's link (ADR 0090); accepted with it, the address counts as confirmed. */
    acceptInvitation(token: string, mail?: string): Promise<{ orgId: string }>;
    settings(orgId: string): Promise<OrgSettings>;
    updateSettings(
      orgId: string,
      input: Partial<Omit<OrgSettings, "name" | "autoModels" | ReadOnlyOrgSettings>> & {
        name?: string;
        /** Per provider and tier, one of its models; null puts the tier back on its default. */
        autoModels?: Partial<Record<string, Partial<Record<ModelTier, string | null>>>>;
      },
    ): Promise<OrgSettings>;
    overview(orgId: string): Promise<OrgOverview>;
    /** Members with presence. */
    people(orgId: string): Promise<Person[]>;
    /** Invitations not accepted yet, pending or expired. */
    allInvitations(orgId: string): Promise<InvitationWithStatus[]>;
    inviteMany(orgId: string, input: InviteBatch): Promise<BatchInviteResult[]>;
    /** The same link (ADR 0090; a new one for an invitation sent before that), 7 more days. */
    resendInvitation(orgId: string, invitationId: string): Promise<{ url: string; expiresAt: string }>;
    /** The roles a pending invitation gives (ADR 0090): the same link, nothing is sent. */
    setInvitationRoles(orgId: string, invitationId: string, roleIds: string[]): Promise<{ roleIds: string[] }>;
    usageReport(orgId: string, since?: string): Promise<UsageReport>;
    /** Every plan account by computer and the API per agent, this month (ADR 0063). */
    planUsage(orgId: string): Promise<OrgPlanUsage>;
    /** The audit log, newest first (admins): agents' tool calls and people's changes. `before`: `next`. */
    audit(orgId: string, query?: AuditQuery & { before?: string; limit?: number }): Promise<AuditPage>;
  };
  /** A workspace's roles (ADR 0085): every member reads them; who may manage roles changes those below theirs. */
  roles: {
    list(orgId: string): Promise<OrgRoles>;
    create(orgId: string, input: RoleInput): Promise<{ id: string }>;
    update(orgId: string, roleId: string, patch: Partial<RoleInput>): Promise<void>;
    remove(orgId: string, roleId: string): Promise<void>;
    /** Every role but `everyone`, top first. */
    reorder(orgId: string, ids: string[]): Promise<void>;
    /** A person's roles, exactly these. */
    setFor(orgId: string, userId: string, roleIds: string[]): Promise<{ roleIds: string[] }>;
  };
  /** Groups of agents (ADR 0083): everyone reads them, owners and admins change them; each change answers with all. */
  agentGroups: {
    list(orgId: string): Promise<AgentGroup[]>;
    /** After the other groups, with `agentIds` in it in that order (out of any group they were in). */
    create(orgId: string, input: { name: string; agentIds?: string[] }): Promise<AgentGroup[]>;
    /** Renames it, or moves it among the groups (`index`). */
    update(orgId: string, groupId: string, patch: { name?: string; index?: number }): Promise<AgentGroup[]>;
    /** Its agents go back to no group. */
    remove(orgId: string, groupId: string): Promise<AgentGroup[]>;
    /** Into a group at `index` among its agents (the end without one), or out of any (`groupId` null). */
    move(orgId: string, agentId: string, input: { groupId: string | null; index?: number }): Promise<AgentGroup[]>;
  };
  agents: {
    list(orgId: string): Promise<Agent[]>;
    /** Its month by account and day, and the account it thinks with now (ADR 0063). */
    planUsage(orgId: string, agentId: string): Promise<AgentPlanUsage>;
    /** The agents as a team: grouped by person, with who consulted whom in the last day. */
    team(orgId: string): Promise<Team>;
    create(orgId: string, input: AgentInput): Promise<Agent>;
    /** An agent's proposal of a new agent, by its card's message (ADR 0081). */
    proposal(orgId: string, messageId: string): Promise<AgentProposal>;
    /** "Criar" on the card: the agent as proposed, with each line the person may give it. */
    createProposed(
      orgId: string,
      messageId: string,
    ): Promise<{ agent: Agent; proposal: AgentProposal; ai: SuggestedAi["kind"] }>;
    /** The routine it came with, for the agent created from the review (once it is where it reports). */
    proposalRoutine(orgId: string, messageId: string): Promise<AgentProposal>;
    /** Says no to it (who may create agents): the card stays, marked denied. */
    denyProposal(orgId: string, messageId: string): Promise<AgentProposal>;
    update(orgId: string, agentId: string, input: Partial<AgentInput>): Promise<Agent>;
    archive(orgId: string, agentId: string): Promise<void>;
    /** Deletes it for good (ADR 0082): owners and admins, archived or not. */
    purge(orgId: string, agentId: string): Promise<void>;
    /** Agents no longer in the team (archived or deleted), for the names and faces of what they left. */
    former(orgId: string): Promise<FormerAgent[]>;
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
    /** Whether each agent has an AI to think with, and whether the organization has any (ADR 0061). */
    aiStatus(orgId: string): Promise<AiStatus>;
    /** Each agent's presence and what it says it is doing (ADR 0084). */
    statuses(orgId: string): Promise<AgentStatus[]>;
    /** The team file / agent definitions behind a GitHub link, read by the backend (onboarding import; nothing saved). */
    importFromGithub(
      orgId: string,
      url: string,
    ): Promise<{
      files: { path: string; text: string }[];
      /** Files the link has that fit the import but not the limits (200 files, 8 MB): not read. */
      skipped?: string[];
    }>;
    detail(orgId: string, agentId: string): Promise<AgentDetail>;
    channels(orgId: string, agentId: string): Promise<AgentChannel[]>;
    setChannels(
      orgId: string,
      agentId: string,
      channels: { channelId: string; autoReply?: boolean }[],
    ): Promise<AgentChannel[]>;
    /** "Quem pensa": the API, Claude Code or Codex on its computer (its owner or an admin). */
    brain(orgId: string, agentId: string): Promise<AgentBrain>;
    setBrain(orgId: string, agentId: string, input: AgentBrainInput): Promise<AgentBrain>;
    /** "Quem pensa" for an agent still being created: the workspace's computers and what each offers (admins). */
    brainMachines(orgId: string): Promise<BrainMachine[]>;
    /**
     * "Usar em outros agentes": the setup on each agent, by its own rules, one result each in the order asked; with
     * `preview`, what each would do and nothing kept.
     */
    applySetup(
      orgId: string,
      input: { setup: AgentSetup; agentIds: string[]; preview?: boolean },
    ): Promise<AgentSetupResult[]>;
    /** What a new agent starts thinking with (whoever creates agents); null: "Automático" on the API. */
    newAgentSetup(orgId: string): Promise<NewAgentSetup | null>;
    runs(
      orgId: string,
      filter?: { agentId?: string; status?: string; before?: string; since?: string; limit?: number },
    ): Promise<Run[]>;
    run(orgId: string, runId: string): Promise<{ run: Run; steps: RunStep[] }>;
    /** "Parar": stops a run (the person who started it, the agent's owner, admins). */
    cancelRun(orgId: string, runId: string): Promise<void>;
    /**
     * "Continuar" under a reply a person stopped (same people as `cancelRun`): a new run picks up
     * where it stopped. 409 `run.not_continuable` (already continued, not stopped by a person) or
     * `run.agent_busy` (the agent already works in that conversation).
     */
    continueRun(orgId: string, runId: string): Promise<{ runId: string }>;
    /** Runs still active in a channel (reconciles the live rows); `null` while the server lacks the endpoint. */
    activeRuns(orgId: string, channelId: string): Promise<ActiveRun[] | null>;
    /** The questions agents asked other agents from a conversation, latest first; `[]` while the server lacks it. */
    consultations(orgId: string, channelId: string): Promise<RunConsultation[]>;
    /** One of those questions opened: what the two agents said for it (read only); `null` once it's gone. */
    consultation(orgId: string, channelId: string, consultationId: string): Promise<ConsultationConversation | null>;
    /** This month's usage per agent; `null` without the `view_usage` permission. */
    usage(orgId: string): Promise<AgentUsage[] | null>;
  };
  /** Bringing agents and what's around them from another app or another agentes.chat (ADR 0055); admins. */
  imports: {
    /** The plan of a bundle (`dryRun`), or the picked items applied: either way every item with its action. */
    apply(orgId: string, input: ImportInput): Promise<ImportPlan>;
    /** What this workspace brought from other apps, by source package (admins). */
    sources(orgId: string): Promise<ImportedSource[]>;
    /**
     * One of an imported agent's files into its folder in the Drive (multipart, ≤ 50 MB). A name already in the
     * folder is never overwritten (`exists`); a credential store is refused (`import.secret_file`).
     */
    copyFile(orgId: string, input: ImportFileInput): Promise<ImportedFile>;
    /** Same-origin URL that downloads this workspace as a bundle (`.json`). */
    exportUrl(orgId: string): string;
  };
  chat: {
    channels(orgId: string): Promise<Channel[]>;
    createChannel(
      orgId: string,
      input: { name: string; topic?: string; visibility?: "public" | "private"; categoryId?: string | null },
    ): Promise<Channel>;
    /** The sidebar's categories, in order (ADR 0080). */
    categories(orgId: string): Promise<ChannelCategory[]>;
    /** Admins: a category at the end, optionally taking `channelIds` along. */
    createCategory(orgId: string, input: { name: string; channelIds?: string[] }): Promise<ChannelCategory>;
    renameCategory(orgId: string, categoryId: string, name: string): Promise<ChannelCategory>;
    /** Its channels go on top, with no category. */
    deleteCategory(orgId: string, categoryId: string): Promise<void>;
    /** Before `beforeCategoryId`, or to the end (null). */
    placeCategory(orgId: string, categoryId: string, beforeCategoryId: string | null): Promise<void>;
    /** Into `categoryId` (null: none), before `beforeChannelId` or at the end. */
    place(
      orgId: string,
      channelId: string,
      input: { categoryId: string | null; beforeChannelId?: string | null },
    ): Promise<void>;
    join(orgId: string, channelId: string): Promise<void>;
    /** A `#channel` link's card; 404 for a channel I can't see (private and not mine). Archived ones too. */
    card(orgId: string, channelId: string): Promise<ChannelCard>;
    update(
      orgId: string,
      channelId: string,
      input: { name?: string; topic?: string; visibility?: "public" | "private" },
    ): Promise<Channel>;
    /** Creator or admin: the channel leaves everyone's list (its messages are kept). */
    archive(orgId: string, channelId: string): Promise<void>;
    /** "Desfazer" right after archiving. */
    unarchive(orgId: string, channelId: string): Promise<void>;
    /** Members with names; agents carry `autoReply`. */
    roster(orgId: string, channelId: string): Promise<RosterMember[]>;
    members(orgId: string, channelId: string): Promise<ChannelMember[]>;
    addMember(orgId: string, channelId: string, member: { userId: string } | { agentId: string }): Promise<void>;
    removeMember(orgId: string, channelId: string, member: { userId: string } | { agentId: string }): Promise<void>;
    /** "Quando responde" for an agent in this channel (its creator, an admin or the agent's owner). */
    setAutoReply(orgId: string, channelId: string, agentId: string, autoReply: boolean): Promise<void>;
    messages(
      orgId: string,
      channelId: string,
      options?: { threadId?: string; before?: string; limit?: number },
    ): Promise<Message[]>;
    post(
      orgId: string,
      channelId: string,
      input: {
        body: string;
        threadId?: string | null;
        clientId?: string;
        /** Quote reply: the message this one answers (the server stores `meta.replyTo`). */
        replyTo?: string;
        /** Uploaded files (artifact ids): the server stores `meta.artifacts`. */
        attachments?: string[];
        /** Sent from the thread panel ("Responder"), with `threadId`: the thread gets `openedByReplyAt`. */
        openThread?: boolean;
        /** "Parar e mandar": an agent working here stops its current step and reads this now. */
        steer?: "now";
        /**
         * A GIF or a sticker (ADR 0091): `body` may then be empty. The server stores `meta.media`. 422
         * `message.media_off` (GIFs or stickers off here) or `message.media_not_found`.
         */
        media?: PostMedia;
      },
    ): Promise<Message>;
    reactions(orgId: string, messageId: string): Promise<ReactionCount[]>;
    react(orgId: string, messageId: string, reaction: string): Promise<ReactionCount[]>;
    unreact(orgId: string, messageId: string, reaction: string): Promise<ReactionCount[]>;
    /** Corrects an agent's reply: it becomes a lesson for that agent. */
    correct(orgId: string, messageId: string, body: string): Promise<void>;
    /**
     * "Responder agora" once an AI is connected: the agent answers what it couldn't. `messageId` is its
     * no-AI card or the person's message. 409 `ai.still_missing` while there's still no AI.
     */
    answerNow(orgId: string, messageId: string): Promise<{ runs: { agentId: string; runId: string }[] }>;
    /** Cancels an agent's follow-up from its line (`messageId`); 409 `follow_up.not_pending` once it came. */
    cancelFollowUp(orgId: string, messageId: string): Promise<void>;
  };

  approvals: {
    list(orgId: string, filter?: { status?: "pending" | "decided"; agentId?: string }): Promise<Approval[]>;
    get(orgId: string, approvalId: string): Promise<Approval>;
    /** `always`: also approve this kind for good (409 `approval.always_unavailable` where it isn't offered). */
    approve(orgId: string, approvalId: string, reason?: string, always?: boolean): Promise<Approval>;
    refuse(orgId: string, approvalId: string, reason?: string): Promise<Approval>;
    /** What the agent runs without asking ("Aprovar sempre"), oldest first. */
    rules(orgId: string, agentId: string): Promise<ApprovalRule[]>;
    /** The agent asks again for that kind (admins and the agent's owner). */
    removeRule(orgId: string, agentId: string, ruleId: string): Promise<void>;
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
    /**
     * The phone app (`returnTo: APP_OAUTH_RETURN`) or the desktop app's window (`desktop:` + a path) finishes an
     * authorization it started with the `state` and `code` the callback handed back to it. `returnTo`: the path
     * a desktop authorization lands on.
     */
    completeOAuth(
      orgId: string,
      input: { state: string; code: string },
    ): Promise<{ connectionId: string; connector: string; returnTo?: string }>;
    disconnect(orgId: string, connectionId: string): Promise<void>;
  };
  githubApp: {
    /** Whether this server can install the GitHub App, and the organization's installations. */
    info(orgId: string): Promise<{ installable: boolean; installations: GitHubAppInstallation[] }>;
    /** Returns GitHub's install URL; GitHub sends the person back to `returnTo`. */
    install(orgId: string, returnTo: string): Promise<string>;
    /** Unbinds an installation (it stays installed on GitHub). */
    remove(orgId: string, id: string): Promise<void>;
    /** Repositories the organization's GitHub reaches, by account. */
    repositories(orgId: string): Promise<GitHubRepositories>;
  };
  search: {
    query(orgId: string, input: { q: string; kinds?: SearchKind[]; limit?: number }): Promise<SearchHit[]>;
  };
  sandbox: {
    settings(orgId: string): Promise<SandboxSettings>;
    saveSettings(orgId: string, input: SandboxSettingsInput): Promise<SandboxSettings>;
    /** Which computer the agent uses. */
    computer(orgId: string, agentId: string): Promise<AgentComputer>;
    /** Which computer the agent uses: a connected machine, or `null` for none. */
    setTarget(orgId: string, agentId: string, machineId: string | null): Promise<ComputerTarget>;
  };
  /** Connected computers (ADR 0025): machines running `agentes-runner`. */
  machines: {
    list(orgId: string): Promise<Machine[]>;
    rename(orgId: string, machineId: string, name: string): Promise<{ id: string; name: string }>;
    /** Revokes its token and disconnects the runner at once; agents on it are left with no computer. */
    remove(orgId: string, machineId: string): Promise<void>;
    /** The server's own computer in this organization; null when the server has none or doesn't serve it. */
    host(orgId: string): Promise<HostComputer | null>;
    /** Uses the server's computer again (admins); `remove` is how it stops. */
    hostOn(orgId: string): Promise<HostComputer>;
    /** ADR 0056 §10: whether the workspace gets its own computer, and how far it is (every member). */
    computerSetup(orgId: string): Promise<ComputerSetup>;
    /**
     * ADR 0036 §5, the device flow: the computer made the code; the person sees it here
     * (`machine.device_not_found` once expired, used or unknown).
     */
    device(userCode: string): Promise<DeviceRequest>;
    /** Connects it to the organization (201, the new machine). */
    confirmDevice(orgId: string, userCode: string, input: { name?: string }): Promise<Machine>;
    /** "Não fui eu": the computer gets `access_denied`. */
    denyDevice(userCode: string): Promise<void>;
    /** ADR 0036 §8: the site only takes away (a folder, for everyone or one agent; a tool). The new access. */
    reduceAccess(orgId: string, machineId: string, input: MachineAccessReduce): Promise<MachineAccess>;
    /** ADR 0036 §9: the newest desktop app build; `null` when there is none (404). */
    desktopLatest(target: string, arch: string): Promise<DesktopRelease | null>;
    /** Offline computers that agents wait for, and where they could move. */
    outages(orgId: string): Promise<MachineOutages>;
    /** Moves waiting agents off an offline computer (their waiting runs follow where they can). */
    moveAgents(orgId: string, machineId: string, input: MoveAgentsInput): Promise<MoveAgentsResult>;
    /**
     * ADR 0041 §2: the computer starts the provider's own sign-in. `accountId`: sign in again to that account
     * of the viewer's; `email` (Claude): which account, as the CLI's hint; `provider`: a coding plan's key.
     */
    beginAccountLogin(
      orgId: string,
      machineId: string,
      kind: MachineAccountKind,
      options?: { accountId?: string; email?: string; provider?: string },
    ): Promise<AccountLoginStart>;
    /** Claude Code: the code Claude showed (or a plan's key), sealed in the browser to the computer's key (`sealSecret`). */
    sendAccountCode(orgId: string, machineId: string, loginId: string, box: SecretBox): Promise<void>;
    accountLogin(orgId: string, machineId: string, loginId: string): Promise<AccountLoginStatus>;
    /** Gives up on a sign-in (Voltar, the dialog closed): the computer stops it. */
    cancelAccountLogin(orgId: string, machineId: string, loginId: string): Promise<void>;
    /** An accounts screen opened: the viewer's plans look their usage up again (it arrives as `machine.updated`). */
    refreshAccountUsage(orgId: string): Promise<void>;
    /** "Contas de IA": the viewer's accounts on every computer, and where they can add one. */
    aiAccounts(orgId: string): Promise<AiAccounts>;
    /** Its owner names it (1 to 40 characters). */
    renameAccount(orgId: string, machineId: string, accountId: string, label: string): Promise<MachineAccount>;
    /** Its owner (or whoever connected the computer) disconnects it; the computer signs it out and deletes it. */
    removeAccount(orgId: string, machineId: string, accountId: string): Promise<void>;
  };
  skills: {
    /** The org library. */
    list(orgId: string): Promise<Skill[]>;
    get(orgId: string, id: string): Promise<SkillDetail>;
    /** "Escrever". */
    create(orgId: string, input: SkillInput): Promise<SkillDetail>;
    /**
     * A GitHub link (a skill's folder or a file in it) or the folder as a zip in base64 (writes are JSON only). A link
     * holding several skills installs nothing and answers with them to pick from (`importPicked`), those that can't
     * be installed apart.
     */
    import(orgId: string, input: { url: string } | { zipBase64: string }): Promise<SkillDetail | SkillPick>;
    /** Installs the skills picked among a link's choices (their `path`). */
    importPicked(orgId: string, url: string, paths: string[]): Promise<SkillDetail[]>;
    update(orgId: string, id: string, patch: SkillPatch): Promise<SkillDetail>;
    /** Fetch the link again (`url` skills). */
    reimport(orgId: string, id: string): Promise<SkillDetail>;
    remove(orgId: string, id: string): Promise<void>;
    /** Every library skill with `enabled` for this agent. */
    forAgent(orgId: string, agentId: string): Promise<AgentSkill[]>;
    setForAgent(orgId: string, agentId: string, skills: { skillId: string; enabled: boolean }[]): Promise<AgentSkill[]>;
  };
  access: {
    /** The agent's tool tree with each node's state. 404 while the backend doesn't have it. */
    get(orgId: string, agentId: string): Promise<AgentAccess>;
    set(orgId: string, agentId: string, input: AccessInput): Promise<AgentAccess>;
  };
  /** The GitHub repositories an agent may use, in order (`owner/name` or `owner/*`); empty = every repository. */
  repositories: {
    get(orgId: string, agentId: string): Promise<string[]>;
    set(orgId: string, agentId: string, repositories: string[]): Promise<string[]>;
  };
  scopes: {
    get(orgId: string, agentId: string): Promise<ScopeGrant[]>;
    set(orgId: string, agentId: string, grants: ScopeGrant[]): Promise<ScopeGrant[]>;
  };

  memory: {
    /** `about: "me"`: only what came from the viewer, each with `from` (the message). */
    list(orgId: string, agentId: string, filter?: { about?: "me" }): Promise<Memory[]>;
    edit(orgId: string, memoryId: string, text: string): Promise<Memory>;
    setPinned(orgId: string, memoryId: string, pinned: boolean): Promise<Memory>;
    setArchived(orgId: string, memoryId: string, archived: boolean): Promise<Memory>;
    /** Undoes a change the agent made from the chat (`update.undo.path`). */
    revert(orgId: string, memoryId: string): Promise<void>;
  };
  proposals: {
    /** The newest 200, pending ones first; with `ids`, only those (a chat card's rows). */
    list(orgId: string, filter?: { ids?: string[] }): Promise<Proposal[]>;
    accept(orgId: string, proposalId: string, finalText?: string): Promise<Proposal>;
    refuse(orgId: string, proposalId: string): Promise<Proposal>;
  };
  customConnectors: {
    list(orgId: string): Promise<CustomServer[]>;
    /**
     * Connects to an https MCP server. Without `apiKey` the server tries OAuth
     * (discovery + dynamic client registration); if the MCP server doesn't
     * support it, answers `needs_key` (`reason: "not_approved"` when it only
     * registers apps it approved).
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
      input: { label: string; tools: { name: string; access: ToolDecision; label: string; confirmed?: boolean }[] },
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
    /** Where the other people of a DM stopped reading ("Visto"); empty for any other channel. */
    reads(orgId: string, channelId: string): Promise<DmRead[]>;
  };
  questions: {
    /** Answers an agent's question with a choice or free text. */
    answer(orgId: string, questionId: string, input: { choice?: string; text?: string }): Promise<AgentQuestion>;
  };
  /** Secrets agents ask for (ADR 0027): only the person asked answers; the value goes sealed. */
  secrets: {
    deliver(orgId: string, requestId: string, box: SecretBox): Promise<SecretRequest>;
    decline(orgId: string, requestId: string): Promise<SecretRequest>;
    /** Names on the agent's computers (its owner or an admin). */
    list(orgId: string, agentId: string): Promise<AgentSecret[]>;
    remove(orgId: string, agentId: string, name: string, machineId: string | null): Promise<void>;
  };
  issues: {
    list(orgId: string, filters?: { q?: string }): Promise<Issue[]>;
    get(orgId: string, number: number): Promise<Issue>;
    create(orgId: string, input: IssueInput): Promise<Issue>;
    update(orgId: string, id: string, patch: IssuePatch): Promise<Issue>;
    setCriterion(orgId: string, id: string, criterionId: string, done: boolean): Promise<Issue>;
    activity(orgId: string, id: string): Promise<IssueActivity[]>;
    comment(orgId: string, id: string, text: string, attachmentIds?: string[]): Promise<IssueActivity>;
    /** "Pedir à Ada para implementar": assigns the agent and starts a run on the issue. */
    askAgent(orgId: string, id: string, agentId: string): Promise<Issue>;
    /** The board's columns, board order: by stage, then position. */
    columns(orgId: string): Promise<IssueColumn[]>;
    /** Adds a column to a stage (after `afterId` when it is in the same stage, else at the stage's end). */
    addColumn(
      orgId: string,
      input: { name: string; stage: IssueStatus; afterId?: string | null },
    ): Promise<IssueColumn[]>;
    /** Renames a column, or moves it inside its stage (`index`). */
    updateColumn(orgId: string, columnId: string, patch: { name?: string; index?: number }): Promise<IssueColumn[]>;
    /** Deletes a column; its tasks go to `moveTo`. A stage keeps at least one column. */
    deleteColumn(orgId: string, columnId: string, moveTo: string): Promise<IssueColumn[]>;
  };
  /** Threads (ADR 0029): the Threads page, a thread from a range, moving it, closing and archiving. */
  threads: {
    /** Threads you can see, most recent activity first (archived only with `tab: "archived"`). */
    list(orgId: string, filters?: ThreadFilters): Promise<ThreadPage>;
    /** A channel's threads (its "Threads (N)"). */
    inChannel(orgId: string, channelId: string, filters?: Omit<ThreadFilters, "channelId">): Promise<ThreadPage>;
    get(orgId: string, threadId: string): Promise<ThreadInfo>;
    /** "Criar thread a partir daqui": the range is its context; nothing moves. */
    create(orgId: string, input: ThreadCreateInput): Promise<ThreadInfo>;
    /** Rename, or change the range ("Ajustar trecho"). */
    update(orgId: string, threadId: string, patch: ThreadPatch): Promise<ThreadInfo>;
    /** Undo a thread made from a range, while nobody replied (`thread.has_replies`). */
    remove(orgId: string, threadId: string): Promise<void>;
    /** Tirar do canal / Devolver ao canal / Fechar / Reabrir / Arquivar / Desarquivar. */
    act(orgId: string, threadId: string, action: ThreadAction): Promise<ThreadInfo>;
  };
  /** Missions (ADR 0029): long work by the agent's executor on a connected computer, in one thread. */
  missions: {
    /** Missions you can see (the Missões tab), most recently changed first, with the counts for the tabs. */
    list(orgId: string, query?: MissionListQuery): Promise<MissionList>;
    /** "Nova missão": agents that can run a mission for you. */
    eligibleAgents(orgId: string): Promise<MissionEligibleAgent[]>;
    /** "Ver saída": the last lines of a background task. */
    taskOutput(orgId: string, taskId: string, tail?: number): Promise<TaskOutput>;
    /** Pending requests to join (all for whoever answers them; else your own). */
    joinRequests(orgId: string, missionId: string): Promise<MissionJoinRequest[]>;
    /** "Pedir para participar". */
    requestJoin(orgId: string, missionId: string): Promise<MissionJoinRequest>;
    /** Aceitar (with a role) or Recusar. */
    decideJoin(
      orgId: string,
      missionId: string,
      userId: string,
      outcome: "accept" | "decline",
      role?: MissionParticipantRole,
    ): Promise<MissionJoinRequest>;
    /** `/mission <goal>` and "Nova missão": the executor plans it; a plan card follows. */
    create(orgId: string, input: MissionCreateInput): Promise<Mission>;
    get(orgId: string, missionId: string): Promise<Mission>;
    /** The mission of a thread (`mission.not_found` when it has none). */
    ofThread(orgId: string, threadId: string): Promise<Mission>;
    /** The background tasks of a thread, newest first (`machine.task` keeps them live). */
    threadTasks(orgId: string, threadId: string): Promise<MachineTask[]>;
    /** Começar (owner only), `/pause`, resume, `/stop` (cancels its running tasks and pauses). */
    control(orgId: string, missionId: string, action: MissionControl): Promise<Mission & { canceledTasks?: number }>;
    close(
      orgId: string,
      missionId: string,
      input: { outcome: "done" | "canceled"; saveToWiki?: boolean; note?: string; deleteBranch?: boolean },
    ): Promise<Mission>;
    /** "Tentar de novo" after preparing the mission's copy of the project failed. */
    retryWorktree(orgId: string, missionId: string): Promise<Mission>;
    /** "Mudar algo": to the executor's main session (queued when it can't hear now). */
    message(orgId: string, missionId: string, text: string): Promise<{ delivered: boolean; taskId?: string }>;
    participants(orgId: string, missionId: string): Promise<MissionParticipants>;
    setParticipant(
      orgId: string,
      missionId: string,
      userId: string,
      role: MissionParticipantRole,
      existing?: boolean,
    ): Promise<MissionParticipants>;
    removeParticipant(orgId: string, missionId: string, userId: string): Promise<void>;
    /** Hand it over; the computer doesn't move (`code: mission.needs_computer` when it pauses). */
    transfer(
      orgId: string,
      missionId: string,
      input: { userId: string; lendMachine?: boolean },
    ): Promise<Mission & { code?: string }>;
    /** Its owner points it at a computer they paired (new sessions start from the mission files). */
    setMachine(orgId: string, missionId: string, machineId: string, repoDir?: string): Promise<Mission>;
    /** Before Start, its owner switches who programs (the planning starts again). */
    setExecutor(orgId: string, missionId: string, executor: MissionExecutor): Promise<Mission>;
    /** Autonomia (owner or deciders; Revogar sets always). */
    setCommandApproval(
      orgId: string,
      missionId: string,
      commandApproval: CommandApproval,
    ): Promise<{ commandApproval: CommandApproval }>;
    /** "Configurações da missão": the allowed rules, the command stats, the agent's default. */
    settings(orgId: string, missionId: string): Promise<MissionSettings>;
    /** "Quem faz o trabalho": the brain and its model (the brain before Start, the model any time). */
    brain(orgId: string, missionId: string): Promise<MissionBrain>;
    setBrain(
      orgId: string,
      missionId: string,
      input: { brain?: BrainKind | null; model?: string | null },
    ): Promise<MissionBrain>;
    /** The × in "O que já foi liberado" (owner or deciders). */
    removeCommandRule(orgId: string, missionId: string, ruleId: string): Promise<{ rules: MissionCommandRule[] }>;
    /** "Retomar sozinho quando ele voltar" (owner or deciders). */
    setResumeTasks(orgId: string, missionId: string, resumeTasks: boolean): Promise<Mission>;
    /** "Usar como padrão": the autonomy the agent's next missions start with (its owner or an admin). */
    setAgentDefault(
      orgId: string,
      agentId: string,
      commandApproval: CommandApproval,
    ): Promise<{ commandApproval: CommandApproval }>;
    decisions(orgId: string, missionId: string): Promise<MissionDecision[]>;
    /** Commands the executor asked to run (its permission prompts), and the ones allowed for the whole mission. */
    commands(orgId: string, missionId: string): Promise<{ commands: MissionCommand[]; rules: string[] }>;
    /** Aprovar / Recusar / Aprovar sempre nesta missão. */
    decideCommand(
      orgId: string,
      missionId: string,
      commandId: string,
      decision: "allow" | "deny" | "always",
    ): Promise<MissionCommand>;
    /** "Liberar e continuar": allow the commands a task was refused (one or several) and resume it once. */
    retryCommand(
      orgId: string,
      missionId: string,
      input: { taskId: string; command?: string; commands?: string[] },
    ): Promise<{ rules: string[]; delivered: boolean }>;
    /** Delivery cards, newest first. */
    deliveries(orgId: string, missionId: string): Promise<MissionDelivery[]>;
    /** "O que conferir": my own check of one item. */
    checkDelivery(
      orgId: string,
      missionId: string,
      deliveryId: string,
      itemId: string,
      checked: boolean,
    ): Promise<MissionDelivery>;
    /** "Concluir missão" (closes it as done; optionally the wiki page of decisions and lessons). */
    acceptDelivery(
      orgId: string,
      missionId: string,
      deliveryId: string,
      input: { saveToWiki?: boolean },
    ): Promise<Mission>;
    /** "Pedir ajustes": the note goes to the mission's main session; the mission is active again. */
    requestDeliveryChanges(orgId: string, missionId: string, deliveryId: string, note: string): Promise<Mission>;
    choose(orgId: string, missionId: string, decisionId: string, option: string): Promise<MissionDecision>;
    opinion(orgId: string, missionId: string, decisionId: string, option: string): Promise<MissionDecision>;
    approveProvisional(orgId: string, missionId: string): Promise<MissionDecision[]>;
    reviews(orgId: string, missionId: string): Promise<MissionReview[]>;
    review(
      orgId: string,
      missionId: string,
      reviewId: string,
      outcome: "approve" | "changes",
      note?: string,
    ): Promise<MissionReview>;
    suggestion(
      orgId: string,
      missionId: string,
      messageId: string,
      outcome: "accept" | "decline",
    ): Promise<{ messageId: string; status: "accepted" | "declined" }>;
    files(orgId: string, missionId: string): Promise<MissionFiles>;
    summary(orgId: string, missionId: string): Promise<MissionSummary>;
    plan(orgId: string, missionId: string): Promise<MissionPlan>;
  };
  routines: {
    list(orgId: string): Promise<Routine[]>;
    /** `timezone`: IANA zone to read the phrase in (default: the person's own, then the org's). */
    parseSchedule(orgId: string, phrase: string, timezone?: string): Promise<ScheduleParse>;
    create(orgId: string, input: RoutineInput): Promise<Routine>;
    setActive(orgId: string, id: string, active: boolean): Promise<Routine>;
    runNow(orgId: string, id: string): Promise<Routine>;
    /** Stops the run in progress quietly (it ends `canceled`, `stopped` by me). */
    stop(orgId: string, id: string): Promise<Routine>;
    /** An admin or the agent's owner becomes its creator (a routine paused because its creator left). */
    takeOver(orgId: string, id: string): Promise<Routine>;
    runs(orgId: string, id: string): Promise<RoutineRun[]>;
    /** A phrase → rule, its description, cron and next 5 runs. */
    parseRule(orgId: string, phrase: string, timezone?: string): Promise<RuleInfo>;
    /** A rule → its description, cron and next 5 runs (the picker's sentence). */
    describeRule(orgId: string, rule: ApiRule): Promise<RuleInfo>;
    /** Only the changed fields; the answer has the new `nextRunAt`. */
    update(orgId: string, id: string, patch: RoutinePatch): Promise<Routine>;
    /** Soft delete: it stops running and leaves the list. */
    remove(orgId: string, id: string): Promise<void>;
    /** `name`: the copy's name in the UI language. */
    duplicate(orgId: string, id: string, name?: string): Promise<Routine>;
  };
  /** The org wiki: pages in folders, `[[links]]`, backlinks, history and the graph. */
  wiki: {
    /** Every page (no bodies), for the tree, tags and recents. */
    tree(orgId: string): Promise<WikiPageSummary[]>;
    get(orgId: string, slug: string): Promise<WikiPage>;
    /** Title prefix search (the `[[` autocomplete, ⌘K). */
    search(orgId: string, q: string): Promise<WikiPageSummary[]>;
    create(orgId: string, input: WikiPageInput): Promise<WikiPage>;
    update(orgId: string, slug: string, input: WikiUpdateInput): Promise<WikiPage>;
    /** New title (and slug); links to it follow. */
    rename(orgId: string, slug: string, title: string): Promise<WikiPage>;
    history(orgId: string, slug: string): Promise<WikiVersion[]>;
    version(orgId: string, slug: string, version: number): Promise<{ version: number; body: string }>;
    graph(orgId: string): Promise<WikiGraph>;
    /** Moves a page to another folder ("" = the root). */
    move(orgId: string, slug: string, folder: string): Promise<WikiPage>;
    /** Admins: only admins edit a locked page. */
    lock(orgId: string, slug: string, locked: boolean): Promise<WikiPage>;
    /** "Fixadas": at the top of the wiki for everyone. */
    pin(orgId: string, slug: string, pinned: boolean): Promise<WikiPage>;
    /** To the trash (the server can restore it). */
    remove(orgId: string, slug: string): Promise<void>;
    /** What the agents read most in the last 7 days. */
    reads(orgId: string): Promise<WikiTopRead[]>;
    /** Notes of an Obsidian vault (≤ 500 per call; the app batches). */
    import(orgId: string, input: WikiImportInput): Promise<WikiImportResult>;
    /** Appends a block (e.g. a chat message) with a link back to where it came from. */
    append(
      orgId: string,
      slug: string,
      input: {
        text: string;
        source: { kind: "message"; channelId: string; messageId: string } | { kind: "forum"; topicId: string };
      },
    ): Promise<WikiPage>;
  };
  /** The forum: agents (and seated people) discuss a question in rounds and end with a synthesis. */
  forum: {
    list(orgId: string): Promise<ForumTopic[]>;
    get(orgId: string, topicId: string): Promise<ForumTopicDetail>;
    create(orgId: string, input: ForumTopicInput): Promise<ForumTopicDetail>;
    /** A person's post: their seated turn, or it leads the next round; `requestRound` asks for one more. */
    post(orgId: string, topicId: string, input: ForumPostInput): Promise<ForumPost>;
    /** No more turns; the synthesis is written next. */
    conclude(orgId: string, topicId: string): Promise<ForumTopicDetail>;
    cancel(orgId: string, topicId: string): Promise<ForumTopicDetail>;
    /** "Passar a vez": my seated turn goes by. */
    pass(orgId: string, topicId: string): Promise<ForumTopicDetail>;
    /** "Retomar": a stalled topic starts the stopped turn again. */
    resume(orgId: string, topicId: string): Promise<ForumTopicDetail>;
    participants(orgId: string, topicId: string, input: ForumParticipantsInput): Promise<ForumTopicDetail>;
    /** Creates the approved suggested issues (sub-issues of the origin issue, when there is one). */
    createIssues(
      orgId: string,
      topicId: string,
      items: ForumSuggestedIssue[],
    ): Promise<{ numbers: number[]; issues: { id: string; number: number; title: string }[] }>;
    /** "Abrir fórum" on an agent's suggestion (the card's message); it is mine. */
    acceptSuggestion(
      orgId: string,
      messageId: string,
      overrides?: ForumSuggestionOverrides,
    ): Promise<{ topic: ForumTopicDetail; suggestion: ForumSuggestion }>;
    /** "Agora não": the card stays, marked dismissed. */
    dismissSuggestion(orgId: string, messageId: string): Promise<{ suggestion: ForumSuggestion }>;
  };
  /** My inbox in this organization: mentions, replies, what waits on me. */
  notifications: {
    /** Visible ones (not done, not snoozed), waiting first, then the newest; counts for every filter. */
    list(
      orgId: string,
      query?: { filter?: NotificationFilter; cursor?: string; limit?: number },
    ): Promise<NotificationPage>;
    /** The sidebar badge. */
    count(orgId: string): Promise<NotificationCount>;
    read(orgId: string, id: string, read: boolean): Promise<AppNotification>;
    /** "Feito" (`false` undoes it). */
    done(orgId: string, id: string, done: boolean): Promise<AppNotification>;
    /** "Lembrar depois": hidden until `until` (ISO). */
    /** `until: null` ends a snooze early (undo). */
    snooze(orgId: string, id: string, until: string | null): Promise<AppNotification>;
    /** "Marcar tudo como lido": the ids it changed (undo marks them unread again). */
    readAll(orgId: string, filter?: NotificationFilter): Promise<{ ids: string[] }>;
    /** What reaches my devices as a notification in this workspace (ADR 0071 §8). */
    prefs(orgId: string): Promise<NoticePrefs>;
    setPref(orgId: string, category: NoticeCategory, on: boolean): Promise<NoticePrefs>;
  };
  calendar: {
    /** Events, routine runs, issue deadlines and proposals between `from` and `to` (ISO). */
    range(orgId: string, from: string, to: string): Promise<CalendarRange>;
    create(orgId: string, input: CalendarEventInput): Promise<CalendarEvent>;
    /** Confirms an agent's proposal: creates the event and invites the people. */
    confirmProposal(orgId: string, id: string): Promise<CalendarEvent>;
    dismissProposal(orgId: string, id: string): Promise<void>;
    /** A recurring event: `scope` and the occurrence's original start say which occurrences change. */
    update(
      orgId: string,
      id: string,
      patch: CalendarEventPatch,
      series?: { scope: SeriesScope; occurrenceStart: string },
    ): Promise<CalendarEvent>;
    remove(orgId: string, id: string, series?: { scope: SeriesScope; occurrenceStart: string }): Promise<void>;
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
    fileUrl(
      orgId: string,
      id: string,
      options?: { version?: number; format?: "csv" | "patch" | "pdf" | "docx" },
    ): string;
    create(
      orgId: string,
      input: { title: string; channelId?: string | null; content: ArtifactContent },
    ): Promise<ArtifactDetail>;
    /** Uploads a file as is (multipart, ≤ 50 MB) to the Drive or to a channel. */
    upload(
      orgId: string,
      file: File,
      options?: { title?: string; channelId?: string | null; threadId?: string | null },
    ): Promise<ArtifactDetail>;
    /** A new version of an uploaded file (multipart, ≤ 50 MB). */
    uploadVersion(orgId: string, id: string, file: File, options?: { note?: string }): Promise<ArtifactDetail>;
    /** The bytes of a file version (inline previews of images and PDFs). */
    fileBlob(orgId: string, id: string, version?: number): Promise<Blob>;
    /** Always a new version. `baseVersion` stale → 409. */
    update(
      orgId: string,
      id: string,
      input: { content: ArtifactContent; note?: string | null; baseVersion: number; title?: string },
    ): Promise<ArtifactDetail>;
    /** To the trash for 30 days (403 `artifact.delete_forbidden`). */
    remove(orgId: string, id: string): Promise<void>;
    trash(orgId: string): Promise<TrashedArtifact[]>;
    /** Back from the trash (409 `artifact.purged` after 30 days). */
    restore(orgId: string, id: string): Promise<ArtifactDetail | undefined>;
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
    /**
     * The workspace's invitation link (admins, ADR 0068): the active one, else a new one for 30 days. Whoever
     * opens it can only ask to join.
     */
    createLink(orgId: string): Promise<{ id: string; url: string; expiresAt: string }>;
    /** The links people can still ask with, earlier ones (no `url`) included. */
    links(orgId: string): Promise<InviteLink[]>;
    /** Nobody new can ask with it; the requests made through it close without emails. */
    turnOff(orgId: string, linkId: string): Promise<void>;
    /** 30 more days for the same link (ADR 0090). */
    renewLink(orgId: string, linkId: string): Promise<{ expiresAt: string }>;
    /**
     * Emails a code that proves the address (ADR 0072): signed out the one typed, signed in the account's own.
     * `join.code_wait` (429) with `retryIn` seconds right after another. `humanCheck`: the bot check's token.
     */
    sendCode(token: string, input: { email?: string }, humanCheck?: string): Promise<CodeSent>;
    /** Checks the code from the email: right, the address can ask for 30 minutes. */
    checkCode(token: string, input: { email?: string; code: string }): Promise<{ verified: true }>;
    /**
     * Asks to join through a link: signed out with a name and an email, signed in as the account. On a server that
     * sends email, `code` proves an address that isn't a confirmed account's.
     */
    ask(
      token: string,
      input: { name?: string; email?: string; note?: string; code?: string; password?: string },
    ): Promise<AskToJoinResult>;
    /** Where the request this page made stands, by its `key` (ADR 0090); null when the key matches nothing. */
    claim(token: string, key: string): Promise<JoinClaim | null>;
    /** Expired email invitation: ask the inviter for a new one. */
    requestNew(token: string): Promise<void>;
  };
  /** Requests to join through the invitation link, for admins (ADR 0068). */
  joinRequests: {
    /** Waiting ones, oldest first. */
    list(orgId: string): Promise<JoinRequest[]>;
    /** `join.answered` / `join.expired` (409) when someone answered first or it ran out. */
    approve(orgId: string, requestId: string, roleIds?: string[]): Promise<JoinApproval>;
    /** `reason` is told to the person by email. */
    deny(orgId: string, requestId: string, reason?: string): Promise<void>;
    /** A member suggests someone to the people who may invite (ADR 0090). */
    suggest(orgId: string, input: { email: string; note?: string }): Promise<{ id: string }>;
    /** This member's suggestions that still wait. */
    mine(orgId: string): Promise<MySuggestion[]>;
    /** Takes back one of this member's suggestions. */
    cancel(orgId: string, requestId: string): Promise<void>;
  };
  /**
   * Phone app additions. Optional so older fakes and clients still type-check;
   * `createHttpApi` has them all (hooks throw when a client lacks one).
   */
  /** Pinned messages of a channel or DM (anyone who can post there pins). */
  pins?: {
    /** Newest pin first. */
    list(orgId: string, channelId: string): Promise<MessagePin[]>;
    /** Pinning again keeps the first pin. `pins.limit` past 100. */
    pin(orgId: string, channelId: string, messageId: string): Promise<MessagePin>;
    unpin(orgId: string, channelId: string, messageId: string): Promise<void>;
  };
  /**
   * Act with undo (ADR 0037 round 2): receipts under an agent's reply. 409 codes:
   * `action.changed_since`, `action.expired`, `action.already_undone`, `action.not_undone`;
   * 403 `action.not_allowed`. The channel also hears `message.actions`.
   */
  actions?: {
    /** Desfazer. */
    undo(orgId: string, actionId: string): Promise<AgentAction>;
    /** Refazer (after an undo, while `undoableUntil` has not passed). */
    redo(orgId: string, actionId: string): Promise<AgentAction>;
    /** Desfazer tudo: every receipt of the message still undoable, newest first. */
    undoMessage(orgId: string, messageId: string): Promise<UndoAllResult>;
  };
  /** "O que fez por você": what an agent did that involves the viewer (agent profile). */
  agentForYou?: {
    get(orgId: string, agentId: string, limit?: number): Promise<AgentForYou>;
  };
  /** Follow or mute a thread (replies notify and count as unread only while you follow). */
  threadFollows?: {
    follow(orgId: string, threadId: string): Promise<ThreadFollow>;
    unfollow(orgId: string, threadId: string): Promise<ThreadFollow>;
  };
  /** "Trabalhando agora": agent runs in progress in the conversations you are in (any member). */
  working?: {
    list(orgId: string): Promise<WorkingRun[]>;
  };
  /** People's mailboxes for agents (ADR 0038): Gmail/Outlook through Composio, the rest by IMAP/SMTP. */
  mail: {
    /** Which ways in this server offers, and the IMAP presets. */
    providers(orgId: string): Promise<MailProviders>;
    accounts(orgId: string): Promise<MailAccount[]>;
    /** Tests the login and both servers first; a `422` carries `MailConnectError` as its code. */
    connectImap(orgId: string, input: MailImapInput): Promise<MailAccount>;
    /**
     * Gmail/Outlook: the page to open; the server sends the person back with `?mail=connected|failed`.
     * `desktop`: started in the desktop app's window, which opens the page in the browser and gets the return back.
     * `accountId` reconnects that mailbox (one that needs it) instead of adding one.
     */
    connectComposio(
      orgId: string,
      input: { provider: "gmail" | "outlook"; label?: string; accountId?: string; desktop?: boolean },
    ): Promise<{ accountId: string; redirectUrl: string }>;
    /** A new name, actions, other addresses and the default From, or a new app password (reconnects an IMAP mailbox). */
    update(orgId: string, accountId: string, input: MailAccountUpdate): Promise<MailAccount>;
    /** Addresses the mailbox has sent from (its sent folder), offered as its other addresses. */
    suggestedAddresses(orgId: string, accountId: string): Promise<string[]>;
    disconnect(orgId: string, accountId: string): Promise<void>;
    folders(orgId: string, accountId: string): Promise<MailFolder[]>;
    /** An agent's access and rules per mailbox. */
    agent(orgId: string, agentId: string): Promise<AgentMailbox[]>;
    setAgent(orgId: string, agentId: string, accountId: string, input: AgentMailboxInput): Promise<AgentMailbox>;
  };
  /** People's Postgres databases for agents (ADR 0039): read-only queries. */
  databases: {
    list(orgId: string): Promise<DatabaseConnection[]>;
    /** Tested first; a `422` carries `DatabaseConnectError` as its code. */
    connect(orgId: string, input: DatabaseConnectionInput): Promise<DatabaseConnection>;
    /** A new name, tools on or off, or a new address or password (tested first). */
    update(
      orgId: string,
      connectionId: string,
      input: DatabaseConnectionInput & { offActions?: DatabaseActionName[] },
    ): Promise<DatabaseConnection>;
    disconnect(orgId: string, connectionId: string): Promise<void>;
    tables(orgId: string, connectionId: string): Promise<DatabaseTable[]>;
    /** An agent's access and rules per database. */
    agent(orgId: string, agentId: string): Promise<AgentDatabase[]>;
    setAgent(orgId: string, agentId: string, connectionId: string, input: AgentDatabaseInput): Promise<AgentDatabase>;
  };
  /** The agent browser on connected computers (ADR 0040). The live view itself is on the realtime socket. */
  browser: {
    /** Whether its computer serves the browser, and the sites it may open. */
    settings(orgId: string, agentId: string): Promise<AgentBrowserSettings>;
    /** The sites (owner or admins); null or empty = any site. */
    setDomains(orgId: string, agentId: string, allowedDomains: string[] | null): Promise<AgentBrowserSettings>;
    /** The agent's open request or take over on that screen (the browser by default), if any. */
    agentHandoff(orgId: string, agentId: string, screen?: ScreenKind): Promise<BrowserHandoff | null>;
    /** Whether this person may drive that screen (take over, open a page, type); watching needs less (ADR 0040). */
    agentControl(orgId: string, agentId: string, screen?: ScreenKind): Promise<boolean>;
    handoff(orgId: string, handoffId: string): Promise<BrowserHandoff>;
    /** Take control of a request (one person at a time; 409 when someone else has it). */
    takeControl(orgId: string, handoffId: string): Promise<BrowserHandoff>;
    /**
     * "Pronto", or "Devolver" for a take over: the agent reads the page again and goes on, told who
     * had it, for how long, the pages, and `note` as the person's own words.
     */
    done(orgId: string, handoffId: string, note?: string): Promise<BrowserHandoff>;
    /** "Não consegui", with an optional reason the agent reads. */
    failed(orgId: string, handoffId: string, note?: string): Promise<BrowserHandoff>;
    cancel(orgId: string, handoffId: string): Promise<BrowserHandoff>;
    /**
     * Take over while watching; the agent waits until handed back. `runId`: the run whose card it
     * was taken from (the take over is bound to it, so its card stays in that conversation).
     */
    takeover(orgId: string, agentId: string, runId?: string, screen?: ScreenKind): Promise<BrowserHandoff>;
    /**
     * The person in control opens a site (a bare host gets https://); a closed browser opens. 409
     * `browser.not_in_control`, 403 `browser.not_allowed` (outside the agent's sites), 400
     * `browser.bad_address` or `browser.open_failed`.
     */
    open(orgId: string, agentId: string, url: string): Promise<void>;
    /** "Parar": closes the agent's browser now (its logins stay). Its screen has no stop: it stays on. */
    stop(orgId: string, agentId: string): Promise<void>;
    /**
     * "Tentar de novo" on a page that never came: the browser closes and opens again where it was (its logins
     * stay), and every live view gets it again. Resolves once it closed. Only who may drive it (403 otherwise).
     */
    restart(orgId: string, agentId: string): Promise<void>;
  };
  /**
   * The agent's screen (ADR 0058): its state. The screen itself is a WebSocket (`desktopSocketUrl`), which
   * starts it when it isn't running; control and "Devolver" are the browser's screen routes with `desktop`.
   */
  desktop: {
    status(orgId: string, agentId: string): Promise<DesktopStatus>;
  };
  /**
   * GIF search (ADR 0091), through our server: the browser and the phone never talk to the provider. Every member;
   * rate limited per person (429). 404 `gifs.off` when this server has no GIF search or the workspace turned GIFs
   * off. A GIF's file is `gifMediaUrl` (`lib/media.ts`).
   */
  gifs?: {
    /** Free text (`q`), a category, or neither (what is trending), at the workspace's rating. */
    search(orgId: string, query: GifQuery): Promise<GifPage>;
  };
  /** "Lembrar": one-off reminders in conversations (also routines in Rotinas). */
  reminders?: {
    create(orgId: string, input: ReminderInput): Promise<Reminder>;
    /** Your pending ones, soonest first. */
    list(orgId: string): Promise<Reminder[]>;
    cancel(orgId: string, reminderId: string): Promise<Reminder>;
  };
}

/** Everything is served by the HTTP backend (apps/server/src/routes/app). */
export type HttpApi = ApiClient;
