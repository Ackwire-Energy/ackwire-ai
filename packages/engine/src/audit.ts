import { type Executor, schema } from "@agenteschat/db";

export interface AuditEntry {
  orgId: string;
  actor: { type: "person" | "agent" | "system"; id: string | null };
  /** e.g. `storage.activated`, `artifact.version_created`. */
  action: string;
  target: { type: string; id: string | null };
  /** Never secrets: hints at most. */
  details?: Record<string, unknown>;
}

/** Appends to the org's audit log (in the caller's transaction when given one). */
export async function recordAudit(db: Executor, entry: AuditEntry) {
  await db.insert(schema.auditLog).values({
    orgId: entry.orgId,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    action: entry.action,
    targetType: entry.target.type,
    targetId: entry.target.id,
    details: entry.details ?? {},
  });
}
