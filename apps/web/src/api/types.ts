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
    };

// ── Mock-backed (no backend endpoint yet) ────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "refused";

/** A sensitive action waiting for a person (mock: approvals belong to the Tool Gateway workstream). */
export interface Approval {
  id: string;
  agentId: string;
  channelId: string | null;
  /** Human words: "Fazer merge do PR #42 em main". */
  title: string;
  /** Exact detail: "github.merge · agentes-chat/app · PR 42 · testes passando". */
  detail: string;
  /** Verb for the primary button: "merge" → "Aprovar merge". */
  action: "merge" | "deploy" | "rollback" | "publish" | "other";
  /** Where to review the change ("Ver diff"), when there is one. */
  diffUrl: string | null;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: { userId: string; name: string } | null;
  decidedAt: string | null;
}

export interface Scope {
  id: string;
  label: string;
  description: string;
  /** Always becomes an approval request (merge, deploy, rollback). */
  requiresApproval?: boolean;
}

export interface Connector {
  id: string;
  name: string;
  /** What the organization connected: "agentes-chat/app, agentes-chat/site". */
  note: string;
  scopes: Scope[];
}

export interface AgentPermissions {
  connectors: Connector[];
  /** Granted scope ids (approval-gated scopes are always granted, and always ask). */
  granted: string[];
}

export interface AgentRunSummary {
  id: string;
  at: string;
  summary: string;
  /** "#eng", "thread em #eng", "DM João". */
  where: string;
  tokens: number;
  costUsd: number;
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
