/** Types of the private web-app API (`/api/app/*`, apps/server/src/routes/app). */

export type Role = "owner" | "admin" | "member";
export type Edition = "selfhost" | "cloud";

export interface Health {
  status: "ok" | "degraded";
  version: string;
  edition: Edition;
}

export interface AuthConfig {
  socialProviders: { google: boolean; github: boolean; apple?: boolean };
  signupOpen: boolean;
  firstRun: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface OrgSummary {
  id: string;
  name: string;
  role: Role;
  /** The workspace logo (`/api/app/org-logos/…`); null or absent = the agent mark. */
  logo?: string | null;
}

export interface Me {
  user: User;
  organizations: OrgSummary[];
}

export interface Organization extends OrgSummary {
  context?: string;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  /** The photo uploaded here (`PUT …/me/avatar`); wins over `image`. */
  avatarUrl?: string | null;
  role: Role;
  joinedAt: string;
  /** `@ana`: unique in the organization; mentions resolve by it. */
  handle: string;
  /** IANA zone (the organization's if the person didn't pick one). */
  timezone: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export interface InvitationPreview {
  orgName: string;
  email: string;
  role: Role;
}

export interface Credential {
  id: string;
  /** "anthropic", "openai", … */
  provider: string;
  label: string;
  keyHint: string;
  /** Last characters of the Anthropic workspace the key is scoped to, if set. */
  workspaceIdHint?: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Who can talk to an agent: everyone, some people, or only its owner. */
export type AudienceMode = "everyone" | "people" | "owner";

export interface AgentAudience {
  mode: AudienceMode;
  /** For `people` (the owner can always talk to it). */
  userIds: string[];
}

export interface Agent {
  id: string;
  name: string;
  handle: string;
  role: string;
  instructions: string;
  model: string;
  ownerUserId: string | null;
  hasCredential: boolean;
  /** Admins only: its own monthly budget; null = the workspace default. Absent for members. */
  monthlyBudgetUsd?: number | null;
  /** This month's spend over its budget, in % (agent list). */
  budgetUsedPercent?: number;
  createdAt: string;
  /** Expected from the backend; absent = everyone. */
  audience?: AgentAudience;
  audienceMode?: AudienceMode;
  /** Whether I can talk to it (absent = yes). */
  canTalk?: boolean;
  /** Its look (color, eyes, accessory), from the backend's allow-list. */
  appearance?: AgentLookInput;
  /** Who thinks for it (ADR 0032): the brain, a computer brain's model label, its computer (owner and admins). */
  brain?: AgentBrainLine;
}

/** `Agent.brain`: shown next to its name instead of the API model when a computer thinks. */
export interface AgentBrainLine {
  kind: BrainKind;
  /** A computer brain's model ("Sonnet"); null for the model brain. */
  model: string | null;
  computer?: string;
}

/** `appearance` as stored: the UI only draws known values. */
export interface AgentLookInput {
  color?: string;
  eyes?: string;
  accessory?: string;
}

export interface AgentInput {
  name: string;
  handle: string;
  role?: string;
  instructions?: string;
  model?: string;
  credentialId?: string | null;
  ownerUserId?: string | null;
  monthlyBudgetUsd?: number | null;
  audience?: AgentAudience;
  appearance?: AgentLookInput;
}

export interface Model {
  id: string;
  label: string;
  provider: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** The workspace can use it (has a key for the provider). Expected from the backend; derived until then. */
  available?: boolean;
}

export interface AgentUsage {
  agentId: string;
  handle: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  isMember: boolean;
  createdAt: string;
  /**
   * Channel list only (`chat.channels`): messages since you last read it
   * (since you joined, if never), not yours; a thread reply counts only in a
   * thread you follow. At most 100 (show "99+"); 0 when not a member.
   */
  unreadCount?: number;
  /** Channel list only: the latest top-level message; null when empty or not a member. */
  lastMessage?: ChannelLastMessage | null;
}

/** A channel's latest top-level message, for the conversation list. */
export interface ChannelLastMessage {
  id: string;
  authorType: "person" | "agent";
  authorId: string | null;
  /** Null when the author was deleted. */
  authorName: string | null;
  /** Plain text, at most 140 characters. */
  preview: string;
  createdAt: string;
}

export type AuthorType = "person" | "agent";

export interface ChannelMember {
  type: AuthorType;
  id: string;
}

export interface Message {
  id: string;
  channelId: string;
  threadId: string | null;
  author: { type: AuthorType; id: string | null };
  body: string;
  mentionedAgentIds: string[];
  agentRunId: string | null;
  /** Attachments, e.g. `{ approvalId }` on an approval card. */
  meta?: Record<string, unknown>;
  /** Echo of the id the client sent, to reconcile an optimistic message (expected from the backend). */
  clientId?: string | null;
  /** Agent receipts on a person's message (expected from the backend). */
  receipts?: MessageReceipts;
  /** Reaction counts (expected from the backend in the message list; else loaded on hover). */
  reactions?: ReactionCount[];
  /** People's messages: what agents saved to memory from them (the memory mark); live via `message.memories`. */
  memories?: MessageMemory[];
  /** In lists: true when pinned in its channel (absent: not pinned); live via `message.pinned` / `message.unpinned`. */
  pinned?: boolean;
  /** Client only: an optimistic message waiting for the server, or one that failed to send. */
  local?: "pending" | "failed";
  createdAt: string;
}

/** How an agent's question to another agent (`ask_agent`) ended. */
export type ConsultationStatus = "answered" | "expired" | "failed";

/** `message.meta.consulted` on the asking agent's reply: one entry per agent it asked. */
export interface MessageConsultation {
  agentId: string;
  consultationId: string;
  status: ConsultationStatus;
  question: string;
  /** Only when answered. */
  answer: string | null;
}

/** Which agents saw a person's message, picked it up, and how their runs ended. */
export interface MessageReceipts {
  seenBy: string[];
  pickedBy: string[];
  handled: { agentId: string; status: RunStatus }[];
}

export type RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed";

/** A run the server still considers active in a channel (`GET …/channels/{id}/active-runs`). */
export interface ActiveRun {
  runId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  status: RunStatus;
  /** The message that started it (the live row goes right after it). */
  triggerMessageId?: string | null;
  startedAt?: string | null;
  /** Last sign of life from the worker. */
  heartbeatAt?: string | null;
  createdAt?: string;
}

/** Real-time channel events (packages/engine/src/events.ts, docs/adr/0010-realtime.md). */
export type ChannelEvent =
  | { type: "message.created"; channelId: string; messageId: string; message?: Message }
  /** Someone reacted or took it back: the message's reactions now (replace). */
  | { type: "message.reactions"; channelId: string; messageId: string; reactions: ReactionCount[] }
  | { type: "message.memories"; channelId: string; messageId: string; memories: MessageMemory[] }
  /** A message was pinned here (`pins.list` has them all, newest first). */
  | {
      type: "message.pinned";
      channelId: string;
      messageId: string;
      threadId: string | null;
      pinnedByUserId: string;
      pinnedAt: string;
    }
  /** A message was unpinned. */
  | { type: "message.unpinned"; channelId: string; messageId: string }
  /**
   * A thread's state, title or context changed (ADR 0029). `thread` is the fresh view when the
   * server had it (its `canManage` is always false: read yours from the API). `messageIds`: messages
   * that left the channel (`moved`) or came back (`returned`).
   */
  | {
      type: "thread.updated";
      channelId: string;
      threadId: string;
      change: ThreadChange;
      state?: ThreadState;
      thread?: ThreadInfo;
      messageIds?: string[];
    }
  | ArtifactEvent
  | {
      type: "agent.delta";
      channelId: string;
      threadId: string;
      runId: string;
      agentId: string;
      seq: number;
      text: string;
      /** Which model call of the run this text belongs to (narration is keyed by it). */
      turn?: number;
    }
  | {
      type: "agent.run";
      channelId: string;
      threadId: string;
      runId: string;
      agentId: string;
      status: RunStatus;
      error?: string;
      /** The message that started the run (anchors its live row). */
      triggerMessageId?: string | null;
      startedAt?: string | null;
    }
  | { type: "approval.created" | "approval.decided"; channelId: string; approval: Approval }
  /** An agent's forum suggestion card was accepted or dismissed: its `meta.forumSuggestion` now. */
  | {
      type: "forum.suggestion.updated";
      channelId: string;
      threadId: string | null;
      messageId: string;
      suggestion: ForumSuggestion;
    }
  // ── Chat latency batch (packages/engine/src/events.ts) ──────────────────────
  /** An agent will answer: show "thinking" at once. `runId` is null when announced at post time. */
  | { type: "agent.thinking"; channelId: string; threadId: string; agentId: string; runId: string | null }
  /** An agent asked another agent (`ask_agent`) and waits for it: "Dev está perguntando ao Infra…". */
  | {
      type: "agent.consulting";
      channelId: string;
      threadId: string;
      runId: string;
      agentId: string;
      consultedAgentId: string;
    }
  /** That question came back (answered, expired or failed): the asking run resumes and writes. */
  | {
      type: "agent.consulted";
      channelId: string;
      threadId: string;
      runId: string;
      agentId: string;
      consultedAgentId: string;
      status: ConsultationStatus;
    }
  /** The agent's first words arrived. */
  | { type: "agent.typing"; channelId: string; threadId: string; agentId: string; runId: string }
  /** The agent stopped (done, failed or waiting for approval). */
  | { type: "agent.idle"; channelId: string; threadId: string; agentId: string; runId: string }
  | {
      type: "run.finished";
      channelId: string;
      threadId: string;
      agentId: string;
      runId: string;
      status: "done" | "failed" | "waiting_approval";
      error?: string;
    }
  /** A person is typing; drop it after `ttlMs`. */
  | { type: "user.typing"; channelId: string; threadId: string | null; userId: string; ttlMs: number }
  /** Who saw a message and who will answer. */
  | {
      type: "message.routed";
      channelId: string;
      messageId: string;
      seenBy: string[];
      pickedBy: string[];
      strategy?: "mention" | "dm" | "router" | "none";
      reason?: string;
    }
  | { type: "message.claimed"; channelId: string; messageId: string; agentId: string; runId?: string }
  | {
      type: "message.handled";
      channelId: string;
      messageId: string;
      agentId: string;
      runId?: string;
      status?: "done" | "failed" | "waiting_approval";
    }
  /** An agent asked a person something and waits (expected: `ask_user` tool; shape to confirm). */
  | {
      type: "question.asked" | "question.answered";
      channelId: string;
      threadId: string | null;
      question: AgentQuestion;
    }
  /** An agent asked a person for a secret, or the request closed (ADR 0027). */
  | {
      type: "secret.requested" | "secret.updated";
      channelId: string;
      threadId: string | null;
      secretRequest: SecretRequest;
    }
  /** An agent changed its memory because a person asked (with an undo), or proposed a change. */
  | {
      type: "memory.updated";
      channelId: string;
      threadId: string;
      agentId: string;
      runId: string;
      update: MemoryUpdate;
    }
  /** A background task on a connected computer changed (`task` is its whole view: replace). */
  | { type: "machine.task"; channelId: string; threadId: string | null; task: MachineTask }
  /** A mission changed (ADR 0029): `change` says what; refetch the mission for the rest. */
  | {
      type: "mission.updated";
      channelId: string;
      threadId: string;
      missionId: string;
      status: MissionStatus;
      change: string;
      decision?: MissionDecision;
      review?: MissionReview;
      messageId?: string;
      planVersion?: number;
      file?: string;
    };

/** You followed or unfollowed a thread (on any of your devices). */
export type ThreadFollowEvent = { type: "thread.follow" } & ThreadFollow;

/** Events for one person (`{ type: "event", scope: "user" }` frames), e.g. approvals they can decide. */
export type UserEvent =
  | { type: "approval.created" | "approval.decided"; approval: Approval }
  | BudgetEvent
  | NotificationEvent
  | ThreadFollowEvent
  | { type: string };

// ── Approvals, connectors, scopes ─────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "refused" | "expired" | "canceled";

/** A sensitive action waiting for a person (apps/server/src/routes/app/approvals.ts). */
export interface Approval {
  id: string;
  /** Null when a mission's executor asked (`missionId`). */
  runId: string | null;
  /** A mission's executor asked (ADR 0029). */
  missionId?: string | null;
  agentId: string;
  channelId: string;
  threadId: string;
  /** The approval card in the chat. */
  messageId: string | null;
  tool: string;
  scope: string;
  /** "Merge PR #42 into main" (from the connector catalog). */
  title: string;
  detail: string;
  /** Exactly what will run if approved. */
  params: Record<string, unknown>;
  status: ApprovalStatus;
  expiresAt: string;
  createdAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  reason: string | null;
  /** You are the agent's owner or an admin, and it is pending. */
  canDecide: boolean;
  /** The agent's owner (they and admins may decide). */
  ownerUserId?: string | null;
  /** When the approved action ran; null while it runs (or if it never did). */
  executedAt?: string | null;
  /** What the action returned once it ran (raw tool output, short). */
  result?: { ok: boolean; text: string } | null;
  /** The connector it goes through ("github") and its account. */
  connector?: string | null;
  connectorAccount?: string | null;
  /** What the agent said right before asking. */
  why?: string | null;
  issue?: { id: string; number: number; title: string } | null;
  /** One approval only: what the agent said at each turn before asking. */
  trail?: { text: string; at: string }[];
}

export interface ScopeInfo {
  id: string;
  label: string;
  description: string;
  /** Using it always becomes an approval request. */
  sensitive: boolean;
}

/** Catalog groups: Desenvolvimento, Produto, Docs, Pagamentos, Suporte, Marketing, Automação. */
export type ConnectorCategory = "dev" | "product" | "docs" | "payments" | "support" | "marketing" | "automation";

/** A connector agentes.chat knows (`GET /connectors/catalog`: ours and the one-click MCP servers, one per service). */
export interface ConnectorDef {
  id: string;
  label: string;
  description: string;
  /**
   * `catalog`: our connector with its own scopes (GitHub, Drive…);
   * `remote_mcp`: the vendor's official MCP server (one click, then the same
   * tools review as a custom server).
   */
  kind: "catalog" | "remote_mcp";
  category: ConnectorCategory;
  auth: ("oauth" | "api_key")[];
  /** Signs in with OAuth here: our OAuth app, or the vendor's MCP OAuth. */
  oauthConfigured: boolean;
  /** Can be connected on this server; `false` shows "Em breve". */
  available: boolean;
  needsServerUrl: boolean;
  /** The MCP endpoint (`remote_mcp`). */
  serverUrl: string | null;
  /** Brand icon served by this app (`/connectors/github.svg`); null = a monogram. */
  iconUrl: string | null;
  /** Tint of the icon; null = the ink. */
  brandColor: string | null;
  scopes: ScopeInfo[];
  tools: { name: string; scope: string; sensitive: boolean }[];
}

export interface ConnectorCatalog {
  connectors: ConnectorDef[];
  builtinScopes: ScopeInfo[];
}

/** The organization's connection to a connector (no secrets). */
export interface Connection {
  id: string;
  connector: string;
  label: string;
  serverUrl: string;
  authType: string;
  accountLabel: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** An installation of our GitHub App bound to the organization (repository access for git and PRs). */
export interface GitHubAppInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  /** `all` or `selected` repositories. */
  repositorySelection: string;
  suspended: boolean;
  createdAt: string;
}

/** A repository the organization's GitHub reaches. */
export interface GitHubRepository {
  /** `owner/name`. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  updatedAt: string | null;
}

/** The repositories the organization's GitHub reaches (its connection and the app's installations), by account. */
export interface GitHubRepositories {
  connected: boolean;
  accounts: { login: string; type: string; repositories: GitHubRepository[] }[];
  truncated: boolean;
}

/** One permission of an agent: a built-in scope (`connectionId: null`) or a connection's scope. */
export interface ScopeGrant {
  connectionId: string | null;
  scope: string;
}

export type MemoryKind = "fact" | "decision" | "lesson" | "preference";

export interface Memory {
  id: string;
  agentId: string;
  kind: MemoryKind;
  text: string;
  /** "Written by Walter in #eng · Oct 12" (the server's English; `origin` has the parts). */
  source: string;
  origin?: {
    by: "person" | "agent" | "lesson" | "recorded";
    name: string | null;
    channel: string | null;
    at: string;
  };
  uses: number;
  lastUsedAt: string | null;
  pinned: boolean;
  archived: boolean;
  /** Came from an external, untrusted source (e.g. a public GitHub comment). */
  lowTrust: boolean;
  /** Backed by an outcome or a person; agent claims alone are not. */
  verified: boolean;
  /** The text this one replaced, if any. */
  supersedes: string | null;
  /** Set when a person edited it ("Editado por você · agora"). */
  editedByUserId: string | null;
  updatedAt: string;
}

export type ProposalStatus = "pending" | "accepted" | "refused";

export interface Proposal {
  id: string;
  agentId: string;
  target: { type: "agent_instructions"; agentId: string } | { type: "org_context" };
  title: string;
  why: string;
  /** `type` names the source for translation; `where` is the server's English text. */
  evidence: {
    where: string;
    what: string;
    channelId?: string | null;
    type?: "outcome" | "human" | "agent" | "self";
  }[];
  before: string;
  after: string;
  status: ProposalStatus;
  /** The text changed since it was proposed: it can no longer be accepted. */
  stale: boolean;
  /** You are the agent's owner or an admin (org context: admins). */
  canDecide: boolean;
  /** Who can decide: the agent's owner for instructions, admins for the org context. */
  decider: { type: "user"; userId: string; name: string } | { type: "admins" };
  createdAt: string;
  decidedBy: { userId: string; name: string } | null;
  decidedAt: string | null;
}

// ── Management (apps/server/src/routes/app/management.ts) ────────────────────

export interface OrgSettings {
  name: string;
  /** Shared with every agent of the organization (start of every prompt). */
  context: string;
  /** Key that pays for router and summaries. */
  defaultCredentialId: string | null;
  routerModel: string | null;
  summaryModel: string | null;
  timezone: string;
  /** Admins only: monthly budget of every agent without its own (US$). Absent for members. */
  defaultAgentBudgetUsd?: number;
}

/** Sidebar counts. */
export interface OrgOverview {
  name: string;
  role: Role;
  people: number;
  agents: number;
  /** What the workspace's agents spent this month over the sum of their budgets, in %. */
  budgetUsedPercent: number;
  approvalsWaitingForMe: number;
}

export interface Person {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  joinedAt: string;
  lastSeenAt: string | null;
  online: boolean;
  handle: string;
  timezone: string;
}

export interface InvitationWithStatus {
  id: string;
  email: string;
  role: Role;
  status: "pending" | "expired";
  expiresAt: string;
  createdAt: string;
}

export interface BatchInviteResult {
  email: string;
  status: "invited" | "already_member" | "invalid_email" | "already_invited";
  invitationId?: string;
  url?: string;
}

export interface AgentChannel {
  id: string;
  name: string;
  /** Answers without a mention in this channel. */
  autoReply: boolean;
}

export interface AgentDetail {
  id: string;
  name: string;
  handle: string;
  role: string;
  instructions: string;
  model: string;
  ownerUserId: string | null;
  /** Null = platform key (Cloud). */
  credentialId: string | null;
  /** This month's spend over its budget (its own, else the workspace default), in %. */
  budgetUsedPercent: number;
  /** Admins only: its own budget; null = the workspace default. Absent for members. */
  monthlyBudgetUsd?: number | null;
  /** Admins only, when it follows the default: the workspace default budget. */
  defaultBudgetUsd?: number;
  tokensThisMonth: number;
  runsThisMonth: number;
  pendingApprovals: number;
  channels: AgentChannel[];
  createdAt: string;
}

export interface Run {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string;
  trigger: string;
  status: string;
  error: string | null;
  /** The error as a code (`run.budget_exceeded`…) and its values, to say it in the person's language. */
  errorCode?: string;
  errorParams?: Record<string, string>;
  /** Start of the message that started the run. */
  what: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  finishedAt: string | null;
  /** The GitHub repository it worked in (`owner/name`). */
  repo?: string | null;
  /** A GitHub repository it was refused (not in the agent's repositories). */
  deniedRepo?: string | null;
}

export interface RunStep {
  seq: number;
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface UsageReport {
  since: string;
  /** Budget of agents without their own. */
  defaultAgentBudgetUsd: number;
  totalUsd: number;
  byKind: {
    kind: "agent" | "router" | "embedding" | "summary" | "sandbox";
    calls: number;
    partialCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
  agents: {
    agentId: string;
    handle: string;
    name: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** Its effective budget (own or the default). */
    monthlyBudgetUsd: number;
    budgetIsDefault: boolean;
    budgetUsedPercent: number;
  }[];
}

export interface RosterMember {
  type: AuthorType;
  id: string;
  name: string;
  handle: string | null;
  /** Agents: answers without a mention here. */
  autoReply: boolean | null;
  joinedAt: string;
}

/** `budget.warning` (80%) / `budget.exhausted` (100%), sent to the agent's owner. */
export interface BudgetEvent {
  type: "budget.warning" | "budget.exhausted";
  agentId: string;
  /** Share of the budget used (no money: owners may be members). */
  percent: number;
}

// ── Custom MCP servers (apps/server/src/routes/app/connectors-custom.ts) ─────

/** How a tool of a custom server may be used. `null` = not classified yet (hidden from agents). */
export type ToolAccess = "read" | "write" | "approval";
/** An admin's decision on a tool: how it may be used, or `off` (never offered, not asked again). */
export type ToolDecision = ToolAccess | "off";

export interface CustomTool {
  name: string;
  /** As the server describes it. */
  description: string;
  /** The server's `readOnlyHint` annotation, when it sends one. */
  readOnlyHint: boolean | null;
  /** Our suggestion until an admin decides (read-only → read, destructive/write-like → approval, else write). */
  suggestedAccess?: ToolAccess | null;
  access: ToolDecision | null;
  /** The decision, else the suggestion. */
  level?: ToolDecision;
  /** Where the suggestion came from: the server's hints, the name's verb, or the judge (ambiguous names). */
  suggestionSource?: "annotation" | "verb" | "preset" | "judge" | "judge_failed" | null;
  /** Why we suggest it, as a code (`spends_money`, `unknown`…): `toolReview.reason.*`. */
  suggestionReason?: string | null;
  /** Deletes, sends, pays…: only "Pede aprovação" or "Desligada". */
  sensitive?: boolean;
  /** The name couldn't decide it and no one confirmed the suggestion yet ("Precisam da sua decisão"). */
  pending?: boolean;
  off?: boolean;
  /** The readable name's parts (English words; the web says them in the person's language). */
  nameParts?: { verb: string | null; words: string[] };
  /** The resource it is about (`campaign`): tools are grouped by it. */
  subject?: string;
  /** Shown to people (approval cards, permissions), in pt-BR. */
  label: string;
  firstSeenAt: string;
}

export interface CustomServer {
  id: string;
  serverUrl: string;
  label: string;
  authType: "oauth" | "api_key";
  tools: CustomTool[];
  /** Last time an admin saved the classification; null = never (nothing exposed). */
  reviewedAt: string | null;
  createdAt: string;
}

/** What connecting to a URL needs: OAuth (discovery + dynamic client registration) or an API key. */
export type CustomConnectStart =
  | { status: "connected"; server: CustomServer }
  | { status: "oauth"; authorizeUrl: string }
  | { status: "needs_key" };

// ── Knowledge (phase 5: apps/server/src/routes/app/knowledge.ts) ─────────────

export type SearchKind = "message" | "context_item" | "issue" | "forum_topic" | "forum_reply" | "file";

export interface SearchHit {
  kind: SearchKind;
  /** The message id, context item id, … */
  sourceId: string;
  channelIds: string[];
  title: string;
  snippet: string;
  score: number;
  createdAt: string;
}

/** `message.meta.replyTo`: the message a quote reply answers, as it was when quoted (server-made). */
export interface ReplyRef {
  messageId: string;
  /** Its thread (null = the main timeline). */
  threadId: string | null;
  author: { type: AuthorType; id: string | null };
  authorName: string;
  excerpt: string;
}

/** Something an agent saved to its memory from a person's message (the memory mark). */
export interface MessageMemory {
  id: string;
  agentId: string;
  kind: "fact" | "preference" | "decision" | "note" | "lesson";
  text: string;
  createdAt: string;
}

export interface ReactionCount {
  /** `+1` / `-1` on agent replies are feedback for the agent. */
  reaction: string;
  /** People and agents together. */
  count: number;
  /** People who reacted. */
  userIds: string[];
  /** Agents who reacted instead of replying (the `react` tool). Older payloads may lack it. */
  agentIds?: string[];
}

/** A memory change an agent made because a person asked, or a proposal it made (`memory.updated`). */
export interface MemoryUpdate {
  action: "remembered" | "forgot" | "updated" | "proposed";
  itemId: string;
  text: string;
  previousText?: string | null;
  requestedByUserId: string;
  /** Undo: `POST …/memories/{itemId}/revert`. Absent for proposals. */
  undo?: { method: "POST"; path: string };
  /** For `proposed`: the proposal to decide inline. */
  proposalId?: string;
  canDecide?: boolean;
}

/** Who a direct message is with. */
export type DmTarget = { agentId: string } | { userId: string };

/** A direct conversation (`GET …/dms`). */
export interface DirectMessage {
  channelId: string;
  with: { type: AuthorType; id: string; name: string; handle: string | null };
  lastMessage: { id: string; body: string; createdAt: string; authorType: string } | null;
  unread: number;
}

/**
 * A question an agent asked (`ask_user`). Expected shape, to confirm when the
 * backend lands it: carried by `question.asked` and by the question message
 * (`meta.question` or `meta.questionId`).
 */
export interface AgentQuestion {
  id: string;
  agentId: string;
  channelId: string;
  /** The person message the agent's run answers (receipts: "esperando sua resposta"). */
  threadId: string | null;
  messageId: string | null;
  text: string;
  /** Buttons to answer with; null = free answer in the composer. */
  choices: string[] | null;
  status: "open" | "answered";
  answer: string | null;
  answeredByUserId: string | null;
}

/** Where a secret goes on the agent's computer (ADR 0027). */
export type SecretTarget = { kind: "env" } | { kind: "file"; path: string };

/**
 * An agent asked a person for a secret for its computer (`request_secret`,
 * ADR 0027): carried by `meta.secretRequest` and `secret.requested` /
 * `secret.updated`. Never the value.
 */
export interface SecretRequest {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  messageId: string | null;
  /** The only person who can answer. */
  requestedForUserId: string;
  name: string;
  purpose: string;
  target: SecretTarget;
  /** null = the agent's cloud computer. */
  machineId: string | null;
  /** The computer's key for this request; null once it is closed. */
  publicKey: string | null;
  status: "pending" | "delivered" | "declined" | "expired" | "canceled";
  expiresAt: string;
  deliveredAt: string | null;
  removed: boolean;
}

/** A secret on an agent's computer, by name (the agent page). */
export interface AgentSecret {
  name: string;
  target: SecretTarget;
  machineId: string | null;
  deliveredAt: string;
  deliveredByUserId: string;
}

/** The value sealed in the browser to the request's key (`lib/secret-box.ts`). */
export interface SecretBox {
  v: 1;
  epk: string;
  iv: string;
  ct: string;
}

// ── File storage (expected: `GET/PUT …/storage`, `POST …/storage/test`, `…/storage/migrate`) ──

export type StorageKind = "agentes" | "s3";

/** What an admin types for "Seu próprio bucket". Keys empty = keep the stored ones. */
export interface S3Input {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string | null;
  pathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface StorageConfig {
  kind: StorageKind;
  /** The bucket in use (keys never come back: only their last characters). */
  s3: (Omit<S3Input, "accessKeyId" | "secretAccessKey"> & { accessKeyIdHint: string; secretHint: string }) | null;
  migration: StorageMigration | null;
}

export type StorageStep = "write" | "read" | "list" | "delete";

export interface StorageTestResult {
  ok: boolean;
  steps: { step: StorageStep; ok: boolean; error?: string | null }[];
}

export interface StorageMigration {
  status: "running" | "failed" | "done";
  copied: number;
  total: number;
  error?: string | null;
}

// ── Artifacts (expected: `…/artifacts`, events `artifact.created` / `artifact.updated`, `meta.artifacts`) ──

export type ArtifactKind = "document" | "table" | "diff" | "diagram" | "html" | "file";

/**
 * An uploaded file as is (ADR 0025): metadata only; the bytes come from the
 * download link. `text`: small UTF-8 text files only.
 */
export interface ArtifactFileContent {
  kind: "file";
  name: string;
  contentType: string;
  /** Bytes. */
  size: number;
  sha256: string;
  text?: string;
}

export interface ArtifactAuthor {
  type: "agent" | "person";
  id: string;
}

/** One file of a code change: a unified patch (`@@ -1,3 +1,4 @@` hunks). */
export interface ArtifactDiffFile {
  path: string;
  patch: string;
}

export type ArtifactContent =
  | { kind: "document"; markdown: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "diff"; files: ArtifactDiffFile[] }
  | { kind: "diagram"; mermaid: string }
  | { kind: "html"; html: string }
  | ArtifactFileContent;

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  /** Latest version number (1, 2, …). */
  version: number;
  channelId: string | null;
  threadId: string | null;
  createdBy: ArtifactAuthor;
  updatedBy: ArtifactAuthor;
  createdAt: string;
  updatedAt: string;
  /** The viewer may save new versions (documents and tables; uploaded files by uploading again). */
  canEdit: boolean;
  /** HTML: render only in a sandboxed iframe (we always do). */
  untrusted: boolean;
  /** The creator, who asked the agent, the agent's owner and admins may delete it. */
  canDelete?: boolean;
}

/** `GET …/artifacts-trash`: deleted files, kept for 30 days. */
export interface TrashedArtifact extends Artifact {
  deletedAt: string;
  /** After this it can't be restored (409 `artifact.purged`). */
  purgeAt: string;
}

export interface ArtifactVersion {
  version: number;
  author: ArtifactAuthor;
  /** "Corrigi os números de março". */
  note: string | null;
  createdAt: string;
}

/** An artifact at one version, with its content. */
export interface ArtifactDetail extends Artifact {
  /** The version shown (may be older than `version`). */
  shownVersion: number;
  content: ArtifactContent;
}

/** `message.meta.artifacts`: what the agent created or changed in that reply. */
export interface ArtifactRef {
  id: string;
  version?: number;
  /** The file was deleted: the card shows "Arquivo removido". */
  deleted?: boolean;
  title?: string;
}

export interface ArtifactFilters {
  q?: string;
  kind?: ArtifactKind;
  channelId?: string;
  author?: ArtifactAuthor;
}

/** Channel event: an artifact was created or got a new version. */
export type ArtifactEvent = {
  type: "artifact.created" | "artifact.updated";
  channelId: string;
  artifact: Artifact;
};

// ── Issues, routines and calendar (D28; expected with backend phase 6) ──────

/** A person or an agent (issues, routines, calendar). */
export type Actor = ArtifactAuthor;

export type IssueStatus = "todo" | "in_progress" | "in_review" | "done" | "canceled";
export type IssuePriority = "low" | "normal" | "high";

export interface IssueCriterion {
  id: string;
  text: string;
  done: boolean;
  /** Who checked it (an agent shows its face next to it). */
  doneBy?: Actor | null;
}

/**
 * The assigned agent's work on an issue, from its runs: live (`running`,
 * waiting on a person) or `stalled` (in progress with the agent, no run alive).
 */
export interface IssueWork {
  agentId: string;
  runId: string | null;
  state: "running" | "waiting_approval" | "waiting_input" | "stalled";
  since: string;
  /** The run's last tool calls, oldest first. */
  steps: { tool: string; detail?: string; at: string }[];
  reason?: "failed" | "canceled" | "budget";
}

export interface Issue {
  id: string;
  /** Per organization: #131. */
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee: Actor | null;
  labels: string[];
  /** Day only, `YYYY-MM-DD`. */
  dueDate: string | null;
  criteria: IssueCriterion[];
  createdBy: Actor;
  /** Where it came from: "a partir de uma mensagem no #produto". */
  source:
    | { type: "manual" }
    | { type: "message"; channelId: string; messageId: string }
    | { type: "forum"; threadId: string }
    | { type: "agent"; agentId: string }
    | { type: "webhook"; provider: string };
  /** The channel it lives in (from a message, or chosen). */
  channelId: string | null;
  pullRequests: { number: number; url: string; openedBy: Actor | null }[];
  artifacts: { id: string; title: string; createdBy: Actor }[];
  work?: IssueWork | null;
  /** The issue this one is a sub-issue of (a plan step from the forum, D45). */
  parentIssueId?: string | null;
  /** On the detail: its sub-issues. */
  subIssues?: { id: string; number: number; title: string; status: IssueStatus; assignee: Actor | null }[];
  /** On the detail: forum topics opened from it ("Avaliar no fórum"), oldest first. */
  forumTopics?: { id: string; title: string; status: ForumStatus; format: ForumFormat }[];
  createdAt: string;
  updatedAt: string;
}

export interface IssueActivity {
  id: string;
  kind: "comment" | "event";
  author: Actor;
  /** Comment body, or the event in words ("asked Ada to implement"; English, the fallback). */
  text: string;
  /** Machine form of an event (`status_changed`, `assigned`, `agent_asked`, …). */
  event?: string;
  /** The event in the app's words: `issues.event.{textCode}` with `textParams`. */
  textCode?: string;
  textParams?: Record<string, string>;
  /** The system moved it on its own (the agent's runs, a linked PR). */
  auto?: boolean;
  /** Files attached to a comment (Drive). */
  attachments?: { id: string; title: string }[];
  createdAt: string;
}

export interface IssueInput {
  title: string;
  description?: string;
  criteria?: string[];
  assignee?: Actor | null;
  priority?: IssuePriority;
  dueDate?: string | null;
  labels?: string[];
}

export type IssuePatch = Partial<
  Pick<Issue, "title" | "description" | "status" | "priority" | "assignee" | "dueDate" | "labels">
>;

export type RoutineEvent = "sentry.issue_created" | "github.pr_opened" | "issue.created" | "deploy.succeeded";

/**
 * The rule as the API sends it: monthly/yearly positions are in `byWeekday`
 * ("2TU", "-1FR"); yearly may carry `byMonth`; `"once"` means no repeat.
 */
export interface ApiRule {
  freq: "once" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  byWeekday?: string[];
  byMonthDay?: number[];
  byMonth?: number[];
  bySetPos?: number | null;
  times?: string[];
  timezone: string;
  start?: string | null;
  until?: string | null;
  count?: number | null;
}

/** `POST …/routines/parse-rule` and `…/describe-rule`. */
export type RuleInfo =
  | { ok: true; rule: ApiRule; description: string; cron: string; nextRuns: string[] }
  /** `code`: stable, for the app to say it in the UI language (`error` is the English fallback). */
  | { ok: false; error: string; code?: string };

export type RoutineTrigger =
  | {
      type: "schedule";
      /** Set when it was written as a phrase; routines made with the picker have only `rule`. */
      phrase?: string | null;
      rule?: ApiRule | null;
      cron: string;
      timezone: string;
      description: string;
    }
  | { type: "event"; event: RoutineEvent }
  /** A one-off (reminders, "amanhã às 9h"): fires once at `at`, then the routine is inactive. */
  | { type: "once"; at: string; timezone: string; description: string };

/** Where a routine created here delivers; `forum` opens a topic with these agents each time. */
export type RoutineTargetInput =
  | { type: "channel"; channelId: string }
  | { type: "dm" }
  | { type: "artifact" }
  | { type: "forum"; agentIds: string[]; rounds?: number };

/**
 * Also `conversation`: a thread or DM, from an agent's `schedule_reminder` or
 * `create_routine` in the chat. `reminder`: a plain reminder (the agent's
 * message mentioning `forUserId`, no run).
 */
export type RoutineTarget =
  | RoutineTargetInput
  | { type: "conversation"; channelId: string; threadId: string | null; reminder?: boolean; forUserId?: string };

export interface Routine {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  target: RoutineTarget;
  trigger: RoutineTrigger;
  active: boolean;
  /** Null when paused or event-driven. */
  nextRunAt: string | null;
  running: boolean;
  lastRun: RoutineRun | null;
  /** The last runs, newest first (at most 14): the row's pixel strip and the horizon. */
  recentRuns?: RoutineRun[];
  /** Event routines that can be triggered by a webhook: the URL to call. */
  webhookUrl?: string | null;
  createdAt: string;
}

export interface RoutineRun {
  id: string;
  at: string;
  /** `silent`: nothing new, the agent stayed quiet (NO_REPLY). */
  status: "ok" | "silent" | "failed" | "skipped";
  /** "Resumo postado no #geral", "Orçamento do mês esgotado" (the server's pt-BR words). */
  summary: string;
  /** The same as a code ("routine_run.paused") and its values: shown in the UI language. */
  summaryCode?: string | null;
  summaryParams?: Record<string, string>;
  /** Recent runs only: cost as a share (0–1) of the priciest recent run; never money. */
  weight?: number;
}

export interface RoutineInput {
  name?: string;
  agentId: string;
  prompt: string;
  target: RoutineTargetInput;
  trigger:
    | { type: "schedule"; phrase: string; timezone?: string }
    | { type: "schedule"; rule: ApiRule }
    | { type: "event"; event: RoutineEvent }
    | { type: "once"; at: string; timezone?: string };
}

/** `PATCH …/routines/{id}`: only what changed. */
export type RoutinePatch = Partial<Omit<RoutineInput, "name">> & { name?: string; active?: boolean };

/** Natural language → cron, in the workspace time zone (the backend decides). */
export type ScheduleParse =
  | { ok: true; cron: string; description: string; timezone: string }
  | { ok: false; error: string };

export type Recurrence = "none" | "weekdays" | "weekly" | "monthly";

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  recurrence: Recurrence;
  participants: Actor[];
  /** Each invited person's answer. */
  rsvp: (Actor & { status: "needs_action" | "accepted" | "declined" })[];
  channelId: string | null;
  issueId: string | null;
  createdBy: Actor;
  /** Structured recurrence (`freq` once = a single event); day and time come from the event. */
  rule?: ApiRule | null;
  location?: string | null;
  /** All-day events: `YYYY-MM-DD`, the end inclusive. */
  startDate?: string | null;
  endDate?: string | null;
  /** An occurrence of a series: the series' id and this occurrence's original start. */
  seriesId?: string | null;
  occurrenceStart?: string | null;
  /** Days left out of the series (`YYYY-MM-DD`). */
  exdates?: string[];
}

/** Which occurrences an edit of a recurring event changes. */
export type SeriesScope = "this" | "following" | "all";

export type CalendarEventPatch = Partial<
  Pick<
    CalendarEventInput,
    | "title"
    | "description"
    | "start"
    | "end"
    | "allDay"
    | "startDate"
    | "endDate"
    | "timezone"
    | "participants"
    | "rule"
    | "location"
  >
>;

/** An agent's suggested slot; a person confirms before anyone is invited. */
export interface CalendarProposal {
  id: string;
  agentId: string;
  title: string;
  start: string;
  end: string;
  participants: Actor[];
  /** "livre para todos". */
  note: string | null;
  status: "pending" | "confirmed" | "dismissed";
}

export interface CalendarRange {
  events: CalendarEvent[];
  /** Scheduled routine runs in the range. */
  routines: { routineId: string; name: string; agentId: string; at: string; target: RoutineTarget }[];
  /** Issues due in the range (all-day). */
  deadlines: { issueId: string; number: number; title: string; date: string }[];
  proposals: CalendarProposal[];
}

export interface CalendarEventInput {
  title: string;
  description?: string;
  start: string;
  end: string;
  allDay?: boolean;
  /** IANA zone of the times (defaults to the workspace's). */
  timezone?: string;
  recurrence: Recurrence;
  participants: Actor[];
  channelId?: string | null;
  issueId?: string | null;
  rule?: ApiRule | null;
  location?: string | null;
  /** All-day: `YYYY-MM-DD`, the end inclusive. */
  startDate?: string | null;
  endDate?: string | null;
}

// ── Agent access (apps/server/src/routes/app/access.ts) ──────────────────────

/** `granted` explicitly, `inherited` from a broader grant ("all", the connector, the scope), `denied`, `off`. */
export type AccessState = "granted" | "inherited" | "denied" | "off";

export interface AccessTool {
  /** As exposed to the model ("github_merge_pull_request"). */
  name: string;
  /** Human name (pt-BR when the backend has one). */
  label: string;
  description: string;
  /** Only reads (built-in `:read` scopes, MCP `readOnlyHint`, or classified as read). */
  readOnly: boolean;
  connectionId: string | null;
  scope: string;
  /** Always asks a person, whatever the grant. */
  sensitive: boolean;
  state: AccessState;
}

export interface AccessScope {
  scope: string;
  /** pt-BR. */
  label: string;
  state: AccessState;
  tools: AccessTool[];
}

/** `GET …/agents/{id}/access`: built-ins, then connectors with their scopes and tools. */
export interface AgentAccess {
  /** "Todas as ferramentas (atuais e futuras)". */
  all: boolean;
  builtins: AccessScope[];
  connectors: {
    connectionId: string;
    connector: string;
    label: string;
    custom: boolean;
    state: AccessState;
    scopes: AccessScope[];
  }[];
}

export interface ToolRef {
  connectionId: string | null;
  name: string;
}

/** `PUT …/agents/{id}/access`: replaces the agent's grants. */
export interface AccessInput {
  all: boolean;
  /** Connection id → "all tools of this connector" (also future ones). */
  connectors: Record<string, boolean>;
  scopes: { connectionId: string | null; scope: string }[];
  tools: { allow: ToolRef[]; deny: ToolRef[] };
}

// ── Skills (apps/server/src/routes/app/skills.ts) ────────────────────────────

/** How it was installed: a zip, a link (GitHub), or written here. */
export type SkillSourceKind = "upload" | "url" | "manual";

export interface Skill {
  id: string;
  name: string;
  /** From SKILL.md's front matter: when to use it. */
  description: string;
  /** Every edit is a new version (1, 2, …). */
  version: number;
  source: SkillSourceKind;
  /** The link it came from (`url` skills). */
  sourceUrl: string | null;
  /** Turned on for agents created from now on. */
  defaultForNewAgents: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SkillFile {
  path: string;
  size: number;
  mime: string;
  /** `script`: runs on the agent's PC; `ignored`: old imports whose scripts never run (reinstall to use them). */
  status: "stored" | "ignored" | "script";
}

export interface SkillDetail extends Skill {
  /** SKILL.md without the front matter (Markdown). */
  body: string;
  files: SkillFile[];
}

/** `GET …/agents/{id}/skills`: every skill of the library, with whether this agent has it. */
export interface AgentSkill extends Skill {
  enabled: boolean;
}

/** "Escrever": a skill made here. */
export interface SkillInput {
  name: string;
  description: string;
  body: string;
  defaultForNewAgents?: boolean;
}

/** An edit (new version unless only the flag changes). */
export interface SkillPatch {
  description?: string;
  body?: string;
  defaultForNewAgents?: boolean;
}

// ── PC do agente (sandbox): apps/server/src/routes/app/sandboxes.ts; `…/agents/{id}/computer` expected ──

export type SandboxNetwork = "blocked" | "allowlist" | "open";

export interface SandboxSettings {
  /** A sandbox provider is configured on this server. */
  available: boolean;
  enabled: boolean;
  /** Domains the PCs may reach (`*.` wildcards), used when `network` is `allowlist`. */
  allowDomains: string[];
  /** No internet, only the listed domains, or open internet. Absent (older servers): follows the list. */
  network?: SandboxNetwork;
  /** After a save: running PCs got it now (`live`) or get it when they next start (`next_start`). */
  networkApply?: "live" | "next_start";
  execTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  /** Minutes of PC time per day for the whole workspace. */
  dailyMinutes: number;
  /** Ask a person before running code. */
  requireApproval: boolean;
}

export type SandboxSettingsInput = Partial<
  Pick<
    SandboxSettings,
    "enabled" | "allowDomains" | "network" | "execTimeoutSeconds" | "dailyMinutes" | "requireApproval"
  >
>;

/** `GET …/agents/{id}/computer`: the agent's own PC. */
export interface AgentComputer {
  status: "running" | "stopped" | "archived" | "none";
  diskUsedGib: number;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** `provider-default` when the provider can't apply our domain list (plan limitation). */
  network?: "blocked" | "allowlist" | "open" | "provider-default";
  /** Which computer the agent uses (ADR 0025). Absent on older servers: the cloud one. */
  target?: ComputerTarget;
}

// ── Connected computers (ADR 0025; apps/server/src/routes/machines.ts) ──────

/** The agent's cloud computer, or a machine someone connected with the runner. */
export type ComputerTarget = { kind: "cloud" } | { kind: "machine"; machineId: string; name: string; online: boolean };

export type MachineOs = "linux" | "darwin" | "windows" | "other";

/** `GET …/machines`: a computer connected with `agentes-runner`. */
export interface Machine {
  id: string;
  name: string;
  /** Runner connected now (`machine.status` events). */
  online: boolean;
  lastSeenAt: string | null;
  hostname: string;
  /** `linux`, `darwin`, `windows` or `other` (`MachineOs`). */
  os: string;
  arch: string;
  runnerVersion: string;
  /** `false`: started with `--no-exec` (files and uploads only). */
  execAllowed: boolean;
  pairedBy: { id: string; name: string } | null;
  agents: { id: string; name: string; handle: string }[];
  /** Workspace folder on the machine; null unless admin or the person who paired it. */
  workspace: string | null;
  /** This person may rename or remove it. */
  canManage: boolean;
  createdAt: string;
}

/** `POST …/machines/pairings`: a one-time code (10 minutes) and the command to run on the machine. */
export interface MachinePairing {
  code: string;
  expiresAt: string;
  installCommand: string;
}

/** Org events about connected computers. */
export type MachineEvent =
  | { type: "machine.status"; machineId: string; online: boolean }
  | { type: "machine.paired"; machineId: string; name: string }
  | { type: "machine.updated"; machineId: string; name: string }
  | { type: "machine.deleted"; machineId: string };

// ── Forum (apps/server/src/routes/app/forum.ts, D33 revised by D45) ─────────

/** `stalled`: a person stopped the turn (or it failed) and nobody speaks until "Retomar". */
export type ForumStatus = "open" | "stalled" | "done" | "canceled";
export type ForumPhase = "discussing" | "waiting_person" | "synthesizing" | "finished";
/** What comes out: a decision (pros and cons, next steps) or a plan (scope, steps, risks, metrics). */
export type ForumFormat = "decision" | "plan";

/** A place at the table: an agent, or a person who sat down (speaking order). */
export interface ForumSeat {
  type: "agent" | "person";
  id: string;
}

export interface ForumOwner {
  type: "agent" | "person";
  id: string;
}

/** An issue the synthesis suggests; created only when a person approves it. */
export interface ForumSuggestedIssue {
  title: string;
  description: string;
  /** The plan step it comes from (1-based). */
  step?: number;
  /** Becomes the assignee when the issue is created. */
  owner?: ForumOwner | null;
}

/**
 * How a seat's turn in a round went: `skipped_budget` (the agent's own budget
 * was out), `passed` (a seated person passed), `skipped` (the round ended
 * early, or not chosen for a new round), `stopped` / `failed` (the turn that
 * stalled the topic), `live` (writing now), `waiting` (a seated person's
 * turn), `pending` (to come).
 */
export type ForumTrackStatus =
  | "spoke"
  | "skipped_budget"
  | "passed"
  | "skipped"
  | "stopped"
  | "failed"
  | "live"
  | "waiting"
  | "pending";

export interface ForumTrackEntry {
  seat: ForumSeat;
  status: ForumTrackStatus;
  postId: string | null;
  /** The post's length in characters (the column's height). */
  length: number;
}

export interface ForumTrackRound {
  round: number;
  /** People's free posts that lead this round (not seated turns). */
  personPosts: { userId: string; postId: string | null; length: number }[];
  entries: ForumTrackEntry[];
}

/** The round track: each round (up to `rounds`), each seat's turn in order; the synthesis at the end. */
export interface ForumTrack {
  rounds: ForumTrackRound[];
  synthesis: { agentId: string | null; status: "live" | "done" | "stalled"; revision: number } | null;
}

export type ForumOriginKind = "direct" | "channel" | "agent" | "suggestion" | "issue" | "routine";

export interface ForumOrigin {
  kind: ForumOriginKind;
  channelId: string | null;
  messageId: string | null;
  issueId: string | null;
  issueNumber: number | null;
  routineId: string | null;
  /** The agent that opened it when asked (`agent`) or suggested it (`suggestion`). */
  agentId: string | null;
}

export interface ForumNextStep {
  text: string;
  owner: ForumOwner | null;
  ownerLabel: string | null;
  when: string | null;
}

export interface ForumDecisionCards {
  format: "decision";
  decision: string;
  positions: { agentId: string | null; name: string; pros: string[]; cons: string[] }[];
  openQuestions: string[];
  nextSteps: ForumNextStep[];
  suggestedIssues: ForumSuggestedIssue[];
  /** Version 2+: what changed. */
  changes: string[];
}

export interface ForumPlanStep {
  title: string;
  owner: ForumOwner | null;
  ownerLabel: string | null;
  /** The step it waits for (1-based), or null: it can start now. */
  after: number | null;
  size: string | null;
}

export interface ForumPlanCards {
  format: "plan";
  objective: string;
  summaryForRequester: string;
  inScope: string[];
  outOfScope: string[];
  steps: ForumPlanStep[];
  risks: string[];
  metrics: string[];
  openQuestions: string[];
  suggestedIssues: ForumSuggestedIssue[];
  changes: string[];
}

export type ForumSynthesisCards = ForumDecisionCards | ForumPlanCards;

export interface ForumSynthesis {
  /** The Drive document (null when it couldn't be written). */
  artifactId: string | null;
  /** The document's version. */
  version: number;
  /** Which synthesis: 1, then 2… after each new round asked from a comment. */
  revision: number;
  format: ForumFormat;
  suggestedIssues: ForumSuggestedIssue[];
  structured: ForumSynthesisCards | null;
  /** The synthesis file was deleted. */
  deleted?: boolean;
  versions: {
    revision: number;
    artifactVersion: number | null;
    createdAt: string;
    afterRound: number;
    changes: string[];
  }[];
  /** Issues already created from it (by a person's approval). */
  createdIssues: { id: string; number: number; title: string }[];
}

export interface ForumStall {
  reason: "stopped" | "failed";
  byUserId: string | null;
  agentId: string | null;
  round: number;
  /** The synthesis was the turn that stopped. */
  synthesis: boolean;
  at: string;
}

/** A discussion among agents (and seated people), in rounds, ending in a synthesis. No money here. */
export interface ForumTopic {
  id: string;
  title: string;
  /** The question or goal. */
  goal: string;
  status: ForumStatus;
  phase: ForumPhase;
  format: ForumFormat;
  /** The round in progress (or the last one when finished), from 1. */
  round: number;
  rounds: number;
  agentIds: string[];
  /** People notified (they can post any time). */
  userIds: string[];
  /** The speaking order: agents and the people who sat down. */
  seats: ForumSeat[];
  createdBy: { type: "person" | "agent"; id: string };
  origin: ForumOrigin;
  originChannelId: string | null;
  /** "Responsável": runs run on their behalf. */
  responsibleUserId: string | null;
  /** "Pedido de" (e.g. the origin issue's author). */
  requestedByUserId: string | null;
  /** Writes the synthesis (null: the first agent). */
  ownerAgentId: string | null;
  deadline: string | null;
  /** The seated person whose turn it is ("Sua vez"). */
  waitingUserId: string | null;
  stall: ForumStall | null;
  reopened: { byUserId: string; at: string } | null;
  /** The topic's hidden channel: subscribe to it for the agents' live runs. */
  channelId: string;
  createdAt: string;
  lastActivityAt: string;
  /** Agents working right now. */
  activeAgentIds: string[];
  track: ForumTrack;
  synthesis: ForumSynthesis | null;
}

export type ForumStanceKind = "propose" | "agree" | "disagree" | "shift" | "ask" | "reply";

/** What a post says about the proposal on the table, and toward whom. */
export interface ForumStance {
  kind: ForumStanceKind;
  target?: { type: "agent" | "person" | "people"; id?: string; handle?: string };
}

/** `turn`: an agent's (or seated person's `seat`) turn; `free`: a person's post that leads the next round; `comment`: after the synthesis. */
export type ForumPostKind = "turn" | "free" | "seat" | "comment" | "synthesis";

export interface ForumPost {
  id: string;
  topicId: string;
  round: number;
  author: { type: "person" | "agent"; id: string };
  body: string;
  /** Agent posts: the run (the work summary under the post). */
  agentRunId: string | null;
  kind: ForumPostKind;
  stance: ForumStance | null;
  /** The post this one answers. */
  replyTo: string | null;
  /** The agent's position in one line. */
  position: string | null;
  /** A person asked for one more round from this post. */
  requestRound?: { agentIds: string[] | null };
  meta?: Record<string, unknown>;
  createdAt: string;
}

/** One synthesis written (version 2+ after a new round asked from a comment). */
export interface ForumSynthesisVersion {
  revision: number;
  artifactId: string | null;
  artifactVersion: number | null;
  agentId: string;
  format: ForumFormat;
  afterRound: number;
  createdAt: string;
  structured: ForumSynthesisCards;
  markdown: string;
}

export interface ForumTopicDetail extends ForumTopic {
  posts: ForumPost[];
  syntheses: ForumSynthesisVersion[];
}

export interface ForumTopicInput {
  title: string;
  goal: string;
  agentIds: string[];
  userIds?: string[];
  rounds?: number;
  /** ISO; when it passes, a seated person's turn is skipped, then the synthesis. */
  deadline?: string;
  /** Writes the synthesis (default: the first agent). */
  ownerAgentId?: string;
  format?: ForumFormat;
  /** The speaking order, agents and seated people mixed (default: the agents in order). */
  seats?: ForumSeat[];
  /** "Avaliar no fórum": the result comes back to the issue. */
  originIssueId?: string;
  /** From a thread: the synthesis comes back to that thread. */
  originMessageId?: string;
}

/** `POST …/posts`: `requestRound` asks for one more round (reopens a concluded topic). */
export interface ForumPostInput {
  body: string;
  requestRound?: { agentIds?: string[] };
  replyTo?: string;
}

/** `PUT …/forum/topics/{id}/participants`. */
export interface ForumParticipantsInput {
  addAgentIds?: string[];
  removeAgentIds?: string[];
  addUserIds?: string[];
  removeUserIds?: string[];
  seatUserIds?: string[];
  unseatUserIds?: string[];
}

/** An agent's "Vale um fórum?" card (`meta.forumSuggestion` of its message). Only a person opens it. */
export interface ForumSuggestion {
  title: string;
  goal: string;
  agentIds: string[];
  rounds: number;
  format: ForumFormat;
  suggestedByAgentId: string;
  state: "pending" | "accepted" | "dismissed";
  topicId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
}

/** "Abrir fórum" with the fields adjusted ("Editar"). */
export type ForumSuggestionOverrides = Partial<Omit<ForumTopicInput, "originIssueId" | "originMessageId">>;

/** Org broadcasts about the forum. */
export type ForumEvent =
  | {
      type: "forum.topic.updated";
      topicId: string;
      status: ForumStatus;
      round: number;
      phase?: ForumPhase;
      waitingUserId?: string;
      activeAgentIds?: string[];
    }
  | { type: "forum.post.created"; topicId: string; post: ForumPost };

/** For me: my seated turn, a topic opened on my request, a topic I asked for concluded. */
export type ForumUserEvent =
  | { type: "forum.your_turn"; topicId: string; title: string; round: number; deadline: string | null }
  | { type: "forum.requested"; topicId: string; title: string; byUserId: string; issueNumber?: number }
  | { type: "forum.concluded"; topicId: string; title: string; revision: number };

export type ForumFilter = "open" | "done" | "mine";

// ── Wiki (expected from the backend; the fake defines the shapes) ────────────

/** Who wrote a version: a person, or an agent (and the person who asked it). */
export interface WikiAuthor {
  type: "person" | "agent";
  id: string;
  /** For agents: "por Theo, a pedido de Walter". */
  onBehalfOf?: string | null;
}

export interface WikiPageSummary {
  id: string;
  /** URL key ("processos/onboarding"); changes when the page is renamed. */
  slug: string;
  title: string;
  /** "Processos/Vendas" ("" = the root). */
  folder: string;
  tags: string[];
  /** Bumped on every save. */
  version?: number;
  /** Only admins edit it. */
  locked?: boolean;
  /** "Fixadas": at the top of the wiki for everyone. */
  pinned?: boolean;
  /** The start of the text, plain, for cards. */
  excerpt?: string;
  /** `obsidian` for an imported page. */
  sourceType?: string | null;
  updatedAt: string;
  updatedBy: WikiAuthor;
}

/** Agents that used pages (in their context or reading them), last 7 days. */
export interface WikiAgentReads {
  total: number;
  agents: { agentId: string; count: number }[];
}

/** "What the agents read most" on the wiki's home. */
export interface WikiTopRead extends WikiAgentReads {
  slug: string;
  title: string;
}

/** A note of an Obsidian vault, read by the app, sent to `POST …/wiki/import`. */
export interface WikiImportNote {
  title: string;
  folder?: string;
  body: string;
  tags?: string[];
  aliases?: string[];
  /** Embedded attachments already in the Drive: name as written in `![[…]]` → artifact id. */
  attachments?: Record<string, string>;
}

export interface WikiImportInput {
  source: { type: "obsidian"; name: string };
  notes: WikiImportNote[];
  folder?: string;
  onConflict: "keep_both" | "skip";
}

export interface WikiImportResult {
  created: WikiPageSummary[];
  skipped: string[];
  failed: { title: string; reason: "title" | "too_long" }[];
}

/** Where a page is mentioned: other pages, messages, forum topics, issues. */
export type WikiBacklink =
  | { kind: "page"; slug: string; title: string; excerpt?: string }
  | { kind: "message"; channelId: string; messageId: string; channelName: string; excerpt: string; at: string }
  | { kind: "forum"; topicId: string; title: string }
  | { kind: "issue"; number: number; title: string };

export interface WikiPage extends WikiPageSummary {
  body: string;
  version: number;
  createdAt: string;
  createdBy: WikiAuthor;
  /** Everyone who wrote it, most recent first. */
  authors: WikiAuthor[];
  backlinks: WikiBacklink[];
  /** Where it came from; an import keeps its attachments (name → Drive artifact id). */
  source?: { type: string; id: string; channelId?: string; attachments?: Record<string, string> } | null;
  /** Agents that used it in the last 7 days; the channel only when public. */
  reads?: WikiAgentReads & {
    last: { agentId: string; channelId: string | null; channelName: string | null; at: string } | null;
  };
}

export interface WikiVersion {
  version: number;
  at: string;
  author: WikiAuthor;
  note: string | null;
  /** A note the server wrote ("created the page"), translated as `wiki.note.{noteCode}`. */
  noteCode?: string;
  noteParams?: Record<string, string>;
}

export interface WikiPageInput {
  title: string;
  folder?: string;
  tags?: string[];
  body: string;
}

/** `PUT …/wiki/pages/{slug}`: `baseVersion` is the version edited (409 `version_conflict` if it moved). */
export interface WikiUpdateInput {
  body: string;
  baseVersion: number;
  title?: string;
  folder?: string;
  tags?: string[];
  note?: string;
}

export interface WikiGraph {
  nodes: {
    slug: string;
    title: string;
    folder: string;
    tags: string[];
    agentId?: string | null;
    sourceType?: string | null;
  }[];
  edges: { from: string; to: string }[];
}

// ── Threads (ADR 0029; apps/server/src/routes/app/threads.ts) ──────────────────

export type ThreadState = "open" | "closed" | "archived";
export type ThreadTab = "all" | "working" | "missions" | "closed" | "archived";
export type ThreadChange =
  | "created"
  | "title"
  | "context"
  | "moved"
  | "returned"
  | "closed"
  | "reopened"
  | "archived"
  | "unarchived"
  | "deleted";

/** A person or an agent in a thread (`id` null: someone who left). */
export interface ThreadActor {
  type: AuthorType;
  id: string | null;
}

/** The range of a conversation a thread was made from. */
export interface ThreadContext {
  channelId: string;
  firstMessageId: string;
  lastMessageId: string;
  excludedMessageIds: string[];
  /** The range left the channel (a stub stays there). */
  moved: boolean;
  /** Messages in the range now (deleted and excluded ones don't count). */
  count: number;
}

export interface ThreadInfo {
  /** The root message id (what replies carry as `threadId`). */
  id: string;
  channelId: string;
  channelName: string;
  channelKind: "channel" | "dm" | "forum";
  /** Null: show `rootText`. */
  title: string | null;
  rootText: string;
  rootAuthor: ThreadActor;
  state: ThreadState;
  createdBy: string | null;
  closedBy: string | null;
  closedAt: string | null;
  archivedBy: string | null;
  archivedAt: string | null;
  context: ThreadContext | null;
  replyCount: number;
  lastActivityAt: string;
  lastMessage: { author: ThreadActor; excerpt: string; createdAt: string } | null;
  participants: ThreadActor[];
  /** An agent run is in progress (or waiting) in this thread. */
  working: boolean;
  needsYou: boolean;
  /** You may close, archive, rename or change the context. */
  canManage: boolean;
  /**
   * You follow it: notified of its replies, which count as unread in the
   * channel. By default whoever started it or wrote in it. Always sent by the
   * API; absent in `thread.updated` events (it is per person).
   */
  following?: boolean;
  /** The thread's mission, in short (details: `GET …/threads/{id}/mission`). */
  mission?: ThreadMissionSummary | null;
  createdAt: string;
}

export interface ThreadMissionSummary {
  id: string;
  /** The mission's agent (the row's avatar). */
  agentId: string;
  status: MissionStatus;
  planDone: number;
  planTotal: number;
  /** Plan items waiting for people, pending decisions and reviews; command cards for whoever answers them. */
  waitingYou: number;
}

export interface ThreadPage {
  threads: ThreadInfo[];
  nextCursor: string | null;
}

export interface ThreadFilters {
  tab?: ThreadTab;
  channelId?: string;
  agentId?: string;
  needsYou?: boolean;
  mine?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface ThreadCreateInput {
  /** Where the thread lives. */
  channelId: string;
  /** Where the range comes from (default: `channelId`). */
  contextChannelId?: string;
  firstMessageId: string;
  lastMessageId: string;
  excludedMessageIds?: string[];
  title?: string | null;
}

export interface ThreadPatch {
  /** Empty or null: no title of its own. */
  title?: string | null;
  firstMessageId?: string;
  lastMessageId?: string;
  excludedMessageIds?: string[];
}

export type ThreadAction = "move" | "return" | "close" | "reopen" | "archive" | "unarchive";

/** `meta.threadStart` on the root of a thread made from a range: the channel shows it as a marker. */
export interface ThreadStartMeta {
  title: string;
  contextChannelId: string;
  firstMessageId: string;
  lastMessageId: string;
  count: number;
  moved: boolean;
  movedCount: number;
}

// ── Missions (ADR 0029; apps/server/src/routes/app/missions.ts) ────────────────

/** `awaiting_close`: every plan item is done and nothing runs; the owner (or a decider) concludes it. */
export type MissionStatus = "proposed" | "active" | "paused" | "awaiting_close" | "done" | "canceled";
export type MissionRole = "owner" | "decide" | "comment" | "none";
export type PlanItemStatus = "todo" | "doing" | "waiting_you" | "done" | "dropped";

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
  note?: string;
}

/** Who programs a mission: Claude Code, Codex (experimental) or the agent itself with its own tools. */
export type MissionExecutor = "claude" | "codex" | "agent";

export interface Mission {
  id: string;
  /** The home thread (root message id). */
  threadId: string;
  channelId: string;
  agentId: string;
  ownerId: string | null;
  /** "claude" | "codex" | "agent". */
  executor: string;
  title: string;
  goal: string;
  status: MissionStatus;
  repoDir: string;
  resumeTasks: boolean;
  /** Autonomia: when the mission stops to ask a person before a command. */
  commandApproval: CommandApproval;
  plan: {
    version: number;
    done: number;
    total: number;
    waiting: number;
    /** Items in progress now. */
    doing: number;
    /** The latest plan in order (at most 40), for the strip. */
    items: Pick<PlanItem, "id" | "title" | "status">[];
  };
  pending: {
    decisions: number;
    provisional: number;
    reviews: number;
    suggestions: number;
    /** Requests to join (0 unless you can answer them). */
    joinRequests: number;
    /** Command cards waiting for an answer (0 unless you can answer them). */
    commands: number;
    /** Delivery cards waiting for you to conclude (0 unless you can answer them). */
    deliveries?: number;
  };
  /** You asked to join and nobody answered yet. */
  joinRequested: boolean;
  runningTasks: number;
  machine: {
    id: string;
    name: string;
    online: boolean;
    lentBy: string | null;
    /** Who can program on that computer (the plan card switches before Start). */
    executors: MissionExecutor[];
    /** Codex is installed but too old for missions. */
    codexTooOld: boolean;
  } | null;
  /** Handed over without a computer: the owner sets one. */
  needsComputer: boolean;
  /** Your role in it. */
  role: MissionRole;
  /** You may start work, decide, review, pause and stop. */
  canAct: boolean;
  /** You may close it and change who takes part. */
  canManage: boolean;
  createdAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  wikiPageId: string | null;
}

export type MissionListStatus = "open" | "closed" | "waiting_you" | MissionStatus;

/** `GET …/missions` filters (the server's; the Missões tab sends them). */
export interface MissionListQuery {
  status?: MissionListStatus;
  channelId?: string;
  agentId?: string;
  /** Words of the title or the goal. */
  q?: string;
  limit?: number;
}

/** Same filters, any status: the tabs and the sidebar's count. */
export interface MissionCounts {
  active: number;
  waitingYou: number;
  closed: number;
}

export interface MissionList {
  missions: Mission[];
  counts: MissionCounts;
}

/** "Pedir para participar": answered by the owner and those who decide. */
export interface MissionJoinRequest {
  id: string;
  missionId: string;
  userId: string;
  name: string;
  status: "pending" | "accepted" | "declined";
  role: MissionParticipantRole | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** Why an agent can't run a mission for you (`cloud_computer`: missions on cloud computers come later). */
export type MissionIneligibleReason =
  | "no_computer"
  | "cloud_computer"
  | "exec_off"
  | "runner_outdated"
  | "not_in_audience";

/** An agent for "Nova missão": whether it can run a mission for you, and why not. */
export interface MissionEligibleAgent {
  agentId: string;
  handle: string;
  name: string;
  /** Older servers only listed eligible agents (absent = eligible). */
  eligible?: boolean;
  reason?: MissionIneligibleReason | null;
  /** You can choose its computer (an admin or its owner). */
  canManage?: boolean;
  machine: { id: string; name: string; online: boolean } | null;
  ready: boolean;
  /** Who can program on its computer ("Quem programa"), and the default. */
  executors: MissionExecutor[];
  defaultExecutor: MissionExecutor | null;
  codexTooOld: boolean;
  /** The autonomy its new missions start with ("Usar como padrão"); absent on older servers. */
  commandApproval?: CommandApproval;
}

/** A command allowed for the whole mission ("Aprovar sempre"), in "O que já foi liberado". */
export interface MissionCommandRule {
  id: string;
  /** `Bash(swift build *)`. */
  rule: string;
  /** Who allowed it (user id). */
  by: string | null;
  createdAt: string;
}

/** "Configurações da missão": what the dialog reads besides the mission itself. */
export interface MissionSettings {
  missionId: string;
  rules: MissionCommandRule[];
  /** "Nesta missão: N liberados automaticamente · N perguntados · N bloqueados". */
  stats: { auto: number; asked: number; blocked: number };
  /** "Próximas missões do <agente>". */
  agentDefault: { commandApproval: CommandApproval; canSet: boolean; ownerId: string | null };
}

/** "Quem pensa" (ADR 0032): the API, or Claude Code / Codex on the agent's computer with a person's plan. */
export type BrainKind = "model" | "claude_code" | "codex";

/** Why a computer brain can't be chosen now. */
export type BrainUnavailable = "no_computer" | "exec_off" | "runner_old" | "not_installed" | "outdated";

export interface BrainModelOption {
  /** What is stored (`opus`, `sonnet`, `haiku`, a Codex model). */
  value: string;
  label: string;
  modelId?: string;
  recommended?: boolean;
}

export interface BrainOption {
  kind: BrainKind;
  available: boolean;
  reason?: BrainUnavailable;
  /** "Em teste" (Codex). */
  experimental: boolean;
  models: BrainModelOption[];
  defaultModel: string | null;
}

/** `GET …/agents/{id}/brain` (its owner or an admin). */
export interface AgentBrain {
  agentId: string;
  brain: BrainKind;
  /** As stored; null = the brain's default. */
  model: string | null;
  effectiveModel: string | null;
  /** If the computer isn't available, answer through the API (counts against the budget). */
  fallback: boolean;
  computer: { machineId: string; name: string; online: boolean } | null;
  options: BrainOption[];
  canEdit: boolean;
}

export interface AgentBrainInput {
  brain?: BrainKind;
  model?: string | null;
  fallback?: boolean;
  /** The person confirmed the personal-subscription warning (switching to Claude Code or Codex). */
  acceptPlanTerms?: boolean;
}

/** `GET …/missions/{id}/brain`: who does the work and with which model. */
export interface MissionBrain {
  missionId: string;
  /** The override; null = from the executor. */
  brain: BrainKind | null;
  model: string | null;
  effectiveBrain: BrainKind;
  effectiveModel: string | null;
  options: BrainOption[];
  canSetBrain: boolean;
  canSetModel: boolean;
}

/** "Ver saída": the last lines of a task, from the computer or what the server kept. */
export interface TaskOutput {
  taskId: string;
  status: MachineTaskStatus;
  source: "computer" | "saved";
  lines: string[];
  truncated: boolean;
}

/** Autonomia ("Pergunta sempre", "Só o que é arriscado", "Não pergunta"): every command, only the risky ones (low-risk ones allowed automatically), or never (but the blocked ones). */
export type CommandApproval = "always" | "low_risk_auto" | "never";

/** `meta.missionAutoApproved`: a command allowed without a card (one quiet line, Revogar). */
export interface MissionAutoApprovedMeta {
  missionId: string;
  taskId: string;
  tool: string;
  command: string;
  reason: "low_risk" | "never";
}

export interface MissionCreateInput {
  agentId: string;
  goal: string;
  title?: string;
  /** Where it starts (a new thread there). */
  channelId?: string;
  /** Or the thread that becomes its home. */
  threadId?: string;
  /** The repository on the computer, relative to the agent's folder. */
  folder?: string;
  /** Default: Claude Code when the computer has it, else the agent itself. */
  executor?: MissionExecutor;
  /** Default: low_risk_auto. */
  commandApproval?: CommandApproval;
}

export interface MissionDecision {
  id: string;
  missionId: string;
  taskId: string | null;
  messageId: string | null;
  question: string;
  options: string[];
  recommendation: string | null;
  why: string | null;
  impact: string | null;
  blocking: boolean;
  status: "pending" | "provisional" | "taken";
  chosen: string | null;
  chosenBy: string | null;
  chosenAt: string | null;
  opinions: { userId: string; option: string; at: string }[];
  createdAt: string;
}

export interface MissionReview {
  id: string;
  missionId: string;
  taskId: string | null;
  messageId: string | null;
  title: string;
  summary: string;
  prUrl: string | null;
  artifactIds: string[];
  status: "pending" | "approved" | "changes_requested";
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export type MissionParticipantRole = "decide" | "comment";

export interface MissionParticipants {
  owner: { userId: string; name: string } | null;
  participants: {
    userId: string;
    name: string;
    role: MissionParticipantRole;
    addedBy: string | null;
    createdAt: string;
  }[];
}

export type MachineTaskStatus = "queued" | "running" | "interrupted" | "done" | "failed" | "canceled";

/** A background task on a connected computer (one session of a mission's executor). */
export interface MachineTask {
  id: string;
  agentId: string;
  machineId: string;
  channelId: string;
  threadId: string | null;
  missionId: string | null;
  title: string;
  executor: string;
  status: MachineTaskStatus;
  exitCode: number | null;
  seconds: number | null;
  lastLine: string | null;
  files: string[];
  /** A pull request it opened (detected by the server). */
  prUrl?: string | null;
  branch: string | null;
  cwd: string | null;
  resumedFromId: string | null;
  resumedTaskId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
}

export type MissionFileName = "mission.md" | "decisions.md" | "notes.md";

export interface MissionFile {
  name: MissionFileName | string;
  content: string | null;
  source: string | null;
  writtenAt: string | null;
  updatedAt: string | null;
}

/** A `.agentes/` file edited on the machine: we kept the approved version. */
export interface MissionFileEdit {
  id?: string;
  name?: string;
  approved?: string;
  edited?: string;
  diff?: string;
  at?: string;
  [key: string]: unknown;
}

export interface MissionFiles {
  files: MissionFile[];
  editedOnMachine: MissionFileEdit[];
}

/** `/summary`: where it stands, from the database. */
export interface MissionSummary {
  missionId: string;
  text: string;
  plan: { done: number; total: number; doing: number; waiting: number };
  running: number;
  pendingDecisions: number;
  provisionalDecisions: number;
  pendingReviews: number;
}

export interface MissionPlanVersion {
  version: number;
  items: PlanItem[];
  source: string;
  taskId: string | null;
  createdAt: string;
}

/** `/plan`: the latest version and the history. */
export interface MissionPlan {
  missionId: string;
  current: MissionPlanVersion | null;
  history: MissionPlanVersion[];
}

export type MissionControl = "start" | "pause" | "resume" | "stop";

/** `meta.missionPlan`: the plan card (Começar / Mudar algo). */
/** `meta.missionLink` on an agent's reply: the mission it proposed, whose thread lives elsewhere. */
export interface MissionLinkMeta {
  missionId: string;
  threadId: string;
}

export interface MissionPlanMeta {
  missionId: string;
  title: string;
  goal: string;
  computer: string;
  executor: string;
}

/** `meta.missionReport`: a report the executor wrote in the thread. */
export interface MissionReportMeta {
  missionId: string;
  taskId: string;
  status: string;
  executor: string;
  computer: string | null;
  main: boolean;
}

/** `meta.missionPlanChange`: one line per plan change. */
export interface MissionPlanChangeMeta {
  missionId: string;
  version: number;
  added: { id: string; title: string }[];
  removed: { id: string; title: string }[];
  changed: { id: string; title: string; from: PlanItemStatus; to: PlanItemStatus; renamedFrom?: string }[];
}

/** `meta.missionSuggestion`: a person without the right to ask for work addressed the agent. */
export interface MissionSuggestionMeta {
  status: "pending" | "accepted" | "declined";
  missionId: string;
  by?: string;
  at?: string;
}

/** `meta.machineTask`: the notice when a background task ended. */
export interface MachineTaskMeta {
  id: string;
  title: string;
  status: MachineTaskStatus;
  exitCode: number | null;
  seconds: number;
  computer: string;
  executor: string;
  branch?: string;
  lastLine?: string;
  files?: string[];
  result?: string;
  missionId?: string;
  /** Commands it was refused with nobody to ask ("Bloqueado", "Liberar e repetir"). */
  blocked?: { tool: string; command: string }[];
}

/** `meta.missionCommand`: the executor asks to run a command off its allow list (the command card). */
/**
 * The end of a mission (`complete_mission`, or `auto` when every plan item
 * is done and nothing runs): what was delivered, what to check (per-person
 * checks), Concluir missão / Pedir ajustes.
 */
export interface MissionDelivery {
  id: string;
  missionId: string;
  taskId: string | null;
  messageId: string | null;
  auto: boolean;
  summary: string;
  artifactIds: string[];
  paths: string[];
  checklist: { id: string; text: string; checkedBy: string[] }[];
  status: "pending" | "accepted" | "changes_requested" | "superseded";
  note: string | null;
  saveToWiki: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** `meta.missionDelivery` on the delivery card's message. */
export interface MissionDeliveryMeta {
  missionId: string;
  id: string;
}

export interface MissionCommandMeta {
  id: string;
  missionId: string;
  taskId: string;
  tool: string;
  command: string;
}

/** A command the executor asked to run, and what became of it. */
export interface MissionCommand {
  id: string;
  missionId: string;
  taskId: string;
  tool: string;
  command: string;
  state: "pending" | "allowed" | "denied" | "expired";
  /** "Aprovar sempre": the rules it adds (`Bash(swift *)`). */
  rules: string[];
  decidedBy: string | null;
  decidedAt: string | null;
  always: boolean;
  createdAt: string;
  expiresAt: string;
}

// ── Notifications (contract: one inbox per person per organization) ─────────────

export type NotificationKind =
  | "mention"
  | "thread_reply"
  | "dm"
  | "agent_question"
  | "issue_assigned"
  | "issue_comment"
  | "issue_status"
  | "forum_turn"
  | "forum_synthesis"
  | "approval"
  | "mission_finished"
  | "mission_stopped"
  | "routine_finished"
  | "routine_failed"
  | "reaction";

/** Who did it; names and avatars come from the directory. */
export interface NotificationActor {
  type: "user" | "agent";
  id: string;
}

/** Where it lives: only the relevant ids are set. */
export interface NotificationSource {
  channelId?: string;
  threadId?: string;
  messageId?: string;
  dmId?: string;
  issueId?: string;
  issueNumber?: number;
  topicId?: string;
  approvalId?: string;
  questionId?: string;
  missionId?: string;
  routineId?: string;
  /** Channel name, thread title, issue title, topic title, mission or routine name. */
  label?: string;
}

/** What the card shows (plain text; only @mentions are highlighted). */
export interface NotificationLatest {
  /** Snippet of the latest message, comment, question or summary (≤ 280 chars). */
  text?: string;
  /** Issue title, the approval's action title, the topic's question. */
  title?: string;
  /** Reactions: distinct emojis (≤ 5) and my message's snippet. */
  emojis?: string[];
  quote?: string;
  statusFrom?: string;
  statusTo?: string;
  /** Missions and routines. */
  steps?: { done: number; total: number; failedAt?: number };
  /** An agent's question with options. */
  suggestions?: string[];
  /** Approvals. */
  expiresAt?: string;
  /** Forum turns. */
  round?: number;
  rounds?: number;
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  /** Goes into "Esperando você": it blocks an agent or a decision. */
  waiting: boolean;
  /** Most recent first, at most 10. */
  actors: NotificationActor[];
  /** Events merged into it (replies, comments, reactions). */
  count: number;
  source: NotificationSource;
  latest: NotificationLatest;
  readAt: string | null;
  doneAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NotificationFilter = "all" | "mentions" | "waiting" | "unread" | "reactions";

export type NotificationCounts = Record<NotificationFilter, number>;

/** `GET …/notifications`: visible ones (not done, not snoozed), waiting first, then newest. */
export interface NotificationPage {
  items: AppNotification[];
  counts: NotificationCounts;
  nextCursor: string | null;
}

/** The sidebar badge (`GET …/notifications/count`, `notification.counts`). */
export interface NotificationCount {
  unread: number;
  waiting: number;
}

/** Per person (user scope): created or merged, auto-resolved, and the new counts. */
export type NotificationEvent =
  | { type: "notification.upserted"; notification: AppNotification }
  | { type: "notification.removed"; id: string }
  | ({ type: "notification.counts" } & NotificationCount);

// ── Phone app: pins, following threads, working now, reminders ─────────────────

/** Your explicit choice about a thread (`threadFollows.follow` / `unfollow`). */
export interface ThreadFollow {
  threadId: string;
  channelId: string;
  following: boolean;
}

/** A pinned message (`GET …/channels/{id}/pins`, newest pin first). */
export interface MessagePin {
  messageId: string;
  channelId: string;
  /** The message's thread (null: the main timeline). */
  threadId: string | null;
  /** Null when that person was deleted. */
  pinnedByUserId: string | null;
  pinnedAt: string;
  message: Message;
}

/** "Trabalhando agora": an agent run in progress in a conversation you are in (`GET …/active-runs`). */
export interface WorkingRun {
  runId: string;
  agentId: string;
  channelId: string;
  channelKind: "channel" | "dm";
  /** Null for a DM. */
  channelName: string | null;
  /** Null: the main timeline (DMs are flat). */
  threadId: string | null;
  status: "queued" | "running" | "waiting_approval" | "waiting_input";
  startedAt: string | null;
  createdAt: string;
  /** What it works on: the thread's title, else its first message (≤ 80 chars). */
  label: string | null;
}

/** A one-off reminder in a conversation (`reminders.*`; also a routine in Rotinas). */
export interface Reminder {
  id: string;
  message: string;
  /** When it fires; null once done. */
  at: string | null;
  timezone: string;
  /** When, in English ("tomorrow, Oct 16, at 09:00 (…)"): show `at` in the app's words instead. */
  description: string;
  forUserId: string;
  channelId: string;
  threadId: string | null;
  done: boolean;
}

/**
 * "Lembrar": at `at` (ISO with offset) an agent of the conversation posts
 * "@you Reminder: …" where the message is. Agent: `agentId`, else the
 * message's agent author, else the first agent there you can talk to
 * (`reminder.no_agent` when none). Errors: `when.past`, `when.too_far`.
 */
export interface ReminderInput {
  channelId: string;
  threadId?: string | null;
  messageId?: string | null;
  agentId?: string | null;
  at: string;
  text?: string | null;
  timezone?: string | null;
}
