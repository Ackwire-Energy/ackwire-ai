import { redactCommon } from "@agenteschat/adapters/redact";
import { and, type Database, desc, eq, type Executor, inArray, lt, ne, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import type { RunAuthority } from "./authority";
import { requirePermission } from "./organizations";
import { maskCredentials } from "./tool-detail";

const { auditLog, agents, users } = schema;

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

const masked = (text: string) => redactCommon(maskCredentials(text));

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
  return kind !== "directory" && kind !== "pass" && kind !== "here";
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
    input: Record<string, unknown>;
    outcome: schema.AuditOutcome;
    /** Why it was refused or failed, or the agent's `why` for an approval. */
    reason?: string | null;
    approvalId?: string | null;
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
      behind: call.authority?.kind ?? null,
      input: auditInput(call.input),
      ...(call.reason ? { reason: masked(call.reason).slice(0, MAX_STRING) } : {}),
      ...(call.approvalId ? { approvalId: call.approvalId } : {}),
    },
    runId: call.runId,
    channelId: call.channelId,
    onBehalfOfUserId: call.authority?.personId ?? null,
    outcome: call.outcome,
  }).catch(() => {});
}

// ── Reading it ────────────────────────────────────────────────────────────

export type AuditActorType = "person" | "agent" | "system";

export interface AuditFilter {
  actorType?: AuditActorType;
  /** An agent's or a person's id. */
  actorId?: string;
  outcome?: schema.AuditOutcome;
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
  onBehalfOf: { id: string; name: string | null } | null;
  outcome: schema.AuditOutcome | null;
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
  await requirePermission(db, actorId, orgId, "configure");
  const limit = Math.min(Math.max(filter.limit ?? AUDIT_PAGE, 1), AUDIT_PAGE_MAX);
  const found = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, orgId),
        filter.actorType ? eq(auditLog.actorType, filter.actorType) : undefined,
        filter.actorId ? eq(auditLog.actorId, filter.actorId) : undefined,
        filter.outcome ? eq(auditLog.outcome, filter.outcome) : undefined,
        filter.kind === "tool" ? eq(auditLog.action, TOOL_CALL) : undefined,
        filter.kind === "change" ? ne(auditLog.action, TOOL_CALL) : undefined,
        filter.before ? lt(auditLog.id, filter.before) : undefined,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const page = found.slice(0, limit);

  const agentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of page) {
    if (r.actorType === "agent" && r.actorId) agentIds.add(r.actorId);
    if (r.actorType === "person" && r.actorId) userIds.add(r.actorId);
    if (r.onBehalfOfUserId) userIds.add(r.onBehalfOfUserId);
  }
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
      details: r.details,
      runId: r.runId,
      channelId: r.channelId,
      onBehalfOf: r.onBehalfOfUserId
        ? { id: r.onBehalfOfUserId, name: userName.get(r.onBehalfOfUserId) ?? null }
        : null,
      outcome: r.outcome ?? null,
    })),
    next: found.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
