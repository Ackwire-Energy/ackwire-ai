import type { HttpApi } from "./client";
import { ApiError, createFileRequester, createRequester, enc, type FetchLike } from "./http";
import type {
  ActiveRun,
  Agent,
  AgentAccess,
  AgentChannel,
  AgentComputer,
  AgentDetail,
  AgentQuestion,
  AgentSecret,
  AgentSkill,
  AgentUsage,
  Approval,
  Artifact,
  ArtifactDetail,
  ArtifactVersion,
  AuthConfig,
  BatchInviteResult,
  CalendarEvent,
  CalendarRange,
  Channel,
  ChannelMember,
  ComputerTarget,
  Connection,
  ConnectorCatalog,
  Credential,
  CustomConnectStart,
  CustomServer,
  DirectMessage,
  ForumPost,
  ForumTopic,
  ForumTopicDetail,
  Health,
  Invitation,
  InvitationPreview,
  InvitationWithStatus,
  Issue,
  IssueActivity,
  Machine,
  MachinePairing,
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
  Skill,
  SkillDetail,
  StorageConfig,
  StorageMigration,
  StorageTestResult,
  TrashedArtifact,
  UsageReport,
  WikiGraph,
  WikiImportResult,
  WikiPage,
  WikiPageSummary,
  WikiTopRead,
  WikiVersion,
} from "./types";

const org = (orgId: string) => `/api/app/organizations/${enc(orgId)}`;

/** The real backend: `/api/health` and `/api/app/*` (apps/server/src/routes/app). */
export function createHttpApi(fetchImpl?: FetchLike): HttpApi {
  const request = createRequester(fetchImpl);
  const files = createFileRequester(fetchImpl);
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
      me: () => nullOn(401, () => request<Me>("/api/app/me")),
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
      importFromGithub: (orgId, url) =>
        request<{ files: { path: string; text: string }[] }>(`${org(orgId)}/agent-imports/github`, { json: { url } }),
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
      cancelRun: (orgId, runId) => request<void>(`${org(orgId)}/runs/${enc(runId)}/cancel`, { json: {} }),
      activeRuns: async (orgId, channelId) => {
        const res = await nullOn(404, () =>
          request<{ runs: ActiveRun[] }>(`${org(orgId)}/channels/${enc(channelId)}/active-runs`),
        );
        return res ? res.runs : null;
      },
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
      createPairing: (orgId, input) => request<MachinePairing>(`${org(orgId)}/machines/pairings`, { json: input }),
      rename: (orgId, machineId, name) =>
        request<{ id: string; name: string }>(`${org(orgId)}/machines/${enc(machineId)}`, {
          method: "PATCH",
          json: { name },
        }),
      remove: (orgId, machineId) => request<void>(`${org(orgId)}/machines/${enc(machineId)}`, { method: "DELETE" }),
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
        return `${org(orgId)}/artifacts/${enc(id)}/file${qs ? `?${qs}` : ""}`;
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
      comment: (orgId, id, text) =>
        request<IssueActivity>(`${org(orgId)}/issues/${enc(id)}/comments`, { json: { text } }),
      askAgent: (orgId, id, agentId) =>
        request<Issue>(`${org(orgId)}/issues/${enc(id)}/ask-agent`, { json: { agentId } }),
    },
    routines: {
      list: async (orgId) => (await request<{ routines: Routine[] }>(`${org(orgId)}/routines`)).routines,
      parseSchedule: (orgId, phrase, timezone) =>
        request<ScheduleParse>(`${org(orgId)}/routines/parse-schedule`, { json: { phrase, timezone } }),
      create: (orgId, input) => request<Routine>(`${org(orgId)}/routines`, { json: input }),
      setActive: (orgId, id, active) =>
        request<Routine>(`${org(orgId)}/routines/${enc(id)}`, { method: "PATCH", json: { active } }),
      runNow: (orgId, id) => request<Routine>(`${org(orgId)}/routines/${enc(id)}/run`, { json: {} }),
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
    forum: {
      list: async (orgId) => (await request<{ topics: ForumTopic[] }>(`${org(orgId)}/forum/topics`)).topics,
      get: (orgId, topicId) => request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}`),
      create: (orgId, input) => request<ForumTopicDetail>(`${org(orgId)}/forum/topics`, { json: input }),
      post: (orgId, topicId, body) =>
        request<ForumPost>(`${org(orgId)}/forum/topics/${enc(topicId)}/posts`, { json: { body } }),
      conclude: (orgId, topicId) =>
        request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}/conclude`, { json: {} }),
      cancel: (orgId, topicId) =>
        request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}/cancel`, { json: {} }),
      participants: (orgId, topicId, input) =>
        request<ForumTopicDetail>(`${org(orgId)}/forum/topics/${enc(topicId)}/participants`, {
          method: "PUT",
          json: input,
        }),
      createIssues: (orgId, topicId, items) =>
        request<{ numbers: number[] }>(`${org(orgId)}/forum/topics/${enc(topicId)}/issues`, { json: { items } }),
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
