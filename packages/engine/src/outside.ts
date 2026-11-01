import { and, desc, type Executor, eq, isNull, or, schema, sql } from "@agenteschat/db";
import { type AuthorityRun, fedByRoutine, type RunAuthority, runAuthority } from "./authority";

const { agentRuns, agentRunSteps, messages } = schema;

/**
 * A computer brain's own calls that read from outside (`transcript.harnessTried` lines, `callLine`): Claude Code's
 * WebFetch and WebSearch, and a command that starts with curl, wget or gh.
 */
const HARNESS_OUTSIDE = /^(?:WebFetch|WebSearch)\b|^\w+\(\s*(?:curl|wget|gh)\s/;

export type OutsideRun = AuthorityRun;

/**
 * Whether a run read content from outside the org (ADR 0117): a routine's reading feeds it, the message that woke
 * it (or its thread's root) relays outside content, one of its tool results came from outside (the gateway's
 * `outside` mark), or its computer brain fetched the web itself. What such a run posts carries
 * `meta.readOutside`, so the next agent reads it as relayed and memory built from it stays low trust. It
 * never stops, asks or refuses anything by itself.
 */
export async function runReadOutside(db: Executor, run: OutsideRun, authority?: RunAuthority): Promise<boolean> {
  if (fedByRoutine(authority ?? (await runAuthority(db, run)))) return true;
  const tried = run.transcript?.harnessTried;
  if (Array.isArray(tried) && tried.some((l) => typeof l === "string" && HARNESS_OUTSIDE.test(l))) return true;
  const [trigger] = await db
    .select({ meta: messages.meta, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
  if (trigger?.meta.readOutside === true) return true;
  if (trigger?.threadId) {
    const [root] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.orgId, run.orgId), eq(messages.id, trigger.threadId)));
    if (root?.meta.readOutside === true) return true;
  }
  const [step] = await db
    .select({ id: agentRunSteps.id })
    .from(agentRunSteps)
    .where(
      and(
        eq(agentRunSteps.runId, run.id),
        eq(agentRunSteps.kind, "tool_result"),
        sql`${agentRunSteps.data}->'data'->>'outside' = 'true'`,
      ),
    )
    .limit(1);
  return Boolean(step);
}

/** `runReadOutside` by the tool context's run id (false when the run is gone). */
export async function runReadOutsideById(db: Executor, orgId: string, runId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return false;
  const [run] = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      triggerMessageId: agentRuns.triggerMessageId,
      background: agentRuns.background,
      transcript: agentRuns.transcript,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  return run ? runReadOutside(db, run) : false;
}

/** The refusal code of a remembered rule naming an address no person wrote (`remember`). */
export const UNASKED_DESTINATION = "memory.unasked_destination";

/** How many of a conversation's newest person messages `personWords` reads. */
const PERSON_WORDS_LIMIT = 200;

/**
 * What people wrote in a conversation (its thread and the channel's top level), newest first, joined: an address,
 * handle or credential found here was written by a person, not read from outside.
 */
export async function personWords(
  db: Executor,
  orgId: string,
  channelId: string,
  threadId: string | null,
): Promise<string> {
  const rows = await db
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.channelId, channelId),
        eq(messages.authorType, "person"),
        isNull(messages.deletedAt),
        threadId
          ? or(isNull(messages.threadId), eq(messages.id, threadId), eq(messages.threadId, threadId))
          : isNull(messages.threadId),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(PERSON_WORDS_LIMIT);
  return rows.map((r) => r.body).join("\n");
}

const URL_HOST = /\b(?:https?:\/\/|www\.)([a-z0-9.-]+\.[a-z]{2,})|\b((?:[a-z0-9-]+\.)+[a-z]{2,})\/[^\s]*/gi;
const EMAIL = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const HANDLE = /(?<![\w.@])@([a-z0-9_][\w-]*)/gi;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const digits = (s: string) => s.replace(/\D/g, "");

/**
 * The first address in `text` (a URL's host, an email address, an @handle, a phone number) that appears nowhere in
 * `words` (what people wrote, `personWords`), or null. Compared without case; a phone by its digits.
 */
export function unaskedDestination(text: string, words: string): string | null {
  const said = words.toLowerCase();
  const saidDigits = digits(words);
  for (const m of text.matchAll(EMAIL)) if (!said.includes(m[0].toLowerCase())) return m[0];
  const noEmails = text.replace(EMAIL, " ");
  for (const m of noEmails.matchAll(URL_HOST)) {
    const host = (m[1] ?? m[2] ?? "").replace(/\.$/, "");
    if (host && !said.includes(host.toLowerCase())) return host;
  }
  for (const m of noEmails.matchAll(HANDLE)) if (!said.includes((m[1] ?? "").toLowerCase())) return m[0];
  for (const m of noEmails.matchAll(PHONE)) {
    const d = digits(m[0]);
    if (d.length >= 8 && !saidDigits.includes(d)) return m[0].trim();
  }
  return null;
}
