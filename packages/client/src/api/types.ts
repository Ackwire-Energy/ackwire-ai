/** Types of the private web-app API (`/api/app/*`, apps/server/src/routes/app). */

import type { OnboardingStepId } from "../lib/onboarding";

export type Role = "owner" | "admin" | "member";
export type Edition = "selfhost" | "cloud";

export interface Health {
  status: "ok" | "degraded";
  version: string;
  edition: Edition;
}

/** The usage report's switch, for the installation's owner (`GET /api/app/telemetry`). */
export interface ServerTelemetry {
  /** The owner's switch. */
  enabled: boolean;
  /** `TELEMETRY=off` on the server: nothing is sent, whatever the switch says. */
  envOff: boolean;
  /** Exactly what the next report sends (shown as is). */
  report: Record<string, unknown>;
}

/** The installation's Jev key, for its pinned owner on a self-hosted server (`GET /api/app/jev`, ADR 0073). */
export interface JevKey {
  /** `env`: `TYPESAFE_API_KEY`, read-only here. `settings`: added in Settings. Null: none. */
  source: "env" | "settings" | null;
  /** The key's last 4 characters (the key itself is never returned). */
  hint: string | null;
  /** What its owner can fix: TypeSafe refused the key, or its account is out of credit. Else `ok`. */
  state: "off" | "ok" | "invalid" | "no_credit";
  /** Jev's calls this month (UTC), every workspace together. */
  month: { decisions: number; costUsd: number };
}

/**
 * A device that hears pushes (`POST /api/app/push/devices`): the phone app's Expo token (ADR 0035), or this
 * browser's Web Push subscription (ADR 0071: its endpoint and keys, from `PushSubscription.toJSON()`).
 */
export type PushDeviceInput =
  | { platform: "ios" | "android"; token: string; locale: string }
  | { platform: "web"; endpoint: string; keys: { p256dh: string; auth: string }; locale: string };

export interface AuthConfig {
  socialProviders: { google: boolean; github: boolean; apple?: boolean };
  signupOpen: boolean;
  firstRun: boolean;
  /** No account yet, and the first one only through the owner link (`/owner#claim=…`; absent: false). */
  ownerClaim?: boolean;
  /** "Esqueci a senha" can send its e-mail. */
  passwordReset?: boolean;
  /** Linked on the sign-in screen; the line shows only when both are set. */
  termsUrl?: string | null;
  privacyUrl?: string | null;
  /** Where people write to whoever runs this server (a workspace on hold or suspended); null: not given. */
  supportEmail?: string | null;
  /** Every workspace gets a computer of its own (the Cloud); absent: a server too old to say. */
  workspaceComputer?: boolean;
  /** The billing service (ADR 0079): owners and admins open a workspace's plan there; null or absent: no billing. */
  billingUrl?: string | null;
  /** The bot check's site key (Cloudflare Turnstile, ADR 0075); null or absent: no check, nothing from Cloudflare. */
  turnstileSiteKey?: string | null;
}

/** A workspace's use against its limits (ADR 0079, `GET …/limits`), for any member; a null limit: none. */
export interface WorkspaceLimits {
  members: { used: number; limit: number | null };
  /** `ownStorage`: new files go to the workspace's own bucket, which no limit counts. */
  storage: { usedBytes: number; limitBytes: number | null; ownStorage: boolean };
  uploads: { usedBytes24h: number; limitBytesPerDay: number | null };
}

/** Where in the app a billing link is opened from: the billing service opens on what it came for (ADR 0079). */
export type BillingFrom =
  | "settings"
  | "hold"
  | "onboarding"
  | "new_workspace"
  | "invite_full"
  | "upload_full"
  | "storage";

export type SignInProvider = "google" | "github" | "apple";

/** How an e-mail signs in: the sign-in screen asks for the e-mail first (`account.signInOptions`). */
export interface SignInOptions {
  account: boolean;
  /** The account has a password. */
  password: boolean;
  /** Social sign-ins linked to the account. */
  providers: SignInProvider[];
  /** No account, and this e-mail may create one. */
  canSignUp: boolean;
  /** The page's early-access link is for this address, and it expired. */
  accessExpired?: true;
}

/** `GET /api/instance`: what the phone and desktop apps check before using a server. Public, nothing secret. */
export interface Instance {
  /** Always "agentes.chat". */
  name: string;
  version: string;
  /** The app API contract the server speaks, and the oldest one it still serves. */
  api: number;
  minApi: number;
  /** The server's own address (`PUBLIC_URL`), the only one its realtime accepts. */
  url: string;
  signIn: { email: boolean; google: boolean; github: boolean; apple: boolean };
  signup: "open" | "invite";
  /** No account yet, and the first one only through the owner link the setup printed (absent: false). */
  ownerClaim?: boolean;
  /** One of agentes.chat's own servers: `/terms` and `/privacy` are agentes.chat Cloud's (absent: an older server). */
  cloud?: boolean;
}

/** "Abrir no celular": a sign-in for the phone, single use, a few minutes long. */
export interface PhoneSignIn {
  token: string;
  /** The server's own address (`PUBLIC_URL`). */
  server: string;
  /** Seconds it lasts from the answer: counted on the device's clock, which may disagree with the server's. */
  expiresIn: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  image: string | null;
  /** Signs in with a password (false: only Google or Apple, or the desktop app that runs the server). */
  hasPassword?: boolean;
  /** Opened the link that confirms the email address. */
  emailVerified?: boolean;
  /**
   * A new workspace would be made for them (false on agentes.chat Cloud while sign-up is by invitation, unless early
   * access allowed them; `org.create_refused` and `org.create_unpaid` can still refuse it).
   */
  canCreateWorkspace?: boolean;
}

/** ADR 0056 §8: `hold` pauses the agents, `suspended` closes the workspace. */
export type StandingState = "active" | "hold" | "suspended";

/** What a member is told of the workspace's standing: `reason` only when the people who run the server show it. */
export interface OrgStanding {
  state: StandingState;
  reason: string | null;
  /** agentes.chat Cloud: a reason reads with how to contest it, and `review` as the automatic hold's line. */
  cloud?: boolean;
}

export interface OrgSummary {
  id: string;
  name: string;
  role: Role;
  /** The workspace logo (`/api/app/org-logos/…`); null or absent = the agent mark. */
  logo?: string | null;
  /** From `GET /me`; absent from older servers (active). Changes come as `org.standing` events. */
  standing?: OrgStanding;
  /**
   * From `GET /me`, to its owner only, while they haven't finished setting it up: the apps open its onboarding,
   * which resumes it, instead of the workspace. Absent: finished, not theirs to set up, or an older server.
   */
  onboarding?: OrgOnboarding;
}

/** Where a workspace's onboarding stands. */
export interface OrgOnboarding {
  /** The furthest step reached: where it resumes. */
  step: OnboardingStepId;
  /** #general, where the onboarding puts the agents and posts the first message. */
  generalChannelId: string;
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
  /** Empty for an org-wide invite link. */
  email: string;
  role: Role;
  kind?: "email" | "link";
  /** Who invited (their name), when known. */
  invitedBy?: string | null;
  /** The workspace's logo, served for this invitation or link only (absent without one, or while it is paused). */
  logo?: string;
  /** The organization's first agents ("Theo, Ada, Lia e Atlas já trabalham lá"). */
  agents?: { id: string; name: string; appearance: { color: string; eyes: string; accessory: string } | null }[];
  /** How many more agents work there than `agents` names ("… e mais 2 já trabalham lá"). */
  moreAgents?: number;
  /** A link turned off, expired, or whose workspace is paused: nobody can ask with it (ADR 0068). */
  closed?: true;
  /** A link opened signed in: where that person stands (on a link that no longer works, only a member's). */
  you?: JoinStatus;
}

/** A signed-in person and a workspace's invitation link: in or not, and their latest request with its answer. */
export interface JoinStatus {
  member: boolean;
  /** Only when they are a member. */
  orgId?: string;
  email: string;
  request: { status: "pending" | "approved" | "denied"; reason: string | null } | null;
}

/** `invites.ask`: asking is all a link does; the admins answer. `emailed`: this server sends email. */
export interface AskToJoinResult {
  status: "pending";
  email: string;
  emailed: boolean;
}

/** `invites.sendCode` (ADR 0072): the code went to `email`; another can go after `resendIn` seconds. */
export interface JoinCodeSent {
  email: string;
  resendIn: number;
}

/** A workspace's invitation link people can still ask with (admins). */
export interface InviteLink {
  id: string;
  /** Null for a link made before links could be shown again: it can only be turned off. */
  url: string | null;
  expiresAt: string;
  createdAt: string;
  /** Who made it (their name). */
  createdBy: string | null;
  /** Requests made through it, still waiting. */
  waiting: number;
}

/** Someone who asked to join through a link, waiting for an admin (ADR 0068). */
export interface JoinRequest {
  id: string;
  name: string;
  email: string;
  /** Their words: shown here only, never in an email or a push. */
  note: string | null;
  /**
   * A code proved the address, or a confirmed account with it asked (ADR 0072). False only on a server without
   * email, or for a request typed before codes: approving can't add anyone at once then.
   */
  verified: boolean;
  /** @deprecated Read `verified`. Kept for phone builds from before it: approving lets an account in at once. */
  confirmed: boolean;
  createdAt: string;
  /** Closes unanswered after this. */
  expiresAt: string;
}

/** An approval: in at once, or an invitation to the address (`emailed: false`: hand them `url` yourself). */
export type JoinApproval = { outcome: "joined" } | { outcome: "invited"; url: string; emailed: boolean };

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

/** An agent on the team screen: what it can do. What it does comes from its instructions (`Agent`). */
export interface TeamAgent {
  id: string;
  name: string;
  handle: string;
  role: string;
  appearance: AgentLookInput | null;
  ownerUserId: string | null;
  /** What it can do, as stable group keys (`drive`, `github`, `calendar`, `custom`…). */
  capabilities: string[];
  /** Working on something right now. */
  busy: boolean;
  canTalk: boolean;
}

/** One agent asked another (`ask_agent`); the question itself stays private. */
export interface TeamConsultation {
  id: string;
  askerAgentId: string;
  targetAgentId: string;
  status: string;
  createdAt: string;
}

/** The team screen: agents, the people responsible for them, the last day's consultations. */
export interface Team {
  agents: TeamAgent[];
  people: { id: string; name: string; image: string | null }[];
  consultations: TeamConsultation[];
}

/** `Agent.brain`: shown next to its name instead of the API model when a computer thinks. */
export interface AgentBrainLine {
  kind: BrainKind;
  /** A computer brain's model ("Sonnet"); null for the model brain. */
  model: string | null;
  computer?: string;
  /** A plan account's provider (`zai`, `kimi`…), whose mark replaces the brain's; absent for the CLI's own sign-in. */
  provider?: string | null;
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
  /** A body the server wrote: show it in the reader's language (`previewBody`). Null for a plain message. */
  meta?: PreviewMeta | null;
  createdAt: string;
}

/**
 * A last-message preview's `meta` (channels, DMs, threads): the keys the chat reads to show a body the
 * server wrote in the reader's language (`bodyCode` + `bodyParams`, a cut-off run's notes, memory lines).
 */
export type PreviewMeta = Record<string, unknown>;

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
  /** Agents' messages: what the agent changed with it, as receipts with Undo; live via `message.actions`. */
  actions?: AgentAction[];
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
  handled: {
    agentId: string;
    runId?: string;
    status: RunStatus | "waiting_input" | "canceled";
    /** `no_ai`: it couldn't answer, it has no AI connected. */
    reason?: string;
  }[];
  /** Agents it mentions that won't answer (they don't reply to this person). */
  blocked?: string[];
  /** Agents it only references as part of the request to another agent: no run, by design. */
  referenced?: string[];
  /** Nobody was asked: the organization has no AI connected. */
  noAi?: boolean;
  /** Nobody was asked: the workspace used up its platform AI for the month, so only @mentions start agents. */
  platformCap?: boolean;
  /** Who picked the agents for it (ADR 0074); absent on a decision from before. */
  decidedBy?: DecidedBy;
  /** No step could read it and no rule fit: only a mention reaches an agent. */
  reason?: "mention_needed";
}

/**
 * Which step picked the agents for a message nobody mentioned (ADR 0074): Jev, the organization's small model
 * (its catalog id and provider), the author's own plan (`ownerId`: the author), or a rule.
 */
export type DecidedBy =
  | { step: "jev" }
  | { step: "model"; model: string; provider: string }
  | { step: "plan"; brand: "claude" | "chatgpt"; ownerId: string }
  | { step: "rule"; rule: "reply" | "only_agent" | "follow_up" };

/**
 * Who picks the agents for a message nobody mentioned (`ai-status`, ADR 0074): `by` for the workspace, `mine` for
 * the person asking (a plan picks only for its owner's own messages). `off`: only mentions. `model`: the small
 * model while it picks. `noSmallModel`: with `rules`, the default key's provider, which has none (Kimi).
 */
export interface AiRouting {
  by: "jev" | "model" | "plans" | "rules" | "off";
  mine: "jev" | "model" | "plan" | "rules" | "off";
  model: string | null;
  noSmallModel: string | null;
}

/** What a person who met "no AI" asked for (Jev): a Connect dialog step; `any` and `task` open its first step. */
export type ConnectIntent = "claude" | "chatgpt" | "api_key" | "any" | "task";

/** `GET …/ai-status` (ADR 0061): whether each agent has an AI to think with, and whether the organization has any. */
export interface AiStatus {
  /** An agent that isn't archived is ready, or waits for its computer. */
  any: boolean;
  /** Who picks the agents (absent from an older server). */
  routing?: AiRouting;
  /** The organization has a key of its own, or the server's own Claude key. */
  apiKey?: boolean;
  agents: {
    agentId: string;
    /** `waiting`: its computer is away for now (not "no AI"). */
    state: "ready" | "no_ai" | "waiting";
    reason?: "no_key" | "not_signed_in" | "no_computer" | "cli_missing";
  }[];
}

export type RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed";

/** What became of a person's message that reached a waiting run (`agent.run.wait_message`). */
export type WaitMessageOutcome = "resolved" | "woke" | "held";

/** A run the server still considers active in a channel (`GET …/channels/{id}/active-runs`). */
/** A question an agent asked from a conversation, still out (`GET …/active-runs`): the working line's "asking…". */
export interface OpenConsult {
  /** The asking run (it may have ended: the answer wakes the agent). */
  runId: string;
  agentId: string;
  consultedAgentId: string;
  channelId: string;
  threadId: string;
  /** When the question went out (ISO). */
  since: string;
}

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
  /** Messages sent to it while it works that it hasn't read yet (the others steered into it, it read). */
  pendingMessageIds?: string[];
  /** A routine's run working in the background: it holds no conversation and shows no "trabalhando". */
  background?: boolean;
}

/** Real-time channel events (packages/engine/src/events.ts, docs/adr/0010-realtime.md). */
export type ChannelEvent =
  | { type: "message.created"; channelId: string; messageId: string; message?: Message }
  /** Someone reacted or took it back: the message's reactions now (replace). */
  | { type: "message.reactions"; channelId: string; messageId: string; reactions: ReactionCount[] }
  | { type: "message.memories"; channelId: string; messageId: string; memories: MessageMemory[] }
  /** An agent message's receipts changed (linked to it, undone or redone): its whole list now (replace). */
  | { type: "message.actions"; channelId: string; threadId: string | null; messageId: string; actions: AgentAction[] }
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
  /** A person read this DM up to `lastReadAt` (DMs between people only: "Visto"). */
  | { type: "channel.read"; channelId: string; userId: string; lastReadAt: string }
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
      /** A routine's background run: never the conversation's working indicator. */
      background?: boolean;
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
  | {
      type: "agent.thinking";
      channelId: string;
      threadId: string;
      agentId: string;
      runId: string | null;
      /** A routine's background run: never the conversation's working indicator. */
      background?: boolean;
    }
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
      /** The error as a code (`run.org_paused`…) and its values, to say it in the person's language. */
      errorCode?: string;
      errorParams?: Record<string, string>;
    }
  // ── Chat delivery (packages/engine/src/events.ts) ───────────────────────────
  /**
   * Handed to a computer brain mid-turn (Claude Code reads it at its next tool boundary), not
   * confirmed read yet: "Ada recebeu". `agent.run.read` follows once it is read.
   */
  | {
      type: "agent.run.delivered";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageIds: string[];
    }
  /** Messages a run took but never read (it ended, failed, was stopped) went to a run of their own. */
  | {
      type: "agent.run.redispatched";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      newRunId: string;
      messageIds: string[];
    }
  /** The run ended without posting (nobody called it by name and it had nothing to add): drop its row now. */
  | { type: "agent.passed"; channelId: string; threadId: string | null; agentId: string; runId: string }
  /**
   * A person's message reached a run that was waiting (browser help, another agent's answer, an approval).
   * `resolved`: it ended the wait; `woke`: the run stopped waiting and reads it now; `held`: it waits for
   * the decision on a card.
   */
  | {
      type: "agent.run.wait_message";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageId: string;
      waitKind: string;
      outcome: WaitMessageOutcome;
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
      /** The run each picked agent answers with (new, steered into, or resumed by an answer). */
      runs?: { agentId: string; runId: string }[];
      /** Agents it mentions that won't answer. */
      blocked?: string[];
      /** Agents it only references (part of the request to another agent): no run, by design. */
      referenced?: string[];
      strategy?: "mention" | "dm" | "router" | "none";
      /**
       * `no_ai`: the organization has no AI connected. `mention_needed`: no step could pick an agent (no Jev, no
       * small model, no plan of the author, no rule): a mention still calls one. `platform_cap`: the workspace used
       * up its platform AI for the month, so only a mention gets one.
       */
      reason?: string;
      /** Who picked (ADR 0074). */
      decidedBy?: DecidedBy;
      /** With `no_ai`: the Connect step the message asked for, and whether it opens by itself (Jev ≥ 0.9). */
      intent?: ConnectIntent;
      provider?: string;
      autoOpen?: boolean;
    }
  /** The author's own plan is picking who answers (seconds): until `message.routed`. */
  | { type: "message.routing"; channelId: string; messageId: string; step: "plan" }
  | { type: "message.claimed"; channelId: string; messageId: string; agentId: string; runId?: string }
  | {
      type: "message.handled";
      channelId: string;
      messageId: string;
      agentId: string;
      runId?: string;
      status?: "done" | "failed" | "waiting_approval";
      /** `no_ai`: the agent has no AI to think with. */
      reason?: string;
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
  /** An agent's browser request changed (ADR 0040 §6): someone took control, or it ended. The card is `meta.browserHandoff`. */
  | {
      type: "browser.handoff.updated";
      channelId: string;
      threadId: string | null;
      handoff: BrowserHandoff;
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
  /** Where its card is; null: the channel's main timeline. */
  threadId: string | null;
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
  /** The email itself, for mail drafts and sends; null for every other action. */
  email?: ApprovalEmail | null;
  /** Why it asks (ADR 0053 §8): what the agent found and why this action. Shown above the action. */
  why?: string | null;
  /** Asked while nobody watched: by a routine (its name) or by an unattended run. Null: a person was there. */
  origin?: ApprovalOrigin | null;
  issue?: { id: string; number: number; title: string } | null;
  /** One approval only: what the agent said at each turn before asking. */
  trail?: { text: string; at: string }[];
}

/** The email a mail approval writes (draft, send, reply, forward), as its card shows it. */
export interface ApprovalEmail {
  verb: "draft" | "send" | "reply" | "forward";
  /** The mailbox it goes through and its provider ("iCloud", "Gmail"; null: unknown). */
  mailbox: string;
  provider: string | null;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The text, cut after 1500 characters. */
  body: string;
  /** The message it answers or forwards (its sender may be unknown). */
  original: { subject: string; from: string | null } | null;
}

/** Who asked when nobody was watching (`approvals.origin`). */
export type ApprovalOrigin = { kind: "routine"; routineId: string; routineName: string } | { kind: "unattended" };

export interface ScopeInfo {
  id: string;
  label: string;
  description: string;
  /** Using it always becomes an approval request. */
  sensitive: boolean;
}

/** Catalog groups: Desenvolvimento, Produto, Docs, Pagamentos, Suporte, Marketing, Automação. */
export type ConnectorCategory =
  | "dev"
  | "product"
  | "docs"
  | "data"
  | "payments"
  | "sales"
  | "support"
  | "marketing"
  | "automation";

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
  /** Brand icon served by this app, null for a monogram: one color (`/connectors/github.svg`) or its maker's colors (`/brands/paypal.svg`). */
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
  /** `about: "me"` only: the viewer's message it came from ("Você disse hoje, nesta conversa"). */
  from?: { messageId: string; channelId: string; threadId: string | null; dm: boolean; at: string } | null;
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
  /** Agents check what the team already did before acting outside (ADR 0064). On by default. */
  actionCheck: boolean;
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
  failuresThisMonth: number;
  /** This month's runs and failures per day of the month (UTC); only days with runs. */
  runsByDay: { day: number; runs: number; failed: number }[];
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
  /** Every input token, cache included. */
  inputTokens: number;
  /** How much of `inputTokens` was read from the prompt cache (older servers: absent). */
  cachedTokens?: number;
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
  /** The server's own icon, kept and served by the backend (`/api/app/connector-icons/…`); null = a monogram. */
  iconUrl?: string | null;
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

export type SearchKind =
  | "message"
  | "context_item"
  | "issue"
  | "forum_topic"
  | "forum_reply"
  | "file"
  | "wiki"
  | "action";

export interface SearchHit {
  kind: SearchKind;
  /** The message id, context item id, … */
  sourceId: string;
  channelIds: string[];
  title: string;
  snippet: string;
  score: number;
  createdAt: string;
  /** Message hits: who wrote it; action hits: the agent that did it. */
  author?: { type: AuthorType; id: string; name: string } | null;
}

/**
 * `message.meta.teamChecks` (ADR 0064, server-made): outside actions the agent didn't repeat because the
 * team already did them. `agentId` null = it happened where the agent can't see: only "someone" and when.
 */
export interface TeamCheck {
  id: string;
  tool: string;
  /** What it touched, as people read it (`ana@acme.com`, `acme/app#212`). */
  targets: string[];
  matches: {
    agentId: string | null;
    agentName: string | null;
    channelId: string | null;
    channelName: string | null;
    summary: string | null;
    at: string;
  }[];
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

/**
 * Act with undo (ADR 0037 round 2): what an agent changed with its reply,
 * shown as a receipt under the message. Say it with `agentActions.{kind}`
 * (pt-BR and en) and `params`.
 */
export type AgentActionKind =
  | "issue.created"
  | "issue.updated"
  | "issue.assigned"
  | "memory.saved"
  | "memory.updated"
  | "memory.forgotten"
  | "routine.created"
  | "routine.updated"
  | "channel.agent_added"
  | "channel.created"
  | "wiki.page_created"
  | "wiki.page_edited"
  | "thread.renamed"
  | "thread.closed";

/** What the change was made to (link it: issue → Issues, wiki_page → Wiki, routine → Rotinas…). */
export interface AgentActionTarget {
  type: "issue" | "memory" | "routine" | "channel" | "wiki_page" | "thread";
  id: string;
  /** Issues. */
  number?: number;
  /** Issue, routine, wiki page or thread title; channel name (without `#`). */
  title?: string;
  /** Wiki pages. */
  slug?: string;
}

/**
 * Values for the sentence, by kind:
 * - `issue.created`: `number`, `title`
 * - `issue.updated`: `number`, `title`, `fields` (any of title, description, status, priority,
 *   assignee, labels, dueDate, criteria) and the new `status`, `priority`, `dueDate`, `labels`,
 *   `assigneeType`/`assigneeId`/`assigneeName`/`assigneeIsSelf` for the fields that changed
 * - `issue.assigned`: `number`, `title`, `assigneeType`, `assigneeId`, `assigneeName`, `assigneeIsSelf`
 * - `memory.saved`: `text` (and `previousText` when it replaced one); `memory.updated`: `text`, `previousText`;
 *   `memory.forgotten`: `text`
 * - `routine.created`: `name`, `rule` (an `ApiRule`, said in the person's language), `schedule` (the server's
 *   English words, never shown), `active`; `routine.updated`: `name`,
 *   `fields` (name, prompt, target, schedule, active), `active`, `schedule`
 * - `channel.agent_added`: `agentId`, `agentName`, `agentHandle`, `channel`
 * - `channel.created`: `name` (undo archives it)
 * - `wiki.page_created` / `wiki.page_edited`: `title`, `slug`
 * - `thread.renamed`: `from`, `to`; `thread.closed`: `title`
 */
export type AgentActionParams = Record<string, string | number | boolean | null | string[] | ApiRule>;

export interface AgentAction {
  id: string;
  kind: AgentActionKind;
  agentId: string;
  messageId: string | null;
  /** The person the agent worked for: they, admins and the agent's owner may undo (see `lib/actions`). */
  requestedByUserId: string | null;
  target: AgentActionTarget;
  params: AgentActionParams;
  createdAt: string;
  /** Desfazer (or Refazer, once undone) works until then; every undo or redo moves it 5 minutes ahead. */
  undoableUntil: string;
  /** Set while undone ("Desfeito por …", Refazer). */
  undoneAt: string | null;
  undoneByUserId: string | null;
  redoneAt: string | null;
}

/** One line of "O que fez por você" (`GET …/agents/{id}/for-you`). */
export type AgentForYouItem =
  | { type: "action"; at: string; channelId: string; action: AgentAction }
  | {
      type: "file";
      at: string;
      file: { id: string; kind: ArtifactKind; title: string; channelId: string | null; threadId: string | null };
    }
  | {
      type: "approval";
      at: string;
      approval: {
        id: string;
        title: string;
        status: ApprovalStatus;
        channelId: string;
        /** Where its card is; null: the main timeline. */
        threadId: string | null;
        /** Pending, and the viewer may decide it ("espera seu ok"). */
        waitingOnYou: boolean;
      };
    };

/** What an agent did for the viewer: their receipts, its files where both are, approvals on them; newest first. */
export interface AgentForYou {
  items: AgentForYouItem[];
  /** Items since the first day of this month. */
  monthCount: number;
}

/** `POST …/messages/{messageId}/actions/undo` (Desfazer tudo). */
export interface UndoAllResult {
  /** The message's receipts now. */
  actions: AgentAction[];
  /** Changes that could not be undone, with the error code (`action.changed_since`, …). */
  failed: { id: string; code: string; message: string }[];
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
/** Where another person of a DM stopped reading ("Visto"). */
export interface DmRead {
  userId: string;
  lastReadAt: string;
}

export interface DirectMessage {
  channelId: string;
  with: { type: AuthorType; id: string; name: string; handle: string | null };
  /** `meta`: a body the server wrote, shown in the reader's language (`previewBody`). */
  lastMessage: { id: string; body: string; meta?: PreviewMeta | null; createdAt: string; authorType: string } | null;
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
  /** The run that asked: the receipt finds the message it answers (a channel question has no thread). */
  runId?: string | null;
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
  /** For a browser password: the only site it may be typed on (`https://host`). */
  site?: string | null;
  /** The connected machine that holds it. */
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

/**
 * Where the server keeps the files of workspaces without a bucket of their own: its disk, its database or the bucket
 * its operator set. `folder`: that disk's folder, absolute, only where the server isn't in a container.
 */
export interface StoragePlatform {
  kind: "disk" | "database" | "bucket";
  folder: string | null;
}

/** What the workspace's files take, summed from the sizes recorded as they were written. */
export interface StorageUsage {
  /** On this server's storage (`platform`), files in the trash left out. */
  platformBytes: number;
  /** In the workspace's own buckets, the trash left out too. */
  ownBucketBytes: number;
  /**
   * The disk holding this server's files folder: its size and what is free. Null without a folder, and on the Cloud,
   * where that disk is every workspace's.
   */
  disk: { sizeBytes: number; freeBytes: number } | null;
}

export interface StorageConfig {
  kind: StorageKind;
  /** The bucket in use (keys never come back: only their last characters). */
  s3: (Omit<S3Input, "accessKeyId" | "secretAccessKey"> & { accessKeyIdHint: string; secretHint: string }) | null;
  migration: StorageMigration | null;
  platform: StoragePlatform;
  /** Absent from an older server. */
  usage?: StorageUsage;
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
  /** `author` made or changed it (any version), not only made it. */
  changed?: boolean;
}

/** Channel event: an artifact was created or got a new version. */
export type ArtifactEvent = {
  type: "artifact.created" | "artifact.updated";
  channelId: string;
  artifact: Artifact;
};

// ── Issues, routines and calendar ───────────────────────────────────────────

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
  /** Its board column, always one of its stage. */
  columnId: string | null;
  /** Order inside the column, lowest first. */
  boardRank: number;
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
  /** The issue this one is a sub-issue of (a plan step from the forum). */
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
  Pick<Issue, "title" | "description" | "status" | "priority" | "assignee" | "dueDate" | "labels" | "boardRank">
> & {
  /** Move to a board column: the issue takes that column's stage. */
  columnId?: string;
};

/** A board column: it sits in a fixed stage; `name` null shows the stage's own name. */
export interface IssueColumn {
  id: string;
  stage: IssueStatus;
  name: string | null;
  position: number;
}

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
  | { type: "once"; at: string; timezone: string; description: string }
  | RoutineEmailTrigger;

/** "Quando chegar um email" (ADR 0038): new mail in a folder of a connected mailbox, optionally filtered. */
export interface RoutineEmailTrigger {
  type: "email";
  accountId: string;
  folder: string;
  filter: RoutineEmailFilter;
  /** The mailbox needs reconnecting (or the watch failed): the routine shows "Precisa reconectar". */
  status?: "active" | "needs_reconnect" | "error";
}

export interface RoutineEmailFilter {
  /** Addresses or `@domain`s. */
  from?: string[];
  /** Subject contains. */
  subject?: string;
  /** Body contains. */
  text?: string;
}

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

/** What a routine may do while nobody watches: look and tell (`read`), or also change things (`act`). */
export type RoutineAccess = "read" | "act";
/** When a routine speaks: on every run (`always`), or only when there is news (`when_new`). */
export type RoutineReport = "always" | "when_new";

/**
 * Where a routine stands (ADR 0053 §11): `paused` (with `pausedReason`), `running` (a run working now),
 * `waiting_computer` (its run waits for the agent's computer: `waitingFor`), `waiting_person` (an approval
 * or an answer), `failing` (its last runs failed: `failuresInRow`).
 */
export type RoutineState = "active" | "paused" | "running" | "waiting_computer" | "waiting_person" | "failing";

/** Why the server paused a routine (the app says it, with its one-tap fix); null: a person paused it. */
export type RoutinePausedReason =
  | "creator_left"
  | "creator_no_access"
  | "agent_archived"
  | "agent_not_in_channel"
  | "audience"
  | "failing";

export interface Routine {
  id: string;
  name: string;
  agentId: string;
  /** What it does; null when the viewer may not see it (only its outcomes). */
  prompt: string | null;
  target: RoutineTarget;
  trigger: RoutineTrigger;
  active: boolean;
  /** Null when paused or event-driven. */
  nextRunAt: string | null;
  createdAt: string;
  access: RoutineAccess;
  report: RoutineReport;
  /** A coded reason (`RoutinePausedReason`); anything else is shown as a plain pause. */
  pausedReason: string | null;
  failuresInRow: number;
  state: RoutineState;
  /** Its run waits for this computer since `since` (state `waiting_computer`). */
  waitingFor: { machineId: string; machineName: string; since: string } | null;
  /** Who thinks for it, and on which computer (`machineName` null for the API). */
  brain: { kind: BrainKind; machineName: string | null };
  /**
   * The last 7 days: `ok` counts runs that reported; `skipped` slots that didn't run (replaced ones too);
   * `total` their sum, without the runs a person stopped.
   */
  health: { ok: number; silent: number; failed: number; skipped: number; missed: number; total: number };
  /** The viewer sees its prompt, records and reports (else only outcomes, without text). */
  canSeeDetails: boolean;
  /** The viewer may change, pause, run, stop or delete it. */
  canManage: boolean;
  lastRun: RoutineRun | null;
  /** The last runs, newest first (at most 14): the row's pixel strip and the horizon. */
  recentRuns: RoutineRun[];
  /** The last 7 days: tokens on a plan (Claude Code, Codex), cost on the API. */
  usage: { runs: number; tokens: number; costNanoUsd: number; billedTo: "api" | "plan" | "mixed" };
  /** Event routines that can be triggered by a webhook: the URL to call. */
  webhookUrl?: string | null;
}

/**
 * A routine run's state (`routine_runs`): working (`queued`, `running`, `waiting` for a person or the
 * computer), then one end: `reported` (it told people), `silent` (nothing new), `failed`, `canceled`
 * (a person stopped it), `superseded` (the next slot took its place), `missed` (too late to run) or
 * `skipped` (the slot never started a run).
 */
export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "reported"
  | "silent"
  | "failed"
  | "canceled"
  | "superseded"
  | "missed"
  | "skipped";

export interface RoutineRun {
  id: string;
  at: string;
  status: RoutineRunStatus;
  /** Why it ended this way (`stopped`, `previous_running`, `budget_exceeded`…): the app says it. */
  code: string | null;
  /** Values for the code's words (`stopped`: `by`, the person who stopped it). */
  codeParams?: Record<string, string>;
  /** The agent's own words for this run; '' when the viewer may not see text. */
  summary: string;
  /** Recent runs only: cost as a share (0–1) of the priciest recent run; never money. */
  weight?: number;
  /** The brain that ran it (`claude_code`, `codex`, `model`). */
  brain: string | null;
  /** The agent's message people saw ("Abrir na conversa"). */
  link: { channelId: string; threadId: string | null; messageId: string } | null;
  /** Waiting for this approval ("Esperando sua aprovação"). */
  approvalId?: string | null;
  finishedAt: string | null;
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
    | { type: "once"; at: string; timezone?: string }
    | Omit<RoutineEmailTrigger, "status">;
  /** Default `read` ("Só olhar e contar"). */
  access?: RoutineAccess;
  /** Default `when_new` ("Só quando tiver novidade"). */
  report?: RoutineReport;
}

/** `PATCH …/routines/{id}`: only what changed (`active: true` also clears a pause reason and a failure streak). */
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

// ── Agent computer and Run code settings: apps/server/src/routes/app/sandboxes.ts ──

export interface SandboxSettings {
  enabled: boolean;
  execTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  /** Ask a person before running code. */
  requireApproval: boolean;
}

export type SandboxSettingsInput = Partial<Pick<SandboxSettings, "enabled" | "execTimeoutSeconds" | "requireApproval">>;

/** `GET …/agents/{id}/computer`: which computer the agent uses (ADR 0025). */
export interface AgentComputer {
  target: ComputerTarget;
}

// ── Connected computers (ADR 0025; apps/server/src/routes/machines.ts) ──────

/** No computer, or a machine someone connected with the runner. */
export type ComputerTarget = { kind: "none" } | { kind: "machine"; machineId: string; name: string; online: boolean };

export type MachineOs = "linux" | "darwin" | "windows" | "other";

/** `connected`: a person paired it; `host`: the server's own; `managed`: the workspace's own (ADR 0056 §10). */
export type MachineKind = "connected" | "host" | "managed";

/** `GET …/machines`: a computer connected with `agentes-runner`. */
export interface Machine {
  id: string;
  name: string;
  /**
   * Absent from a server that doesn't say: `connected`. A `managed` one can't be removed, and its hostname,
   * OS and arch are blank.
   */
  kind?: MachineKind;
  /** Runner connected now (`machine.status` events). */
  online: boolean;
  lastSeenAt: string | null;
  hostname: string;
  /** `linux`, `darwin`, `windows` or `other` (`MachineOs`). */
  os: string;
  arch: string;
  /** `system`: each agent works as its own OS user, in its own folder (ADR 0057). Absent on older servers: `single`. */
  mode?: "system" | "single";
  runnerVersion: string;
  /** `false`: started with `--no-exec` (files and uploads only). */
  execAllowed: boolean;
  pairedBy: { id: string; name: string } | null;
  agents: { id: string; name: string; handle: string }[];
  /** Workspace folder on the machine; null unless admin or the person who paired it. */
  workspace: string | null;
  /** This person may rename or remove it (an admin or whoever connected it); they may also reduce its access. */
  canManage: boolean;
  createdAt: string;
  /** ADR 0036 §6: the owner paused it on the machine; nothing new starts until it resumes. Null or absent: not paused. */
  paused?: MachinePause | null;
  /** ADR 0036 §8 (protocol 10): what the machine allows, as last reported. Absent until the machine reports it. */
  access?: MachineAccess | null;
  /** ADR 0040 (protocol 12): whether the agent browser can run there; null or absent when its runner doesn't say. */
  browser?: MachineBrowser | null;
  /**
   * ADR 0062 (protocol 21): whether agents can use their own desktops there (only where each agent is its own OS
   * user); `reason`, in the runner's words, says what is missing. Null or absent when its runner doesn't say.
   */
  desktopUse?: { available: boolean; reason: string | null } | null;
}

/** Whether the organization uses the server's own computer (`GET …/machines/host`). */
export interface HostComputer {
  machineId: string;
  /** false: an admin stopped it in this organization. */
  on: boolean;
}

/** The provisioner's steps while the workspace's own computer is being prepared (ADR 0056 §10), in order. */
export type ComputerSetupStep = "reserving" | "starting" | "installing" | "connecting";

/**
 * `GET …/computer-setup` (every member): `pair` where people connect their own computers (the rest null);
 * `external` where the workspace gets its own computer, and how far it is. `machine.provisioning` events carry
 * the same fields but `mode`.
 */
export interface ComputerSetup {
  mode: "external" | "pair";
  /** With `external`, null while the workspace is on hold and its computer isn't ready: it waits for none. */
  state: "preparing" | "waiting" | "problem" | "ready" | null;
  /** While `preparing`. */
  step: ComputerSetupStep | null;
  /**
   * While `preparing`, when the provisioner says: what it is doing within its step (`updating`, `restarting`…), in
   * its own word; one the app has no words for reads as its step. Absent from an older server.
   */
  stage?: string | null;
  /** While `waiting`: `capacity` (no computer on its way yet). */
  reason: "capacity" | null;
  since: string | null;
  /** When people started waiting: the workspace's creation, or the computer's last revoke. */
  requestedAt: string | null;
  /** The earliest ready time this wait was told, never moved later; null while the provisioner can't say. */
  expectedReadyAt: string | null;
  /** `expectedReadyAt` less the server's clock when it answered (negative once past), so a device's clock doesn't matter. */
  secondsLeft: number | null;
  /** The server's clock when it answered less `requestedAt`, for the same reason. */
  secondsWaited: number | null;
  /** The server sends email: the workspace's owners get one when it's ready after a wait. */
  notifyByEmail: boolean;
  specs: { cpus: number; memoryGb: number; diskGb: number } | null;
  /** The computer itself, once the provisioner made it. */
  machineId: string | null;
}

/** The agent browser on a computer, as its runner reports it. Turned on at the computer (`access.tools.browser`). */
export interface MachineBrowser {
  available: boolean;
  version: string | null;
  chrome: string | null;
  /** Why it can't run yet, in the runner's words. */
  reason: string | null;
}

/**
 * The pause the machine reported. The server sends `{ until }` (present = paused) or null;
 * `paused: false` is also understood. `until` null: until the owner resumes.
 */
export interface MachinePause {
  paused?: boolean;
  until?: string | null;
}

/** A tool the person turns on or off on the machine. */
export type MachineToolName = "claude" | "codex" | "commands";

/** A folder allowed on the machine and the agents (ids) that may use it; empty: allowed, no agent yet. */
export interface MachineFolderGrant {
  path: string;
  agents: string[];
}

/** What the machine allows (the runner's `RunnerAccess`). Granting only ever happens on the machine. */
export interface MachineAccess {
  folders: MachineFolderGrant[];
  /**
   * `browser` (ADR 0040): the agent browser; absent on runners before protocol 12 (off). `desktop` and
   * `terminal` (ADR 0058): the agents' desktops and terminals; absent before protocol 18 (off).
   */
  tools: Record<MachineToolName, boolean> & { browser?: boolean; desktop?: boolean; terminal?: boolean };
}

/** `POST …/machines/{id}/access/reduce`: the site can only take away, never grant. */
export interface MachineAccessReduce {
  /** Without `agentId`: the folder for everyone. */
  removeFolder?: { path: string; agentId?: string };
  disableTool?: MachineToolName | "browser" | "desktop" | "terminal";
}

/** Approximate location of the computer that asked for a code (best effort, from its IP). */
export type DeviceLocation = string | { city?: string | null; region?: string | null; country?: string | null };

/** `GET /api/app/machines/device/{userCode}` (ADR 0036 §5): the computer waiting for someone to confirm it. */
export interface DeviceRequest {
  name: string;
  os: string;
  arch: string;
  hostname: string;
  version: string;
  approxLocation?: DeviceLocation | null;
  createdAt: string;
  expiresAt: string;
  /** The code brings back this machine (same name, permissions and agents); only for people who may manage it. */
  reconnect?: { machineId: string; name: string; orgId: string; orgName: string };
}

/** `GET /api/desktop/latest?target=&arch=` (ADR 0036 §9): the newest app build. */
export interface DesktopRelease {
  version: string;
  /** Download link (`/api/desktop/download/{version}/{file}`), relative or absolute. */
  url: string;
  sha256: string;
  notes?: string | null;
  publishedAt: string;
  minVersion?: string | null;
  /** Bytes, when the server knows it. */
  size?: number | null;
}

/** A computer brain that runs on a connected machine. */
export type ComputerBrain = "claude_code" | "codex";

/** An agent waiting for an offline computer, and what it has waiting. */
export interface OutageAgent {
  agentId: string;
  name: string;
  brain: ComputerBrain;
  waiting: { routines: number; conversations: number };
}

/** A connected computer that went offline while agents' brains run on it. */
export interface MachineOutage {
  machineId: string;
  name: string;
  /** The machine's `os` (`darwin`, `windows`, `linux`…); `other` for the workspace's own computer. */
  platform: string;
  /** The workspace's own computer (ADR 0056 §10). */
  managed?: boolean;
  offlineSince: string;
  agents: OutageAgent[];
  /** Runs parked until the computer (or another one) can take them. */
  waitingRuns: number;
}

/** Where waiting agents may move: another connected machine. */
export type OutageTarget = {
  kind: "machine";
  machineId: string;
  name: string;
  platform: string;
  /** The workspace's own computer (ADR 0056 §10). */
  managed?: boolean;
  online: boolean;
  brains: ComputerBrain[];
  /** Why it can't take them now, or null. */
  reasonOff: "offline" | "paused" | null;
};

/** `GET …/machines/outages`. */
export interface MachineOutages {
  outages: MachineOutage[];
  targets: OutageTarget[];
}

/** `POST …/machines/{machineId}/move-agents`. */
export interface MoveAgentsInput {
  agentIds: string[];
  target: { kind: "machine"; machineId: string };
}

export interface MoveAgentsResult {
  moved: string[];
  skipped: { agentId: string; reason: string }[];
  /** Waiting runs that started again on the new computer. */
  resumed: number;
  /** Runs that keep waiting for the old computer (they already changed files there). */
  stillWaiting: number;
}

/** Org events about connected computers. */
export type MachineEvent =
  | { type: "machine.status"; machineId: string; online: boolean }
  | { type: "machine.paired"; machineId: string; name: string }
  | {
      type: "machine.updated";
      machineId: string;
      name?: string;
      paused?: MachinePause | null;
      /** `true`: what it allows changed; refetch the list (each person sees only what they may). */
      access?: MachineAccess | null | true;
      /** `true`: its Claude Code / Codex accounts changed (ADR 0041); refetch the agents' brain settings. */
      accounts?: true;
    }
  /** ADR 0036: a new pause state or access reported by the machine (also accepted inside `machine.updated`). */
  | { type: "machine.state"; machineId: string; paused?: MachinePause | null }
  | { type: "machine.access"; machineId: string; access?: MachineAccess | null }
  | { type: "machine.deleted"; machineId: string }
  /** Waiting agents moved off an offline computer ("Trocar computador"). */
  | { type: "machine.agents_moved"; machineId: string };

// ── Forum (apps/server/src/routes/app/forum.ts, ADR 0022) ───────────────────

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
  /** Why it was decided (syntheses before this field have none). */
  reasons?: string[];
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

/**
 * Everything an import can create, in one shape for every source (ADR 0055).
 * The app parses another product's files into it where the person is (their
 * browser); `POST …/imports` plans it (`dryRun`) and applies the picked items;
 * `GET …/export` returns this workspace as one. Keys are the source's own ids:
 * they only link items to each other and tell a re-import what it created.
 * Never carries keys, tokens or passwords.
 */
export interface MigrationBundle {
  format: "agenteschat.bundle";
  version: 1;
  source: {
    /** The app it came from: an import source id ("openmausbot", "openclaw"…) or "agenteschat". */
    app: string;
    /** Stable id of the package or workspace in that app; with `app`, which earlier import an item belongs to. */
    ref: string;
    /** For the header ("Equipe de vendas", "~/.openclaw"). */
    name: string;
    files: string[];
  };
  agents: BundleAgent[];
  skills: BundleSkill[];
  channels: BundleChannel[];
  routines: BundleRoutine[];
  notes: BundleNote[];
  /** What the person does afterwards: connect an app, add a key, sign in. */
  todo: BundleTodo[];
  /** What doesn't come along, as labels only. */
  leftOut: { kind: string; label: string }[];
}

export interface BundleAgent {
  key: string;
  name: string;
  handle: string;
  role: string;
  instructions: string;
  /** A model id of our catalog, else null (the workspace's suggestion). */
  model: string | null;
  appearance: { color?: string; eyes?: string; accessory?: string };
  /** Keys in `skills` this agent had on. */
  skills: string[];
}

export interface BundleSkill {
  key: string;
  /** The whole SKILL.md: frontmatter with `name` and `description`, then the body. */
  markdown: string;
}

export interface BundleChannel {
  key: string;
  name: string;
  topic: string;
  agents: { key: string; autoReply: boolean }[];
}

export interface BundleRoutine {
  key: string;
  name: string;
  /** Key of the agent that runs it. */
  agent: string;
  prompt: string;
  /** Key of a channel in the bundle; null posts in the importer's DM with the agent. */
  channel: string | null;
  trigger: { cron: string; timezone: string | null } | { rule: ApiRule } | { at: string };
}

export interface BundleNote {
  key: string;
  /** Key of the agent it belongs to; null for the whole workspace. */
  agent: string | null;
  kind: "fact" | "preference" | "decision" | "note" | "lesson";
  title?: string;
  content: string;
}

export interface BundleTodo {
  kind: "connection" | "app" | "secret" | "model" | "file";
  label: string;
  url?: string;
  /** Keys of the agents it matters to. */
  agents: string[];
}

export type ImportItemKind = "agent" | "skill" | "channel" | "routine" | "note";

export type ImportSkipReason =
  | "exists"
  | "model_not_in_catalog"
  | "invalid_skill"
  | "schedule_unsupported"
  | "schedule_in_past"
  | "secret_like"
  | "agent_not_picked"
  /** A routine whose channel isn't coming (unpicked, or a private channel with that name exists). */
  | "channel_not_picked"
  | "invalid"
  | "failed";

export interface ImportItemResult {
  kind: ImportItemKind;
  key: string;
  label: string;
  action: "create" | "update" | "unchanged" | "skip";
  /**
   * Why it is skipped. On a create or update, a note: `model_not_in_catalog` (the workspace's
   * default model instead), `exists` (a public channel with that name: the agents join it).
   */
  reason?: ImportSkipReason;
  /** Fields cut to fit our limits. */
  trimmed?: string[];
  /** An agent whose handle was taken gets the next free one. */
  renamedTo?: string;
  /** The row created or updated (after an apply). */
  targetId?: string;
}

export interface ImportInput {
  bundle: MigrationBundle;
  dryRun: boolean;
  /**
   * `kind:key` of the items to apply; default every item (items left out aren't in the plan). One
   * apply creates or updates at most 200 (`import.too_many_items`): apply a big import in chunks,
   * in the plan's order (each call is safe to repeat).
   */
  pick?: string[];
  /** `skill:key` of the skills to turn on for their agents; imported skills land off otherwise. */
  enableSkills?: string[];
}

export interface ImportPlan {
  items: ImportItemResult[];
}

/** A source package this workspace brought things from, with how many of each kind came. */
export interface ImportedSource {
  app: string;
  ref: string;
  counts: Record<ImportItemKind, number>;
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
  /** `meta`: a body the server wrote, shown in the reader's language (`previewBody`). */
  lastMessage: { author: ThreadActor; excerpt: string; meta?: PreviewMeta | null; createdAt: string } | null;
  participants: ThreadActor[];
  /** An agent run is in progress (or waiting) in this thread. */
  working: boolean;
  needsYou: boolean;
  /** Open, and a model judged its matter done after its last message: offer one-click close. Never closes by itself. */
  /**
   * When "Responder" opened it (its first reply from the thread panel): replies from then on live in
   * the panel and the channel shows one line. Null: the channel shows its replies in the timeline.
   */
  openedByReplyAt: string | null;
  suggestedResolved: boolean;
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

/**
 * What the agent found before proposing a mission (ADR 0037 round 2), shown on the plan card:
 * `read` = code or files it read (icon: search), `data` = numbers from analytics, logs or errors
 * (icon: chart), `decision` = the one open question left for the person (icon: help; at most one).
 * `refs`: files with lines (`ReviewPrompt.swift:41`), links or ids it cites.
 */
export interface MissionFinding {
  kind: "read" | "data" | "decision";
  text: string;
  refs?: string[];
}

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
  /** What the agent found before proposing it (read only); empty when a person started it and planning found nothing yet. */
  findings: MissionFinding[];
  /** The `decision` finding's text: the one question left for the person (null: none). */
  openQuestion: string | null;
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
  /** ADR 0044: the mission's own branch in its copy of the project (null until it is prepared). */
  branch?: string | null;
  /** The branch it started from ("a partir de main"). */
  baseBranch?: string | null;
  baseSha?: string | null;
  /** Its copy of the project: being prepared, ready, failed (`worktreeError`), or removed at close. */
  worktreeState?: MissionWorktreeState;
  /** Why preparing failed (the last lines of the output). */
  worktreeError?: string | null;
  /** Why it is `failed` (`branch_missing`: the branch is gone, trying again starts over); null otherwise. */
  worktreeFailReason?: MissionSetupMeta["reason"] | null;
}

export type MissionWorktreeState = "none" | "preparing" | "ready" | "failed" | "removed";

/** `meta.missionSetup`: preparing the mission's copy of the project failed ("Tentar de novo"). */
export interface MissionSetupMeta {
  state: "failed";
  /** `branch_missing`: the mission's branch is gone from the computer; trying again starts over from the base. */
  reason: "setup" | "ensure" | "branch_missing";
  error: string;
  branch?: string;
  /** The thread's mission is used when absent. */
  missionId?: string;
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

/** Why an agent can't run a mission for you. */
export type MissionIneligibleReason = "no_computer" | "exec_off" | "runner_outdated" | "not_in_audience";

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
export type BrainUnavailable = "no_computer" | "exec_off" | "runner_old" | "tool_off" | "not_installed" | "outdated";

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

/** A computer the caller may give an agent, with what it offers. */
export interface BrainMachine {
  machineId: string;
  name: string;
  online: boolean;
  options: BrainOption[];
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
  /** Every computer the caller may give the agent, with what each offers ("Vai para o Mac mini"). */
  machines: BrainMachine[];
  canEdit: boolean;
  /** ADR 0041: the account on the agent's computer it thinks with; null = "Conta deste computador". */
  account: string | null;
  /** How much it thinks before answering; `auto` = picked per task; null = the brain's default. */
  effort: BrainEffortSetting | null;
  /**
   * The agent's owner's accounts on its computer (both kinds) and the one it thinks with; "Conta deste
   * computador" isn't listed. A plan thinks only for its owner's agents (ADR 0059).
   */
  accounts: MachineAccount[];
  /** The viewer may add an account there for this agent: its owner, on a computer where they add accounts. */
  canManageAccounts: boolean;
  /** False while the app on the computer is too old for accounts (nothing about them shows). */
  accountsSupported: boolean;
  /** Nobody but the agent's owner talks to it ("Responde a todos" off). */
  onlyOwner: boolean;
  /** The viewer owns the agent: only they choose its plan and let other people talk to it on one. */
  canUsePlans: boolean;
  /** "Conta deste computador" can think for it: whoever connected the computer owns the agent. */
  ownSignIn: boolean;
  /** "Conta deste computador"'s plan usage, by brain (absent: not known). */
  ownUsage: Partial<Record<MachineAccountKind, PlanUsage>>;
}

/** ADR 0041 §5: `xhigh` may be stored; the page offers low, medium, high and max. */
export type BrainEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** A level, or "Automático" (each run picks low, medium or high with the model). */
export type BrainEffortSetting = BrainEffort | "auto";

export type MachineAccountKind = "claude_code" | "codex";

/** ADR 0041 §3, ADR 0059: a Claude Code or Codex account signed in on a connected computer (metadata only). */
export interface MachineAccount {
  id: string;
  kind: MachineAccountKind;
  label: string;
  /** Only for its owner. */
  email: string | null;
  /** "Pro", "Max", "Team"… as the provider reports it. */
  plan: string | null;
  status: "active" | "signed_out";
  /** Whose it is (the person who signed it in); null: nobody's. */
  ownerId: string | null;
  ownerName: string | null;
  /** The viewer owns it: only they rename it or pick it for an agent. */
  mine: boolean;
  /** Names of the agents that think with it (one at most). */
  usedBy: string[];
  /** Its plan's usage limits; null: not known yet. */
  usage: PlanUsage | null;
  /** A key account's coding plan (`zai`, `kimi`, `minimax`, `opencode`); null: the CLI's own sign-in. */
  provider: string | null;
  /** The last 4 of a key account's key (its owner only). */
  keyHint: string | null;
}

/** `GET …/ai-accounts`: the viewer's AI accounts on the organization's computers, and where they can add one. */
export interface AiAccounts {
  accounts: (MachineAccount & { machineId: string; computer: string })[];
  computers: AiComputer[];
}

export interface AiComputer {
  machineId: string;
  name: string;
  online: boolean;
  /** The viewer connected it. */
  mine: boolean;
  /** The viewer adds accounts there (they connected it, or nobody did), on a runner that knows accounts. */
  canAdd: boolean;
  /** Its runner takes coding plans' keys. */
  keys: boolean;
  /** What it can think with now: Claude Code (Claude and the coding plans) and Codex (ChatGPT). */
  brains: { claude_code: boolean; codex: boolean };
  /**
   * "Conta deste computador": each CLI's own sign-in there, on a computer the viewer connected (absent: a server
   * too old to say). Its plan and usage when the computer reported them.
   */
  own?: Partial<Record<MachineAccountKind, { plan?: string; usage?: PlanUsage }>>;
}

/** A plan's usage window: how much of it is used (0–100) and when it resets. */
export interface PlanWindow {
  kind: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "monthly" | "other";
  /** `other`: the provider's name for it ("Extra usage", a model's name). */
  label?: string;
  usedPercent: number;
  resetsAt?: string;
}

/** A plan's usage limits, as the CLI on its computer said them (`at`); no token is ever read. */
export interface PlanUsage {
  windows: PlanWindow[];
  /** The plan refused a request for its limit (until a window resets). */
  limited?: boolean;
  source: "turn" | "probe";
  at: string;
}

export interface AgentBrainInput {
  brain?: BrainKind;
  model?: string | null;
  fallback?: boolean;
  /** "Responde a todos" turned off: false lets in whoever its "who can talk" list allows (everyone with no list). */
  onlyOwner?: boolean;
  /** One of the viewer's own accounts; null = "Conta deste computador". */
  account?: string | null;
  /** The account thinks for another agent: take it from that one. */
  moveAccount?: boolean;
  effort?: BrainEffortSetting | null;
}

/** `POST …/machines/{id}/account-logins` (201): what the person needs to sign in. */
export interface AccountLoginStart {
  loginId: string;
  kind: MachineAccountKind;
  /** The provider's own page (Claude's sign-in, the device page for Codex, or where a plan's key is made). */
  url: string;
  /** A coding plan's key account. */
  provider?: string;
  /** Claude Code: the computer's one-time key the pasted code is sealed to. */
  publicKey?: string;
  /** Codex: the one-time code to type on the device page. */
  userCode?: string;
  expiresAt: string;
}

/** `GET …/account-logins/{loginId}`. */
export interface AccountLoginStatus {
  state: "waiting" | "done" | "failed" | "expired";
  account?: MachineAccount;
  error?: string;
  /** `failed`: the viewer already has this account on that computer, named `label` (an older server sends no `account`). */
  duplicate?: { label: string; account?: MachineAccount };
  /** `failed`: signing in again came back as another account, this email; the account stays signed out. */
  signedInAs?: string;
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
  /** ADR 0044 (missions): writes in the mission's copy, only reads, or prepares the copy. */
  mode?: "write" | "read" | "setup" | null;
  /** The commits it started from and ended at ("O que mudou" per session). */
  startSha?: string | null;
  endSha?: string | null;
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
  | "agent_reply"
  | "agent_question"
  | "issue_assigned"
  | "issue_comment"
  | "issue_status"
  | "forum_turn"
  | "forum_synthesis"
  | "approval"
  | "mission_finished"
  | "mission_stopped"
  /** ADR 0053: the agent told people what a routine found. Opens its message (`source.channelId`, `messageId`). */
  | "routine_finished"
  /** A routine's failure streak began (one per streak; the next good run resolves it). Opens it in Rotinas. */
  | "routine_failed"
  /** The server paused a routine (`latest.reason`: its coded `pausedReason`). Opens it in Rotinas. */
  | "routine_paused"
  /** A routine waits for its computer (once per outage; `source.machineId`). Opens it in Rotinas. */
  | "routine_stalled"
  | "reaction"
  /** ADR 0036 §5: a new computer joined the organization (admins). `source.machineId`; `source.label` = its name. */
  | "machine_connected"
  /** ADR 0040 §6: an agent needs a person in its browser (sign in, a code). `source.handoffId`. */
  | "browser_handoff"
  /**
   * ADR 0056 §8: the workspace was held, suspended or restored (owners and admins). `latest.statusTo`, `latest.text`:
   * why. On agentes.chat Cloud also an agent held (`statusTo: "agent_hold"`, `latest.holdKind`, `source.agentId`).
   */
  | "org_standing"
  /** ADR 0056 §10: the workspace's own computer is ready (owners). `source.machineId`; `source.label` = its name. */
  | "computer_ready"
  /**
   * ADR 0068: someone asks to join through the invitation link (owners and admins). Waiting; no actor;
   * `latest.title` the newest name, `count` how many asked while it was unread. Opens Members.
   */
  | "join_request";

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
  /** `machine_connected`: the computer. */
  machineId?: string;
  /** `browser_handoff`: the request (its chat card has the same id). */
  handoffId?: string;
  /** `browser_handoff`: the agent's screen it is on, when not its browser (ADR 0058: `desktop`). */
  screen?: ScreenKind;
  /** `org_standing` to `agent_hold`: the agent held (its name in `label`). */
  agentId?: string;
  /** Channel name, thread title, issue title, topic title, mission or routine name (or the computer's name). */
  label?: string;
}

/** What the card shows (plain text; only @mentions are highlighted). */
export interface NotificationLatest {
  /** Snippet of the latest message, comment, question or summary (≤ 280 chars); an approval's why. */
  text?: string;
  /** Issue title, the approval's action title, the topic's question. */
  title?: string;
  /** Reactions: distinct emojis (≤ 5) and my message's snippet. */
  emojis?: string[];
  quote?: string;
  statusFrom?: string;
  statusTo?: string;
  /** `org_standing`: the billing hold put on (ADR 0079), in place of `text`. */
  billingHold?: string;
  /** Missions and routines. */
  steps?: { done: number; total: number; failedAt?: number };
  /** An agent's question with options. */
  suggestions?: string[];
  /** Approvals. */
  expiresAt?: string;
  /** Forum turns. */
  round?: number;
  rounds?: number;
  /**
   * `routine_paused`: why (a `RoutinePausedReason`); `routine_failed`: its failed run's code (`routines.code.*`).
   * Both said in the person's language.
   */
  reason?: string;
  /** `approval`: asked while nobody watched, by a routine or an unattended run (ADR 0053 §8). */
  origin?: ApprovalOrigin;
  /** `org_standing` to `agent_hold` (agentes.chat Cloud): `network` or `operator`, never the hold's reason. */
  holdKind?: string;
  /** `org_standing` on agentes.chat Cloud: `text` is the reason a restriction reads with (`restrictionOf`). */
  cloud?: boolean;
  /** `join_request`: the first two people who asked, in the order they asked (`count` says how many in all). */
  names?: string[];
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

// ── Audit (Configurações › Auditoria) ────────────────────────────────────────

export type AuditOutcome = "done" | "failed" | "refused" | "pending";

/**
 * One row of the org's audit log (`GET …/audit`, admins): an agent's tool call
 * (`action: "tool.call"`, with an `outcome`) or a change (`approval.approved`,
 * `routine.created`…; `outcome` null).
 */
export interface AuditRow {
  id: string;
  at: string;
  actor: { type: "person" | "agent" | "system"; id: string | null; name: string | null };
  action: string;
  target: { type: string; id: string | null };
  /**
   * A tool call's: `kind`, `connector`, `title` (the call in words), `behind` (`person`, `routine`,
   * `unattended`), `routine` ({ id, name }), `input` (secrets masked), `reason`, `approvalId`, `secretRequestId`.
   */
  details: Record<string, unknown>;
  runId: string | null;
  channelId: string | null;
  channel: { id: string; name: string; kind: "channel" | "dm" | "forum" } | null;
  onBehalfOf: { id: string; name: string | null } | null;
  outcome: AuditOutcome | null;
  /** The approval the call waited for or ran after, as it stands now. */
  approval: { id: string; status: string; decidedBy: { id: string; name: string | null } | null } | null;
  /** The secret the call waited for (`request_secret`), as it stands now. */
  secret: { id: string; status: "pending" | "delivered" | "declined" | "expired" | "canceled" } | null;
}

export interface AuditPage {
  rows: AuditRow[];
  next: string | null;
}

export interface AuditQuery {
  actorType?: "person" | "agent" | "system";
  actorId?: string;
  outcome?: AuditOutcome[];
  /** Only calls whose approval or secret nobody has answered yet. */
  waiting?: boolean;
  kind?: "tool" | "change";
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
/**
 * What reaches my devices as a notification, by category (ADR 0071 §8): the phone's and the browser's pushes and
 * the desktop app's banners. The inbox keeps everything either way.
 */
export type NoticeCategory =
  | "waiting"
  | "replies"
  | "mentions"
  | "threads"
  | "tasks"
  | "routines"
  | "computers"
  | "reactions";

export interface NoticePrefs {
  /** Every category, in the order the settings show them. */
  categories: { id: NoticeCategory; on: boolean }[];
  /** My phones that get pushes (the phone app). */
  phones: number;
}

export interface NotificationCount {
  unread: number;
  waiting: number;
}

/** Per person (user scope): created or merged, auto-resolved, and the new counts. */
export type NotificationEvent =
  | {
      type: "notification.upserted";
      notification: AppNotification;
      /** Whether it reaches my devices as a notification, by my choices (ADR 0071 §8); absent from older servers. */
      alert?: boolean;
    }
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
  /** Messages sent to it while it works that it hasn't read yet. */
  pendingMessageIds?: string[];
  /** A routine's run working in the background: it holds no conversation and shows no "trabalhando". */
  background?: boolean;
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

// ── Mailboxes (ADR 0038) ────────────────────────────────────────────────────

/** A preset for our IMAP/SMTP connector (iCloud, Locaweb, Hostinger, Zoho…). */
export interface MailPreset {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** What to log in with: the whole address, or only the part before the @. */
  username: "address" | "local";
  /** Where the person creates an app password; null = none to link. */
  appPasswordUrl: string | null;
}

/** `GET …/mail/providers`: which ways in this server offers. */
export interface MailProviders {
  /** Gmail and Outlook (through Composio). */
  composio: boolean;
  /** iCloud and any other mailbox (IMAP/SMTP). */
  imap: boolean;
  presets: MailPreset[];
}

export type MailLevel = "read" | "read_write";

/** A mailbox the organization connected (never its password). */
export interface MailAccount {
  id: string;
  provider: "gmail" | "outlook" | "imap";
  via: "composio" | "imap";
  address: string;
  label: string;
  status: "pending" | "active" | "needs_reconnect";
  lastError: string | null;
  /** The IMAP preset (`icloud`, `locaweb`…); null for Gmail/Outlook or a custom server. */
  preset: string | null;
  createdAt: string;
  /** Actions turned off in this mailbox for every agent ("O que faz"). */
  offActions: MailActionName[];
  /** Actions that always ask a person in this mailbox (`draft`, `organize`). */
  askActions: MailActionName[];
  /** Other addresses of this mailbox: a reply goes out from the one the email arrived at. */
  aliases: string[];
  /** What new emails go out from; null = `address`. */
  defaultFrom: string | null;
  /** Agents with access, and how much. */
  agents: { agentId: string; level: MailLevel; canDelete: boolean }[];
}

/** What can be turned on or off for a mailbox; each of the agents' email tools belongs to one. */
export type MailActionName =
  | "search"
  | "read"
  | "folders"
  | "draft"
  | "organize"
  | "send"
  | "reply"
  | "forward"
  | "delete";

/** Why an IMAP mailbox didn't connect (`422 { error }`). */
export type MailConnectError = "auth" | "imap_unreachable" | "smtp_unreachable" | "tls" | "blocked_host" | "unknown";

/** What a mailbox's PATCH changes (each field optional). */
export interface MailAccountUpdate {
  label?: string;
  /** A new app password (IMAP): tested first, a `422` carries `MailConnectError`. */
  password?: string;
  offActions?: MailActionName[];
  askActions?: MailActionName[];
  /** The mailbox's other addresses (replaces the list). */
  aliases?: string[];
  /** One of `address` or `aliases`; null = `address`. */
  defaultFrom?: string | null;
}

export interface MailImapInput {
  preset: string;
  address: string;
  password: string;
  label?: string;
  username?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

export interface MailFolder {
  id: string;
  name: string;
  /** `inbox`, `sent`, `drafts`, `trash`, `archive`, `junk`… */
  role?: string;
}

/** An agent's rules for one mailbox. */
export interface MailPolicy {
  /** Folders it may read; empty = all. */
  folders: string[];
  /** Only mail from these addresses or `@domain`s; empty = anyone. */
  senders: string[];
  /** Only mail from the last N days; null = no limit. */
  windowDays: number | null;
  /** Only send to these addresses or `@domain`s; empty = anyone (always asking). */
  allowedRecipients: string[];
  dailySendCap: number;
  /** Sends without asking (only with `allowedRecipients`). */
  sendWithoutAsking: boolean;
  /** The only address this agent sends from (one of the mailbox's); null = automatic (replies from where the email arrived). */
  fromAddress: string | null;
}

/** An agent's access to one mailbox. */
export interface AgentMailbox {
  accountId: string;
  level: "none" | MailLevel;
  canDelete: boolean;
  policy: MailPolicy;
}

export interface AgentMailboxInput {
  level: "none" | MailLevel;
  canDelete: boolean;
  policy: MailPolicy;
}

// ── Databases (ADR 0039) ────────────────────────────────────────────────────

/** Where the database lives (only for the help when connecting). */
export type DatabaseProvider = "supabase" | "neon" | "railway" | "rds" | "render" | "other";

/** What can be turned on or off for a database; one of the agents' database tools each. */
export type DatabaseActionName = "list_tables" | "describe_table" | "query";

/** A Postgres database the organization connected (never its password). */
export interface DatabaseConnection {
  id: string;
  label: string;
  provider: DatabaseProvider;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: "require" | "disable";
  status: "active" | "needs_reconnect";
  lastError: string | null;
  /** The user can change data: the app recommends a read-only one (agents only read anyway). */
  canWrite: boolean;
  createdAt: string;
  offActions: DatabaseActionName[];
  /** Columns hidden by default in agents' rules (`schema.table.column`). */
  suggestedHidden: string[];
  /** Agents that can read it. */
  agents: { agentId: string }[];
}

/** Why a database didn't connect (`422 { error }`). */
export type DatabaseConnectError = "auth" | "unreachable" | "blocked_host" | "tls" | "unknown";

export interface DatabaseConnectionInput {
  label?: string;
  provider?: DatabaseProvider;
  /** `postgres://user:password@host:5432/database`; the fields win over it. */
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  sslmode?: "require" | "disable";
}

export interface DatabaseTable {
  schema: string;
  name: string;
  kind: string;
  rowsEstimate: number;
}

/** An agent's rules for one database. */
export interface DatabasePolicy {
  /** `schema.table`; empty = every table. */
  tables: string[];
  /** `schema.table.column`, never read. */
  hiddenColumns: string[];
  /** Queries per day; null = no cap. */
  dailyQueryCap: number | null;
  /** Each query is cancelled past this. */
  timeoutSeconds: number;
}

/** An agent's access to one database. */
export interface AgentDatabase {
  connectionId: string;
  level: "none" | "read";
  policy: DatabasePolicy;
}

export interface AgentDatabaseInput {
  level: "none" | "read";
  policy: DatabasePolicy;
}

// ── Agent browser (ADR 0040) ─────────────────────────────────────────────────

export type BrowserHandoffStatus = "pending" | "active" | "done" | "failed" | "expired" | "cancelled";

/** The screens of an agent that people watch and take over: one open handoff per agent and screen. */
export type ScreenKind = "browser" | "desktop";

/**
 * A person's turn on one of an agent's screens: the agent asked (`ask`, with a
 * chat card `meta.browserHandoff` whose message id is this id) or someone
 * watching took over (`takeover`: no card of its own; its browser card stays
 * with the run it is bound to, `runId`).
 */
export interface BrowserHandoff {
  id: string;
  agentId: string;
  runId: string | null;
  machineId: string;
  /** Absent from servers older than screens: the browser (`handoffScreen`). */
  screen?: ScreenKind;
  kind: "ask" | "takeover";
  instructions: string;
  status: BrowserHandoffStatus;
  requestedForUserId: string | null;
  /** Who is in control now (null: nobody yet). */
  controllerUserId: string | null;
  /** What the person told the agent when it ended ("Não consegui"'s reason, or a note on "Pronto"/"Devolver"). */
  note: string | null;
  /** While nobody has opened it: when it expires. Null once someone is in control (no deadline then). */
  expiresAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Why an agent can't use its browser now (codes for the app's own text). */
export type BrowserUnavailableReason =
  | "no_machine"
  | "machine_removed"
  | "outdated"
  | "switched_off"
  | "not_installed"
  | "not_reported";

/** `GET …/agents/{id}/browser`: whether its computer serves the browser, and the sites it may open. */
export interface AgentBrowserSettings {
  /** Null: any site. `*.example.com` covers the domain too. */
  allowedDomains: string[] | null;
  available: boolean;
  reason: BrowserUnavailableReason | null;
  /** The computer's own words, when it said why. */
  detail: string | null;
  machine: { id: string; name: string } | null;
}

/** `GET …/agents/{id}/desktop` (ADR 0058): the agent's desktop as this person sees it. */
export interface DesktopStatus {
  /** Whether it can be shown now, else why (`reason`). */
  available: boolean;
  /** `no_desktop`, `no_computer`, `offline`, `other_server`, `runner_outdated`, `not_allowed` (its switch is off), `desktop_unavailable`. */
  reason: string | null;
  /** What the computer says it lacks (what to install). */
  detail: string | null;
  running: boolean;
  startedAt: string | null;
  /** Who is in control (of the desktop, or of the browser showing the same window), and that handoff. */
  controllerUserId: string | null;
  handoff: BrowserHandoff | null;
  viewers: number;
  /** This person may take control. */
  canControl: boolean;
  /** The agent is held, or the workspace is on hold: people watch, nobody takes control. */
  held: boolean;
}

/** A plan window with each agent's estimated part of it (the usage views, ADR 0063). */
export interface PlanWindowParts extends PlanWindow {
  /**
   * The window's percent × each agent's API-priced share of the account's use since it started, biggest
   * first; null for a window of unknown length (no estimate).
   */
  agents: { agentId: string; name: string; percent: number }[] | null;
}

/** A plan account as the usage views name it. */
export interface PlanAccountInfo {
  /** `machineId:kind:accountId`, or `…:computer` for the computer's own sign-in. */
  key: string;
  machineId: string;
  machineName: string;
  kind: MachineAccountKind;
  /** Null: the computer's own sign-in ("Conta deste computador"). */
  accountId: string | null;
  label: string | null;
  plan: string | null;
  /** A key account's coding plan (`zai`, `kimi`…). */
  provider: string | null;
  /** Its owner, or the person who connected the computer for its own sign-in. */
  ownerName: string | null;
  /** The viewer owns it. */
  mine: boolean;
  /** Only for its owner. */
  email: string | null;
  signedOut: boolean;
}

export interface PlanAccountUsage extends PlanAccountInfo {
  /** Its windows as last reported, each with the agents' parts; null: not known yet. */
  usage: (Omit<PlanUsage, "windows"> & { windows: PlanWindowParts[] }) | null;
  /** This month per agent; `now`: it thinks with this account today. */
  agents: { agentId: string; name: string; tokens: number; now: boolean }[];
  monthTokens: number;
  /** `view_usage` only: what the month's tokens would cost through the API (null: no price). */
  equivalentUsd?: number | null;
}

/** `GET …/usage/plans`: every plan account by computer, and the API per agent this month. */
export interface OrgPlanUsage {
  /** `YYYY-MM`. */
  month: string;
  /** The viewer sees money. */
  money: boolean;
  accounts: PlanAccountUsage[];
  api: {
    agentId: string;
    name: string;
    tokens: number;
    budgetPercent: number;
    costUsd?: number;
    budgetUsd?: number;
    budgetIsDefault?: boolean;
  }[];
}

export interface AgentUsageSource {
  /** An account's key, `plan:<kind>` (before accounts were recorded) or `api`. */
  key: string;
  type: "plan" | "api";
  kind: MachineAccountKind | null;
  /** Null: the API, a removed account, or plan usage from before accounts were recorded. */
  account: PlanAccountInfo | null;
  /** A plan account that is no longer there. */
  removed: boolean;
  tokens: number;
  /** Share of the agent's month, 0–100. */
  share: number;
  /** `YYYY-MM-DD`. */
  lastDay: string | null;
  /** The account it thinks with now. */
  now: boolean;
  /** Plan: what it would cost through the API (money only). */
  equivalentUsd?: number | null;
  /** API: what it cost (money only). */
  costUsd?: number;
  /** API: this month's spend over the agent's budget. */
  budgetPercent?: number;
}

/** `GET …/agents/{id}/usage`: an agent's month by account and day, and the account it thinks with now. */
export interface AgentPlanUsage {
  month: string;
  money: boolean;
  tokens: number;
  equivalentUsd?: number | null;
  sources: AgentUsageSource[];
  /** Every day of the month so far: tokens per source key. */
  days: { date: string; tokens: Record<string, number> }[];
  current: PlanAccountUsage | null;
}
