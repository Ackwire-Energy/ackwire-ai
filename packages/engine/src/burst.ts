import { and, type Database, eq, gte, isNull, schema, sql } from "@agenteschat/db";
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
  signal?: AbortSignal,
): Promise<void> {
  const author = trigger.authorUserId;
  if (!author || quietMs <= 0) return;
  // Parar or a shutdown drain ends the wait at once: the run frees its slot instead of sitting out the window.
  const aborted = signal
    ? new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    : null;
  const from = trigger.createdAt.getTime();
  const cap = from + quietMs * BURST_MAX_WINDOWS;
  for (;;) {
    if (signal?.aborted) return;
    // Message times come from the database's clock: the wait is measured on it too, never the app's.
    const [row] = await db
      .select({
        latest: sql<number>`extract(epoch from max(${messages.createdAt})) * 1000`.mapWith(Number),
        now: sql<number>`extract(epoch from clock_timestamp()) * 1000`.mapWith(Number),
      })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, trigger.orgId),
          eq(messages.channelId, trigger.channelId),
          trigger.threadId ? eq(messages.threadId, trigger.threadId) : isNull(messages.threadId),
          eq(messages.authorUserId, author),
          isNull(messages.deletedAt),
          gte(messages.createdAt, trigger.createdAt),
        ),
      );
    if (!row) return;
    const last = Math.max(from, row.latest || 0);
    const wait = Math.min(last + quietMs, cap) - row.now;
    if (wait <= 0) return;
    const nap = Bun.sleep(Math.min(wait, quietMs));
    await (aborted ? Promise.race([nap, aborted]) : nap);
  }
}
