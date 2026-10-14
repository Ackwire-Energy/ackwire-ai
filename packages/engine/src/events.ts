import { channelTopic, orgTopic, type PubSub, userTopic } from "@agenteschat/adapters";
import type { ApprovalView } from "./approvals";
import type { MessageView } from "./messages";

/** What a memory tool changed, for the "memória atualizada" card (persisted in the reply's `meta.memoryUpdates`). */
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
}

import type { AgentQuestion } from "./questions";
import type { RunStatus } from "./runs";

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
    }
  /** An agent run changed state (`running` = typing indicator). */
  | {
      type: "agent.run";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      status: RunStatus;
      error?: string;
    }
  /**
   * An agent will answer (mention, DM, router pick, or a run was claimed):
   * show "thinking" right away. `runId` is null when announced at post time,
   * before the run exists.
   */
  | { type: "agent.thinking"; channelId: string; threadId: string | null; agentId: string; runId: string | null }
  /** The agent's first words arrived (switch "thinking" to "typing"). */
  | { type: "agent.typing"; channelId: string; threadId: string | null; agentId: string; runId: string }
  /** The agent stopped (done, failed or waiting for approval). */
  | { type: "agent.idle"; channelId: string; threadId: string | null; agentId: string; runId: string }
  | {
      type: "run.finished";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      status: "done" | "failed" | "waiting_approval" | "waiting_input";
      error?: string;
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
      strategy: "mention" | "dm" | "router" | "none";
      reason?: string;
    }
  | { type: "message.claimed"; channelId: string; messageId: string; agentId: string; runId: string }
  | {
      type: "message.handled";
      channelId: string;
      messageId: string;
      agentId: string;
      runId: string;
      status: "done" | "failed" | "waiting_approval" | "waiting_input";
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
  /** Channel membership changed (agents carry `autoReply`). */
  | {
      type: "channel.member_added" | "channel.member_removed" | "channel.member_updated";
      channelId: string;
      member: { type: "person" | "agent"; id: string; autoReply?: boolean };
    }
  /** A sensitive action waits for a person (`approval.created`) or was decided/expired (`approval.decided`). */
  | { type: "approval.created" | "approval.decided"; channelId: string; approval: ApprovalView };

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

/**
 * Organization events, consumed by the WebSocket server (not sent to clients
 * verbatim). A membership change drops the affected subscriptions at once
 * instead of waiting for a reconnect (docs/adr/0010-realtime.md).
 */
export type OrgEvent =
  /** `userId` left or was removed: from one channel (`channelId`), or from the whole organization. */
  | { type: "membership.revoked"; orgId: string; userId: string; channelId?: string }
  /** The channel is gone for everyone. */
  | { type: "channel.archived"; orgId: string; channelId: string };

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
