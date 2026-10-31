import { and, type Database, desc, type Executor, eq, inArray, lt, ne, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import type { RunAuthority } from "./authority";
import { requirePermission } from "./organizations";
import { redactCredentials as masked } from "./tool-detail";

const { auditLog, agents, approvals, channels, secretRequests, users } = schema;

/**
 * The audit of what agents do: every tool call that matters, written by the
 * Tool Gateway on every brain as one `tool.call` row in `audit_log` (with the
 * run, its conversation, the person behind it and how it ended), next to what
 * people change. Admins read it all (`listAudit`).
 */

export const TOOL_CALL = "tool.call";

const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;
const MAX_STRING = 500;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;
const MAX_INPUT = 4000;

/**
 * A call's input as the audit keeps it: values under secret-looking keys
 * dropped, credentials masked in every string, long strings and lists cut.
 * Enough to tell what the agent did (to whom, which repository, what title),
 * never a key someone could use.
 */
export function auditInput(input: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      const text = masked(value);
      return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text;
    }
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_DEPTH) return "…";
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((v) => clean(v, depth + 1));
      return value.length > MAX_ITEMS ? [...items, `… ${value.length - MAX_ITEMS} more`] : items;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "***" : clean(v, depth + 1),
      ]),
    );
  };
  const out = clean(input, 0) as Record<string, unknown>;
  const text = JSON.stringify(out);
  return text.length > MAX_INPUT ? { cut: `${text.slice(0, MAX_INPUT)}…` } : out;
}

/**
 * Which calls the audit keeps. Every refusal and failure; of the rest, what
 * changes or sends something, a connected app's reads (someone's data), and
 * the computer's commands. Not looking around inside the workspace (search,
 * reading a channel), a directory's search or `pass`: they would bury the rest.
 */
export function auditsCall(
  kind: string,
  tool: { connectionId?: string | null },
  outcome: schema.AuditOutcome,
): boolean {
  if (outcome === "refused" || outcome === "failed") return kind !== "directory";
  if (kind === "read") return Boolean(tool.connectionId);
  return kind !== "directory" && kind !== "pass" && kind !== "self" && kind !== "here";
}

const MAX_TITLE = 200;

/** The call in words, as its approval card says it ("Sentry: List issues"); null when the tool has none. */
export function callTitle(
  tool: { describe?: (input: Record<string, unknown>) => { title: string } },
  input: Record<string, unknown>,
): string | null {
  try {
    return tool.describe?.(input).title ?? null;
  } catch {
    return null;
  }
}

/** One tool call an agent made (see `auditsCall`). Never fails the call. */
export async function recordToolCall(
  db: Executor,
  call: {
    orgId: string;
    agentId: string;
    runId: string | null;
    channelId: string | null;
    authority: RunAuthority | null;
    tool: string;
    /** `toolKind`'s kind (`external`, `internal`, `computer`…). */
    kind: string;
    connector?: string | null;
    /** `callTitle`, or an approval's title. */
    title?: string | null;
    input: Record<string, unknown>;
    outcome: schema.AuditOutcome;
    /** Why it was refused or failed, or the agent's `why` for an approval. */
    reason?: string | null;
    approvalId?: string | null;
    /** A call waiting for a person's secret (`request_secret`): the request. */
    secretRequestId?: string | null;
  },
) {
  await recordAudit(db, {
    orgId: call.orgId,
    actor: { type: "agent", id: call.agentId },
    action: TOOL_CALL,
    target: { type: "tool", id: call.tool },
    details: {
      kind: call.kind,
      ...(call.connector ? { connector: call.connector } : {}),
      ...(call.title ? { title: masked(call.title).slice(0, MAX_TITLE) } : {}),
      behind: call.authority?.kind ?? null,
      ...(call.authority?.kind === "routine" && call.authority.brief
        ? { routine: { id: call.authority.brief.routineId, name: call.authority.brief.name } }
        : {}),
      input: auditInput(call.input),
      ...(call.reason ? { reason: masked(call.reason).slice(0, MAX_STRING) } : {}),
      ...(call.approvalId ? { approvalId: call.approvalId } : {}),
      ...(call.secretRequestId ? { secretRequestId: call.secretRequestId } : {}),
    },
    runId: call.runId,
    channelId: call.channelId,
    onBehalfOfUserId: call.authority?.personId ?? null,
    outcome: call.outcome,
  }).catch(() => {});
}

// ── Reading it ────────────────────────────────────────────────────────────

/**
 * Rows a tool writes about itself while the gateway records the same call (`tool.call`): the reader leaves
 * them out so one action is one row. They stay in the table for whoever reads it raw.
 */
const TOOL_CALL_ECHOES = [
  "message.posted_elsewhere",
  "message.sent_dm",
  "secret.requested",
  "desktop.app_opened",
  "desktop.file_opened",
];
/** A mailbox tool's own rows (`mail.sent`, `mail.archive`…), echoes too. */
const MAIL_ECHO = "mail.%";

export type AuditActorType = "person" | "agent" | "system";

export interface AuditFilter {
  actorType?: AuditActorType;
  /** An agent's or a person's id. */
  actorId?: string;
  /** Any of these endings (`refused` and `failed` together: what went wrong). */
  outcome?: schema.AuditOutcome[];
  /** Only calls whose approval nobody has answered yet. */
  waiting?: boolean;
  /** `tool`: agents' tool calls only; `change`: everything else. */
  kind?: "tool" | "change";
  /** Rows older than this id (ids grow with time): the next page. */
  before?: string;
  limit?: number;
}

export interface AuditRow {
  id: string;
  at: string;
  actor: { type: AuditActorType; id: string | null; name: string | null };
  action: string;
  target: { type: string; id: string | null };
  details: Record<string, unknown>;
  runId: string | null;
  channelId: string | null;
  /** Where it happened; null when there is no conversation or it was deleted. */
  channel: { id: string; name: string; kind: "channel" | "dm" | "forum" } | null;
  onBehalfOf: { id: string; name: string | null } | null;
  outcome: schema.AuditOutcome | null;
  /** The approval a call waited for (or ran after), as it stands now: a `pending` row may be decided since. */
  approval: { id: string; status: string; decidedBy: { id: string; name: string | null } | null } | null;
  /** The secret a call waited for, as it stands now (`pending`, `delivered`, `declined`, `expired`, `canceled`). */
  secret: { id: string; status: (typeof schema.secretRequestStatusEnum.enumValues)[number] } | null;
}

export const AUDIT_PAGE = 50;
export const AUDIT_PAGE_MAX = 200;

/**
 * The org's audit log, newest first, for admins (`configure`): what people
 * changed and what agents did, with names (an agent or person since removed
 * keeps its id and a null name).
 */
export async function listAudit(
  db: Database,
  actorId: string,
  orgId: string,
  filter: AuditFilter = {},
): Promise<{ rows: AuditRow[]; next: string | null }> {
  await requirePermission(db, actorId, orgId, "view_audit");
  const limit = Math.min(Math.max(filter.limit ?? AUDIT_PAGE, 1), AUDIT_PAGE_MAX);
  const found = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, orgId),
        filter.actorType ? eq(auditLog.actorType, filter.actorType) : undefined,
        filter.actorId ? eq(auditLog.actorId, filter.actorId) : undefined,
        filter.outcome?.length ? inArray(auditLog.outcome, filter.outcome) : undefined,
        filter.waiting
          ? and(
              eq(auditLog.outcome, "pending"),
              sql`(exists (select 1 from ${approvals} where ${approvals.orgId} = ${auditLog.orgId}
                and ${approvals.id}::text = ${auditLog.details}->>'approvalId' and ${approvals.status} = 'pending')
              or exists (select 1 from ${secretRequests} where ${secretRequests.orgId} = ${auditLog.orgId}
                and ${secretRequests.id}::text = ${auditLog.details}->>'secretRequestId'
                and ${secretRequests.status} = 'pending'))`,
            )
          : undefined,
        sql`not (${auditLog.actorType} = 'agent' and (${inArray(auditLog.action, TOOL_CALL_ECHOES)}
          or ${auditLog.action} like ${MAIL_ECHO}))`,
        filter.kind === "tool" ? eq(auditLog.action, TOOL_CALL) : undefined,
        filter.kind === "change" ? ne(auditLog.action, TOOL_CALL) : undefined,
        filter.before ? lt(auditLog.id, filter.before) : undefined,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const page = found.slice(0, limit);

  const approvalOf = (r: (typeof page)[number]) =>
    typeof r.details.approvalId === "string" ? r.details.approvalId : null;
  const secretOf = (r: (typeof page)[number]) =>
    typeof r.details.secretRequestId === "string" ? r.details.secretRequestId : null;
  const ids = (of: (r: (typeof page)[number]) => string | null) => [
    ...new Set(page.map(of).filter((id): id is string => Boolean(id))),
  ];
  const approvalIds = ids(approvalOf);
  const secretIds = ids(secretOf);
  const channelIds = ids((r) => r.channelId);
  const [approvalRows, secretRows, channelRows] = await Promise.all([
    approvalIds.length
      ? db
          .select({ id: approvals.id, status: approvals.status, decidedBy: approvals.decidedByUserId })
          .from(approvals)
          .where(and(eq(approvals.orgId, orgId), inArray(approvals.id, approvalIds)))
      : Promise.resolve([]),
    secretIds.length
      ? db
          .select({ id: secretRequests.id, status: secretRequests.status })
          .from(secretRequests)
          .where(and(eq(secretRequests.orgId, orgId), inArray(secretRequests.id, secretIds)))
      : Promise.resolve([]),
    channelIds.length
      ? db
          .select({ id: channels.id, name: channels.name, kind: channels.kind })
          .from(channels)
          .where(and(eq(channels.orgId, orgId), inArray(channels.id, channelIds)))
      : Promise.resolve([]),
  ]);
  const approvalById = new Map(approvalRows.map((a) => [a.id, a]));
  const secretById = new Map(secretRows.map((s) => [s.id, s]));
  const channelById = new Map(channelRows.map((c) => [c.id, c]));

  const agentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of page) {
    if (r.actorType === "agent" && r.actorId) agentIds.add(r.actorId);
    if (r.actorType === "person" && r.actorId) userIds.add(r.actorId);
    if (r.onBehalfOfUserId) userIds.add(r.onBehalfOfUserId);
  }
  for (const a of approvalRows) if (a.decidedBy) userIds.add(a.decidedBy);
  const [agentRows, userRows] = await Promise.all([
    agentIds.size
      ? db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.id, [...agentIds])))
      : Promise.resolve([]),
    userIds.size
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, [...userIds]))
      : Promise.resolve([]),
  ]);
  const agentName = new Map(agentRows.map((a) => [a.id, a.name]));
  const userName = new Map(userRows.map((u) => [u.id, u.name]));
  const nameOf = (type: string, id: string | null) =>
    id ? ((type === "agent" ? agentName.get(id) : type === "person" ? userName.get(id) : undefined) ?? null) : null;

  return {
    rows: page.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      actor: { type: r.actorType as AuditActorType, id: r.actorId, name: nameOf(r.actorType, r.actorId) },
      action: r.action,
      target: { type: r.targetType, id: r.targetId },
      // A tool call's input was cleaned when it was written; the rest (a server's address, a database's
      // host…) is cleaned here, as it leaves.
      details: r.action === TOOL_CALL ? r.details : auditInput(r.details),
      runId: r.runId,
      channelId: r.channelId,
      channel: (r.channelId && channelById.get(r.channelId)) || null,
      onBehalfOf: r.onBehalfOfUserId
        ? { id: r.onBehalfOfUserId, name: userName.get(r.onBehalfOfUserId) ?? null }
        : null,
      outcome: r.outcome ?? null,
      approval: (() => {
        const a = approvalById.get(approvalOf(r) ?? "");
        if (!a) return null;
        return {
          id: a.id,
          status: a.status,
          decidedBy: a.decidedBy ? { id: a.decidedBy, name: userName.get(a.decidedBy) ?? null } : null,
        };
      })(),
      secret: secretById.get(secretOf(r) ?? "") ?? null,
    })),
    next: found.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
