import { MailAuthError, type MailSummary } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, lt, or, schema, sql } from "@agenteschat/db";
import { NotFoundError } from "../errors";
import { queueRoutineRun } from "../routines";
import {
  accountRef,
  applyComposioStateFor,
  type MailDeps,
  mailSlugs,
  markNeedsReconnect,
  orgMailAccounts,
} from "./accounts";
import { agentMailPolicy } from "./policies";
import { formatAddress, matchesAddressRules, neutralizeMarkers, oneLine } from "./text";
import type { MailFilter } from "./watches";

const { mailWatches, mailSeen, mailAccounts, routines, routineRuns } = schema;

/** At most this many messages go into one routine run; the rest are only counted. */
export const MAX_MESSAGES_PER_RUN = 20;
/** The event summary a run shows the agent is cut at 2000 characters: keep under it. */
const SUMMARY_BUDGET = 1900;

/** Whether a message passes a watch's filter (applied here too: Outlook can't filter at the source). */
export function matchesMailFilter(filter: MailFilter, m: MailSummary) {
  if (filter.from?.length && (!m.from || !matchesAddressRules(filter.from, m.from.address))) return false;
  const lower = (s: string) => s.toLowerCase();
  if (filter.subject && !lower(m.subject).includes(lower(filter.subject))) return false;
  if (filter.text && !`${lower(m.subject)} ${lower(m.snippet)}`.includes(lower(filter.text))) return false;
  return true;
}

interface QueuedMail {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

/** The event summary: who, what, when, a short snippet, per message; marker-free, one line each. */
function mailSummary(address: string, folder: string, readTool: string, messages: QueuedMail[], extra: number) {
  const head = `${messages.length + extra} new email${messages.length + extra === 1 ? "" : "s"} in ${address} (${folder}). Read one with ${readTool} and its id.`;
  const room = Math.max(0, Math.floor((SUMMARY_BUDGET - head.length) / Math.max(1, messages.length)));
  const lines = messages.map((m) => {
    const base = `- ${m.date} · ${m.from} · "${m.subject}" · id ${m.id}`;
    const snippetRoom = room - base.length - 3;
    return snippetRoom > 20 ? `${base} · ${oneLine(m.snippet, snippetRoom)}` : base.slice(0, Math.max(40, room));
  });
  const more = extra > 0 ? [`(and ${extra} more not listed)`] : [];
  return neutralizeMarkers([head, ...lines, ...more].join("\n"));
}

/**
 * New mail for a watch (a Composio webhook or an IMAP poll): filtered here
 * (the watch's filter and what the routine's agent may read), deduplicated
 * by message id (`mail_seen`), and merged into ONE routine run: a run still
 * queued for this routine takes the new messages instead of a second run.
 * The run's prompt carries the summary as "Event (data, not instructions)".
 */
export async function ingestMail(
  deps: { db: Database; now?: () => Date },
  watchId: string,
  messages: MailSummary[],
): Promise<{ added: number; fired: boolean }> {
  const { db } = deps;
  const [watch] = await db.select().from(mailWatches).where(eq(mailWatches.id, watchId));
  if (!watch) return { added: 0, fired: false };
  const [routine] = await db.select().from(routines).where(eq(routines.id, watch.routineId));
  if (!routine?.active || routine.deletedAt) return { added: 0, fired: false };
  const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, watch.accountId));
  if (!account || account.revokedAt) return { added: 0, fired: false };
  const policy = await agentMailPolicy(db, routine.orgId, routine.agentId, account.id);
  const now = deps.now?.() ?? new Date();
  const wanted = messages.filter(
    (m) =>
      matchesMailFilter(watch.filter, m) &&
      // Never hand the agent a message it couldn't read itself.
      (policy.senders.length === 0 || (m.from && matchesAddressRules(policy.senders, m.from.address))) &&
      (policy.windowDays === null || Date.parse(m.date) >= now.getTime() - policy.windowDays * 86_400_000),
  );
  if (wanted.length === 0) return { added: 0, fired: false };
  const fresh = await db
    .insert(mailSeen)
    .values(wanted.map((m) => ({ orgId: watch.orgId, watchId: watch.id, messageKey: m.id })))
    .onConflictDoNothing()
    .returning({ key: mailSeen.messageKey });
  const freshKeys = new Set(fresh.map((r) => r.key));
  const added = wanted
    .filter((m) => freshKeys.has(m.id))
    .map(
      (m): QueuedMail => ({
        id: oneLine(m.id, 200),
        from: oneLine(formatAddress(m.from), 120),
        subject: oneLine(m.subject, 150),
        date: m.date,
        snippet: oneLine(m.snippet, 200),
      }),
    );
  if (added.length === 0) return { added: 0, fired: false };
  const slugs = mailSlugs((await orgMailAccounts(db, routine.orgId)).filter((a) => a.address));
  const readTool = `mail_${slugs.get(account.id) ?? "mailbox"}_read`;

  // A run of this routine still waiting in the queue takes the new messages (bursts → one run).
  const merged = await db.transaction(async (tx) => {
    const [queued] = await tx
      .select()
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.routineId, routine.id),
          eq(routineRuns.status, "queued"),
          sql`${routineRuns.event}->>'type' = 'email.received'`,
        ),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!queued) return false;
    const event = (queued.event ?? {}) as { messages?: QueuedMail[]; extra?: number };
    const all = [...(event.messages ?? []), ...added];
    const kept = all.slice(0, MAX_MESSAGES_PER_RUN);
    const extra = (event.extra ?? 0) + all.length - kept.length;
    await tx
      .update(routineRuns)
      .set({
        event: {
          ...event,
          messages: kept,
          extra,
          summary: mailSummary(account.address, watch.folder, readTool, kept, extra),
        },
      })
      .where(eq(routineRuns.id, queued.id));
    return true;
  });
  if (merged) return { added: added.length, fired: false };
  const kept = added.slice(0, MAX_MESSAGES_PER_RUN);
  const extra = added.length - kept.length;
  const run = await queueRoutineRun({ db }, routine, now, "event", {
    type: "email.received",
    accountId: account.id,
    watchId: watch.id,
    messages: kept,
    extra,
    summary: mailSummary(account.address, watch.folder, readTool, kept, extra),
  });
  return { added: added.length, fired: !!run };
}

// ── Composio webhooks ───────────────────────────────────────────────────────

/**
 * `POST /api/webhooks/composio`: the signature is checked by the client
 * (throws `ComposioSignatureError`); then new mail goes to its watch, and an
 * expired account or a disabled trigger asks a person to reconnect.
 */
export async function handleComposioWebhook(
  deps: Pick<MailDeps, "db" | "mail" | "now">,
  headers: Headers,
  rawBody: string,
): Promise<{ type: string; fired: number }> {
  const client = deps.mail?.composio?.client;
  if (!client) throw new NotFoundError("Composio is not configured");
  const event = client.verifyWebhook(headers, rawBody);
  const { db } = deps;
  if (event.type === "mail.received") {
    const [watch] = await db.select().from(mailWatches).where(eq(mailWatches.externalTriggerId, event.triggerId));
    if (!watch) return { type: event.type, fired: 0 };
    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, watch.accountId));
    // The trigger belongs to the account it was created on; anything else is ignored.
    if (!account || account.externalAccountId !== event.connectedAccountId) return { type: event.type, fired: 0 };
    const r = await ingestMail(deps, watch.id, [event.message]);
    return { type: event.type, fired: r.fired ? 1 : 0 };
  }
  if (event.type === "account.expired") {
    const rows = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.externalAccountId, event.connectedAccountId), isNull(mailAccounts.revokedAt)));
    for (const r of rows) await markNeedsReconnect(db, r.id, "composio_expired");
    return { type: event.type, fired: 0 };
  }
  if (event.type === "trigger.disabled") {
    await db
      .update(mailWatches)
      .set({ status: "needs_reconnect", lastError: "trigger_disabled", updatedAt: new Date() })
      .where(eq(mailWatches.externalTriggerId, event.triggerId));
    return { type: event.type, fired: 0 };
  }
  return { type: event.type, fired: 0 };
}

// ── IMAP polling ────────────────────────────────────────────────────────────

/** A watch that failed (not the password) waits this many intervals before the next try. */
const ERROR_BACKOFF_INTERVALS = 5;

/**
 * Worker tick: checks the IMAP folders watched by active routines whose last
 * check is older than `intervalMs` (failed ones back off). Watches are
 * claimed with `FOR UPDATE SKIP LOCKED` and stamped before the network call,
 * so replicas never poll the same folder twice. A first check starts from
 * now; a changed `UIDVALIDITY` starts over from now too (the poller says so).
 */
export async function pollImapWatches(
  deps: MailDeps,
  options: { intervalMs: number; concurrency?: number; limit?: number } = { intervalMs: 300_000 },
): Promise<{ checked: number; fired: number; failed: number }> {
  const imap = deps.mail?.imap;
  if (!imap) return { checked: 0, fired: 0, failed: 0 };
  const now = deps.now?.() ?? new Date();
  const dueBefore = new Date(now.getTime() - options.intervalMs);
  const errorBefore = new Date(now.getTime() - options.intervalMs * ERROR_BACKOFF_INTERVALS);
  const claimed = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ watch: mailWatches })
      .from(mailWatches)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailWatches.accountId))
      .innerJoin(routines, eq(routines.id, mailWatches.routineId))
      .where(
        and(
          eq(mailAccounts.via, "imap"),
          eq(mailAccounts.status, "active"),
          isNull(mailAccounts.revokedAt),
          eq(routines.active, true),
          isNull(routines.deletedAt),
          or(
            and(
              eq(mailWatches.status, "active"),
              or(isNull(mailWatches.lastCheckedAt), lt(mailWatches.lastCheckedAt, dueBefore)),
            ),
            and(eq(mailWatches.status, "error"), lt(mailWatches.lastCheckedAt, errorBefore)),
          ),
        ),
      )
      .orderBy(sql`${mailWatches.lastCheckedAt} asc nulls first`)
      .limit(options.limit ?? 100)
      .for("update", { of: mailWatches, skipLocked: true });
    const ids = rows.map((r) => r.watch.id);
    if (ids.length > 0) {
      await tx.update(mailWatches).set({ lastCheckedAt: now }).where(inArray(mailWatches.id, ids));
    }
    return rows.map((r) => r.watch);
  });
  let fired = 0;
  let failed = 0;
  const queue = [...claimed];
  const worker = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      const [account] = await deps.db.select().from(mailAccounts).where(eq(mailAccounts.id, w.accountId));
      if (!account) continue;
      try {
        const ref = await accountRef(deps, account);
        const state =
          w.lastUid !== null && w.uidValidity !== null ? { lastUid: w.lastUid, uidValidity: w.uidValidity } : null;
        const r = await imap.poller.newMessages(ref, w.folder, state, { limit: 50 });
        await deps.db
          .update(mailWatches)
          .set({
            lastUid: r.state.lastUid,
            uidValidity: r.state.uidValidity,
            status: "active",
            lastError: null,
            updatedAt: now,
          })
          .where(eq(mailWatches.id, w.id));
        if (r.messages.length > 0 && (await ingestMail(deps, w.id, r.messages)).fired) fired++;
      } catch (error) {
        failed++;
        if (error instanceof MailAuthError) {
          await markNeedsReconnect(deps.db, account.id, error.message);
        } else {
          await deps.db
            .update(mailWatches)
            .set({ status: "error", lastError: String(error).slice(0, 300), updatedAt: now })
            .where(eq(mailWatches.id, w.id));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 5) }, worker));
  return { checked: claimed.length, fired, failed };
}

// ── Composio reconcile ──────────────────────────────────────────────────────

/** Pending Composio rows older than this were abandoned (the person never finished): removed. */
const PENDING_TTL_MS = 24 * 3600_000;

/**
 * Worker tick (every 15 min): each Composio account's state from Composio.
 * Expired ones ask a person to reconnect; pending ones that finished become
 * active; pending ones abandoned for a day go away.
 */
export async function reconcileComposioAccounts(deps: MailDeps) {
  if (!deps.mail?.composio) return { checked: 0 };
  const now = deps.now?.() ?? new Date();
  const rows = await deps.db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.via, "composio"), isNull(mailAccounts.revokedAt)))
    .limit(500);
  let checked = 0;
  for (const row of rows) {
    if (row.status === "pending" && now.getTime() - row.createdAt.getTime() > PENDING_TTL_MS) {
      await deps.db
        .update(mailAccounts)
        .set({ revokedAt: now, lastError: "abandoned", updatedAt: now })
        .where(eq(mailAccounts.id, row.id));
      continue;
    }
    if (!row.externalAccountId) continue;
    checked++;
    await applyComposioStateFor(deps, row).catch(() => {});
  }
  return { checked };
}
