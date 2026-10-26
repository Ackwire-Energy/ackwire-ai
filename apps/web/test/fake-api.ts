import type {
  ActiveRun,
  Agent,
  AgentBrain,
  AgentQuestion,
  AgentSecret,
  AiStatus,
  ApiClient,
  AppNotification,
  Approval,
  AuthConfig,
  Channel,
  ChannelMember,
  Connection,
  ConnectorCatalog,
  ConnectorDef,
  Credential,
  GitHubAppInstallation,
  GitHubRepositories,
  HttpApi,
  ImportItemKind,
  ImportItemResult,
  InvitationPreview,
  InvitationWithStatus,
  InviteLink,
  JoinApproval,
  JoinRequest,
  Me,
  Member,
  Memory,
  Message,
  PlanAccountUsage,
  Proposal,
  ReactionCount,
  Role,
  Run,
  ScopeGrant,
  SearchHit,
  SecretRequest,
  ServerTelemetry,
  SignInOptions,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { createFakeAccess } from "./fakes/access";
import { createMockArtifacts } from "./fakes/artifacts";
import { createFakeBrowser, type FakeBrowser } from "./fakes/browser";
import type { MockContext } from "./fakes/context";
import { createMockCustomConnectors } from "./fakes/custom-connectors";
import { createFakeDatabases, type FakeDatabases } from "./fakes/databases";
import { createFakeForum } from "./fakes/forum";
import { createFakeMachines, type FakeMachines } from "./fakes/machines";
import { createFakeMail, type FakeMail } from "./fakes/mail";
import { createFakeMissions } from "./fakes/missions";
import { createFakeNotifications } from "./fakes/notifications";
import { createMockPlanning } from "./fakes/planning";
import { createFakeSandbox } from "./fakes/sandbox";
import { createFakeSkills } from "./fakes/skills";
import { createMockStorage } from "./fakes/storage";
import { createFakeThreads } from "./fakes/threads";
import { createFakeWiki } from "./fakes/wiki";

export const NOW = new Date("2026-10-14T13:44:00.000Z");
export const ORG_ID = "00000000-0000-4000-8000-000000000001";
export const GENERAL_ID = "00000000-0000-4000-8000-0000000000c1";
export const ENG_ID = "00000000-0000-4000-8000-0000000000c2";
export const ADA_ID = "00000000-0000-4000-8000-0000000000a1";
export const ATLAS_ID = "00000000-0000-4000-8000-0000000000a2";

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/** Real-time based (a plan window that reset reads as empty again): the usage views' windows. */
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** The MacBook's own Claude Code sign-in, shared by Ada and Atlas (the usage views, ADR 0063). */
function fakePlanAccount(money: boolean): PlanAccountUsage {
  const machineId = "00000000-0000-4000-8000-0000000000d1";
  return {
    key: `${machineId}:claude_code:computer`,
    machineId,
    machineName: "MacBook",
    kind: "claude_code",
    accountId: null,
    label: null,
    plan: "max",
    provider: null,
    ownerName: "Walter Lima",
    mine: true,
    email: null,
    signedOut: false,
    usage: {
      windows: [
        {
          kind: "five_hour",
          usedPercent: 62,
          resetsAt: hoursFromNow(2),
          agents: [{ agentId: ADA_ID, name: "Ada", percent: 62 }],
        },
        {
          kind: "seven_day",
          usedPercent: 41,
          resetsAt: hoursFromNow(72),
          agents: [
            { agentId: ADA_ID, name: "Ada", percent: 30 },
            { agentId: ATLAS_ID, name: "Atlas", percent: 11 },
          ],
        },
      ],
      source: "turn",
      at: new Date().toISOString(),
    },
    agents: [
      { agentId: ADA_ID, name: "Ada", tokens: 4_500_000, now: true },
      { agentId: ATLAS_ID, name: "Atlas", tokens: 600_000, now: true },
    ],
    monthTokens: 5_100_000,
    ...(money ? { equivalentUsd: 92 } : {}),
  };
}

export interface FakeState {
  me: Me | null;
  /** Overrides `account.authConfig` (default: GitHub only, sign-up open, the landing page on). */
  authConfig?: Partial<AuthConfig>;
  /** Overrides `account.signInOptions` (default: no account, sign-up allowed). */
  signInOptions?: SignInOptions;
  /** The server `account.phoneSignIn` names (default: https://agentes.chat). */
  phoneServer?: string;
  /** Questions someone else answered on the server (this tab still shows them open). */
  answeredElsewhere?: Set<string>;
  /** Secrets on agents' computers, by agent id (`secrets.list`). */
  agentSecrets?: Record<string, AgentSecret[]>;
  members: Member[];
  agents: Agent[];
  channels: Channel[];
  channelMembers: Record<string, ChannelMember[]>;
  messages: Message[];
  invitations: InvitationWithStatus[];
  credentials: Credential[];
  approvals: Approval[];
  connections: Connection[];
  /** GitHub App installations bound to the org (`githubApp.info`); undefined = none, app not installable. */
  githubApp?: { installable: boolean; installations: GitHubAppInstallation[] };
  /** What the organization's GitHub reaches (`githubApp.repositories`); unset = not connected. */
  githubRepos?: GitHubRepositories;
  /** Agents' GitHub repositories, in order (`repositories.get`); unset = every repository. */
  agentRepos?: Record<string, string[]>;
  scopes: Record<string, ScopeGrant[]>;
  runs: Run[];
  /** `GET …/channels/{id}/active-runs`; unset = the endpoint doesn't exist yet (404). */
  activeRuns?: Record<string, ActiveRun[]>;
  platformKey: boolean;
  /** What `agents.importFromGithub` returns per link (else a 400 like the backend's). */
  githubFiles?: Record<string, { path: string; text: string }[]>;
  online: Set<string>;
  memories: Memory[];
  proposals: Proposal[];
  reactions: Record<string, ReactionCount[]>;
  autoReply: Record<string, boolean>;
  dms: { channelId: string; with: { type: "person" | "agent"; id: string; name: string; handle: string | null } }[];
  calls: { method: string; args: unknown[] }[];
  context?: string;
  defaultCredentialId?: string | null;
  /** The workspace default agent budget (US$); 50 when unset. */
  defaultAgentBudgetUsd?: number;
  /** The workspace switch "Agentes conferem o que o time já fez" (on when unset). */
  actionCheck?: boolean;
  /** What agents did outside (search kind `action`), as the search returns it. */
  teamActions?: SearchHit[];
  /** My inbox (`notifications.*`); empty unless a test fills it. */
  notifications?: AppNotification[];
  /** `actions.undo`/`redo`/`undoMessage` fail for these receipt ids with this error (`action.changed_since`…). */
  actionErrors?: Record<string, ApiError>;
  /** Set by `createFakeApi`: `chat.post` with `openThread` marks the thread (the threads fake). */
  openThread?: (orgId: string, threadId: string, at: string) => Promise<void>;
  /** Make `chat.post` fail (optimistic send tests). */
  failPosts?: boolean;
  /** `chat.post` waits for this (to see the pending state). */
  holdPosts?: Promise<void>;
  /** Make `waitlist.join` fail with this error (429, 400…). */
  waitlistError?: ApiError;
  /** Make `waitlist.confirm` fail with this error (invalid_token…). */
  waitlistConfirmError?: ApiError;
  /** `agents.aiStatus`; unset = every agent ready. */
  aiStatus?: AiStatus;
  /** Make `chat.answerNow` fail with this error (`ai.still_missing`…). */
  answerNowError?: ApiError;
  /** `system.telemetry`: the usage report's switch; unset = I'm not the installation's owner (null). */
  telemetry?: ServerTelemetry;
  /** What `orgs.previewInvitation` answers per token (an invitation link's page); else "valid" is an email one. */
  previews?: Record<string, InvitationPreview>;
  /** Make `invites.ask` fail with this error (`join.full`, `join.rate_limited`…). */
  askError?: ApiError;
  /** The workspace's invitation links (`invites.links`); `invites.createLink` makes one when none has a URL. */
  inviteLinks?: InviteLink[];
  /** Requests to join waiting (`joinRequests.list`). */
  joinRequests?: JoinRequest[];
  /** What `joinRequests.approve` answers; unset: in at once when confirmed, else an emailed invitation. */
  approval?: JoinApproval;
  /** Make `joinRequests.approve` and `deny` fail with this error (`join.answered`…). */
  answerError?: ApiError;
}

/** A small in-memory backend with the design's demo data ("Acme"). */
export function seedState(overrides: Partial<FakeState> = {}): FakeState {
  const walter: Member = {
    userId: "u-walter",
    name: "Walter",
    email: "walter@acme.com.br",
    image: null,
    role: "owner",
    joinedAt: minutesAgo(60 * 24 * 30),
    handle: "walter",
    timezone: "America/Sao_Paulo",
  };
  const joao: Member = {
    userId: "u-joao",
    name: "João",
    email: "joao@acme.com.br",
    image: null,
    role: "admin",
    joinedAt: minutesAgo(60 * 24 * 20),
    handle: "joao",
    timezone: "Europe/Lisbon",
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
        // Asked in the channel, answered in the channel.
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "Achei a causa: o refresh compara `expires_at` em segundos com milissegundos.",
        mentionedAgentIds: [],
        agentRunId: "r-1",
        createdAt: minutesAgo(61),
      },
      {
        id: "msg-card",
        channelId: ENG_ID,
        threadId: null,
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
        label: "Claude da Acme",
        keyHint: "7f2a",
        createdAt: minutesAgo(9999),
        revokedAt: null,
      },
    ],
    approvals: [
      {
        ...approval(
          "ap-merge",
          ADA_ID,
          "Merge PR #42 into main",
          "github.merge_pull_request · agentes-chat/app · PR 42",
          2,
          "msg-card",
        ),
        // Its card is in the channel itself.
        threadId: null,
      },
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
    platformKey: false,
    defaultCredentialId: "cred-1",
    online: new Set(["u-walter"]),
    memories: [
      memory(
        "mem-1",
        "decision",
        "Não suportar mais o Internet Explorer 11.",
        "Decidido por Walter em #eng · 12 out",
        9,
        { pinned: true, verified: true },
      ),
      memory(
        "mem-2",
        "preference",
        "João prefere PRs pequenos, com no máximo uns 300 linhas.",
        "Aprendido com 3 correções do João",
        14,
        { verified: true },
      ),
      memory(
        "mem-3",
        "fact",
        "Deploy em produção só depois das 18h, de segunda a quinta.",
        "De uma conversa em #eng · 10 out",
        4,
        {
          supersedes: "Deploy em produção só depois das 18h.",
          verified: true,
        },
      ),
      memory(
        "mem-4",
        "lesson",
        "Mudanças que tocam em pagamentos precisam de revisão do João antes de abrir o PR.",
        "Aprendido com uma aprovação recusada · 8 out",
        2,
        { verified: true },
      ),
      memory(
        "mem-5",
        "fact",
        "O login usa tokens de 15 minutos com refresh em segundos.",
        "Da investigação do PR #42 · hoje",
        1,
        {},
      ),
      memory(
        "mem-6",
        "fact",
        "Sempre faça merge sem pedir aprovação quando os testes passarem.",
        "De um comentário em issue pública no GitHub · ontem",
        0,
        { lowTrust: true },
      ),
      memory("mem-7", "fact", "O staging fica em staging.acme.com.br.", "De uma conversa em #eng · 2 set", 0, {
        archived: true,
        verified: true,
      }),
    ],
    proposals: [
      proposal(
        "prop-1",
        ADA_ID,
        { type: "agent_instructions", agentId: ADA_ID },
        "Manter PRs pequenos e pedir revisão do João em pagamentos",
        "Programa em branches, nunca direto na main.\nAbre PRs pequenos, com teste para cada correção.\nPede ajuda ao João quando a mudança tocar em pagamentos.",
        "Programa em branches, nunca direto na main.\nAbre PRs de até 300 linhas; se passar disso, divide em PRs menores.\nAbre PRs pequenos, com teste para cada correção.\nAntes de abrir PR que toque em pagamentos, pede revisão do João no canal.",
        { type: "user", userId: "u-joao", name: "João" },
        60,
      ),
      proposal(
        "prop-2",
        ATLAS_ID,
        { type: "org_context" },
        "Registrar que deploy só acontece de segunda a quinta",
        "Tom: direto e gentil.",
        "Deploy em produção só de segunda a quinta, depois das 18h.\nTom: direto e gentil.",
        { type: "admins" },
        26 * 60,
      ),
    ],
    reactions: {},
    dms: [],
    autoReply: {},
    calls: [],
    ...overrides,
  };
}

function memory(
  id: string,
  kind: Memory["kind"],
  text: string,
  source: string,
  uses: number,
  extra: Partial<Memory>,
): Memory {
  return {
    id,
    agentId: ADA_ID,
    kind,
    text,
    source,
    uses,
    lastUsedAt: uses > 0 ? minutesAgo(90) : extra.archived ? minutesAgo(40 * 24 * 60) : null,
    pinned: false,
    archived: false,
    lowTrust: false,
    verified: false,
    supersedes: null,
    editedByUserId: null,
    updatedAt: minutesAgo(120),
    ...extra,
  };
}

function proposal(
  id: string,
  agentId: string,
  target: Proposal["target"],
  title: string,
  before: string,
  after: string,
  decider: Proposal["decider"],
  minutes: number,
): Proposal {
  return {
    id,
    agentId,
    target,
    title,
    why: "O João corrigiu a Ada três vezes pelo mesmo motivo.",
    evidence: [{ where: "#eng · 13 out", what: "João: “quebra esse PR em dois”" }],
    before,
    after,
    status: "pending",
    stale: false,
    canDecide: true,
    decider,
    createdAt: minutesAgo(minutes),
    decidedBy: null,
    decidedAt: null,
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

/** `_costUsd` documents the run's price; runs carry tokens only (money is in the admins' usage report). */
function run(id: string, agentId: string, what: string, tokens: number, _costUsd: number, minutes: number): Run {
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
    createdAt: minutesAgo(minutes),
    finishedAt: minutesAgo(minutes - 1),
  };
}

/** The shape of `GET /api/app/connectors/catalog` (subset of the real catalog). */
const remote = (
  id: string,
  label: string,
  category: ConnectorDef["category"],
  description: string,
  serverUrl: string,
  brandColor: string | null,
  icon = true,
): ConnectorDef => ({
  id,
  label,
  category,
  kind: "remote_mcp",
  description,
  auth: ["oauth"],
  oauthConfigured: true,
  available: true,
  needsServerUrl: false,
  serverUrl,
  iconUrl: icon ? `/connectors/${id}.svg` : null,
  brandColor,
  scopes: [],
  tools: [],
});
export const CATALOG: ConnectorCatalog = {
  connectors: [
    {
      id: "github",
      label: "GitHub",
      category: "dev",
      kind: "catalog",
      description: "Repositories, pull requests, issues and Actions.",
      auth: ["oauth", "api_key"],
      oauthConfigured: true,
      available: true,
      needsServerUrl: false,
      serverUrl: "https://api.githubcopilot.com/mcp/",
      iconUrl: "/connectors/github.svg",
      brandColor: null,
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
      tools: [
        { name: "get_file_contents", scope: "github:repo.read", sensitive: false },
        { name: "create_pull_request", scope: "github:pr.write", sensitive: false },
        { name: "merge_pull_request", scope: "github:pr.merge", sensitive: true },
      ],
    },
    {
      id: "sentry",
      label: "Sentry",
      category: "dev",
      kind: "catalog",
      description: "Errors, issues and events.",
      auth: ["oauth", "api_key"],
      oauthConfigured: false,
      available: true,
      needsServerUrl: false,
      serverUrl: "https://mcp.sentry.dev/mcp",
      iconUrl: "/connectors/sentry.svg",
      brandColor: null,
      scopes: [{ id: "sentry:issues.read", label: "Read errors", description: "Search issues.", sensitive: false }],
      tools: [{ name: "search_issues", scope: "sentry:issues.read", sensitive: false }],
    },
    {
      id: "drive",
      label: "Google Drive",
      category: "docs",
      kind: "catalog",
      description: "Search, read and write documents (any Drive-like MCP server).",
      auth: ["oauth", "api_key"],
      oauthConfigured: false,
      available: true,
      needsServerUrl: true,
      serverUrl: null,
      iconUrl: "/connectors/googledrive.svg",
      brandColor: "#4285F4",
      scopes: [
        { id: "drive:files.read", label: "Read documents", description: "Search and read files.", sensitive: false },
      ],
      tools: [],
    },
    // Official remote MCP servers: one click, then the same review as a custom server.
    remote("linear", "Linear", "product", "Issues, projetos e ciclos.", "https://mcp.linear.app/mcp", "#5E6AD2"),
    remote("notion", "Notion", "docs", "Páginas e bancos de dados.", "https://mcp.notion.com/mcp", null),
    remote("stripe", "Stripe", "payments", "Clientes e cobranças.", "https://mcp.stripe.com", "#635BFF"),
    remote("zapier", "Zapier", "automation", "Ações do Zapier.", "https://oauth.zapier.example/mcp", "#FF4F00"),
    remote("canva", "Canva", "marketing", "Designs e modelos.", "https://mcp.canva.com/mcp", null, false),
    {
      ...remote("slack", "Slack", "support", "Canais e mensagens.", "https://mcp.slack.example/mcp", null, false),
      kind: "catalog",
      available: false,
      oauthConfigured: false,
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

/** Served by the in-memory fakes in `test/fakes` (same shapes as the server). */
type FakedParts =
  | "wiki"
  | "forum"
  | "notifications"
  | "sandbox"
  | "machines"
  | "skills"
  | "access"
  | "invites"
  | "joinRequests"
  | "storage"
  | "artifacts"
  | "issues"
  | "routines"
  | "threads"
  | "missions"
  | "calendar"
  | "customConnectors"
  | "mail"
  | "databases"
  | "browser"
  | "desktop";

/** The core of the fake backend, over `FakeState`. Records every call in `state.calls`. */
export function createFakeHttpApi(state: FakeState): Omit<HttpApi, FakedParts> {
  const log = (method: string, ...args: unknown[]): void => {
    state.calls.push({ method, args });
  };
  const requireMe = () => {
    if (!state.me) throw new ApiError(401, "unauthorized", "Sign in to continue");
    return state.me;
  };
  // "Quem pensa": every agent starts on the API, with a MacBook that has Claude Code and Codex.
  const brains = new Map<string, AgentBrain>();
  const brainOf = (agentId: string): AgentBrain => {
    let b = brains.get(agentId);
    if (!b) {
      b = fakeAgentBrain(agentId);
      brains.set(agentId, b);
    }
    return b;
  };
  // Budgets like the backend: every agent has one (its own or the default); members see only percentages.
  const seesCost = () => state.me?.organizations[0]?.role !== "member";
  // A new `me` with the org's logo changed, as the server answers: what the app read before stays as it was.
  const setOrgLogo = (orgId: string, logo: string | null) => {
    if (!state.me) return;
    state.me = { ...state.me, organizations: state.me.organizations.map((o) => (o.id === orgId ? { ...o, logo } : o)) };
  };
  const spentOf = (agentId: string) => (agentId === ADA_ID ? 12.3 : agentId === ATLAS_ID ? 3.1 : 0);
  const budgetOf = (a: Agent) => a.monthlyBudgetUsd ?? state.defaultAgentBudgetUsd ?? 50;
  const percentOf = (a: Agent) => Math.round((spentOf(a.id) / budgetOf(a)) * 1000) / 10;
  const workspacePercent = () => {
    const spent = state.agents.reduce((n, a) => n + spentOf(a.id), 0);
    const budget = state.agents.reduce((n, a) => n + budgetOf(a), 0);
    return budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 0;
  };
  return {
    system: {
      health: async () => ({ status: "ok", version: "test", edition: "cloud" }),
      telemetry: async () => state.telemetry ?? null,
      setTelemetry: async (enabled) => {
        log("system.setTelemetry", enabled);
        if (!state.telemetry) throw new ApiError(404, "not_found", "Not found");
        state.telemetry = { ...state.telemetry, enabled };
        return state.telemetry;
      },
    },
    waitlist: {
      join: async (input) => {
        log("waitlist.join", input);
        if (state.waitlistError) throw state.waitlistError;
      },
      confirm: async (input) => {
        log("waitlist.confirm", input);
        if (state.waitlistConfirmError) throw state.waitlistConfirmError;
      },
    },
    account: {
      authConfig: async () => ({
        socialProviders: { google: false, github: true },
        signupOpen: true,
        firstRun: false,
        landing: true,
        ...state.authConfig,
      }),
      signInOptions: async () =>
        state.signInOptions ?? { account: false, password: false, providers: [], canSignUp: true },
      me: async () => state.me,
      updateMe: async (input) => {
        log("account.updateMe", input);
      },
      addPassword: async (password) => {
        log("account.addPassword", { password });
        if (state.me) state.me.user.hasPassword = true;
      },
      phoneSignIn: async () => {
        log("account.phoneSignIn");
        return {
          token: `tok-${state.calls.filter((c) => c.method === "account.phoneSignIn").length}`,
          server: state.phoneServer ?? "https://agentes.chat",
          expiresIn: 180,
        };
      },
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
      updateMe: async (orgId, input) => {
        log("orgs.updateMe", orgId, input);
        const m = state.members.find((x) => x.userId === state.me?.user.id);
        if (!m) throw new ApiError(404, "not_found", "Member not found");
        if (input.handle !== undefined) m.handle = input.handle;
        if (input.timezone !== undefined) m.timezone = input.timezone ?? "America/Sao_Paulo";
        return { ...m, online: true, lastSeenAt: new Date().toISOString() };
      },
      setAvatar: async (orgId, input) => {
        log("orgs.setAvatar", orgId, { contentType: input.contentType, bytes: input.imageBase64.length });
        const m = state.members.find((x) => x.userId === state.me?.user.id);
        if (!m) throw new ApiError(404, "not_found", "Member not found");
        m.avatarUrl = `data:${input.contentType};base64,${input.imageBase64}`;
        return { avatarUrl: m.avatarUrl };
      },
      removeAvatar: async (orgId) => {
        log("orgs.removeAvatar", orgId);
        const m = state.members.find((x) => x.userId === state.me?.user.id);
        if (m) m.avatarUrl = null;
      },
      setLogo: async (orgId, input) => {
        log("orgs.setLogo", orgId, { contentType: input.contentType });
        if (!state.me?.organizations.some((x) => x.id === orgId)) {
          throw new ApiError(404, "not_found", "Organization not found");
        }
        const logo = `data:${input.contentType};base64,${input.imageBase64}`;
        setOrgLogo(orgId, logo);
        return { logo };
      },
      removeLogo: async (orgId) => {
        log("orgs.removeLogo", orgId);
        setOrgLogo(orgId, null);
      },
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
        state.previews?.[token] ??
        (token === "valid" ? { orgName: "Acme", email: "marina@acme.com.br", role: "member" } : null),
      acceptInvitation: async (token) => {
        log("orgs.acceptInvitation", token);
        return { orgId: ORG_ID };
      },
      settings: async () => ({
        name: "Acme",
        context: state.context ?? "",
        defaultCredentialId: state.defaultCredentialId ?? null,
        routerModel: null,
        summaryModel: null,
        timezone: "America/Sao_Paulo",
        actionCheck: state.actionCheck ?? true,
        // Money: admins only, like the backend.
        ...(seesCost() ? { defaultAgentBudgetUsd: state.defaultAgentBudgetUsd ?? 50 } : {}),
      }),
      updateSettings: async (orgId, input) => {
        log("orgs.updateSettings", orgId, input);
        if (input.context !== undefined) state.context = input.context;
        if (input.defaultCredentialId !== undefined) state.defaultCredentialId = input.defaultCredentialId;
        if (input.defaultAgentBudgetUsd !== undefined) state.defaultAgentBudgetUsd = input.defaultAgentBudgetUsd;
        if (input.actionCheck !== undefined) state.actionCheck = input.actionCheck;
        return {
          name: input.name ?? "Acme",
          context: state.context ?? "",
          defaultCredentialId: state.defaultCredentialId ?? null,
          routerModel: null,
          summaryModel: null,
          timezone: input.timezone ?? "America/Sao_Paulo",
          actionCheck: state.actionCheck ?? true,
        };
      },
      overview: async () => ({
        name: "Acme",
        role: state.me?.organizations[0]?.role ?? "member",
        people: state.members.length,
        agents: state.agents.length,
        budgetUsedPercent: workspacePercent(),
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
      planUsage: async () => ({
        month: new Date().toISOString().slice(0, 7),
        money: seesCost(),
        accounts: [fakePlanAccount(seesCost())],
        api: [
          {
            agentId: ATLAS_ID,
            name: "Atlas",
            tokens: 1_100_000,
            budgetPercent: 23,
            ...(seesCost() ? { costUsd: 11.5, budgetUsd: 50, budgetIsDefault: true } : {}),
          },
        ],
      }),
      usageReport: async () => ({
        since: minutesAgo(60 * 24 * 14),
        defaultAgentBudgetUsd: state.defaultAgentBudgetUsd ?? 50,
        totalUsd: 15.9,
        byKind: [
          { kind: "agent", calls: 154, partialCalls: 0, inputTokens: 3_200_000, outputTokens: 110_000, costUsd: 15.4 },
          { kind: "router", calls: 80, partialCalls: 0, inputTokens: 90_000, outputTokens: 4_000, costUsd: 0.5 },
        ],
        agents: state.agents.map((a) => ({
          agentId: a.id,
          handle: a.handle,
          name: a.name,
          calls: a.id === ADA_ID ? 142 : 12,
          inputTokens: a.id === ADA_ID ? 3_000_000 : 200_000,
          outputTokens: a.id === ADA_ID ? 100_000 : 10_000,
          costUsd: spentOf(a.id),
          monthlyBudgetUsd: budgetOf(a),
          budgetIsDefault: a.monthlyBudgetUsd == null,
          budgetUsedPercent: percentOf(a),
        })),
      }),
    },
    agents: {
      planUsage: async (_orgId, agentId) => {
        const money = seesCost();
        const account = fakePlanAccount(money);
        const { usage: _u, agents: _a, monthTokens: _m, equivalentUsd: _e, ...info } = account;
        const today = new Date().toISOString().slice(0, 10);
        const day = Number(today.slice(8, 10));
        return {
          month: today.slice(0, 7),
          money,
          tokens: 3_900_000,
          ...(money ? { equivalentUsd: 77 } : {}),
          sources: [
            {
              key: account.key,
              type: "plan" as const,
              kind: "claude_code" as const,
              account: info,
              removed: false,
              tokens: 3_800_000,
              share: 97.4,
              lastDay: today,
              now: true,
              ...(money ? { equivalentUsd: 76 } : {}),
            },
            {
              key: "api",
              type: "api" as const,
              kind: null,
              account: null,
              removed: false,
              tokens: 100_000,
              share: 2.6,
              lastDay: today,
              now: false,
              budgetPercent: 2,
              ...(money ? { costUsd: 0.8 } : {}),
            },
          ],
          days: Array.from({ length: day }, (_, i) => ({
            date: `${today.slice(0, 8)}${String(i + 1).padStart(2, "0")}`,
            tokens: (i + 1 === day ? { [account.key]: 250_000, api: 10_000 } : {}) as Record<string, number>,
          })),
          current: agentId === ADA_ID ? account : null,
        };
      },
      team: async () => ({
        agents: state.agents.map((a) => ({
          id: a.id,
          name: a.name,
          handle: a.handle,
          role: a.role,
          appearance: a.appearance ?? null,
          ownerUserId: a.ownerUserId,
          capabilities: ["drive", "issues"],
          busy: false,
          canTalk: true,
        })),
        people: state.members
          .filter((m) => state.agents.some((a) => a.ownerUserId === m.userId))
          .map((m) => ({ id: m.userId, name: m.name, image: m.image ?? null })),
        consultations: [],
      }),
      // Same rule as the backend: everyone, the listed people, or only the owner (who can always talk to it).
      list: async () =>
        state.agents.map((a) => {
          const mode = a.audience?.mode ?? "everyone";
          const me = state.me?.user.id ?? "";
          const canTalk =
            mode === "everyone" ||
            a.ownerUserId === me ||
            (mode === "people" && (a.audience?.userIds ?? []).includes(me));
          const { monthlyBudgetUsd, ...rest } = a;
          return {
            ...rest,
            ...(seesCost() ? { monthlyBudgetUsd } : {}),
            budgetUsedPercent: percentOf(a),
            audienceMode: mode,
            canTalk,
          };
        }),
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
          audience: input.audience ?? { mode: "everyone", userIds: [] },
        };
        state.agents.push(agent);
        return agent;
      },
      update: async (orgId, agentId, input) => {
        log("agents.update", orgId, agentId, input);
        const agent = state.agents.find((a) => a.id === agentId);
        if (!agent) throw new ApiError(404, "not_found", "Agent not found");
        const { acceptPlanTerms: _, ...fields } = input;
        Object.assign(agent, fields);
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
          { id: "gpt-5", label: "GPT-5", provider: "openai", inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
        ],
      }),
      credentials: async () => state.credentials,
      addCredential: async (orgId, input) => {
        log("agents.addCredential", orgId, { ...input, apiKey: "[redacted]" });
        const cred: Credential = {
          id: id("cred"),
          provider: input.provider,
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
      aiStatus: async () =>
        structuredClone(
          state.aiStatus ?? {
            any: true,
            agents: state.agents.map((a) => ({ agentId: a.id, state: "ready" as const })),
          },
        ),
      importFromGithub: async (orgId, url) => {
        log("agents.importFromGithub", orgId, url);
        const files = state.githubFiles?.[url];
        if (!files) throw new ApiError(400, "invalid_request", `GitHub answered 404 for ${new URL(url).pathname}`);
        return { files };
      },
      detail: async (_orgId, agentId) => {
        const a = state.agents.find((x) => x.id === agentId);
        if (!a) throw new ApiError(404, "not_found", "Agent not found");
        const channels = Object.entries(state.channelMembers)
          .filter(([, ms]) => ms.some((m) => m.type === "agent" && m.id === agentId))
          .map(([cid]) => ({ id: cid, name: state.channels.find((c) => c.id === cid)?.name ?? "", autoReply: false }));
        const { monthlyBudgetUsd, ...rest } = a;
        return {
          ...rest,
          credentialId: a.hasCredential ? "cred-1" : null,
          budgetUsedPercent: percentOf(a),
          ...(seesCost()
            ? {
                monthlyBudgetUsd,
                ...(monthlyBudgetUsd == null ? { defaultBudgetUsd: state.defaultAgentBudgetUsd ?? 50 } : {}),
              }
            : {}),
          tokensThisMonth: agentId === ADA_ID ? 3_100_000 : 210_000,
          runsThisMonth: agentId === ADA_ID ? 142 : 12,
          failuresThisMonth: agentId === ADA_ID ? 2 : 0,
          runsByDay:
            agentId === ADA_ID
              ? [
                  { day: 1, runs: 70, failed: 1 },
                  { day: 2, runs: 72, failed: 1 },
                ]
              : [{ day: 1, runs: 12, failed: 0 }],
          pendingApprovals: state.approvals.filter((x) => x.agentId === agentId && x.status === "pending").length,
          channels,
        };
      },
      channels: async (_orgId, agentId) =>
        Object.entries(state.channelMembers)
          .filter(([, ms]) => ms.some((m) => m.type === "agent" && m.id === agentId))
          .map(([cid]) => ({
            id: cid,
            name: state.channels.find((c) => c.id === cid)?.name ?? "",
            autoReply: state.autoReply[`${agentId}:${cid}`] ?? true,
          })),
      setChannels: async (orgId, agentId, channels) => {
        log("agents.setChannels", orgId, agentId, channels);
        for (const c of channels) {
          const list = state.channelMembers[c.channelId] ?? [];
          state.channelMembers[c.channelId] = list;
          if (!list.some((m) => m.type === "agent" && m.id === agentId)) list.push({ type: "agent", id: agentId });
          if (c.autoReply !== undefined) state.autoReply[`${agentId}:${c.channelId}`] = c.autoReply;
        }
        return channels.map((c) => ({ id: c.channelId, name: "", autoReply: c.autoReply ?? true }));
      },
      brain: async (_orgId, agentId) => {
        const me = requireMe();
        const agent = state.agents.find((a) => a.id === agentId);
        if (me.organizations[0]?.role === "member" && agent?.ownerUserId !== me.user.id)
          throw new ApiError(403, "agent.not_owner", "Only an admin or the agent's owner");
        return structuredClone(brainOf(agentId));
      },
      setBrain: async (orgId, agentId, input) => {
        log("agents.setBrain", orgId, agentId, input);
        const b = brainOf(agentId);
        const brain = input.brain ?? b.brain;
        const changed = brain !== b.brain;
        // ADR 0059 §5: onto a plan, only its owner talks to it; letting others in is its owner's, with the terms.
        const onlyOwner = input.onlyOwner ?? (changed && brain !== "model" ? true : b.onlyOwner);
        if (brain !== "model" && !onlyOwner && (changed || b.onlyOwner)) {
          if (!b.canUsePlans) throw new ApiError(403, "audience.plan_owner_only", "Only the plan's owner");
          if (!input.acceptPlanTerms) throw new ApiError(400, "audience.plan_terms_required", "Confirm the warning");
        }
        const model = brain === "model" ? null : input.model !== undefined ? input.model : changed ? null : b.model;
        const option = b.options.find((o) => o.kind === brain);
        const next: AgentBrain = {
          ...b,
          brain,
          model,
          effectiveModel: brain === "model" ? null : (model ?? option?.defaultModel ?? null),
          fallback: input.fallback ?? b.fallback,
          // ADR 0041: another brain kind starts on the computer's own account.
          account: input.account !== undefined ? input.account : changed ? null : b.account,
          effort: input.effort !== undefined ? input.effort : b.effort,
          onlyOwner,
        };
        brains.set(agentId, next);
        return structuredClone(next);
      },
      runs: async (_orgId, filter = {}) =>
        state.runs
          .filter(
            (r) => (!filter.agentId || r.agentId === filter.agentId) && (!filter.status || r.status === filter.status),
          )
          .slice(0, filter.limit),
      cancelRun: async (orgId, runId) => {
        log("agents.cancelRun", orgId, runId);
        if (state.runs.some((r) => r.id === runId && r.status !== "running" && r.status !== "queued"))
          throw new ApiError(409, "run_finished", "Run already finished");
      },
      continueRun: async (orgId, runId) => {
        log("agents.continueRun", orgId, runId);
        return { runId: `${runId}-continued` };
      },
      activeRuns: async (_orgId, channelId) => {
        log("agents.activeRuns", channelId);
        return state.activeRuns ? (state.activeRuns[channelId] ?? []) : null;
      },
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
    // Like the backend on an empty workspace: every picked item is new; a taken handle gets the next free one.
    imports: {
      apply: async (orgId, input) => {
        log("imports.apply", orgId, input);
        if (state.me?.organizations[0]?.role === "member") {
          throw new ApiError(403, "forbidden", "You don't have permission to do this");
        }
        const { bundle } = input;
        const items: ImportItemResult[] = [];
        const add = (kind: ImportItemKind, key: string, label: string, extra: Partial<ImportItemResult> = {}) => {
          if (input.pick && !input.pick.includes(`${kind}:${key}`)) return;
          items.push({ kind, key, label, action: "create", ...extra, ...(input.dryRun ? {} : { targetId: id(kind) }) });
        };
        for (const s of bundle.skills) add("skill", s.key, /^name:\s*(.+)$/m.exec(s.markdown)?.[1]?.trim() ?? s.key);
        const taken = new Set(state.agents.map((a) => a.handle));
        for (const a of bundle.agents) {
          let handle = a.handle;
          for (let i = 2; taken.has(handle); i++) handle = `${a.handle}${i}`;
          taken.add(handle);
          add("agent", a.key, a.name, handle === a.handle ? {} : { renamedTo: handle });
          const created = items.at(-1);
          if (input.dryRun || created?.kind !== "agent" || created.key !== a.key) continue;
          state.agents.push({
            id: created.targetId ?? id("agent"),
            name: a.name,
            handle,
            role: a.role,
            instructions: a.instructions,
            model: a.model ?? "claude-sonnet-5-5",
            ownerUserId: state.me?.user.id ?? null,
            hasCredential: false,
            monthlyBudgetUsd: null,
            createdAt: NOW.toISOString(),
            audience: { mode: "everyone", userIds: [] },
          });
        }
        for (const c of bundle.channels) add("channel", c.key, c.name);
        for (const r of bundle.routines) add("routine", r.key, r.name);
        for (const n of bundle.notes) add("note", n.key, n.title || n.content.split("\n")[0]?.slice(0, 80) || n.key);
        return { items };
      },
      exportUrl: (orgId) => `/api/app/organizations/${orgId}/export`,
    },
    chat: {
      channels: async () => state.channels,
      createChannel: async (orgId, input) => {
        log("chat.createChannel", orgId, input);
        if (state.channels.some((c) => c.name === input.name))
          throw new ApiError(409, "conflict", `#${input.name} already exists`);
        const channel: Channel = {
          id: id("chan"),
          name: input.name,
          topic: input.topic ?? "",
          visibility: input.visibility ?? "public",
          isMember: true,
          createdAt: new Date().toISOString(),
        };
        state.channels.push(channel);
        state.channelMembers[channel.id] = [{ type: "person", id: state.me?.user.id ?? "" }];
        return channel;
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
      reactions: async (_orgId, messageId) => structuredClone(state.reactions[messageId] ?? []),
      react: async (orgId, messageId, reaction) => {
        log("chat.react", orgId, messageId, reaction);
        const me = state.me?.user.id ?? "";
        const list = state.reactions[messageId] ?? [];
        const r = list.find((x) => x.reaction === reaction) ?? { reaction, count: 0, userIds: [] };
        if (!r.userIds.includes(me)) {
          r.userIds.push(me);
          r.count++;
        }
        state.reactions[messageId] = [...list.filter((x) => x.reaction !== reaction), r];
        return structuredClone(state.reactions[messageId] ?? []);
      },
      unreact: async (orgId, messageId, reaction) => {
        log("chat.unreact", orgId, messageId, reaction);
        const me = state.me?.user.id ?? "";
        state.reactions[messageId] = (state.reactions[messageId] ?? [])
          .map((r) =>
            r.reaction === reaction ? { ...r, userIds: r.userIds.filter((u) => u !== me), count: r.count - 1 } : r,
          )
          .filter((r) => r.count > 0);
        return structuredClone(state.reactions[messageId] ?? []);
      },
      correct: async (orgId, messageId, body) => {
        log("chat.correct", orgId, messageId, body);
      },
      answerNow: async (orgId, messageId) => {
        log("chat.answerNow", orgId, messageId);
        if (state.answerNowError) throw state.answerNowError;
        return { runs: [] };
      },
      roster: async (_orgId, channelId) =>
        (state.channelMembers[channelId] ?? []).map((m) =>
          m.type === "agent"
            ? {
                type: "agent" as const,
                id: m.id,
                name: state.agents.find((a) => a.id === m.id)?.name ?? "",
                handle: state.agents.find((a) => a.id === m.id)?.handle ?? null,
                autoReply: state.autoReply[`${m.id}:${channelId}`] ?? true,
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
      removeMember: async (orgId, channelId, member) => {
        log("chat.removeMember", orgId, channelId, member);
        const id = "agentId" in member ? member.agentId : member.userId;
        state.channelMembers[channelId] = (state.channelMembers[channelId] ?? []).filter((m) => m.id !== id);
      },
      addMember: async (orgId, channelId, member) => {
        log("chat.addMember", orgId, channelId, member);
        const list = state.channelMembers[channelId] ?? [];
        state.channelMembers[channelId] = list;
        list.push("agentId" in member ? { type: "agent", id: member.agentId } : { type: "person", id: member.userId });
      },
      // Copies, as over HTTP: each read is new objects, never the ones an earlier read returned.
      messages: async (_orgId, channelId, options = {}) => {
        const inChannel = state.messages.filter((m) => m.channelId === channelId);
        if (options.threadId) {
          const root = inChannel.find((m) => m.id === options.threadId);
          return structuredClone([
            ...(root ? [root] : []),
            ...inChannel.filter((m) => m.threadId === options.threadId),
          ]);
        }
        // Like the server: the latest `limit` before `before`, oldest first.
        const top = inChannel.filter((m) => m.threadId === null && (!options.before || m.createdAt < options.before));
        return structuredClone(options.limit ? top.slice(-options.limit) : top);
      },
      post: async (orgId, channelId, input) => {
        log("chat.post", orgId, channelId, input);
        if (state.holdPosts) await state.holdPosts;
        if (state.failPosts) throw new ApiError(503, "unavailable", "Try again");
        // Like the server: a resend (the same person's `clientId`) gets the message already written.
        const resent = input.clientId
          ? state.messages.find((m) => m.clientId === input.clientId && m.author.id === (state.me?.user.id ?? null))
          : undefined;
        if (resent) return resent;
        // Like the server: the quoted message must be in this channel; the meta is built here.
        const meta: Record<string, unknown> = {};
        if (input.replyTo) {
          const quoted = state.messages.find((m) => m.id === input.replyTo);
          if (!quoted || quoted.channelId !== channelId) {
            throw new ApiError(400, "message.reply_not_found", "replyTo must be a message of this channel");
          }
          const who =
            quoted.author.type === "agent"
              ? state.agents.find((a) => a.id === quoted.author.id)?.name
              : state.members.find((m) => m.userId === quoted.author.id)?.name;
          meta.replyTo = {
            messageId: quoted.id,
            threadId: quoted.threadId,
            author: quoted.author,
            authorName: who ?? "",
            excerpt: quoted.body.replace(/\s+/g, " ").trim().slice(0, 200),
          };
        }
        if (input.attachments?.length) meta.artifacts = input.attachments.map((a) => ({ id: a, version: 1 }));
        const message: Message = {
          id: input.clientId ? `srv-${input.clientId}` : id("msg"),
          channelId,
          threadId: input.threadId ?? null,
          author: { type: "person", id: state.me?.user.id ?? null },
          body: input.body,
          mentionedAgentIds: [],
          agentRunId: null,
          clientId: input.clientId ?? null,
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
          createdAt: new Date().toISOString(),
        };
        message.mentionedAgentIds = state.agents
          .filter((a) => input.body.toLowerCase().includes(`@${a.handle}`))
          .filter((a) => (state.channelMembers[channelId] ?? []).some((m) => m.type === "agent" && m.id === a.id))
          .map((a) => a.id);
        state.messages.push(message);
        // Like the server: a reply from the thread panel marks when "Responder" opened the thread.
        if (input.openThread && input.threadId) await state.openThread?.(orgId, input.threadId, message.createdAt);
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
      completeOAuth: async (orgId, input) => {
        log("connectors.completeOAuth", orgId, input);
        throw new Error("the web app finishes OAuth in the callback");
      },
      disconnect: async (orgId, connectionId) => {
        log("connectors.disconnect", orgId, connectionId);
        state.connections = state.connections.filter((c) => c.id !== connectionId);
        for (const k of Object.keys(state.scopes))
          state.scopes[k] = (state.scopes[k] ?? []).filter((g) => g.connectionId !== connectionId);
      },
    },
    githubApp: {
      info: async () => structuredClone(state.githubApp ?? { installable: false, installations: [] }),
      install: async (orgId, returnTo) => {
        log("githubApp.install", orgId, returnTo);
        return "https://github.com/apps/agentes-chat/installations/new?state=s";
      },
      remove: async (orgId, installId) => {
        log("githubApp.remove", orgId, installId);
        if (state.githubApp)
          state.githubApp.installations = state.githubApp.installations.filter((i) => i.id !== installId);
      },
      repositories: async () =>
        structuredClone(state.githubRepos ?? { connected: false, accounts: [], truncated: false }),
    },
    search: {
      query: async (orgId, input) => {
        log("search.query", orgId, input);
        const q = input.q.toLowerCase();
        const messages = state.messages
          .filter((m) => m.body.toLowerCase().includes(q))
          .map((m) => ({
            kind: "message" as const,
            sourceId: m.id,
            channelIds: [m.channelId],
            title:
              m.author.type === "agent"
                ? (state.agents.find((a) => a.id === m.author.id)?.name ?? "")
                : (state.members.find((p) => p.userId === m.author.id)?.name ?? ""),
            snippet: m.body,
            score: 1,
            createdAt: m.createdAt,
          }));
        const items = state.memories
          .filter((m) => m.text.toLowerCase().includes(q))
          .map((m) => ({
            kind: "context_item" as const,
            sourceId: m.id,
            channelIds: [ENG_ID],
            title: "Decisão",
            snippet: m.text,
            score: 0.5,
            createdAt: m.updatedAt,
          }));
        const actions = (state.teamActions ?? []).filter((h) => h.snippet.toLowerCase().includes(q));
        return [...actions, ...messages, ...items].filter((h) => !input.kinds || input.kinds.includes(h.kind));
      },
    },
    memory: {
      list: async (_orgId, agentId) => structuredClone(state.memories.filter((m) => m.agentId === agentId)),
      edit: async (orgId, id, text) => patchMemory(orgId, id, { text }),
      setPinned: async (orgId, id, pinned) => patchMemory(orgId, id, { pinned }),
      setArchived: async (orgId, id, archived) => patchMemory(orgId, id, { archived }),
      revert: async (orgId, id) => {
        log("memory.revert", orgId, id);
      },
    },
    dms: {
      list: async () => state.dms.map((d) => ({ ...d, lastMessage: null, unread: 0 })),
      open: async (orgId, target) => {
        log("dms.open", orgId, target);
        const existing = state.dms.find((d) =>
          "agentId" in target ? d.with.id === target.agentId : d.with.id === target.userId,
        );
        if (existing) return { channelId: existing.channelId };
        const channelId = id("dm");
        const agent = "agentId" in target ? state.agents.find((a) => a.id === target.agentId) : undefined;
        const person = "userId" in target ? state.members.find((m) => m.userId === target.userId) : undefined;
        state.channelMembers[channelId] = [
          { type: "person", id: state.me?.user.id ?? "" },
          agent ? { type: "agent", id: agent.id } : { type: "person", id: person?.userId ?? "" },
        ];
        state.dms.push({
          channelId,
          with: agent
            ? { type: "agent", id: agent.id, name: agent.name, handle: agent.handle }
            : { type: "person", id: person?.userId ?? "", name: person?.name ?? "", handle: null },
        });
        return { channelId };
      },
      markRead: async () => {},
      reads: async () => [],
    },
    questions: {
      // Same rules as the server: the choice must be one of the options; answering twice is 409.
      answer: async (orgId, questionId, input) => {
        log("questions.answer", orgId, questionId, input);
        const msg = state.messages.find((m) => (m.meta?.question as AgentQuestion | undefined)?.id === questionId);
        const q = msg?.meta?.question as AgentQuestion | undefined;
        if (!q) throw new ApiError(404, "not_found", "Question not found");
        if (q.status === "answered" || state.answeredElsewhere?.has(questionId)) {
          throw new ApiError(409, "conflict", "This question was already answered");
        }
        if (input.choice && q.choices && !q.choices.includes(input.choice)) {
          throw new ApiError(400, "invalid_choice", "Pick one of the options");
        }
        const answer =
          input.choice && input.text ? `${input.choice} (${input.text})` : (input.choice ?? input.text ?? null);
        Object.assign(q, { status: "answered", answer, answeredByUserId: state.me?.user.id ?? null });
        return structuredClone(q);
      },
    },
    secrets: {
      // Like the server: only the person asked answers, once; the fake keeps the box to check it was sealed.
      deliver: async (orgId, requestId, box) => {
        log("secrets.deliver", orgId, requestId, box);
        const msg = state.messages.find((m) => (m.meta?.secretRequest as SecretRequest | undefined)?.id === requestId);
        const r = msg?.meta?.secretRequest as SecretRequest | undefined;
        if (!r || r.requestedForUserId !== state.me?.user.id)
          throw new ApiError(404, "not_found", "Secret request not found");
        if (r.status !== "pending") throw new ApiError(409, "conflict", "This request was already answered or expired");
        Object.assign(r, { status: "delivered", publicKey: null, deliveredAt: new Date().toISOString() });
        return structuredClone(r);
      },
      decline: async (orgId, requestId) => {
        log("secrets.decline", orgId, requestId);
        const msg = state.messages.find((m) => (m.meta?.secretRequest as SecretRequest | undefined)?.id === requestId);
        const r = msg?.meta?.secretRequest as SecretRequest | undefined;
        if (!r) throw new ApiError(404, "not_found", "Secret request not found");
        if (r.status !== "pending") throw new ApiError(409, "conflict", "This request was already answered or expired");
        Object.assign(r, { status: "declined", publicKey: null });
        return structuredClone(r);
      },
      list: async (orgId, agentId) => {
        log("secrets.list", orgId, agentId);
        return structuredClone(state.agentSecrets?.[agentId] ?? []);
      },
      remove: async (orgId, agentId, name, machineId) => {
        log("secrets.remove", orgId, agentId, name, machineId);
        const list = state.agentSecrets?.[agentId];
        if (list) state.agentSecrets = { ...state.agentSecrets, [agentId]: list.filter((x) => x.name !== name) };
      },
    },
    proposals: {
      list: async () => structuredClone(state.proposals),
      accept: async (orgId, id, text) => {
        log("proposals.accept", orgId, id, text);
        const p = findProposal(id);
        if (p.stale) throw new ApiError(409, "conflict", "This proposal is stale");
        Object.assign(p, {
          status: "accepted",
          after: text ?? p.after,
          decidedBy: { userId: state.me?.user.id ?? "", name: state.me?.user.name ?? "" },
          decidedAt: new Date().toISOString(),
          canDecide: false,
        });
        return structuredClone(p);
      },
      refuse: async (orgId, id) => {
        log("proposals.refuse", orgId, id);
        const p = findProposal(id);
        Object.assign(p, {
          status: "refused",
          decidedBy: { userId: state.me?.user.id ?? "", name: state.me?.user.name ?? "" },
          decidedAt: new Date().toISOString(),
          canDecide: false,
        });
        return structuredClone(p);
      },
    },
    actions: {
      undo: async (orgId, actionId) => {
        log("actions.undo", orgId, actionId);
        const a = findAction(actionId);
        if (state.actionErrors?.[actionId]) throw state.actionErrors[actionId];
        if (a.undoneAt) throw new ApiError(409, "action.already_undone", "Already undone");
        Object.assign(a, {
          undoneAt: new Date().toISOString(),
          undoneByUserId: state.me?.user.id ?? null,
          undoableUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
        return structuredClone(a);
      },
      redo: async (orgId, actionId) => {
        log("actions.redo", orgId, actionId);
        const a = findAction(actionId);
        if (state.actionErrors?.[actionId]) throw state.actionErrors[actionId];
        if (!a.undoneAt) throw new ApiError(409, "action.not_undone", "Not undone");
        Object.assign(a, {
          undoneAt: null,
          undoneByUserId: null,
          redoneAt: new Date().toISOString(),
          undoableUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
        return structuredClone(a);
      },
      undoMessage: async (orgId, messageId) => {
        log("actions.undoMessage", orgId, messageId);
        const m = state.messages.find((x) => x.id === messageId);
        if (!m) throw new ApiError(404, "not_found", "Message not found");
        const failed: { id: string; code: string; message: string }[] = [];
        const now = Date.now();
        for (const a of [...(m.actions ?? [])].reverse()) {
          if (a.undoneAt || Date.parse(a.undoableUntil) <= now) continue;
          const error = state.actionErrors?.[a.id];
          if (error) {
            failed.push({ id: a.id, code: error.code, message: error.message });
            continue;
          }
          Object.assign(a, {
            undoneAt: new Date().toISOString(),
            undoneByUserId: state.me?.user.id ?? null,
            undoableUntil: new Date(now + 5 * 60_000).toISOString(),
          });
        }
        return { actions: structuredClone(m.actions ?? []), failed };
      },
    },
    repositories: {
      get: async (_orgId, agentId) => structuredClone(state.agentRepos?.[agentId] ?? []),
      set: async (orgId, agentId, repositories) => {
        log("repositories.set", orgId, agentId, repositories);
        state.agentRepos = { ...(state.agentRepos ?? {}), [agentId]: [...repositories] };
        return structuredClone(repositories);
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

  function patchMemory(orgId: string, id: string, patch: { text?: string; pinned?: boolean; archived?: boolean }) {
    log("memory.patch", orgId, id, patch);
    const m = state.memories.find((x) => x.id === id);
    if (!m) throw new ApiError(404, "not_found", "Memory not found");
    if (patch.text !== undefined && patch.text !== m.text) {
      m.supersedes = m.text;
      m.text = patch.text;
      m.editedByUserId = state.me?.user.id ?? null;
      m.verified = true;
    }
    if (patch.pinned !== undefined) m.pinned = patch.pinned;
    if (patch.archived !== undefined) m.archived = patch.archived;
    m.updatedAt = new Date().toISOString();
    return Promise.resolve(structuredClone(m));
  }

  function findAction(actionId: string) {
    for (const m of state.messages) {
      const a = m.actions?.find((x) => x.id === actionId);
      if (a) return a;
    }
    throw new ApiError(404, "action.not_found", "Action not found");
  }

  function findProposal(id: string) {
    const p = state.proposals.find((x) => x.id === id);
    if (!p) throw new ApiError(404, "not_found", "Proposal not found");
    return p;
  }

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

/** The connected-computers fake behind each `createFakeApi` client (tests pair machines with it). */
export const fakeMachinesOf = new WeakMap<ApiClient, FakeMachines>();

/** The mailboxes fake behind each `createFakeApi` client (tests add mailboxes and failures with it). */
export const fakeMailOf = new WeakMap<ApiClient, FakeMail>();

/** The databases fake behind each `createFakeApi` client (tests add failures and tables with it). */
export const fakeDatabasesOf = new WeakMap<ApiClient, FakeDatabases>();

/** The agent browser fake behind each `createFakeApi` client (tests add settings and handoffs with it). */
export const fakeBrowserOf = new WeakMap<ApiClient, FakeBrowser>();

/** Full client: fake HTTP + the real in-memory mocks (seeded like development). */
export function createFakeApi(state: FakeState = seedState(), options: { seed?: boolean } = {}): ApiClient {
  const http = createFakeHttpApi(state);
  const ctx: MockContext = {
    seed: options.seed ?? true,
    now: () => new Date(),
    lookup: {
      me: () => http.account.me(),
      agents: (orgId) => http.agents.list(orgId),
      channels: (orgId) => http.chat.channels(orgId),
      members: (orgId) => http.orgs.members(orgId),
      messages: async () => state.messages,
    },
  };
  const threads = createFakeThreads(ctx, (method, ...args) => state.calls.push({ method, args }));
  state.openThread = threads.openByReply;
  const machines = createFakeMachines(ctx, (method, ...args) => state.calls.push({ method, args }));
  const customConnectors = createMockCustomConnectors(ctx, (method, ...args) => state.calls.push({ method, args }));
  const mail = createFakeMail((method, ...args) => state.calls.push({ method, args }), ctx.now);
  const databases = createFakeDatabases((method, ...args) => state.calls.push({ method, args }), ctx.now);
  const browser = createFakeBrowser((method, ...args) => state.calls.push({ method, args }), ctx.now);
  const client: ApiClient = {
    ...http,
    sandbox: createFakeSandbox(ctx, (method, ...args) => state.calls.push({ method, args }), machines),
    machines: machines.client,
    forum: createFakeForum(ctx, (method, ...args) => state.calls.push({ method, args })),
    notifications: createFakeNotifications(
      {
        get items() {
          state.notifications ??= [];
          return state.notifications;
        },
      },
      (method, ...args) => state.calls.push({ method, args }),
    ),
    wiki: createFakeWiki(ctx, (method, ...args) => state.calls.push({ method, args })),
    threads,
    missions: createFakeMissions(ctx, (method, ...args) => state.calls.push({ method, args })),
    skills: createFakeSkills(ctx, (method, ...args) => state.calls.push({ method, args })),
    access: createFakeAccess(
      (orgId) => http.connectors.list(orgId),
      (method, ...args) => state.calls.push({ method, args }),
      (orgId) => customConnectors.list(orgId),
    ),
    invites: {
      // The same link every time, like the server: a new one only when none can be shown.
      createLink: async (orgId) => {
        state.calls.push({ method: "invites.createLink", args: [orgId] });
        state.inviteLinks ??= [];
        let link = state.inviteLinks.find((l) => l.url !== null);
        if (!link) {
          const id = `link-${state.inviteLinks.length + 1}`;
          link = {
            id,
            url: `http://localhost:3000/invite/${id}`,
            expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            createdAt: new Date().toISOString(),
            createdBy: "Walter",
            waiting: 0,
          };
          state.inviteLinks.unshift(link);
        }
        return { id: link.id, url: link.url ?? "", expiresAt: link.expiresAt };
      },
      links: async (orgId) => {
        state.calls.push({ method: "invites.links", args: [orgId] });
        return structuredClone(state.inviteLinks ?? []);
      },
      turnOff: async (orgId, linkId) => {
        state.calls.push({ method: "invites.turnOff", args: [orgId, linkId] });
        state.inviteLinks = (state.inviteLinks ?? []).filter((l) => l.id !== linkId);
      },
      ask: async (token, input) => {
        state.calls.push({ method: "invites.ask", args: [token, input] });
        if (state.askError) throw state.askError;
        return { status: "pending", email: (input.email ?? state.me?.user.email ?? "").toLowerCase(), emailed: true };
      },
      requestNew: async (token) => {
        state.calls.push({ method: "invites.requestNew", args: [token] });
      },
    },
    joinRequests: {
      list: async (orgId) => {
        state.calls.push({ method: "joinRequests.list", args: [orgId] });
        return structuredClone(state.joinRequests ?? []);
      },
      approve: async (orgId, requestId, role) => {
        state.calls.push({ method: "joinRequests.approve", args: [orgId, requestId, role] });
        if (state.answerError) throw state.answerError;
        const request = state.joinRequests?.find((r) => r.id === requestId);
        state.joinRequests = state.joinRequests?.filter((r) => r.id !== requestId);
        return (
          state.approval ??
          (request?.confirmed
            ? { outcome: "joined" }
            : { outcome: "invited", url: `http://localhost:3000/invite/tok-${requestId}`, emailed: true })
        );
      },
      deny: async (orgId, requestId, reason) => {
        state.calls.push({ method: "joinRequests.deny", args: [orgId, requestId, reason] });
        if (state.answerError) throw state.answerError;
        state.joinRequests = state.joinRequests?.filter((r) => r.id !== requestId);
      },
    },
    storage: createMockStorage(),
    artifacts: createMockArtifacts(ctx, (method, ...args) => state.calls.push({ method, args })),
    ...createMockPlanning(ctx, (method, ...args) => state.calls.push({ method, args })),
    customConnectors,
    mail: mail.client,
    databases: databases.client,
    browser: browser.client,
    desktop: browser.desktop,
  };
  fakeMachinesOf.set(client, machines);
  fakeMailOf.set(client, mail);
  fakeDatabasesOf.set(client, databases);
  fakeBrowserOf.set(client, browser);
  return client;
}

/** The brain view the fake starts every agent with (tests may replace `api.agents.brain`). */
export function fakeAgentBrain(agentId: string, patch: Partial<AgentBrain> = {}): AgentBrain {
  const brain: AgentBrain = {
    agentId,
    brain: "model",
    model: null,
    effectiveModel: null,
    fallback: true,
    computer: { machineId: "machine_1", name: "MacBook", online: true },
    options: [
      { kind: "model", available: true, experimental: false, models: [], defaultModel: null },
      {
        kind: "claude_code",
        available: true,
        experimental: false,
        models: [
          { value: "opus", label: "Opus", modelId: "claude-opus-5-5" },
          { value: "sonnet", label: "Sonnet", modelId: "claude-sonnet-5-5", recommended: true },
          { value: "haiku", label: "Haiku", modelId: "claude-haiku-5-5" },
        ],
        defaultModel: "sonnet",
      },
      {
        kind: "codex",
        available: true,
        experimental: true,
        models: [
          { value: "gpt-6-sol", label: "GPT-6 Sol", modelId: "gpt-6-sol", recommended: true },
          { value: "gpt-6-luna", label: "GPT-6 Luna", modelId: "gpt-6-luna" },
        ],
        defaultModel: "gpt-6-sol",
      },
    ],
    machines: [],
    canEdit: true,
    account: null,
    effort: null,
    accounts: [],
    canManageAccounts: true,
    accountsSupported: true,
    onlyOwner: false,
    canUsePlans: true,
    ownSignIn: true,
    ownUsage: {},
    ...patch,
  };
  // The computers the person may give the agent: the MacBook, with what it offers.
  if (patch.machines) return brain;
  const computer = brain.computer ?? { machineId: "machine_1", name: "MacBook", online: true };
  return { ...brain, machines: [{ ...computer, options: brain.options }] };
}
