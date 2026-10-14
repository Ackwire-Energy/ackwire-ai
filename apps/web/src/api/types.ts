/**
 * Types of the private web-app API (`/api/app/*`, apps/server/src/routes/app),
 * plus the types of the features whose endpoints don't exist yet (marked
 * "mock" — see `src/api/mock`).
 */

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
  role: Role;
  joinedAt: string;
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
  provider: "anthropic";
  label: string;
  keyHint: string;
  createdAt: string;
  revokedAt: string | null;
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
}

export interface Model {
  id: string;
  label: string;
  provider: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
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
  createdAt: string;
}

export type RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed";

/** Real-time channel events (packages/engine/src/events.ts, docs/adr/0010-realtime.md). */
export type ChannelEvent =
  | { type: "message.created"; channelId: string; messageId: string; message?: Message }
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
  | { type: "approval.created" | "approval.decided"; channelId: string; approval: Approval };

/** Events for one person (`{ type: "event", scope: "user" }` frames), e.g. approvals they can decide. */
export type UserEvent =
  | { type: "approval.created" | "approval.decided"; approval: Approval }
  | BudgetEvent
  | { type: string };

// ── Mock-backed (no backend endpoint yet) ────────────────────────────────────

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

/** A connector agentes.chat knows (catalog). */
export interface ConnectorDef {
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
    kind: "agent" | "router" | "embedding" | "summary";
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
