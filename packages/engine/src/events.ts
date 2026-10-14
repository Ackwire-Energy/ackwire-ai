import { channelTopic, orgTopic, type PubSub, userTopic } from "@agenteschat/adapters";
import type { ApprovalView } from "./approvals";
import type { MessageView } from "./messages";
import type { RunStatus } from "./runs";

/**
 * Real-time events sent to WebSocket clients subscribed to a channel. The
 * database is the source of truth; events only tell clients what changed.
 * Documented for the web app in docs/adr/0010-realtime.md.
 */
export type ChannelEvent =
  /** A message was committed. `message` is omitted when too large for pub/sub: fetch it by id. */
  | { type: "message.created"; channelId: string; messageId: string; message?: MessageView }
  /** A fragment of an agent's reply while it is generated (not persisted; the final message follows). */
  | {
      type: "agent.delta";
      channelId: string;
      threadId: string;
      runId: string;
      agentId: string;
      seq: number;
      text: string;
    }
  /** An agent run changed state (`running` = typing indicator). */
  | {
      type: "agent.run";
      channelId: string;
      threadId: string;
      runId: string;
      agentId: string;
      status: RunStatus;
      error?: string;
    }
  /** A sensitive action waits for a person (`approval.created`) or was decided/expired (`approval.decided`). */
  | { type: "approval.created" | "approval.decided"; channelId: string; approval: ApprovalView };

const INLINE_LIMIT = 6000;

export async function publishChannelEvent(pubsub: PubSub, event: ChannelEvent): Promise<void> {
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
