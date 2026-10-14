import type { ApiClient, HttpApi } from "@/api/client";
import { ApiError } from "@/api/http";
import { createMockApi } from "@/api/mock";
import type {
  Agent,
  Approval,
  Channel,
  ChannelMember,
  Connection,
  ConnectorCatalog,
  Credential,
  InvitationWithStatus,
  Me,
  Member,
  Message,
  Role,
  Run,
  ScopeGrant,
} from "@/api/types";

export const NOW = new Date("2026-10-14T13:44:00.000Z");
export const ORG_ID = "00000000-0000-4000-8000-000000000001";
export const GENERAL_ID = "00000000-0000-4000-8000-0000000000c1";
export const ENG_ID = "00000000-0000-4000-8000-0000000000c2";
export const ADA_ID = "00000000-0000-4000-8000-0000000000a1";
export const ATLAS_ID = "00000000-0000-4000-8000-0000000000a2";

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

export interface FakeState {
  me: Me | null;
  members: Member[];
  agents: Agent[];
  channels: Channel[];
  channelMembers: Record<string, ChannelMember[]>;
  messages: Message[];
  invitations: InvitationWithStatus[];
  credentials: Credential[];
  approvals: Approval[];
  connections: Connection[];
  scopes: Record<string, ScopeGrant[]>;
  runs: Run[];
  platformKey: boolean;
  online: Set<string>;
  calls: { method: string; args: unknown[] }[];
  context?: string;
}

/** A small in-memory backend with the data of the approved screens ("Acme"). */
export function seedState(overrides: Partial<FakeState> = {}): FakeState {
  const walter: Member = {
    userId: "u-walter",
    name: "Walter",
    email: "walter@acme.com.br",
    image: null,
    role: "owner",
    joinedAt: minutesAgo(60 * 24 * 30),
  };
  const joao: Member = {
    userId: "u-joao",
    name: "João",
    email: "joao@acme.com.br",
    image: null,
    role: "admin",
    joinedAt: minutesAgo(60 * 24 * 20),
  };
  const agent = (id: string, name: string, role: string, owner: string, budget: number | null): Agent => ({
    id,
    name,
    handle: name.toLowerCase(),
    role,
    instructions: `Instruções de ${name}.`,
    model: "claude-sonnet-5-5",
    ownerUserId: owner,
    hasCredential: true,
    monthlyBudgetUsd: budget,
    createdAt: minutesAgo(60 * 24 * 10),
  });
  return {
    me: {
      user: { id: walter.userId, name: walter.name, email: walter.email, image: null },
      organizations: [{ id: ORG_ID, name: "Acme", role: "owner" }],
    },
    members: [walter, joao],
    agents: [agent(ADA_ID, "Ada", "Dev", "u-joao", 40), agent(ATLAS_ID, "Atlas", "Ops", "u-joao", 20)],
    channels: [
      {
        id: ENG_ID,
        name: "eng",
        topic: "Código, erros e deploys",
        visibility: "public",
        isMember: true,
        createdAt: minutesAgo(9999),
      },
      { id: GENERAL_ID, name: "general", topic: "", visibility: "public", isMember: true, createdAt: minutesAgo(9999) },
    ],
    channelMembers: {
      [ENG_ID]: [
        { type: "person", id: "u-walter" },
        { type: "person", id: "u-joao" },
        { type: "agent", id: ADA_ID },
        { type: "agent", id: ATLAS_ID },
      ],
      [GENERAL_ID]: [{ type: "person", id: "u-walter" }],
    },
    messages: [
      {
        id: "m-1",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "@ada o login está devolvendo 401 desde o deploy das 9h. Consegue olhar?",
        mentionedAgentIds: [ADA_ID],
        agentRunId: null,
        createdAt: minutesAgo(62),
      },
      {
        id: "m-2",
        channelId: ENG_ID,
        threadId: "m-1",
        author: { type: "agent", id: ADA_ID },
        body: "Achei a causa: o refresh compara `expires_at` em segundos com milissegundos.",
        mentionedAgentIds: [],
        agentRunId: "r-1",
        createdAt: minutesAgo(61),
      },
      {
        id: "msg-card",
        channelId: ENG_ID,
        threadId: "m-1",
        author: { type: "agent", id: ADA_ID },
        body: "",
        mentionedAgentIds: [],
        agentRunId: "r-1",
        meta: { approvalId: "ap-merge" },
        createdAt: minutesAgo(60),
      },
    ],
    invitations: [],
    credentials: [
      {
        id: "cred-1",
        provider: "anthropic",
        label: "Anthropic da Acme",
        keyHint: "7f2a",
        createdAt: minutesAgo(9999),
        revokedAt: null,
      },
    ],
    approvals: [
      approval(
        "ap-merge",
        ADA_ID,
        "Merge PR #42 into main",
        "github.merge_pull_request · agentes-chat/app · PR 42",
        2,
        "msg-card",
      ),
      approval(
        "ap-deploy",
        ATLAS_ID,
        "Run deploy workflow",
        "github.run_workflow · deploy.yml · main",
        14,
        null,
        "github:actions.run",
        "run_workflow",
      ),
      {
        ...approval("ap-old", ATLAS_ID, "Run rollback workflow", "github.run_workflow · rollback.yml", 26 * 60, null),
        status: "approved",
        decidedByUserId: "u-joao",
        decidedAt: minutesAgo(22 * 60),
        canDecide: false,
      },
    ],
    connections: [
      {
        id: "conn-gh",
        connector: "github",
        label: "GitHub",
        serverUrl: "https://api.githubcopilot.com/mcp/",
        authType: "oauth",
        accountLabel: "acme",
        tokenExpiresAt: null,
        createdAt: minutesAgo(60 * 24 * 5),
        revokedAt: null,
      },
    ],
    scopes: {
      [ADA_ID]: [
        { connectionId: null, scope: "context:read" },
        { connectionId: null, scope: "memory:write" },
        { connectionId: "conn-gh", scope: "github:repo.read" },
        { connectionId: "conn-gh", scope: "github:pr.merge" },
      ],
    },
    runs: [
      run("run-1", ADA_ID, "@ada o login está devolvendo 401", 1240, 0.004, 62),
      run("run-2", ADA_ID, "revisa o PR #39 da Marina", 6880, 0.021, 60 * 24),
    ],
    platformKey: true,
    online: new Set(["u-walter"]),
    calls: [],
    ...overrides,
  };
}

function approval(
  id: string,
  agentId: string,
  title: string,
  detail: string,
  minutes: number,
  messageId: string | null,
  scope = "github:pr.merge",
  tool = "merge_pull_request",
): Approval {
  return {
    id,
    runId: `run-${id}`,
    agentId,
    channelId: ENG_ID,
    threadId: "m-1",
    messageId,
    tool,
    scope,
    title,
    detail,
    params: {},
    status: "pending",
    expiresAt: new Date(Date.now() + (24 * 60 - minutes) * 60_000).toISOString(),
    createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    decidedByUserId: null,
    decidedAt: null,
    reason: null,
    canDecide: true,
  };
}

function run(id: string, agentId: string, what: string, tokens: number, costUsd: number, minutes: number): Run {
  return {
    id,
    agentId,
    channelId: ENG_ID,
    threadId: "m-1",
    trigger: "mention",
    status: "done",
    error: null,
    what,
    turns: 1,
    inputTokens: tokens - 100,
    outputTokens: 100,
    costUsd,
    createdAt: minutesAgo(minutes),
    finishedAt: minutesAgo(minutes - 1),
  };
}

/** The shape of `GET /api/app/connectors/catalog` (subset of the real catalog). */
export const CATALOG: ConnectorCatalog = {
  connectors: [
    {
      id: "github",
      label: "GitHub",
      description: "Repositories, pull requests, issues and Actions.",
      auth: ["oauth", "api_key"],
      oauthConfigured: true,
      needsServerUrl: false,
      scopes: [
        {
          id: "github:repo.read",
          label: "Read code",
          description: "Read files, commits and search code.",
          sensitive: false,
        },
        {
          id: "github:pr.read",
          label: "Read pull requests",
          description: "List and read pull requests.",
          sensitive: false,
        },
        { id: "github:pr.write", label: "Open pull requests", description: "Open pull requests.", sensitive: false },
        { id: "github:pr.merge", label: "Merge pull requests", description: "Merge a pull request.", sensitive: true },
      ],
      tools: [{ name: "merge_pull_request", scope: "github:pr.merge", sensitive: true }],
    },
    {
      id: "sentry",
      label: "Sentry",
      description: "Errors, issues and events.",
      auth: ["oauth", "api_key"],
      oauthConfigured: false,
      needsServerUrl: false,
      scopes: [{ id: "sentry:issues.read", label: "Read errors", description: "Search issues.", sensitive: false }],
      tools: [],
    },
    {
      id: "drive",
      label: "Google Drive",
      description: "Search, read and write documents (any Drive-like MCP server).",
      auth: ["oauth", "api_key"],
      oauthConfigured: false,
      needsServerUrl: true,
      scopes: [
        { id: "drive:files.read", label: "Read documents", description: "Search and read files.", sensitive: false },
      ],
      tools: [],
    },
  ],
  builtinScopes: [
    { id: "context:read", label: "Read context", description: "Search messages.", sensitive: false },
    { id: "memory:write", label: "Remember", description: "Save notes.", sensitive: false },
    { id: "drive:write", label: "Write files", description: "Create reports.", sensitive: false },
  ],
};

let n = 0;
const id = (prefix: string) => `${prefix}-${++n}`;

/** The HTTP half of the client, over `FakeState`. Records every call in `state.calls`. */
export function createFakeHttpApi(state: FakeState): HttpApi {
  const log = (method: string, ...args: unknown[]): void => {
    state.calls.push({ method, args });
  };
  const requireMe = () => {
    if (!state.me) throw new ApiError(401, "unauthorized", "Sign in to continue");
    return state.me;
  };
  return {
    system: { health: async () => ({ status: "ok", version: "test", edition: "cloud" }) },
    account: {
      authConfig: async () => ({ socialProviders: { google: false, github: true }, signupOpen: true, firstRun: false }),
      me: async () => state.me,
    },
    orgs: {
      create: async (input) => {
        log("orgs.create", input);
        const me = requireMe();
        const orgId = id("org");
        const general = id("chan");
        me.organizations.push({ id: orgId, name: input.name, role: "owner" });
        state.channels.push({
          id: general,
          name: "general",
          topic: "",
          visibility: "public",
          isMember: true,
          createdAt: NOW.toISOString(),
        });
        return {
          organization: { id: orgId, name: input.name, role: "owner", context: input.context },
          generalChannelId: general,
        };
      },
      get: async (orgId) => ({ id: orgId, name: "Acme", role: "owner", context: "" }),
      update: async (orgId, input) => log("orgs.update", orgId, input),
      members: async () => state.members,
      changeRole: async (orgId, userId, role: Role) => {
        log("orgs.changeRole", orgId, userId, role);
        const m = state.members.find((x) => x.userId === userId);
        if (m) m.role = role;
      },
      removeMember: async (orgId, userId) => log("orgs.removeMember", orgId, userId),
      invitations: async () => structuredClone(state.invitations),
      invite: async (orgId, input) => {
        log("orgs.invite", orgId, input);
        if (state.members.some((m) => m.email === input.email))
          throw new ApiError(409, "conflict", `${input.email} is already a member`);
        const invitation = newInvitation(input.email, input.role);
        state.invitations.push(invitation);
        return { invitation, url: `http://localhost:3000/invite/tok-${invitation.id}` };
      },
      revokeInvitation: async (orgId, invitationId) => {
        log("orgs.revokeInvitation", orgId, invitationId);
        state.invitations = state.invitations.filter((i) => i.id !== invitationId);
      },
      previewInvitation: async (token) =>
        token === "valid" ? { orgName: "Acme", email: "marina@acme.com.br", role: "member" } : null,
      acceptInvitation: async (token) => {
        log("orgs.acceptInvitation", token);
        return { orgId: ORG_ID };
      },
      settings: async () => ({
        name: "Acme",
        context: state.context ?? "",
        defaultCredentialId: null,
        routerModel: null,
        summaryModel: null,
        timezone: "America/Sao_Paulo",
      }),
      updateSettings: async (orgId, input) => {
        log("orgs.updateSettings", orgId, input);
        if (input.context !== undefined) state.context = input.context;
        return {
          name: input.name ?? "Acme",
          context: state.context ?? "",
          defaultCredentialId: input.defaultCredentialId ?? null,
          routerModel: null,
          summaryModel: null,
          timezone: input.timezone ?? "America/Sao_Paulo",
        };
      },
      overview: async () => ({
        name: "Acme",
        role: state.me?.organizations[0]?.role ?? "member",
        people: state.members.length,
        agents: state.agents.length,
        myAgentsSpendUsd: 15.4,
        approvalsWaitingForMe: state.approvals.filter((a) => a.status === "pending" && a.canDecide).length,
      }),
      people: async () =>
        state.members.map((m) => ({
          ...m,
          online: state.online.has(m.userId),
          lastSeenAt: state.online.has(m.userId) ? new Date().toISOString() : minutesAgo(60),
        })),
      allInvitations: async () => structuredClone(state.invitations),
      inviteMany: async (orgId, input) => {
        log("orgs.inviteMany", orgId, input);
        return input.emails.map((email) => {
          if (state.members.some((m) => m.email === email)) return { email, status: "already_member" as const };
          if (state.invitations.some((i) => i.email === email)) return { email, status: "already_invited" as const };
          const inv = newInvitation(email, input.role);
          state.invitations.push(inv);
          return {
            email,
            status: "invited" as const,
            invitationId: inv.id,
            url: `http://localhost:3000/invite/tok-${inv.id}`,
          };
        });
      },
      resendInvitation: async (orgId, invitationId) => {
        log("orgs.resendInvitation", orgId, invitationId);
        const inv = state.invitations.find((i) => i.id === invitationId);
        if (inv) {
          inv.status = "pending";
          inv.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
        }
        return { url: `http://localhost:3000/invite/tok-new-${invitationId}`, expiresAt: inv?.expiresAt ?? "" };
      },
      usageReport: async () => ({
        since: minutesAgo(60 * 24 * 14),
        totalUsd: 15.9,
        byKind: [
          { kind: "agent", calls: 154, partialCalls: 0, inputTokens: 3_200_000, outputTokens: 110_000, costUsd: 15.4 },
          { kind: "router", calls: 80, partialCalls: 0, inputTokens: 90_000, outputTokens: 4_000, costUsd: 0.5 },
        ],
        agents: [],
      }),
    },
    agents: {
      list: async () => state.agents,
      create: async (orgId, input) => {
        log("agents.create", orgId, input);
        const agent: Agent = {
          id: id("agent"),
          name: input.name,
          handle: input.handle,
          role: input.role ?? "",
          instructions: input.instructions ?? "",
          model: input.model ?? "claude-sonnet-5-5",
          ownerUserId: input.ownerUserId ?? null,
          hasCredential: Boolean(input.credentialId),
          monthlyBudgetUsd: input.monthlyBudgetUsd ?? null,
          createdAt: NOW.toISOString(),
        };
        state.agents.push(agent);
        return agent;
      },
      update: async (orgId, agentId, input) => {
        log("agents.update", orgId, agentId, input);
        const agent = state.agents.find((a) => a.id === agentId);
        if (!agent) throw new ApiError(404, "not_found", "Agent not found");
        Object.assign(agent, input);
        return { ...agent };
      },
      archive: async (orgId, agentId) => log("agents.archive", orgId, agentId),
      models: async () => ({
        defaultModel: "claude-sonnet-5-5",
        models: [
          {
            id: "claude-sonnet-5-5",
            label: "Claude Sonnet 5.5",
            provider: "anthropic",
            inputUsdPerMTok: 2,
            outputUsdPerMTok: 10,
          },
          {
            id: "claude-opus-5-5",
            label: "Claude Opus 5.5",
            provider: "anthropic",
            inputUsdPerMTok: 4,
            outputUsdPerMTok: 20,
          },
          {
            id: "claude-haiku-5-5",
            label: "Claude Haiku 5.5",
            provider: "anthropic",
            inputUsdPerMTok: 0.1,
            outputUsdPerMTok: 0.5,
          },
        ],
      }),
      credentials: async () => state.credentials,
      addCredential: async (orgId, input) => {
        log("agents.addCredential", orgId, { ...input, apiKey: "[redacted]" });
        const cred: Credential = {
          id: id("cred"),
          provider: "anthropic",
          label: input.label,
          keyHint: input.apiKey.slice(-4),
          createdAt: NOW.toISOString(),
          revokedAt: null,
        };
        state.credentials.push(cred);
        return cred;
      },
      rotateCredential: async (orgId, credentialId, input) => {
        log("agents.rotateCredential", orgId, credentialId, { apiKey: "[redacted]" });
        const cred = state.credentials.find((c) => c.id === credentialId);
        if (!cred) throw new ApiError(404, "not_found", "Credential not found");
        cred.keyHint = input.apiKey.slice(-4);
        return { ...cred };
      },
      removeCredential: async (orgId, credentialId, purge) => {
        log("agents.removeCredential", orgId, credentialId, purge);
        state.credentials = state.credentials.filter((c) => c.id !== credentialId);
      },
      platformKeyAvailable: async () => state.platformKey,
      detail: async (_orgId, agentId) => {
        const a = state.agents.find((x) => x.id === agentId);
        if (!a) throw new ApiError(404, "not_found", "Agent not found");
        const channels = Object.entries(state.channelMembers)
          .filter(([, ms]) => ms.some((m) => m.type === "agent" && m.id === agentId))
          .map(([cid]) => ({ id: cid, name: state.channels.find((c) => c.id === cid)?.name ?? "", autoReply: false }));
        return {
          ...a,
          credentialId: a.hasCredential ? "cred-1" : null,
          spentThisMonthUsd: agentId === ADA_ID ? 12.3 : 3.1,
          reservedUsd: 0,
          tokensThisMonth: agentId === ADA_ID ? 3_100_000 : 210_000,
          runsThisMonth: agentId === ADA_ID ? 142 : 12,
          pendingApprovals: state.approvals.filter((x) => x.agentId === agentId && x.status === "pending").length,
          channels,
        };
      },
      channels: async () => [],
      setChannels: async (orgId, agentId, channels) => {
        log("agents.setChannels", orgId, agentId, channels);
        for (const c of channels) {
          const list = state.channelMembers[c.channelId] ?? [];
          state.channelMembers[c.channelId] = list;
          list.push({ type: "agent", id: agentId });
        }
        return channels.map((c) => ({ id: c.channelId, name: "", autoReply: c.autoReply ?? false }));
      },
      runs: async (_orgId, filter = {}) => state.runs.filter((r) => !filter.agentId || r.agentId === filter.agentId),
      run: async (_orgId, runId) => {
        const r = state.runs.find((x) => x.id === runId);
        if (!r) throw new ApiError(404, "not_found", "Run not found");
        return { run: r, steps: [] };
      },
      usage: async () =>
        state.me?.organizations[0]?.role === "member"
          ? null
          : [
              {
                agentId: ADA_ID,
                handle: "ada",
                calls: 142,
                inputTokens: 3_000_000,
                outputTokens: 100_000,
                costUsd: 12.3,
              },
              {
                agentId: ATLAS_ID,
                handle: "atlas",
                calls: 12,
                inputTokens: 200_000,
                outputTokens: 10_000,
                costUsd: 3.1,
              },
            ],
    },
    chat: {
      channels: async () => state.channels,
      createChannel: async () => {
        throw new Error("not used");
      },
      join: async (orgId, channelId) => {
        log("chat.join", orgId, channelId);
        const c = state.channels.find((x) => x.id === channelId);
        if (c) c.isMember = true;
      },
      members: async (_orgId, channelId) => state.channelMembers[channelId] ?? [],
      update: async (orgId, channelId, input) => {
        log("chat.update", orgId, channelId, input);
        const c = state.channels.find((x) => x.id === channelId);
        if (!c) throw new ApiError(404, "not_found", "Channel not found");
        Object.assign(c, input);
        return { ...c };
      },
      roster: async (_orgId, channelId) =>
        (state.channelMembers[channelId] ?? []).map((m) =>
          m.type === "agent"
            ? {
                type: "agent" as const,
                id: m.id,
                name: state.agents.find((a) => a.id === m.id)?.name ?? "",
                handle: state.agents.find((a) => a.id === m.id)?.handle ?? null,
                autoReply: true,
                joinedAt: NOW.toISOString(),
              }
            : {
                type: "person" as const,
                id: m.id,
                name: state.members.find((p) => p.userId === m.id)?.name ?? "",
                handle: null,
                autoReply: null,
                joinedAt: NOW.toISOString(),
              },
        ),
      addMember: async (orgId, channelId, member) => {
        log("chat.addMember", orgId, channelId, member);
        const list = state.channelMembers[channelId] ?? [];
        state.channelMembers[channelId] = list;
        list.push("agentId" in member ? { type: "agent", id: member.agentId } : { type: "person", id: member.userId });
      },
      messages: async (_orgId, channelId, options = {}) => {
        const inChannel = state.messages.filter((m) => m.channelId === channelId);
        if (options.threadId) {
          const root = inChannel.find((m) => m.id === options.threadId);
          return [...(root ? [root] : []), ...inChannel.filter((m) => m.threadId === options.threadId)];
        }
        return inChannel.filter((m) => m.threadId === null);
      },
      post: async (orgId, channelId, input) => {
        log("chat.post", orgId, channelId, input);
        const message: Message = {
          id: id("msg"),
          channelId,
          threadId: input.threadId ?? null,
          author: { type: "person", id: state.me?.user.id ?? null },
          body: input.body,
          mentionedAgentIds: [],
          agentRunId: null,
          createdAt: new Date().toISOString(),
        };
        state.messages.push(message);
        return message;
      },
    },
    approvals: {
      list: async (_orgId, filter = {}) =>
        structuredClone(state.approvals).filter(
          (a) =>
            (!filter.agentId || a.agentId === filter.agentId) &&
            (!filter.status || (filter.status === "pending") === (a.status === "pending")),
        ),
      get: async (_orgId, id) => {
        const a = state.approvals.find((x) => x.id === id);
        if (!a) throw new ApiError(404, "not_found", "Approval not found");
        return structuredClone(a);
      },
      approve: async (orgId, id, reason) => decide(orgId, id, "approved", reason),
      refuse: async (orgId, id, reason) => decide(orgId, id, "refused", reason),
    },
    connectors: {
      catalog: async () => CATALOG,
      list: async () => structuredClone(state.connections),
      connectWithKey: async (orgId, input) => {
        log("connectors.connectWithKey", orgId, { ...input, apiKey: "[redacted]" });
        const conn: Connection = {
          id: id("conn"),
          connector: input.connector,
          label: CATALOG.connectors.find((d) => d.id === input.connector)?.label ?? input.connector,
          serverUrl: input.serverUrl ?? "https://example.test/mcp",
          authType: "api_key",
          accountLabel: null,
          tokenExpiresAt: null,
          createdAt: new Date().toISOString(),
          revokedAt: null,
        };
        state.connections.push(conn);
        return conn;
      },
      startOAuth: async (orgId, connector, input) => {
        log("connectors.startOAuth", orgId, connector, input);
        return `https://github.com/login/oauth/authorize?state=s&return=${encodeURIComponent(input.returnTo)}`;
      },
      disconnect: async (orgId, connectionId) => {
        log("connectors.disconnect", orgId, connectionId);
        state.connections = state.connections.filter((c) => c.id !== connectionId);
        for (const k of Object.keys(state.scopes))
          state.scopes[k] = (state.scopes[k] ?? []).filter((g) => g.connectionId !== connectionId);
      },
    },
    scopes: {
      get: async (_orgId, agentId) => structuredClone(state.scopes[agentId] ?? []),
      set: async (orgId, agentId, grants) => {
        log("scopes.set", orgId, agentId, grants);
        state.scopes[agentId] = grants;
        return grants;
      },
    },
  };

  function decide(orgId: string, approvalId: string, status: "approved" | "refused", reason?: string) {
    log(`approvals.${status === "approved" ? "approve" : "refuse"}`, orgId, approvalId, reason);
    const a = state.approvals.find((x) => x.id === approvalId);
    if (!a) throw new ApiError(404, "not_found", "Approval not found");
    if (a.status !== "pending") throw new ApiError(409, "conflict", "Already decided");
    Object.assign(a, {
      status,
      decidedByUserId: state.me?.user.id ?? null,
      decidedAt: new Date().toISOString(),
      reason: reason ?? null,
      canDecide: false,
    });
    return Promise.resolve({ ...a });
  }
}

function newInvitation(email: string, role: Role): InvitationWithStatus {
  return {
    id: id("inv"),
    email,
    role,
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

/** Full client: fake HTTP + the real in-memory mocks (seeded like development). */
export function createFakeApi(state: FakeState = seedState(), options: { seed?: boolean } = {}): ApiClient {
  const http = createFakeHttpApi(state);
  const mocks = createMockApi(
    {
      seed: options.seed ?? true,
      now: () => new Date(),
      lookup: {
        me: () => http.account.me(),
        agents: (orgId) => http.agents.list(orgId),
        channels: (orgId) => http.chat.channels(orgId),
        members: (orgId) => http.orgs.members(orgId),
      },
    },
    () => "http://localhost:3000",
  );
  return { ...http, ...mocks };
}
