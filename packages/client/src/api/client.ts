import type {
  AccessInput,
  ActiveRun,
  Agent,
  AgentAccess,
  AgentBrain,
  AgentBrainInput,
  AgentChannel,
  AgentComputer,
  AgentDetail,
  AgentInput,
  AgentQuestion,
  AgentSecret,
  AgentSkill,
  AgentUsage,
  ApiRule,
  AppNotification,
  Approval,
  Artifact,
  ArtifactContent,
  ArtifactDetail,
  ArtifactFilters,
  ArtifactVersion,
  AuthConfig,
  BatchInviteResult,
  BrainKind,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarRange,
  Channel,
  ChannelMember,
  CommandApproval,
  ComputerTarget,
  Connection,
  ConnectorCatalog,
  Credential,
  CustomConnectStart,
  CustomServer,
  DirectMessage,
  DmTarget,
  ForumParticipantsInput,
  ForumPost,
  ForumPostInput,
  ForumSuggestedIssue,
  ForumSuggestion,
  ForumSuggestionOverrides,
  ForumTopic,
  ForumTopicDetail,
  ForumTopicInput,
  GitHubAppInstallation,
  GitHubRepositories,
  Health,
  Invitation,
  InvitationPreview,
  InvitationWithStatus,
  Issue,
  IssueActivity,
  IssueInput,
  IssuePatch,
  Machine,
  MachinePairing,
  MachineTask,
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
  NotificationCount,
  NotificationFilter,
  NotificationPage,
  Organization,
  OrgOverview,
  OrgSettings,
  Person,
  Proposal,
  ReactionCount,
  Reminder,
  ReminderInput,
  Role,
  RosterMember,
  Routine,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  RuleInfo,
  Run,
  RunStep,
  S3Input,
  SandboxSettings,
  SandboxSettingsInput,
  ScheduleParse,
  ScopeGrant,
  SearchHit,
  SearchKind,
  SecretBox,
  SecretRequest,
  SeriesScope,
  Skill,
  SkillDetail,
  SkillInput,
  SkillPatch,
  StorageConfig,
  StorageMigration,
  StorageTestResult,
  TaskOutput,
  ThreadAction,
  ThreadCreateInput,
  ThreadFilters,
  ThreadFollow,
  ThreadInfo,
  ThreadPage,
  ThreadPatch,
  ToolDecision,
  TrashedArtifact,
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
    /** My handle and time zone in this organization (`timezone: null` = the organization's). */
    updateMe(orgId: string, input: { handle?: string; timezone?: string | null }): Promise<Person>;
    /** My profile photo: a square image (JSON only: base64), already cropped. */
    setAvatar(orgId: string, input: { imageBase64: string; contentType: string }): Promise<{ avatarUrl: string }>;
    removeAvatar(orgId: string): Promise<void>;
    /** The workspace logo (admins): a square image (JSON only: base64), already cropped. */
    setLogo(orgId: string, input: { imageBase64: string; contentType: string }): Promise<{ logo: string }>;
    removeLogo(orgId: string): Promise<void>;
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
    /** The team file / agent definitions behind a GitHub link, read by the backend (onboarding import; nothing saved). */
    importFromGithub(orgId: string, url: string): Promise<{ files: { path: string; text: string }[] }>;
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
    runs(
      orgId: string,
      filter?: { agentId?: string; status?: string; before?: string; since?: string; limit?: number },
    ): Promise<Run[]>;
    run(orgId: string, runId: string): Promise<{ run: Run; steps: RunStep[] }>;
    /** "Parar": stops a run (the person who started it, the agent's owner, admins). */
    cancelRun(orgId: string, runId: string): Promise<void>;
    /** Runs still active in a channel (reconciles the live rows); `null` while the server lacks the endpoint. */
    activeRuns(orgId: string, channelId: string): Promise<ActiveRun[] | null>;
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
      input: {
        body: string;
        threadId?: string | null;
        clientId?: string;
        /** Quote reply: the message this one answers (the server stores `meta.replyTo`). */
        replyTo?: string;
        /** Uploaded files (artifact ids): the server stores `meta.artifacts`. */
        attachments?: string[];
      },
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
    /** The agent's PC (404 = this server has no sandbox). */
    computer(orgId: string, agentId: string): Promise<AgentComputer>;
    start(orgId: string, agentId: string): Promise<AgentComputer>;
    stop(orgId: string, agentId: string): Promise<AgentComputer>;
    /** Deletes the PC and all its files. */
    remove(orgId: string, agentId: string): Promise<void>;
    /** Which computer the agent uses: a connected machine, or `null` for the cloud one. */
    setTarget(orgId: string, agentId: string, machineId: string | null): Promise<ComputerTarget>;
  };
  /** Connected computers (ADR 0025): machines running `agentes-runner`. */
  machines: {
    list(orgId: string): Promise<Machine[]>;
    /** A one-time pairing code (10 minutes) and the command to run on the machine. */
    createPairing(orgId: string, input: { name: string }): Promise<MachinePairing>;
    rename(orgId: string, machineId: string, name: string): Promise<{ id: string; name: string }>;
    /** Revokes its token and disconnects the runner at once; agents on it go back to the cloud. */
    remove(orgId: string, machineId: string): Promise<void>;
  };
  skills: {
    /** The org library. */
    list(orgId: string): Promise<Skill[]>;
    get(orgId: string, id: string): Promise<SkillDetail>;
    /** "Escrever". */
    create(orgId: string, input: SkillInput): Promise<SkillDetail>;
    /** A GitHub link (folder or SKILL.md) or the folder as a zip in base64 (writes are JSON only). */
    import(orgId: string, input: { url: string } | { zipBase64: string }): Promise<SkillDetail>;
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
      input: { outcome: "done" | "canceled"; saveToWiki?: boolean; note?: string },
    ): Promise<Mission>;
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
  /** My inbox in this organization: mentions, replies, what waits on me (telas/Notificacoes.html). */
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
    /** Org-wide link: whoever joins with it becomes a member (7 days). */
    createLink(orgId: string): Promise<{ url: string; expiresAt: string }>;
    /** Expired invitation: ask the inviter for a new one. */
    requestNew(token: string): Promise<void>;
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
  /** Follow or mute a thread (replies notify and count as unread only while you follow). */
  threadFollows?: {
    follow(orgId: string, threadId: string): Promise<ThreadFollow>;
    unfollow(orgId: string, threadId: string): Promise<ThreadFollow>;
  };
  /** "Trabalhando agora": agent runs in progress in the conversations you are in (any member). */
  working?: {
    list(orgId: string): Promise<WorkingRun[]>;
  };
  /** "Lembrar": one-off reminders in conversations (also routines in Rotinas). */
  reminders?: {
    create(orgId: string, input: ReminderInput): Promise<Reminder>;
    /** Your pending ones, soonest first. */
    list(orgId: string): Promise<Reminder[]>;
    cancel(orgId: string, reminderId: string): Promise<Reminder>;
  };
  /** Public waiting list (`POST /api/waitlist`, outside `/api/app`): same answer whether or not the email was there. */
  waitlist: {
    join(input: { email: string; locale: string }): Promise<void>;
    /** The link in the confirmation email (`?confirm=`); `invalid_token` when unknown or expired. */
    confirm(input: { token: string }): Promise<void>;
  };
}

/** Everything is served by the HTTP backend (apps/server/src/routes/app). */
export type HttpApi = ApiClient;
