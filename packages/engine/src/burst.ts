import { and, type Database, desc, eq, gt, isNull, schema } from "@agenteschat/db";
import type { Message } from "./messages";

const { messages } = schema;

/** However long a person keeps writing, a run started on their message waits at most this many quiet windows. */
export const BURST_MAX_WINDOWS = 4;

/**
 * People split one request over a few messages ("oi" / "preciso de uma coisa" / "olha o relatório de ontem"):
 * before its first model call, a run started on a person's message waits until that person has been quiet for
 * `quietMs` in the conversation (capped at `BURST_MAX_WINDOWS` windows from the trigger), so the messages that
 * joined its inbox meanwhile are read with the first one (ADR 0112). Measured from the messages' own times: a
 * run that starts late (a busy worker, the router's own wait) waits only what is left, usually nothing.
 */
export async function waitForBurst(
  db: Database,
  trigger: Pick<Message, "orgId" | "channelId" | "threadId" | "authorUserId" | "createdAt">,
  quietMs: number,
  now: () => number = Date.now,
): Promise<void> {
  const author = trigger.authorUserId;
  if (!author || quietMs <= 0) return;
  const cap = trigger.createdAt.getTime() + quietMs * BURST_MAX_WINDOWS;
  let last = trigger.createdAt;
  for (;;) {
    const wait = Math.min(last.getTime() + quietMs, cap) - now();
    if (wait <= 0) return;
    await Bun.sleep(wait);
    const [next] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, trigger.orgId),
          eq(messages.channelId, trigger.channelId),
          trigger.threadId ? eq(messages.threadId, trigger.threadId) : isNull(messages.threadId),
          eq(messages.authorUserId, author),
          isNull(messages.deletedAt),
          gt(messages.createdAt, last),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (!next) return;
    last = next.createdAt;
  }
}
