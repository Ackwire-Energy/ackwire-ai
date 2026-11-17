import { and, asc, type Executor, eq, schema, sql } from "@agenteschat/db";
import { readableChannelIds } from "./channels";
import { cutText } from "./format";
import {
  inboxVisible,
  type NotificationActor,
  type NotificationDeps,
  type NotificationKind,
  type NotificationLatest,
  type NotificationSource,
} from "./notifications";
import { requirePermission } from "./organizations";

const { agents, notifications } = schema;

/**
 * "Esperando você" (ADR 0172): everything that waits on one person in a workspace, read from their inbox's waiting
 * rows. Each flow that blocks on a person already writes one there and resolves it when the wait ends (a question
 * answered, an approval decided, a secret given), so this is a view of the inbox and never a second record.
 */
export interface WaitingItem {
  /** The inbox row: the apps act on it (done, snooze) and open it as they open any notification. */
  id: string;
  kind: NotificationKind;
  /** Who asks: the agent or the person; null when the wait has no one behind it (a workspace's notice). */
  asker: NotificationActor | null;
  /** Where it was asked and what it opens (the inbox's own shape, read by every opener). */
  source: NotificationSource;
  /** What is asked, in one line. */
  question: string;
  since: string;
}

/** The most one list holds: a person with more waiting reads the oldest first. */
export const MAX_WAITING = 100;
const QUESTION_CHARS = 280;

/** A question is its own words; anything else leads with its name (the action, the secret) over the reason. */
const questionOf = (kind: string, latest: NotificationLatest) =>
  cutText(
    ((kind === "agent_question" ? latest.text : latest.title) ?? latest.text ?? latest.title ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    QUESTION_CHARS,
  );

/**
 * What waits on the person, oldest first, with how many. The inbox's rule decides what they still see (not done, not
 * snoozed, an approval only while they may decide it); an item asked in a conversation stays only while they can
 * still read that conversation. Two statements whatever the number of items.
 */
export async function listWaiting(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  options: { channelId?: string } = {},
): Promise<{ items: WaitingItem[]; count: number }> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "read");
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        inboxVisible(orgId, userId, deps.now?.() ?? new Date()),
        eq(notifications.waiting, true),
        options.channelId ? sql`${notifications.source}->>'channelId' = ${options.channelId}` : undefined,
      ),
    )
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .limit(MAX_WAITING);
  const asked = rows.flatMap((r) => (typeof r.source.channelId === "string" ? [r.source.channelId] : []));
  const readable = await readableChannelIds(db, orgId, userId, asked);
  const items = rows
    .filter((r) => typeof r.source.channelId !== "string" || readable.has(r.source.channelId))
    .map((r) => ({
      id: r.id,
      kind: r.kind as NotificationKind,
      asker: r.actors[0] ?? null,
      source: r.source as NotificationSource,
      question: questionOf(r.kind, r.latest as NotificationLatest),
      since: r.createdAt.toISOString(),
    }));
  return { items, count: items.length };
}

/** What another agent asked a person and still waits, as an agent's prompt reads it. */
export interface WaitingOnPerson {
  agentName: string;
  channelId: string | null;
  question: string;
}

const MAX_IN_PROMPT = 8;

/**
 * What other agents asked this person and nobody answered yet: one statement, read before a turn that may ask them
 * something more. This conversation's come first, then the oldest, so the cap never drops the ones the prompt quotes.
 */
export async function waitingOnPerson(
  db: Executor,
  orgId: string,
  userId: string,
  exceptAgentId: string,
  channelId: string,
): Promise<WaitingOnPerson[]> {
  const asker = sql`${notifications.actors}->0->>'id'`;
  const rows = await db
    .select({
      agentName: agents.name,
      kind: notifications.kind,
      source: notifications.source,
      latest: notifications.latest,
    })
    .from(notifications)
    .innerJoin(agents, and(eq(agents.orgId, notifications.orgId), sql`${agents.id}::text = ${asker}`))
    .where(
      and(
        inboxVisible(orgId, userId, new Date()),
        eq(notifications.waiting, true),
        sql`${notifications.actors}->0->>'type' = 'agent'`,
        sql`${asker} <> ${exceptAgentId}`,
      ),
    )
    .orderBy(
      sql`(${notifications.source}->>'channelId' is distinct from ${channelId})`,
      asc(notifications.createdAt),
      asc(notifications.id),
    )
    .limit(MAX_IN_PROMPT + 1);
  return rows.map((r) => ({
    agentName: r.agentName,
    channelId: typeof r.source.channelId === "string" ? r.source.channelId : null,
    question: questionOf(r.kind, r.latest as NotificationLatest),
  }));
}

/**
 * "# Already waiting on this person", read on a turn that may ask them something; null with nothing waiting. Only
 * what was asked in this conversation is quoted: the rest is counted, since the people here may not read where it
 * was asked.
 */
export function waitingOnPersonBlock(rows: WaitingOnPerson[], channelId: string): string | null {
  if (rows.length === 0) return null;
  const asked = rows.filter((r) => r.channelId === channelId);
  const here = asked.slice(0, MAX_IN_PROMPT);
  const elsewhere = rows.length - asked.length;
  const more = rows.length > MAX_IN_PROMPT ? "or more " : "";
  return [
    "# Already waiting on this person",
    "Other agents asked the person you answer for these, and nobody answered yet:",
    ...here.map((r) => `- ${r.agentName}, here: "${cutText(r.question, 200)}"`),
    // The read stops one past the cap, this conversation's first: past it, where the rest was asked is unknown.
    ...(asked.length > here.length ? ["- more, here or in other conversations"] : []),
    ...(elsewhere > 0 ? [`- ${elsewhere} ${more}in other conversations`] : []),
    "Don't pile a new question on these. If one of them already covers what you need, wait for its answer. If yours can wait, go on with what you can do and say what you need in your reply. Ask only what blocks you, in one question.",
  ].join("\n");
}
