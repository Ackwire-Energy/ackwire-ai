import { channelTopic, orgTopic, type PubSub, userTopic } from "@agenteschat/adapters";
import { MODEL_CATALOG } from "@agenteschat/providers";
import type { AgentActionView } from "./agent-actions";
import type { ConnectIntent } from "./ai-intent";
import type { ApprovalView } from "./approvals";
import type { ArtifactView } from "./artifacts";
import type { BrowserHandoffView } from "./browser/handoff";
import type { CalendarEventView } from "./calendar";
import type { IssueActivityView, IssueView } from "./issues";
import type { MachineTaskView } from "./machine-tasks";
import type { MessageMemory } from "./message-memories";
import type { MessageView, ReactionCount } from "./messages";

/** What a memory tool changed, for the "memory updated" card (persisted in the reply's `meta.memoryUpdates`). */
export interface MemoryUpdate {
  action: "remembered" | "forgot" | "updated" | "proposed";
  itemId: string;
  text: string;
  previousText?: string | null;
  requestedByUserId: string;
  /** Undo: `POST /api/app/organizations/{orgId}/memories/{itemId}/revert`. Absent for proposals. */
  undo?: { method: "POST"; path: string };
  /** For `proposed`: the proposal to accept inline, and whether the requester can decide it. */
  proposalId?: string;
  canDecide?: boolean;
  /** `memory.remembered` | `memory.updated` | `memory.forgot` | `memory.proposed`: the app's own words, with `params`. */
  code?: string;
  params?: { text: string; previousText?: string | null };
}

import type { AgentQuestion } from "./questions";
import type { RunStatus } from "./runs";
import type { SecretRequestView } from "./secrets";
import type { ThreadChange, ThreadInfo, ThreadState } from "./threads";

/** Which step of the router's chain picked the agents for a message nobody mentioned (ADR 0074). */
export type DecidedBy =
  | { step: "jev" }
  | { step: "model"; model: string; provider: string }
  /** The author's own plan: `ownerId` is the author. */
  | { step: "plan"; brand: "claude" | "chatgpt"; ownerId: string }
  | { step: "rule"; rule: "reply" | "only_agent" | "follow_up" };

/** Why a routed message reached no agent: no step could read it, and no rule fit (`strategy` `none`). */
export const MENTION_NEEDED = "mention_needed";

const RULES = new Set(["reply", "only_agent", "follow_up"]);

/**
 * `DecidedBy` from a stored decision's `strategy` (`jev`, `llm:<model>`, `plan:<kind>`, `rule:<name>`). Undefined
 * for anything else: a mention's judge, or a decision from before the chain.
 */
export function decidedByOf(strategy: string, authorUserId: string | null): DecidedBy | undefined {
  if (strategy === "jev") return { step: "jev" };
  const [step, rest = ""] = strategy.split(/:(.*)/s);
  if (step === "llm" && rest) return { step: "model", model: rest, provider: MODEL_CATALOG[rest]?.provider ?? "" };
  if (step === "plan" && authorUserId && (rest === "claude_code" || rest === "codex")) {
    return { step: "plan", brand: rest === "codex" ? "chatgpt" : "claude", ownerId: authorUserId };
  }
  if (step === "rule" && RULES.has(rest)) return { step: "rule", rule: rest as "reply" | "only_agent" | "follow_up" };
  return undefined;
}

/**
 * Real-time events sent to WebSocket clients subscribed to a channel. The
 * database is the source of truth; events only tell clients what changed.
 * Documented for the web app in docs/adr/0010-realtime.md.
 */
/** `threadId` null on agent events = the main timeline (DMs are flat). */
export type ChannelEvent =
  /** A message was committed. `message` is omitted when too large for pub/sub: fetch it by id. */
  | { type: "message.created"; channelId: string; messageId: string; message?: MessageView }
  /** A fragment of an agent's reply while it is generated (not persisted; the final message follows). */
  | {
      type: "agent.delta";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      seq: number;
      text: string;
      /** The model call this text belongs to (1, 2…): a new turn starts a new segment, never glued to the last one. */
      turn: number;
    }
  /**
   * The text the agent streamed before calling tools was progress narration
   * ("Go isn't installed; I'll try…"), not the answer: show it as a step
   * of the work and clear it from the live reply. The message holds only the
   * final answer.
   */
  | {
      type: "agent.narration";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      turn: number;
      text: string;
    }
  /** An agent run changed state (`running` = typing indicator). */
  | {
      type: "agent.run";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      status: RunStatus;
      /** Background work (a routine's run): not the conversation's "working" indicator. */
      background?: true;
      error?: string;
      /** Stable code of `error` (`run.budget_exceeded`, `run.provider_error`…) and its params. */
      errorCode?: string;
      errorParams?: Record<string, string>;
    }
  /**
   * An agent will answer (mention, DM, router pick, or a run was claimed):
   * show "thinking" right away. `runId` is null when announced at post time,
   * before the run exists.
   */
  | {
      type: "agent.thinking";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string | null;
      /** Background work (a routine's run): not the conversation's "working" indicator. */
      background?: true;
    }
  /** An agent asked another agent (`ask_agent`, ADR 0034); the answer comes later as a notice: "Dev asked Infra…". */
  | {
      type: "agent.consulting";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      consultedAgentId: string;
    }
  /**
   * An agent's question to another agent (`ask_agent`, ADR 0034) came back:
   * `status` answered, expired or failed. The asking run resumes.
   */
  | {
      type: "agent.consulted";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      consultedAgentId: string;
      status: "answered" | "expired" | "failed";
    }
  /**
   * A question still out changed without closing: the consulted agent stopped on a person (an approval, a
   * question, a secret). The app reloads the conversation's questions (`GET …/consultations`).
   */
  | {
      type: "agent.consultation";
      channelId: string;
      threadId: string | null;
      runId: string;
      consultationId: string;
    }
  /**
   * The agent started a tool call (`tool` = its name; `connector` = the app, for MCP tools) or finished (`tool: null`,
   * with its `toolUseId`, `failed` when the tool answered with an error, `held` when it waits on a person).
   */
  | {
      type: "agent.tool";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      tool: string | null;
      connector?: string;
      /** A short label (≤ 80 chars): the skill, the issue (#131 or title) or the Drive file. Built-in tools only. */
      detail?: string;
      /** The model's id of this call (live output refers to it). */
      toolUseId?: string;
      /** `run_code`: the code being run (≤ 4 KB, secrets masked). */
      code?: { language: string; source: string };
      /** On the end (`tool: null`): the tool answered with an error. Never the error itself (it can carry data). */
      failed?: boolean;
      /** On the end: it didn't run, it waits on a person (an approval, a question, a secret). */
      held?: boolean;
    }
  /** What a computer command prints while it runs (throttled, ≤ 64 KB per call). */
  | {
      type: "agent.tool.output";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      toolUseId?: string;
      stream: "stdout" | "stderr";
      text: string;
    }
  /** The agent's first words arrived (switch "thinking" to "typing"). */
  | { type: "agent.typing"; channelId: string; threadId: string | null; agentId: string; runId: string }
  /** The agent stopped (done, failed or waiting for approval). */
  | {
      type: "agent.idle";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      background?: true;
    }
  | {
      type: "run.finished";
      channelId: string;
      threadId: string | null;
      agentId: string;
      background?: true;
      runId: string;
      status: "done" | "failed" | "waiting_approval" | "waiting_input" | "canceled";
      error?: string;
      errorCode?: string;
      errorParams?: Record<string, string>;
    }
  /**
   * A person's message went to the agent's task already in progress (one
   * active run per agent and conversation): it reads it at its next step.
   * `now`: the person asked it to stop and read it now ("Parar e mandar"): its current model
   * call is cut short. `stop`: the message asked to stop, and the run is being canceled (it can
   * arrive in a second event, after the stop judge).
   */
  | {
      type: "agent.run.steered";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageId: string;
      now?: true;
      stop?: boolean;
    }
  /** The run read these messages sent while it worked (they are in its conversation now): "Ada leu". */
  | {
      type: "agent.run.read";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageIds: string[];
    }
  /**
   * Handed to a computer brain mid-turn (Claude Code reads it at its next tool boundary), not
   * confirmed read yet: "Ada recebeu". `agent.run.read` follows once the turn reports it read.
   */
  | {
      type: "agent.run.delivered";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageIds: string[];
    }
  /**
   * Messages a run took but never read (it ended, failed, was stopped or interrupted by a deploy)
   * went to a run of their own: nothing sent to an agent is dropped.
   */
  | {
      type: "agent.run.redispatched";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      newRunId: string;
      messageIds: string[];
    }
  /** The run ended without posting: nobody called it by name and it had nothing to add (`pass`). */
  | { type: "agent.passed"; channelId: string; threadId: string | null; agentId: string; runId: string }
  /**
   * A person's message reached a run that was waiting (help in the browser, another agent's answer,
   * an approval): `outcome` says what became of it. `resolved`: it ended the wait (e.g. "pronto,
   * loguei" closed the browser help as done). `woke`: the run stopped waiting and reads it now (the
   * wait stays open; its result comes later as a notice). `held`: it waits for the decision on a card.
   */
  | {
      type: "agent.run.wait_message";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageId: string;
      waitKind: string;
      outcome: "resolved" | "woke" | "held";
    }
  /**
   * A person pressed "Continuar" under a stopped reply (`messageId`): `newRunId` picks up where
   * `runId` stopped (its reply's `meta.canceled.continuedRunId`), so every app hides the button.
   */
  | {
      type: "run.continued";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      newRunId: string;
      messageId: string;
    }
  /** A person stopped the run (`POST …/runs/{id}/cancel`): drop "pensando…" now; its text so far follows as a message. */
  | {
      type: "run.canceled";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      byUserId: string;
    }
  /** A person is typing (client frame `typing`). Clients drop it after `ttlMs`. */
  | { type: "user.typing"; channelId: string; threadId: string | null; userId: string; ttlMs: number }
  /** Who saw a message and who will answer (receipts). No router scores here. */
  | {
      type: "message.routed";
      channelId: string;
      messageId: string;
      seenBy: string[];
      pickedBy: string[];
      /** The run each picked agent answers with (new, steered into, or resumed by an answer). */
      runs?: { agentId: string; runId: string }[];
      /** Agents it mentions that won't answer (they don't reply to this person). */
      blocked?: string[];
      /** Agents it only references (part of the request to another agent): no run, by design. */
      referenced?: string[];
      strategy: "mention" | "dm" | "router" | "none";
      /**
       * `no_ai`: the organization has no AI. `mention_needed`: no step could pick an agent (no Jev, no small
       * model, no plan of the author, no rule): a mention still calls one.
       */
      reason?: string;
      /** The router's step that picked (ADR 0074). */
      decidedBy?: DecidedBy;
      /** With `no_ai`: the Connect step the message asks for (`aiConnectIntent`). */
      intent?: ConnectIntent["intent"];
      provider?: string;
      autoOpen?: true;
    }
  /** The author's own plan reads a message nobody mentioned, which takes seconds: "Picking who answers" until `message.routed`. */
  | { type: "message.routing"; channelId: string; messageId: string; step: "plan" }
  | { type: "message.claimed"; channelId: string; messageId: string; agentId: string; runId: string }
  | {
      type: "message.handled";
      channelId: string;
      messageId: string;
      agentId: string;
      runId: string;
      status: "done" | "failed" | "waiting_approval" | "waiting_input" | "canceled";
      /** `no_ai`: the agent has no AI to think with. */
      reason?: string;
    }
  /** An agent changed its memory because a person asked (with an undo). */
  | {
      type: "memory.updated";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      update: MemoryUpdate;
    }
  /** An agent asked a person something (`ask_user`), or the question was answered or expired. */
  | {
      type: "question.asked" | "question.answered";
      channelId: string;
      threadId: string | null;
      question: AgentQuestion;
    }
  /** An agent asked a person for a secret for its computer (ADR 0027), or the request closed. Never the value. */
  | {
      type: "secret.requested" | "secret.updated";
      channelId: string;
      threadId: string | null;
      secretRequest: SecretRequestView;
    }
  /** An agent's browser handoff changed (ADR 0040 §6): someone took control, or it ended. The card is `meta.browserHandoff`. */
  | {
      type: "browser.handoff.updated";
      channelId: string;
      threadId: string | null;
      handoff: BrowserHandoffView;
    }
  /** An issue of this channel was created or changed, or got a comment. */
  | { type: "issue.created" | "issue.updated"; channelId: string; issue: IssueView }
  | { type: "issue.comment"; channelId: string; issueId: string; activity: IssueActivityView }
  /** An event of this channel's calendar was created. */
  | { type: "calendar.event_created" | "calendar.event_updated"; channelId: string; event: CalendarEventView }
  /** An event (or some of its occurrences: `scope`) was deleted. */
  | {
      type: "calendar.event_deleted";
      channelId: string;
      eventId: string;
      scope: "this" | "following" | "all";
      occurrenceStart?: string;
    }
  /** A file was created or got a new version (Drive preview card). */
  | { type: "artifact.created" | "artifact.updated"; channelId: string; artifact: ArtifactView }
  /** A file was deleted (it shows as removed; restorable for 30 days). */
  | { type: "artifact.deleted"; channelId: string; artifactId: string }
  /** Channel membership changed (agents carry `autoReply`). */
  | {
      type: "channel.member_added" | "channel.member_removed" | "channel.member_updated";
      channelId: string;
      member: { type: "person" | "agent"; id: string; autoReply?: boolean };
    }
  /** A sensitive action waits for a person (`approval.created`) or was decided/expired (`approval.decided`). */
  | { type: "approval.created" | "approval.decided"; channelId: string; approval: ApprovalView }
  /**
   * A thread's state, title or context changed (ADR 0029). `thread` is the
   * fresh view when the server has it at hand (a reply that reopened a closed
   * thread sends only `state`). `messageIds`: messages that left the channel
   * (`moved`) or came back (`returned`).
   */
  | {
      type: "thread.updated";
      channelId: string;
      threadId: string;
      change: ThreadChange;
      state?: ThreadState;
      /** Without `following` (each person reads their own from the API). */
      thread?: Omit<ThreadInfo, "following">;
      messageIds?: string[];
    }
  /** Someone reacted or took a reaction back: the message's reactions now (replace, don't merge). */
  | { type: "message.reactions"; channelId: string; messageId: string; reactions: ReactionCount[] }
  /** A message was pinned in this channel (`GET …/channels/{id}/pins` lists them, newest first). */
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
  /** An agent saved something to memory from this person's message: its current memory marks. */
  | { type: "message.memories"; channelId: string; messageId: string; memories: MessageMemory[] }
  /**
   * Act with undo (ADR 0037 round 2): the receipts of an agent's message
   * changed (they were linked to it, or someone undid or redid one). `actions`
   * is the message's whole list now (replace, don't merge).
   */
  | {
      type: "message.actions";
      channelId: string;
      threadId: string | null;
      messageId: string;
      actions: AgentActionView[];
    }
  /**
   * A background task on a connected computer started, reported progress
   * (last line, files, elapsed), ended, was interrupted or resumed (ADR 0029).
   * `task` is its whole view (replace, don't merge); `threadId` null = main timeline.
   */
  | { type: "machine.task"; channelId: string; threadId: string | null; task: MachineTaskView }
  /**
   * A mission changed (ADR 0029): status, plan, participants, owner,
   * computer, a decision, a review, a suggestion, a task, a file edited on
   * the machine. `change` says what; small details ride along (`decision`,
   * `review`, `messageId`…); clients refetch `GET …/missions/{missionId}` for
   * the rest. `threadId` is the mission's home thread.
   */
  | {
      type: "mission.updated";
      channelId: string;
      threadId: string;
      missionId: string;
      status: "proposed" | "active" | "paused" | "done" | "canceled" | "awaiting_close";
      change: string;
      [key: string]: unknown;
    }
  /** An agent's forum suggestion card was accepted (a topic opened) or dismissed: its `meta.forumSuggestion` now. */
  | {
      type: "forum.suggestion.updated";
      channelId: string;
      threadId: string | null;
      messageId: string;
      suggestion: Record<string, unknown>;
    };

const INLINE_LIMIT = 6000;

export async function publishChannelEvent(pubsub: PubSub | undefined, event: ChannelEvent): Promise<void> {
  if (!pubsub) return;
  try {
    await pubsub.publish(channelTopic(event.channelId), event);
  } catch {
    // Real-time is best effort: clients catch up from the API on reconnect.
  }
}

export async function publishMessageCreated(pubsub: PubSub, message: MessageView) {
  const inline = Buffer.byteLength(JSON.stringify(message)) <= INLINE_LIMIT;
  await publishChannelEvent(pubsub, {
    type: "message.created",
    channelId: message.channelId,
    messageId: message.id,
    ...(inline ? { message } : {}),
  });
}

/** Receipts of a routed message (`message.routed`), then "thinking" for each run it started, where the message is. */
export async function publishRouted(
  pubsub: PubSub | undefined,
  message: { id: string; channelId: string; threadId: string | null },
  routed: {
    strategy: "mention" | "dm" | "router" | "none";
    seenBy: string[];
    runs: { id: string; agentId: string }[];
    reason?: string;
    decidedBy?: DecidedBy;
  } & Partial<ConnectIntent>,
) {
  const { strategy, seenBy, runs, reason, decidedBy, ...intent } = routed;
  await publishChannelEvent(pubsub, {
    type: "message.routed",
    channelId: message.channelId,
    messageId: message.id,
    seenBy,
    pickedBy: runs.map((r) => r.agentId),
    runs: runs.map((r) => ({ agentId: r.agentId, runId: r.id })),
    strategy,
    ...(reason ? { reason } : {}),
    ...(decidedBy ? { decidedBy } : {}),
    ...intent,
  });
  for (const run of runs) {
    await publishChannelEvent(pubsub, {
      type: "agent.thinking",
      channelId: message.channelId,
      threadId: message.threadId,
      agentId: run.agentId,
      runId: run.id,
    });
  }
}

/**
 * Organization events, consumed by the WebSocket server (not sent to clients
 * verbatim). A membership change drops the affected subscriptions at once
 * instead of waiting for a reconnect (docs/adr/0010-realtime.md).
 */
export type OrgEvent =
  /** `userId` left or was removed: from one channel (`channelId`), or from the whole organization. */
  | { type: "membership.revoked"; orgId: string; userId: string; channelId?: string }
  /** The channel is gone for everyone. */
  | { type: "channel.archived"; orgId: string; channelId: string }
  /** Something every member of the org may see (org-wide issues, calendar): forwarded as `scope: "org"`. */
  | { type: "org.broadcast"; orgId: string; event: { type: string; [key: string]: unknown } };

export async function publishOrgEvent(pubsub: PubSub | undefined, event: OrgEvent): Promise<void> {
  if (!pubsub) return;
  try {
    await pubsub.publish(orgTopic(event.orgId), event);
  } catch {
    // Best effort; access is still re-checked on every subscribe and HTTP request.
  }
}

/** An event for one person (forwarded to every connection they have open in that organization). */
export type UserEvent = { type: string; [key: string]: unknown };

export async function publishUserEvent(pubsub: PubSub | undefined, orgId: string, userId: string, event: UserEvent) {
  if (!pubsub) return;
  try {
    await pubsub.publish(userTopic(orgId, userId), event);
  } catch {}
}
