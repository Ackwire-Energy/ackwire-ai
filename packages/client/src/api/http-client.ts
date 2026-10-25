import { steerStore } from "../realtime/steer";
import type { HttpApi } from "./client";
import { ApiError, createFileRequester, createRequester, enc, type TransportOptions } from "./http";
import type {
  AccountLoginStart,
  AccountLoginStatus,
  ActiveRun,
  Agent,
  AgentAccess,
  AgentAction,
  AgentBrain,
  AgentBrowserSettings,
  AgentChannel,
  AgentComputer,
  AgentDatabase,
  AgentDetail,
  AgentForYou,
  AgentMailbox,
  AgentPlanUsage,
  AgentQuestion,
  AgentSecret,
  AgentSkill,
  AgentUsage,
  AiAccounts,
  AiStatus,
  AppNotification,
  Approval,
  Artifact,
  ArtifactDetail,
  ArtifactVersion,
  AuditPage,
  AuthConfig,
  BatchInviteResult,
  BrowserHandoff,
  CalendarEvent,
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
  DatabaseConnection,
  DatabaseTable,
  DesktopRelease,
  DesktopStatus,
  DeviceRequest,
  DirectMessage,
  DmRead,
  ForumPost,
  ForumSuggestion,
  ForumTopic,
  ForumTopicDetail,
  GitHubAppInstallation,
  GitHubRepositories,
  Health,
  HostComputer,
  ImportPlan,
  Invitation,
  InvitationPreview,
  InvitationWithStatus,
  Issue,
  IssueActivity,
  IssueColumn,
  Machine,
  MachineAccess,
  MachineAccount,
  MachineOutages,
  MachineTask,
  MailAccount,
  MailFolder,
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
  MissionDecision,
  MissionDelivery,
  MissionEligibleAgent,
  MissionFiles,
  MissionJoinRequest,
  MissionList,
  MissionParticipants,
  MissionPlan,
  MissionReview,
  MissionSettings,
  MissionSummary,
  Model,
  MoveAgentsResult,
  NotificationCount,
  NotificationPage,
  Organization,
  OrgOverview,
  OrgPlanUsage,
  OrgSettings,
  Person,
  PhoneSignIn,
  Proposal,
  ReactionCount,
  Reminder,
  RosterMember,
  Routine,
  RoutineRun,
  RuleInfo,
  Run,
  RunStep,
  SandboxSettings,
  ScheduleParse,
  ScopeGrant,
  SearchHit,
  SecretRequest,
  SignInOptions,
  Skill,
  SkillDetail,
  StorageConfig,
  StorageMigration,
  StorageTestResult,
  TaskOutput,
  Team,
  ThreadFilters,
  ThreadFollow,
  ThreadInfo,
  ThreadPage,
  TrashedArtifact,
  UndoAllResult,
  UsageReport,
  WikiGraph,
  WikiImportResult,
  WikiPage,
  WikiPageSummary,
  WikiTopRead,
  WikiVersion,
  WorkingRun,
} from "./types";

const org = (orgId: string) => `/api/app/organizations/${enc(orgId)}`;

/** The list's query string (booleans as "true"; nothing for what isn't set). */
const threadQuery = (f: Partial<ThreadFilters>) => ({
  tab: f.tab,
  channelId: f.channelId,
  agentId: f.agentId,
  needsYou: f.needsYou ? "true" : undefined,
  mine: f.mine ? "true" : undefined,
  q: f.q?.trim() || undefined,
  cursor: f.cursor,
  limit: f.limit,
});

/**
 * The real backend: `/api/health` and `/api/app/*` (apps/server/src/routes/app).
 * The web app calls it with no options (same origin, its cookie). The phone app
 * passes `baseUrl` and `headers` (its session cookie and `X-Agentes-Client`),
 * merged into every request, JSON and files alike.
 */
export function createHttpApi(options: TransportOptions = {}): HttpApi {
  const request = createRequester(options);
  const files = createFileRequester(options);
  /** Prefix for URLs the platform opens itself (file links); "" on the web. */
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const nullOn = async <T>(status: number, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiError && error.status === status) return null;
      throw error;
    }
  };

  return {
    actions: {
      undo: (orgId, actionId) => request<AgentAction>(`${org(orgId)}/actions/${enc(actionId)}/undo`, { json: {} }),
      redo: (orgId, actionId) => request<AgentAction>(`${org(orgId)}/actions/${enc(actionId)}/redo`, { json: {} }),
      undoMessage: (orgId, messageId) =>
        request<UndoAllResult>(`${org(orgId)}/messages/${enc(messageId)}/actions/undo`, { json: {} }),
    },
    agentForYou: {
      get: (orgId, agentId, limit) =>
        request<AgentForYou>(`${org(orgId)}/agents/${enc(agentId)}/for-you`, { query: { limit } }),
    },
    pins: {
      list: async (orgId, channelId) =>
        (await request<{ pins: MessagePin[] }>(`${org(orgId)}/channels/${enc(channelId)}/pins`)).pins,
      pin: (orgId, channelId, messageId) =>
        request<MessagePin>(`${org(orgId)}/channels/${enc(channelId)}/pins/${enc(messageId)}`, { json: {} }),
      unpin: (orgId, channelId, messageId) =>
        request<void>(`${org(orgId)}/channels/${enc(channelId)}/pins/${enc(messageId)}`, { method: "DELETE" }),
    },
    threadFollows: {
      follow: (orgId, threadId) =>
        request<ThreadFollow>(`${org(orgId)}/threads/${enc(threadId)}/follow`, { method: "PUT", json: {} }),
      unfollow: (orgId, threadId) =>
        request<ThreadFollow>(`${org(orgId)}/threads/${enc(threadId)}/follow`, { method: "DELETE" }),
    },
    working: {
      list: async (orgId) => (await request<{ runs: WorkingRun[] }>(`${org(orgId)}/active-runs`)).runs,
    },
    mail: {
      providers: (orgId) => request<MailProviders>(`${org(orgId)}/mail/providers`),
      accounts: async (orgId) => (await request<{ accounts: MailAccount[] }>(`${org(orgId)}/mail/accounts`)).accounts,
      connectImap: async (orgId, input) =>
        (await request<{ account: MailAccount }>(`${org(orgId)}/mail/accounts/imap`, { json: input })).account,
      connectComposio: (orgId, input) =>
        request<{ accountId: string; redirectUrl: string }>(`${org(orgId)}/mail/accounts/composio`, { json: input }),
      update: async (orgId, accountId, input) =>
        (
          await request<{ account: MailAccount }>(`${org(orgId)}/mail/accounts/${enc(accountId)}`, {
            method: "PATCH",
            json: input,
          })
        ).account,
      disconnect: (orgId, accountId) =>
        request<void>(`${org(orgId)}/mail/accounts/${enc(accountId)}`, { method: "DELETE" }),
      folders: async (orgId, accountId) =>
        (await request<{ folders: MailFolder[] }>(`${org(orgId)}/mail/accounts/${enc(accountId)}/folders`)).folders,
      agent: async (orgId, agentId) =>
        (await request<{ mailboxes: AgentMailbox[] }>(`${org(orgId)}/agents/${enc(agentId)}/mail`)).mailboxes,
      setAgent: (orgId, agentId, accountId, input) =>
        request<AgentMailbox>(`${org(orgId)}/agents/${enc(agentId)}/mail/${enc(accountId)}`, {
          method: "PUT",
          json: input,
        }),
    },
    databases: {
      list: async (orgId) =>
        (await request<{ connections: DatabaseConnection[] }>(`${org(orgId)}/databases`)).connections,
      connect: async (orgId, input) =>
        (await request<{ connection: DatabaseConnection }>(`${org(orgId)}/databases`, { json: input })).connection,
      update: async (orgId, connectionId, input) =>
        (
          await request<{ connection: DatabaseConnection }>(`${org(orgId)}/databases/${enc(connectionId)}`, {
            method: "PATCH",
            json: input,
          })
        ).connection,
      disconnect: (orgId, connectionId) =>
        request<void>(`${org(orgId)}/databases/${enc(connectionId)}`, { method: "DELETE" }),
      tables: async (orgId, connectionId) =>
        (await request<{ tables: DatabaseTable[] }>(`${org(orgId)}/databases/${enc(connectionId)}/tables`)).tables,
      agent: async (orgId, agentId) =>
        (await request<{ databases: AgentDatabase[] }>(`${org(orgId)}/agents/${enc(agentId)}/databases`)).databases,
      setAgent: (orgId, agentId, connectionId, input) =>
        request<AgentDatabase>(`${org(orgId)}/agents/${enc(agentId)}/databases/${enc(connectionId)}`, {
          method: "PUT",
          json: input,
        }),
    },
    browser: {
      settings: (orgId, agentId) => request<AgentBrowserSettings>(`${org(orgId)}/agents/${enc(agentId)}/browser`),
      setDomains: (orgId, agentId, allowedDomains) =>
        request<AgentBrowserSettings>(`${org(orgId)}/agents/${enc(agentId)}/browser`, {
          method: "PUT",
          json: { allowedDomains },
        }),
      agentHandoff: async (orgId, agentId, screen = "browser") =>
        (await request<{ handoff: BrowserHandoff | null }>(`${org(orgId)}/agents/${enc(agentId)}/${screen}/handoff`))
          .handoff,
      handoff: (orgId, handoffId) => request<BrowserHandoff>(`${org(orgId)}/browser/handoffs/${enc(handoffId)}`),
      takeControl: (orgId, handoffId) =>
        request<BrowserHandoff>(`${org(orgId)}/browser/handoffs/${enc(handoffId)}/control`, { json: {} }),
      done: (orgId, handoffId, note) =>
        request<BrowserHandoff>(`${org(orgId)}/browser/handoffs/${enc(handoffId)}/done`, {
          json: note ? { note } : {},
        }),
      failed: (orgId, handoffId, note) =>
        request<BrowserHandoff>(`${org(orgId)}/browser/handoffs/${enc(handoffId)}/failed`, {
          json: note ? { note } : {},
        }),
      cancel: (orgId, handoffId) =>
        request<BrowserHandoff>(`${org(orgId)}/browser/handoffs/${enc(handoffId)}/cancel`, { json: {} }),
      takeover: (orgId, agentId, runId, screen = "browser") =>
        request<BrowserHandoff>(`${org(orgId)}/agents/${enc(agentId)}/${screen}/takeover`, {
          json: runId ? { runId } : {},
        }),
      open: (orgId, agentId, url) =>
        request<void>(`${org(orgId)}/agents/${enc(agentId)}/browser/open`, { json: { url } }),
      stop: (orgId, agentId, screen = "browser") =>
        request<void>(`${org(orgId)}/agents/${enc(agentId)}/${screen}/stop`, { json: {} }),
    },
    desktop: {
      status: (orgId, agentId) => request<DesktopStatus>(`${org(orgId)}/agents/${enc(agentId)}/desktop`),
      start: (orgId, agentId) => request<void>(`${org(orgId)}/agents/${enc(agentId)}/desktop/start`, { json: {} }),
    },
    reminders: {
      create: (orgId, input) => request<Reminder>(`${org(orgId)}/reminders`, { json: input }),
      list: async (orgId) => (await request<{ reminders: Reminder[] }>(`${org(orgId)}/reminders`)).reminders,
      cancel: (orgId, reminderId) =>
        request<Reminder>(`${org(orgId)}/reminders/${enc(reminderId)}`, { method: "DELETE" }),
    },
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
    waitlist: {
      join: async (input) => {
        await request<{ ok: true }>("/api/waitlist", { json: input });
      },
      confirm: async (input) => {
        await request<{ ok: true }>("/api/waitlist/confirm", { json: input });
      },
    },
    account: {
      authConfig: () => request<AuthConfig>("/api/app/auth-config"),
      signInOptions: (input) => request<SignInOptions>("/api/app/sign-in-options", { json: input }),
      me: () => nullOn(401, () => request<Me>("/api/app/me")),
      updateMe: (input) => request<void>("/api/app/me", { method: "PATCH", json: input }),
      phoneSignIn: () => request<PhoneSignIn>("/api/app/phone-sign-in", { json: {} }),
    },
    orgs: {
      create: (input) =>
        request<{ organization: Organization; generalChannelId: string }>("/api/app/organizations", { json: input }),
      get: (orgId) => request<Organization>(org(orgId)),
      setAvatar: (orgId, input) =>
        request<{ avatarUrl: string }>(`${org(orgId)}/me/avatar`, { method: "PUT", json: input }),
      removeAvatar: (orgId) => request<void>(`${org(orgId)}/me/avatar`, { method: "DELETE" }),
      setLogo: (orgId, input) => request<{ logo: string }>(`${org(orgId)}/logo`, { method: "PUT", json: input }),
      removeLogo: (orgId) => request<void>(`${org(orgId)}/logo`, { method: "DELETE" }),
      updateMe: (orgId, input) => request<Person>(`${org(orgId)}/me`, { method: "PATCH", json: input }),
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
      planUsage: (orgId) => request<OrgPlanUsage>(`${org(orgId)}/usage/plans`),
      audit: (orgId, query = {}) =>
        request<AuditPage>(`${org(orgId)}/audit`, {
          query: {
            actorType: query.actorType,
            actorId: query.actorId,
            outcome: query.outcome?.length ? query.outcome.join(",") : undefined,
            waiting: query.waiting ? "true" : undefined,
            kind: query.kind,
            before: query.before,
            limit: query.limit,
          },
        }),
    },
    agents: {
      list: async (orgId) => (await request<{ agents: Agent[] }>(`${org(orgId)}/agents`)).agents,
      planUsage: (orgId, agentId) => request<AgentPlanUsage>(`${org(orgId)}/agents/${enc(agentId)}/usage`),
      team: (orgId) => request<Team>(`${org(orgId)}/team`),
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
      aiStatus: (orgId) => request<AiStatus>(`${org(orgId)}/ai-status`),
      importFromGithub: (orgId, url) =>
        request<{ files: { path: string; text: string }[]; skipped?: string[] }>(`${org(orgId)}/agent-imports/github`, {
          json: { url },
        }),
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
      brain: (orgId, agentId) => request<AgentBrain>(`${org(orgId)}/agents/${enc(agentId)}/brain`),
      setBrain: (orgId, agentId, input) =>
        request<AgentBrain>(`${org(orgId)}/agents/${enc(agentId)}/brain`, { method: "PUT", json: input }),
      runs: async (orgId, filter = {}) =>
        (await request<{ runs: Run[] }>(`${org(orgId)}/runs`, { query: filter })).runs,
      run: (orgId, runId) => request<{ run: Run; steps: RunStep[] }>(`${org(orgId)}/runs/${enc(runId)}`),
      cancelRun: (orgId, runId) => request<void>(`${org(orgId)}/runs/${enc(runId)}/cancel`, { json: {} }),
      continueRun: (orgId, runId) =>
        request<{ runId: string }>(`${org(orgId)}/runs/${enc(runId)}/continue`, { json: {} }),
      activeRuns: async (orgId, channelId) => {
        const askedAt = Date.now();
        const res = await nullOn(404, () =>
          request<{ runs: ActiveRun[] }>(`${org(orgId)}/channels/${enc(channelId)}/active-runs`),
        );
        // What the agents working here haven't read yet ("lê na próxima pausa" after a reload).
        if (res) steerStore.reconcile(channelId, res.runs, askedAt);
        return res ? res.runs : null;
      },
      usage: async (orgId) => {
        const res = await nullOn(403, () => request<{ usage: AgentUsage[] }>(`${org(orgId)}/usage`));
        return res ? res.usage : null;
      },
    },
    imports: {
      apply: (orgId, input) => request<ImportPlan>(`${org(orgId)}/imports`, { json: input }),
      exportUrl: (orgId) => `${base}${org(orgId)}/export`,
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
      answerNow: (orgId, messageId) =>
        request<{ runs: { agentId: string; runId: string }[] }>(`${org(orgId)}/messages/${enc(messageId)}/answer-now`, {
          json: {},
        }),
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
      messages: async (orgId, channelId, options = {}) => {
        const path = `${org(orgId)}/channels/${enc(channelId)}/messages`;
        const query = { threadId: options.threadId, before: options.before, limit: options.limit };
        const { messages } = await request<{ messages: Message[] }>(path, { query });
        steerStore.seed(channelId, messages);
        return messages;
      },
      post: async (orgId, channelId, input) => {
        const message = await request<Message>(`${org(orgId)}/channels/${enc(channelId)}/messages`, { json: input });
        steerStore.seed(channelId, [message]);
        return message;
      },
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
    githubApp: {
      info: (orgId) =>
        request<{ installable: boolean; installations: GitHubAppInstallation[] }>(`${org(orgId)}/github-app`),
      install: async (orgId, returnTo) =>
        (await request<{ installUrl: string }>(`${org(orgId)}/github-app/install`, { json: { returnTo } })).installUrl,
      remove: (orgId, id) => request<void>(`${org(orgId)}/github-app/installations/${enc(id)}`, { method: "DELETE" }),
      repositories: (orgId) => request<GitHubRepositories>(`${org(orgId)}/github/repositories`),
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
      list: async (orgId, agentId, filter) =>
        (
          await request<{ memories: Memory[] }>(`${org(orgId)}/agents/${enc(agentId)}/memories`, {
            query: { about: filter?.about },
          })
        ).memories,
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
      reads: async (orgId, channelId) =>
        (await request<{ reads: DmRead[] }>(`${org(orgId)}/channels/${enc(channelId)}/reads`)).reads,
    },
    sandbox: {
      settings: (orgId) => request<SandboxSettings>(`${org(orgId)}/sandbox-settings`),
      saveSettings: (orgId, input) =>
        request<SandboxSettings>(`${org(orgId)}/sandbox-settings`, { method: "PUT", json: input }),
      computer: (orgId, agentId) => request<AgentComputer>(`${org(orgId)}/agents/${enc(agentId)}/computer`),
      start: (orgId, agentId) =>
        request<AgentComputer>(`${org(orgId)}/agents/${enc(agentId)}/computer/start`, { json: {} }),
      stop: (orgId, agentId) =>
        request<AgentComputer>(`${org(orgId)}/agents/${enc(agentId)}/computer/stop`, { json: {} }),
      remove: (orgId, agentId) => request<void>(`${org(orgId)}/agents/${enc(agentId)}/computer`, { method: "DELETE" }),
      setTarget: (orgId, agentId, machineId) =>
        request<ComputerTarget>(`${org(orgId)}/agents/${enc(agentId)}/computer/target`, {
          method: "PUT",
          json: { machineId },
        }),
    },
    machines: {
      list: async (orgId) => (await request<{ machines: Machine[] }>(`${org(orgId)}/machines`)).machines,
      rename: (orgId, machineId, name) =>
        request<{ id: string; name: string }>(`${org(orgId)}/machines/${enc(machineId)}`, {
          method: "PATCH",
          json: { name },
        }),
      remove: (orgId, machineId) => request<void>(`${org(orgId)}/machines/${enc(machineId)}`, { method: "DELETE" }),
      host: (orgId) => nullOn(404, () => request<HostComputer>(`${org(orgId)}/machines/host`)),
      hostOn: (orgId) => request<HostComputer>(`${org(orgId)}/machines/host`, { json: {} }),
      device: (userCode) => request<DeviceRequest>(`/api/app/machines/device/${enc(userCode)}`),
      confirmDevice: (orgId, userCode, input) =>
        request<Machine>(`${org(orgId)}/machines/device/${enc(userCode)}/confirm`, { json: input }),
      denyDevice: (userCode) => request<void>(`/api/app/machines/device/${enc(userCode)}/deny`, { json: {} }),
      reduceAccess: async (orgId, machineId, input) => {
        const out = await request<MachineAccess | { access: MachineAccess }>(
          `${org(orgId)}/machines/${enc(machineId)}/access/reduce`,
          { json: input },
        );
        // The new access, bare or wrapped.
        return "access" in out ? out.access : out;
      },
      desktopLatest: (target, arch) =>
        nullOn(404, () => request<DesktopRelease>("/api/desktop/latest", { query: { target, arch } })),
      outages: (orgId) => request<MachineOutages>(`${org(orgId)}/machines/outages`),
      moveAgents: (orgId, machineId, input) =>
        request<MoveAgentsResult>(`${org(orgId)}/machines/${enc(machineId)}/move-agents`, { json: input }),
      beginAccountLogin: (orgId, machineId, kind, options = {}) =>
        request<AccountLoginStart>(`${org(orgId)}/machines/${enc(machineId)}/account-logins`, {
          json: {
            kind,
            ...(options.accountId ? { accountId: options.accountId } : {}),
            ...(options.email ? { email: options.email } : {}),
            ...(options.provider ? { provider: options.provider } : {}),
          },
        }),
      sendAccountCode: (orgId, machineId, loginId, box) =>
        request<void>(`${org(orgId)}/machines/${enc(machineId)}/account-logins/${enc(loginId)}/code`, {
          json: { box },
        }),
      accountLogin: (orgId, machineId, loginId) =>
        request<AccountLoginStatus>(`${org(orgId)}/machines/${enc(machineId)}/account-logins/${enc(loginId)}`),
      cancelAccountLogin: (orgId, machineId, loginId) =>
        request<void>(`${org(orgId)}/machines/${enc(machineId)}/account-logins/${enc(loginId)}`, {
          method: "DELETE",
        }),
      refreshAccountUsage: (orgId) => request<void>(`${org(orgId)}/ai-accounts/refresh`, { json: {} }),
      aiAccounts: (orgId) => request<AiAccounts>(`${org(orgId)}/ai-accounts`),
      renameAccount: (orgId, machineId, accountId, label) =>
        request<MachineAccount>(`${org(orgId)}/machines/${enc(machineId)}/accounts/${enc(accountId)}`, {
          method: "PATCH",
          json: { label },
        }),
      removeAccount: (orgId, machineId, accountId) =>
        request<void>(`${org(orgId)}/machines/${enc(machineId)}/accounts/${enc(accountId)}`, { method: "DELETE" }),
    },
    skills: {
      list: async (orgId) => (await request<{ skills: Skill[] }>(`${org(orgId)}/skills`)).skills,
      get: (orgId, id) => request<SkillDetail>(`${org(orgId)}/skills/${enc(id)}`),
      create: (orgId, input) => request<SkillDetail>(`${org(orgId)}/skills`, { json: input }),
      import: (orgId, input) => request<SkillDetail>(`${org(orgId)}/skills/import`, { json: input }),
      update: (orgId, id, patch) =>
        request<SkillDetail>(`${org(orgId)}/skills/${enc(id)}`, { method: "PATCH", json: patch }),
      reimport: (orgId, id) => request<SkillDetail>(`${org(orgId)}/skills/${enc(id)}/reimport`, { json: {} }),
      remove: (orgId, id) => request<void>(`${org(orgId)}/skills/${enc(id)}`, { method: "DELETE" }),
      forAgent: async (orgId, agentId) =>
        (await request<{ skills: AgentSkill[] }>(`${org(orgId)}/agents/${enc(agentId)}/skills`)).skills,
      setForAgent: async (orgId, agentId, skills) =>
        (
          await request<{ skills: AgentSkill[] }>(`${org(orgId)}/agents/${enc(agentId)}/skills`, {
            method: "PUT",
            json: { skills },
          })
        ).skills,
    },
    access: {
      get: (orgId, agentId) => request<AgentAccess>(`${org(orgId)}/agents/${enc(agentId)}/access`),
      set: (orgId, agentId, input) =>
        request<AgentAccess>(`${org(orgId)}/agents/${enc(agentId)}/access`, { method: "PUT", json: input }),
    },
    invites: {
      createLink: (orgId) => request<{ url: string; expiresAt: string }>(`${org(orgId)}/invite-links`, { json: {} }),
      requestNew: (token) => request<void>(`/api/app/invitations/${enc(token)}/request-new`, { json: {} }),
    },
    storage: {
      get: (orgId) => request<StorageConfig>(`${org(orgId)}/storage`),
      test: (orgId, input) => request<StorageTestResult>(`${org(orgId)}/storage/test`, { json: input }),
      save: (orgId, input) => request<StorageConfig>(`${org(orgId)}/storage`, { method: "PUT", json: input }),
      migrate: (orgId) => request<StorageMigration>(`${org(orgId)}/storage/migrate`, { json: {} }),
      migration: (orgId) => request<StorageMigration | null>(`${org(orgId)}/storage/migration`),
    },
    artifacts: {
      list: async (orgId, filters = {}) =>
        (
          await request<{ artifacts: Artifact[] }>(`${org(orgId)}/artifacts`, {
            query: {
              q: filters.q,
              kind: filters.kind,
              channelId: filters.channelId,
              authorType: filters.author?.type,
              authorId: filters.author?.id,
              changed: filters.changed && filters.author ? "1" : undefined,
            },
          })
        ).artifacts,
      get: (orgId, id, version) =>
        request<ArtifactDetail>(`${org(orgId)}/artifacts/${enc(id)}`, { query: { version } }),
      versions: async (orgId, id) =>
        (await request<{ versions: ArtifactVersion[] }>(`${org(orgId)}/artifacts/${enc(id)}/versions`)).versions,
      download: (orgId, id, version) =>
        request<{ url: string; expiresAt: string }>(`${org(orgId)}/artifacts/${enc(id)}/download`, {
          query: { version },
        }),
      fileUrl: (orgId, id, options = {}) => {
        const params = new URLSearchParams();
        if (options.version) params.set("version", String(options.version));
        if (options.format) params.set("format", options.format);
        const qs = params.toString();
        return `${base}${org(orgId)}/artifacts/${enc(id)}/file${qs ? `?${qs}` : ""}`;
      },
      upload: (orgId, file, options = {}) => {
        const form = new FormData();
        form.append("file", file, file.name);
        if (options.title) form.append("title", options.title);
        if (options.channelId) form.append("channelId", options.channelId);
        if (options.threadId) form.append("threadId", options.threadId);
        return files.upload<ArtifactDetail>(`${org(orgId)}/artifacts/files`, form);
      },
      uploadVersion: (orgId, id, file, options = {}) => {
        const form = new FormData();
        form.append("file", file, file.name);
        if (options.note) form.append("note", options.note);
        return files.upload<ArtifactDetail>(`${org(orgId)}/artifacts/${enc(id)}/files`, form);
      },
      fileBlob: (orgId, id, version) =>
        files.blob(`${org(orgId)}/artifacts/${enc(id)}/file${version ? `?version=${version}` : ""}`),
      create: (orgId, input) => request<ArtifactDetail>(`${org(orgId)}/artifacts`, { json: input }),
      update: (orgId, id, input) =>
        request<ArtifactDetail>(`${org(orgId)}/artifacts/${enc(id)}/versions`, { json: input }),
      remove: (orgId, id) => request<void>(`${org(orgId)}/artifacts/${enc(id)}`, { method: "DELETE" }),
      trash: async (orgId) => {
        // The server answers `{ files }`.
        const res = await request<{ files?: TrashedArtifact[]; artifacts?: TrashedArtifact[] } | TrashedArtifact[]>(
          `${org(orgId)}/artifacts-trash`,
        );
        return Array.isArray(res) ? res : (res.files ?? res.artifacts ?? []);
      },
      restore: (orgId, id) =>
        request<ArtifactDetail | undefined>(`${org(orgId)}/artifacts/${enc(id)}/restore`, { json: {} }),
    },
    issues: {
      list: async (orgId, filters = {}) =>
        (await request<{ issues: Issue[] }>(`${org(orgId)}/issues`, { query: { q: filters.q } })).issues,
      get: (orgId, number) => request<Issue>(`${org(orgId)}/issues/by-number/${number}`),
      create: (orgId, input) => request<Issue>(`${org(orgId)}/issues`, { json: input }),
      update: (orgId, id, patch) => request<Issue>(`${org(orgId)}/issues/${enc(id)}`, { method: "PATCH", json: patch }),
      setCriterion: (orgId, id, criterionId, done) =>
        request<Issue>(`${org(orgId)}/issues/${enc(id)}/criteria/${enc(criterionId)}`, {
          method: "PUT",
          json: { done },
        }),
      activity: async (orgId, id) =>
        (await request<{ activity: IssueActivity[] }>(`${org(orgId)}/issues/${enc(id)}/activity`)).activity,
      comment: (orgId, id, text, attachmentIds) =>
        request<IssueActivity>(`${org(orgId)}/issues/${enc(id)}/comments`, {
          json: { text, ...(attachmentIds?.length ? { attachmentIds } : {}) },
        }),
      askAgent: (orgId, id, agentId) =>
        request<Issue>(`${org(orgId)}/issues/${enc(id)}/ask-agent`, { json: { agentId } }),
      columns: async (orgId) => (await request<{ columns: IssueColumn[] }>(`${org(orgId)}/issue-columns`)).columns,
      addColumn: async (orgId, input) =>
        (await request<{ columns: IssueColumn[] }>(`${org(orgId)}/issue-columns`, { json: input })).columns,
      updateColumn: async (orgId, columnId, patch) =>
        (
          await request<{ columns: IssueColumn[] }>(`${org(orgId)}/issue-columns/${enc(columnId)}`, {
            method: "PATCH",
            json: patch,
          })
        ).columns,
      deleteColumn: async (orgId, columnId, moveTo) =>
        (
          await request<{ columns: IssueColumn[] }>(`${org(orgId)}/issue-columns/${enc(columnId)}`, {
            method: "DELETE",
            query: { moveTo },
          })
        ).columns,
    },
    threads: {
      list: (orgId, filters = {}) => request<ThreadPage>(`${org(orgId)}/threads`, { query: threadQuery(filters) }),
      inChannel: (orgId, channelId, filters = {}) =>
        request<ThreadPage>(`${org(orgId)}/channels/${enc(channelId)}/threads`, { query: threadQuery(filters) }),
      get: (orgId, threadId) => request<ThreadInfo>(`${org(orgId)}/threads/${enc(threadId)}`),
      create: (orgId, input) => request<ThreadInfo>(`${org(orgId)}/threads`, { json: input }),
      update: (orgId, threadId, patch) =>
        request<ThreadInfo>(`${org(orgId)}/threads/${enc(threadId)}`, { method: "PATCH", json: patch }),
      remove: (orgId, threadId) => request<void>(`${org(orgId)}/threads/${enc(threadId)}`, { method: "DELETE" }),
      act: (orgId, threadId, action) =>
        request<ThreadInfo>(`${org(orgId)}/threads/${enc(threadId)}/${action}`, { json: {} }),
    },
    missions: ((): HttpApi["missions"] => {
      const one = (orgId: string, missionId: string) => `${org(orgId)}/missions/${enc(missionId)}`;
      return {
        list: (orgId, query = {}) =>
          request<MissionList>(`${org(orgId)}/missions`, {
            query: {
              status: query.status,
              channelId: query.channelId,
              agentId: query.agentId,
              q: query.q || undefined,
              limit: query.limit === undefined ? undefined : String(query.limit),
            },
          }),
        eligibleAgents: async (orgId) =>
          (await request<{ agents: MissionEligibleAgent[] }>(`${org(orgId)}/missions/eligible-agents`)).agents,
        taskOutput: (orgId, taskId, tail) =>
          request<TaskOutput>(`${org(orgId)}/tasks/${enc(taskId)}/output`, {
            query: { tail: tail === undefined ? undefined : String(tail) },
          }),
        joinRequests: async (orgId, missionId) =>
          (await request<{ requests: MissionJoinRequest[] }>(`${one(orgId, missionId)}/join-requests`)).requests,
        requestJoin: (orgId, missionId) =>
          request<MissionJoinRequest>(`${one(orgId, missionId)}/join-requests`, { json: {} }),
        decideJoin: (orgId, missionId, userId, outcome, role) =>
          request<MissionJoinRequest>(`${one(orgId, missionId)}/join-requests/${enc(userId)}/${outcome}`, {
            json: outcome === "accept" ? { role: role ?? "comment" } : {},
          }),
        create: (orgId, input) => request<Mission>(`${org(orgId)}/missions`, { json: input }),
        get: (orgId, missionId) => request<Mission>(one(orgId, missionId)),
        ofThread: (orgId, threadId) => request<Mission>(`${org(orgId)}/threads/${enc(threadId)}/mission`),
        threadTasks: async (orgId, threadId) =>
          (await request<{ tasks: MachineTask[] }>(`${org(orgId)}/threads/${enc(threadId)}/tasks`)).tasks,
        control: (orgId, missionId, action) =>
          request<Mission & { canceledTasks?: number }>(`${one(orgId, missionId)}/${action}`, { json: {} }),
        close: (orgId, missionId, input) => request<Mission>(`${one(orgId, missionId)}/close`, { json: input }),
        retryWorktree: (orgId, missionId) => request<Mission>(`${one(orgId, missionId)}/worktree/retry`, { json: {} }),
        message: (orgId, missionId, text) =>
          request<{ delivered: boolean; taskId?: string }>(`${one(orgId, missionId)}/messages`, { json: { text } }),
        participants: (orgId, missionId) => request<MissionParticipants>(`${one(orgId, missionId)}/participants`),
        setParticipant: (orgId, missionId, userId, role, existing) =>
          existing
            ? request<MissionParticipants>(`${one(orgId, missionId)}/participants/${enc(userId)}`, {
                method: "PATCH",
                json: { role },
              })
            : request<MissionParticipants>(`${one(orgId, missionId)}/participants`, { json: { userId, role } }),
        removeParticipant: (orgId, missionId, userId) =>
          request<void>(`${one(orgId, missionId)}/participants/${enc(userId)}`, { method: "DELETE" }),
        transfer: (orgId, missionId, input) =>
          request<Mission & { code?: string }>(`${one(orgId, missionId)}/transfer`, { json: input }),
        setMachine: (orgId, missionId, machineId, repoDir) =>
          request<Mission>(`${one(orgId, missionId)}/machine`, {
            method: "PUT",
            json: { machineId, ...(repoDir ? { repoDir } : {}) },
          }),
        setExecutor: (orgId, missionId, executor) =>
          request<Mission>(`${one(orgId, missionId)}/executor`, { method: "PUT", json: { executor } }),
        setCommandApproval: (orgId, missionId, commandApproval) =>
          request<{ commandApproval: CommandApproval }>(`${one(orgId, missionId)}/command-approval`, {
            method: "PUT",
            json: { commandApproval },
          }),
        settings: (orgId, missionId) => request<MissionSettings>(`${one(orgId, missionId)}/settings`),
        brain: (orgId, missionId) => request<MissionBrain>(`${one(orgId, missionId)}/brain`),
        setBrain: (orgId, missionId, input) =>
          request<MissionBrain>(`${one(orgId, missionId)}/brain`, { method: "PUT", json: input }),
        removeCommandRule: (orgId, missionId, ruleId) =>
          request<{ rules: MissionCommandRule[] }>(`${one(orgId, missionId)}/command-rules/${enc(ruleId)}`, {
            method: "DELETE",
          }),
        setResumeTasks: (orgId, missionId, resumeTasks) =>
          request<Mission>(one(orgId, missionId), { method: "PATCH", json: { resumeTasks } }),
        setAgentDefault: (orgId, agentId, commandApproval) =>
          request<{ commandApproval: CommandApproval }>(
            `${org(orgId)}/agents/${enc(agentId)}/mission-command-approval`,
            { method: "PUT", json: { commandApproval } },
          ),
        decisions: async (orgId, missionId) =>
          (await request<{ decisions: MissionDecision[] }>(`${one(orgId, missionId)}/decisions`)).decisions,
        commands: (orgId, missionId) =>
          request<{ commands: MissionCommand[]; rules: string[] }>(`${one(orgId, missionId)}/commands`),
        decideCommand: (orgId, missionId, commandId, decision) =>
          request<MissionCommand>(`${one(orgId, missionId)}/commands/${enc(commandId)}/decide`, {
            json: { decision },
          }),
        retryCommand: (orgId, missionId, input) =>
          request<{ rules: string[]; delivered: boolean }>(`${one(orgId, missionId)}/commands/retry`, {
            json: input,
          }),
        deliveries: (orgId, missionId) => request<MissionDelivery[]>(`${one(orgId, missionId)}/deliveries`),
        checkDelivery: (orgId, missionId, deliveryId, itemId, checked) =>
          request<MissionDelivery>(`${one(orgId, missionId)}/deliveries/${enc(deliveryId)}/checks/${enc(itemId)}`, {
            method: "PUT",
            json: { checked },
          }),
        acceptDelivery: (orgId, missionId, deliveryId, input) =>
          request<Mission>(`${one(orgId, missionId)}/deliveries/${enc(deliveryId)}/accept`, { json: input }),
        requestDeliveryChanges: (orgId, missionId, deliveryId, note) =>
          request<Mission>(`${one(orgId, missionId)}/deliveries/${enc(deliveryId)}/changes`, { json: { note } }),
        choose: (orgId, missionId, decisionId, option) =>
          request<MissionDecision>(`${one(orgId, missionId)}/decisions/${enc(decisionId)}/choose`, {
            json: { option },
          }),
        opinion: (orgId, missionId, decisionId, option) =>
          request<MissionDecision>(`${one(orgId, missionId)}/decisions/${enc(decisionId)}/opinion`, {
            json: { option },
          }),
        approveProvisional: async (orgId, missionId) =>
          (
            await request<{ decisions: MissionDecision[] }>(`${one(orgId, missionId)}/decisions/approve-provisional`, {
              json: {},
            })
          ).decisions,
        reviews: async (orgId, missionId) =>
          (await request<{ reviews: MissionReview[] }>(`${one(orgId, missionId)}/reviews`)).reviews,
        review: (orgId, missionId, reviewId, outcome, note) =>
          request<MissionReview>(`${one(orgId, missionId)}/reviews/${enc(reviewId)}/${outcome}`, {
            json: note ? { note } : {},
          }),
        suggestion: (orgId, missionId, messageId, outcome) =>
          request<{ messageId: string; status: "accepted" | "declined" }>(
            `${one(orgId, missionId)}/suggestions/${enc(messageId)}/${outcome}`,
            { json: {} },
          ),
        files: (orgId, missionId) => request<MissionFiles>(`${one(orgId, missionId)}/files`),
        summary: (orgId, missionId) => request<MissionSummary>(`${one(orgId, missionId)}/summary`),
        plan: (orgId, missionId) => request<MissionPlan>(`${one(orgId, missionId)}/plan`),
      };
    })(),
    routines: {
      list: async (orgId) => (await request<{ routines: Routine[] }>(`${org(orgId)}/routines`)).routines,
      parseSchedule: (orgId, phrase, timezone) =>
        request<ScheduleParse>(`${org(orgId)}/routines/parse-schedule`, { json: { phrase, timezone } }),
      create: (orgId, input) => request<Routine>(`${org(orgId)}/routines`, { json: input }),
      setActive: (orgId, id, active) =>
        request<Routine>(`${org(orgId)}/routines/${enc(id)}`, { method: "PATCH", json: { active } }),
      runNow: (orgId, id) => request<Routine>(`${org(orgId)}/routines/${enc(id)}/run`, { json: {} }),
      stop: (orgId, id) => request<Routine>(`${org(orgId)}/routines/${enc(id)}/stop`, { json: {} }),
      takeOver: (orgId, id) => request<Routine>(`${org(orgId)}/routines/${enc(id)}/take-over`, { json: {} }),
      runs: async (orgId, id) => (await request<{ runs: RoutineRun[] }>(`${org(orgId)}/routines/${enc(id)}/runs`)).runs,
      parseRule: (orgId, phrase, timezone) =>
        request<RuleInfo>(`${org(orgId)}/routines/parse-rule`, { json: { phrase, ...(timezone ? { timezone } : {}) } }),
      describeRule: (orgId, rule) => request<RuleInfo>(`${org(orgId)}/routines/describe-rule`, { json: { rule } }),
      update: (orgId, id, patch) =>
        request<Routine>(`${org(orgId)}/routines/${enc(id)}`, { method: "PATCH", json: patch }),
      remove: (orgId, id) => request<void>(`${org(orgId)}/routines/${enc(id)}`, { method: "DELETE" }),
      duplicate: (orgId, id, name) =>
        request<Routine>(`${org(orgId)}/routines/${enc(id)}/duplicate`, { json: name ? { name } : {} }),
    },
    wiki: {
      tree: async (orgId) => (await request<{ pages: WikiPageSummary[] }>(`${org(orgId)}/wiki/pages`)).pages,
      get: (orgId, slug) => request<WikiPage>(`${org(orgId)}/wiki/pages/${enc(slug)}`),
      search: async (orgId, q) =>
        (await request<{ pages: WikiPageSummary[] }>(`${org(orgId)}/wiki/search`, { query: { q } })).pages,
      create: (orgId, input) => request<WikiPage>(`${org(orgId)}/wiki/pages`, { json: input }),
      update: (orgId, slug, input) =>
        request<WikiPage>(`${org(orgId)}/wiki/pages/${enc(slug)}`, { method: "PUT", json: input }),
      rename: (orgId, slug, title) =>
        request<WikiPage>(`${org(orgId)}/wiki/pages/${enc(slug)}/rename`, { json: { title } }),
      history: async (orgId, slug) =>
        (await request<{ versions: WikiVersion[] }>(`${org(orgId)}/wiki/pages/${enc(slug)}/history`)).versions,
      version: (orgId, slug, version) =>
        request<{ version: number; body: string }>(`${org(orgId)}/wiki/pages/${enc(slug)}/versions/${version}`),
      graph: (orgId) => request<WikiGraph>(`${org(orgId)}/wiki/graph`),
      move: (orgId, slug, folder) =>
        request<WikiPage>(`${org(orgId)}/wiki/pages/${enc(slug)}/move`, { json: { folder } }),
      lock: (orgId, slug, locked) =>
        request<WikiPage>(`${org(orgId)}/wiki/pages/${enc(slug)}/lock`, { json: { locked } }),
      pin: (orgId, slug, pinned) =>
        request<WikiPage>(`${org(orgId)}/wiki/pages/${enc(slug)}/pin`, { json: { pinned } }),
      remove: async (orgId, slug) => {
        await request<void>(`${org(orgId)}/wiki/pages/${enc(slug)}`, { method: "DELETE" });
      },
      reads: (orgId) => request<WikiTopRead[]>(`${org(orgId)}/wiki/reads`),
      import: (orgId, input) => request<WikiImportResult>(`${org(orgId)}/wiki/import`, { json: input }),
      append: (orgId, slug, input) =>
        request<WikiPage>(`${org(orgId)}/wiki/pages/${enc(slug)}/append`, { json: input }),
    },
    notifications: {
      list: (orgId, query = {}) =>
        request<NotificationPage>(`${org(orgId)}/notifications`, {
          query: { filter: query.filter, cursor: query.cursor, limit: query.limit },
        }),
      count: (orgId) => request<NotificationCount>(`${org(orgId)}/notifications/count`),
      read: (orgId, id, read) =>
        request<AppNotification>(`${org(orgId)}/notifications/${enc(id)}/read`, { json: { read } }),
      done: (orgId, id, done) =>
        request<AppNotification>(`${org(orgId)}/notifications/${enc(id)}/done`, { json: { done } }),
      snooze: (orgId, id, until) =>
        request<AppNotification>(`${org(orgId)}/notifications/${enc(id)}/snooze`, { json: { until } }),
      readAll: (orgId, filter) =>
        request<{ ids: string[] }>(`${org(orgId)}/notifications/read-all`, { json: filter ? { filter } : {} }),
    },
    forum: {
      list: async (orgId) => (await request<{ topics: ForumTopic[] }>(`${org(orgId)}/forum/topics`)).topics,
      get: (orgId, topicId) => request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}`),
      create: (orgId, input) => request<ForumTopicDetail>(`${org(orgId)}/forum/topics`, { json: input }),
      post: (orgId, topicId, input) =>
        request<ForumPost>(`${org(orgId)}/forum/topics/${enc(topicId)}/posts`, { json: input }),
      conclude: (orgId, topicId) =>
        request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}/conclude`, { json: {} }),
      cancel: (orgId, topicId) =>
        request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}/cancel`, { json: {} }),
      pass: (orgId, topicId) =>
        request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}/pass`, { json: {} }),
      resume: (orgId, topicId) =>
        request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}/resume`, { json: {} }),
      participants: (orgId, topicId, input) =>
        request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}/participants`, {
          method: "PUT",
          json: input,
        }),
      createIssues: (orgId, topicId, items) =>
        request<{ numbers: number[]; issues: { id: string; number: number; title: string }[] }>(
          `${org(orgId)}/forum/topics/${enc(topicId)}/issues`,
          { json: { items } },
        ),
      acceptSuggestion: (orgId, messageId, overrides) =>
        request<{ topic: ForumTopicDetail; suggestion: ForumSuggestion }>(
          `${org(orgId)}/forum/suggestions/${enc(messageId)}/accept`,
          { json: overrides ?? {} },
        ),
      dismissSuggestion: (orgId, messageId) =>
        request<{ suggestion: ForumSuggestion }>(`${org(orgId)}/forum/suggestions/${enc(messageId)}/dismiss`, {
          json: {},
        }),
    },
    calendar: {
      range: (orgId, from, to) => request<CalendarRange>(`${org(orgId)}/calendar`, { query: { from, to } }),
      create: (orgId, input) => request<CalendarEvent>(`${org(orgId)}/calendar/events`, { json: input }),
      confirmProposal: (orgId, id) =>
        request<CalendarEvent>(`${org(orgId)}/calendar/proposals/${enc(id)}/confirm`, { json: {} }),
      dismissProposal: (orgId, id) =>
        request<void>(`${org(orgId)}/calendar/proposals/${enc(id)}/dismiss`, { json: {} }),
      update: (orgId, id, patch, series) =>
        request<CalendarEvent>(`${org(orgId)}/calendar/events/${enc(id)}`, {
          method: "PATCH",
          json: { ...patch, ...(series ?? {}) },
        }),
      remove: (orgId, id, series) =>
        request<void>(`${org(orgId)}/calendar/events/${enc(id)}`, {
          method: "DELETE",
          ...(series ? { query: series } : {}),
        }),
    },
    customConnectors: {
      list: async (orgId) => (await request<{ servers: CustomServer[] }>(`${org(orgId)}/connectors/custom`)).servers,
      connect: (orgId, input) => request<CustomConnectStart>(`${org(orgId)}/connectors/custom`, { json: input }),
      refresh: (orgId, serverId) =>
        request<CustomServer>(`${org(orgId)}/connectors/custom/${enc(serverId)}/refresh`, { json: {} }),
      saveTools: (orgId, serverId, input) =>
        request<CustomServer>(`${org(orgId)}/connectors/custom/${enc(serverId)}/tools`, {
          method: "PUT",
          json: input,
        }),
      disconnect: (orgId, serverId) =>
        request<void>(`${org(orgId)}/connectors/custom/${enc(serverId)}`, { method: "DELETE" }),
    },
    questions: {
      answer: (orgId, questionId, input) =>
        request<AgentQuestion>(`${org(orgId)}/questions/${enc(questionId)}/answer`, { json: input }),
    },
    secrets: {
      deliver: (orgId, requestId, box) =>
        request<SecretRequest>(`${org(orgId)}/secret-requests/${enc(requestId)}/deliver`, { json: { box } }),
      decline: (orgId, requestId) =>
        request<SecretRequest>(`${org(orgId)}/secret-requests/${enc(requestId)}/decline`, { json: {} }),
      list: async (orgId, agentId) =>
        (await request<{ secrets: AgentSecret[] }>(`${org(orgId)}/agents/${enc(agentId)}/secrets`)).secrets,
      remove: (orgId, agentId, name, machineId) =>
        request<void>(
          `${org(orgId)}/agents/${enc(agentId)}/secrets/${enc(name)}${machineId ? `?machineId=${enc(machineId)}` : ""}`,
          { method: "DELETE" },
        ),
    },
    proposals: {
      list: async (orgId) => (await request<{ proposals: Proposal[] }>(`${org(orgId)}/proposals`)).proposals,
      accept: (orgId, id, text) =>
        request<Proposal>(`${org(orgId)}/proposals/${enc(id)}/accept`, { json: text === undefined ? {} : { text } }),
      refuse: (orgId, id) => request<Proposal>(`${org(orgId)}/proposals/${enc(id)}/refuse`, { json: {} }),
    },
    repositories: {
      get: async (orgId, agentId) =>
        (await request<{ repositories: string[] }>(`${org(orgId)}/agents/${enc(agentId)}/repositories`)).repositories,
      set: async (orgId, agentId, repositories) =>
        (
          await request<{ repositories: string[] }>(`${org(orgId)}/agents/${enc(agentId)}/repositories`, {
            method: "PUT",
            json: { repositories },
          })
        ).repositories,
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
