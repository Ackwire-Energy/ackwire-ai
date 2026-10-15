/** Types of the private web-app API (`/api/app/*`, apps/server/src/routes/app). */

export type Role = "owner" | "admin" | "member";
export type Edition = "selfhost" | "cloud";

export interface Health {
  status: "ok" | "degraded";
  version: string;
  edition: Edition;
}

export interface AuthConfig {
  socialProviders: { google: boolean; github: boolean };
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
  monthlyBudgetUsd: number | null;
  createdAt: string;
  /** Expected from the backend; absent = everyone. */
  audience?: AgentAudience;
  audienceMode?: AudienceMode;
  /** Whether I can talk to it (absent = yes). */
  canTalk?: boolean;
  /** Its look (color, eyes, accessory), from the backend's allow-list. */
  appearance?: AgentLookInput;
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
  /** Client only: an optimistic message waiting for the server, or one that failed to send. */
  local?: "pending" | "failed";
  createdAt: string;
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
  startedAt?: string | null;
}

/** Real-time channel events (packages/engine/src/events.ts, docs/adr/0010-realtime.md). */
export type ChannelEvent =
  | { type: "message.created"; channelId: string; messageId: string; message?: Message }
  | ArtifactEvent
  | {
      type: "agent.delta";
      channelId: string;
      threadId: string;
      runId: string;
      agentId: string;
      seq: number;
      text: string;
    }
  | {
      type: "agent.run";
      channelId: string;
      threadId: string;
      runId: string;
      agentId: string;
      status: RunStatus;
      error?: string;
    }
  | { type: "approval.created" | "approval.decided"; channelId: string; approval: Approval }
  // ── Chat latency batch (packages/engine/src/events.ts) ──────────────────────
  /** An agent will answer: show "thinking" at once. `runId` is null when announced at post time. */
  | { type: "agent.thinking"; channelId: string; threadId: string; agentId: string; runId: string | null }
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
  /** An agent changed its memory because a person asked (with an undo), or proposed a change. */
  | {
      type: "memory.updated";
      channelId: string;
      threadId: string;
      agentId: string;
      runId: string;
      update: MemoryUpdate;
    };

/** Events for one person (`{ type: "event", scope: "user" }` frames), e.g. approvals they can decide. */
export type UserEvent =
  | { type: "approval.created" | "approval.decided"; approval: Approval }
  | BudgetEvent
  | { type: string };

// ── Approvals, connectors, scopes ─────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "refused" | "expired";

/** A sensitive action waiting for a person (apps/server/src/routes/app/approvals.ts). */
export interface Approval {
  id: string;
  runId: string;
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
}

export interface ScopeInfo {
  id: string;
  label: string;
  description: string;
  /** Using it always becomes an approval request. */
  sensitive: boolean;
}

/** Catalog groups: Desenvolvimento, Produto, Docs, Pagamentos, Marketing, Suporte. */
export type ConnectorCategory = "dev" | "product" | "docs" | "payments" | "marketing" | "support";

/** A connector agentes.chat knows (catalog). */
export interface ConnectorDef {
  /** Expected from the backend's catalog: the group it shows under. */
  category?: ConnectorCategory;
  /**
   * `remote_mcp`: the vendor's official remote MCP server (one click, then the
   * same review as a custom server); `oauth_app`: our OAuth app (GitHub);
   * absent: the classic catalog connector.
   */
  kind?: "remote_mcp" | "oauth_app";
  /** The remote MCP endpoint (`remote_mcp`). */
  serverUrl?: string | null;
  /** Configured on this server; `false` shows "Em breve". */
  available?: boolean;
  /** An official asset URL from the catalog (else a monogram). */
  iconUrl?: string | null;
  id: string;
  label: string;
  description: string;
  auth: ("oauth" | "api_key")[];
  /** The server has an OAuth app for it (else: API key only). */
  oauthConfigured: boolean;
  needsServerUrl: boolean;
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
  /** "Decidido por Walter em #eng · 12 out". */
  source: string;
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
  evidence: { where: string; what: string; channelId?: string | null }[];
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
}

/** Sidebar counts. */
export interface OrgOverview {
  name: string;
  role: Role;
  people: number;
  agents: number;
  /** This month's spend of the agents you own. */
  myAgentsSpendUsd: number;
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
  monthlyBudgetUsd: number | null;
  spentThisMonthUsd: number;
  /** Held for calls in flight. */
  reservedUsd: number;
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
  /** Start of the message that started the run. */
  what: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunStep {
  seq: number;
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface UsageReport {
  since: string;
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
    monthlyBudgetUsd: number | null;
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
  spentNanoUsd: number;
  budgetNanoUsd: number;
}

// ── Custom MCP servers (apps/server/src/routes/app/connectors-custom.ts) ─────

/** How a tool of a custom server may be used. `null` = not classified yet (hidden from agents). */
export type ToolAccess = "read" | "write" | "approval";

export interface CustomTool {
  name: string;
  /** As the server describes it. */
  description: string;
  /** The server's `readOnlyHint` annotation, when it sends one. */
  readOnlyHint: boolean | null;
  /** Our suggestion until an admin decides (read-only → read, destructive/write-like → approval, else write). */
  suggestedAccess?: ToolAccess | null;
  access: ToolAccess | null;
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

export interface ReactionCount {
  /** `+1` / `-1` on agent replies are feedback for the agent. */
  reaction: string;
  count: number;
  userIds: string[];
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

export type ArtifactKind = "document" | "table" | "diff" | "diagram" | "html";

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
  | { kind: "html"; html: string };

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
  /** The viewer may save new versions (documents and tables only). */
  canEdit: boolean;
  /** HTML: render only in a sandboxed iframe (we always do). */
  untrusted: boolean;
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
  version: number;
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
  createdAt: string;
  updatedAt: string;
}

export interface IssueActivity {
  id: string;
  kind: "comment" | "event";
  author: Actor;
  /** Comment body, or the event in words ("pediu à Ada para implementar"). */
  text: string;
  /** Machine form of an event (`status_changed`, `assigned`, `agent_asked`, …). */
  event?: string;
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

export type RoutineTrigger =
  | { type: "schedule"; phrase: string; cron: string; timezone: string; description: string }
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
  monthCostUsd: number;
  createdAt: string;
}

export interface RoutineRun {
  id: string;
  at: string;
  status: "ok" | "failed" | "skipped";
  /** "Resumo postado no #geral", "Orçamento do mês esgotado". */
  summary: string;
  costUsd: number;
}

export interface RoutineInput {
  name?: string;
  agentId: string;
  prompt: string;
  target: RoutineTargetInput;
  trigger: { type: "schedule"; phrase: string } | { type: "event"; event: RoutineEvent };
}

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
}

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

/** `GET …/access-matrix` (admins): agents × tools, effective state per cell. */
export interface AccessMatrix {
  agents: { id: string; name: string; handle: string }[];
  tools: (Omit<AccessTool, "state"> & { group: string; key: string })[];
  /** cells[agentId][tool.key]. */
  cells: Record<string, Record<string, AccessState>>;
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
  costMonthUsd: number;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** `provider-default` when the provider can't apply our domain list (plan limitation). */
  network?: "blocked" | "allowlist" | "open" | "provider-default";
}

// ── Forum (apps/server/src/routes/app/forum.ts) ──────────────────────────────

export type ForumStatus = "open" | "done" | "canceled";

/** An issue the synthesis suggests ("Criar issues sugeridas"). */
export interface ForumSuggestedIssue {
  title: string;
  description: string;
}

/** A discussion among agents, in rounds, ending in a synthesis document. */
export interface ForumTopic {
  id: string;
  title: string;
  /** The question or goal ("Decidir o plano de preços do Q1"). */
  goal: string;
  status: ForumStatus;
  /** The round in progress (or the last one when finished), from 1 (0 = not started yet). */
  round: number;
  /** `discussing`, `synthesizing` (writing the synthesis) or `finished`. */
  phase?: "discussing" | "synthesizing" | "finished";
  rounds: number;
  agentIds: string[];
  /** People notified (they can post between rounds). */
  userIds: string[];
  createdBy: { type: "person" | "agent"; id: string };
  /** The conversation it was opened from, when an agent opened it. */
  originChannelId: string | null;
  /** The topic's hidden channel: subscribe to it for the agents' live runs. */
  channelId: string;
  createdAt: string;
  lastActivityAt: string;
  costUsd: number;
  budgetUsd: number | null;
  /** Agents working right now. */
  activeAgentIds: string[];
  synthesis: { artifactId: string; version: number; suggestedIssues: ForumSuggestedIssue[] } | null;
}

/** One per agent run (one per agent per round), people's posts in between. `meta.synthesis`: the closing post. */
export interface ForumPost {
  id: string;
  topicId: string;
  /** From 0 (before round 1, e.g. a person's opening note). */
  round: number;
  author: { type: "person" | "agent"; id: string };
  body: string;
  /** Agent posts: the run (the work summary under the post). */
  agentRunId: string | null;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface ForumTopicDetail extends ForumTopic {
  posts: ForumPost[];
}

export interface ForumTopicInput {
  title: string;
  goal: string;
  agentIds: string[];
  userIds: string[];
  rounds: number;
  budgetUsd?: number | null;
  /** ISO; the discussion stops and writes the synthesis at this time. */
  deadline?: string;
  /** Writes the synthesis (default: the first agent). */
  ownerAgentId?: string;
}

/** `PUT …/forum/topics/{id}/participants`. */
export interface ForumParticipantsInput {
  addAgentIds?: string[];
  removeAgentIds?: string[];
  addUserIds?: string[];
  removeUserIds?: string[];
}

/** Org broadcasts about the forum. */
export type ForumEvent =
  | { type: "forum.topic.updated"; topicId: string; status: ForumStatus; round: number }
  | { type: "forum.post.created"; topicId: string; post: ForumPost };

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
  updatedAt: string;
  updatedBy: WikiAuthor;
}

/** Where a page is mentioned: other pages, messages, forum topics, issues. */
export type WikiBacklink =
  | { kind: "page"; slug: string; title: string }
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
}

export interface WikiVersion {
  version: number;
  at: string;
  author: WikiAuthor;
  note: string | null;
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
  nodes: { slug: string; title: string; folder: string; tags: string[]; agentId?: string | null }[];
  edges: { from: string; to: string }[];
}
