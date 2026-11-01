import { createHash } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNotNull, schema } from "@agenteschat/db";
import { caches } from "../cache";
import { NotFoundError } from "../errors";
import { notifyToolChanged, resolveToolChanged } from "../notification-producers";
import { requirePermission } from "../organizations";
import { canonicalJson } from "../tools/json-schema";
import type { ConnectorConnection } from "./connections";
import type { McpTool } from "./mcp";

const pins = schema.connectorToolPins;

export const toolFingerprint = (t: { description?: string | null; inputSchema?: unknown }) =>
  createHash("sha256")
    .update(canonicalJson({ description: t.description ?? "", inputSchema: t.inputSchema ?? {} }))
    .digest("hex");

/**
 * The tools as the model may see them (ADR 0117): each `pinned` tool's description and schema as first listed. A
 * tool listed for the first time is pinned as is; one the server changed since keeps its pinned text, its new
 * version waits for an admin (`pending_*`), and the workspace's connector admins hear it once. The tool stays
 * callable either way.
 */
export async function applyToolPins(
  deps: { db: Database; pubsub?: PubSub },
  connection: Pick<ConnectorConnection, "id" | "orgId" | "label">,
  tools: McpTool[],
  pinned: (name: string) => boolean,
): Promise<McpTool[]> {
  const names = tools.filter((t) => pinned(t.name)).map((t) => t.name);
  if (names.length === 0) return tools;
  const rows = await deps.db
    .select()
    .from(pins)
    .where(and(eq(pins.orgId, connection.orgId), eq(pins.connectionId, connection.id), inArray(pins.toolName, names)));
  const byName = new Map(rows.map((r) => [r.toolName, r]));
  const fresh: (typeof pins.$inferInsert)[] = [];
  const changed: { name: string; fingerprint: string }[] = [];
  const out: McpTool[] = [];
  for (const tool of tools) {
    if (!pinned(tool.name)) {
      out.push(tool);
      continue;
    }
    const fingerprint = toolFingerprint(tool);
    const pin = byName.get(tool.name);
    if (!pin) {
      fresh.push({
        orgId: connection.orgId,
        connectionId: connection.id,
        toolName: tool.name,
        fingerprint,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? {},
      });
      out.push(tool);
      continue;
    }
    if (pin.fingerprint === fingerprint) {
      // Back to what was approved: nothing waits any more.
      if (pin.pendingFingerprint) await clearPending(deps.db, pin.id);
      out.push(tool);
      continue;
    }
    if (pin.pendingFingerprint !== fingerprint) {
      await deps.db
        .update(pins)
        .set({
          pendingFingerprint: fingerprint,
          pendingDescription: tool.description ?? "",
          pendingSchema: tool.inputSchema ?? {},
          ...(pin.changedAt ? {} : { changedAt: new Date() }),
        })
        .where(eq(pins.id, pin.id));
      if (!pin.pendingFingerprint) changed.push({ name: tool.name, fingerprint });
    }
    out.push({ ...tool, description: pin.description, inputSchema: pin.inputSchema });
  }
  if (fresh.length > 0) await deps.db.insert(pins).values(fresh).onConflictDoNothing();
  if (changed.length > 0) await notifyToolChanged(deps, connection, changed).catch(() => {});
  return out;
}

const clearPending = (db: Database, id: string) =>
  db
    .update(pins)
    .set({ pendingFingerprint: null, pendingDescription: null, pendingSchema: null, changedAt: null })
    .where(eq(pins.id, id));

export interface ToolChangeView {
  connectionId: string;
  connectionLabel: string;
  toolName: string;
  before: { description: string; inputSchema: Record<string, unknown> };
  after: { description: string; inputSchema: Record<string, unknown> };
  changedAt: string;
}

/** The tools whose server changed them since they were approved, waiting for an admin (connector admins only). */
export async function listToolChanges(db: Database, actorId: string, orgId: string): Promise<ToolChangeView[]> {
  await requirePermission(db, actorId, orgId, "manage_connectors");
  const rows = await db
    .select({ pin: pins, label: schema.connectorConnections.label })
    .from(pins)
    .innerJoin(schema.connectorConnections, eq(schema.connectorConnections.id, pins.connectionId))
    .where(and(eq(pins.orgId, orgId), isNotNull(pins.pendingFingerprint)))
    .orderBy(pins.changedAt);
  return rows.map(({ pin, label }) => ({
    connectionId: pin.connectionId,
    connectionLabel: label,
    toolName: pin.toolName,
    before: { description: pin.description, inputSchema: pin.inputSchema },
    after: { description: pin.pendingDescription ?? "", inputSchema: pin.pendingSchema ?? {} },
    changedAt: (pin.changedAt ?? pin.pinnedAt).toISOString(),
  }));
}

/**
 * An admin accepts a tool's new description and schema: they become its pin, the connection is listed again (so
 * agents get the new text now, and a custom server's tools are classified again by `resync`), and the notice is
 * resolved once nothing else of the connection waits.
 */
export async function acceptToolChange(
  deps: { db: Database; pubsub?: PubSub; resync?: (connectionId: string) => Promise<unknown> },
  actorId: string,
  orgId: string,
  connectionId: string,
  toolName: string,
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const where = and(eq(pins.orgId, orgId), eq(pins.connectionId, connectionId), eq(pins.toolName, toolName));
  const [pin] = await deps.db.select().from(pins).where(where);
  if (!pin?.pendingFingerprint) throw new NotFoundError("No change waits for this tool");
  await deps.db
    .update(pins)
    .set({
      fingerprint: pin.pendingFingerprint,
      description: pin.pendingDescription ?? "",
      inputSchema: pin.pendingSchema ?? {},
      pinnedAt: new Date(),
      pendingFingerprint: null,
      pendingDescription: null,
      pendingSchema: null,
      changedAt: null,
    })
    .where(eq(pins.id, pin.id));
  await deps.db
    .update(schema.connectorConnections)
    .set({ updatedAt: new Date() })
    .where(and(eq(schema.connectorConnections.id, connectionId), eq(schema.connectorConnections.orgId, orgId)));
  caches.connections.delete(`${orgId}:active`);
  await deps.resync?.(connectionId).catch(() => {});
  const [left] = await deps.db
    .select({ id: pins.id })
    .from(pins)
    .where(and(eq(pins.orgId, orgId), eq(pins.connectionId, connectionId), isNotNull(pins.pendingFingerprint)))
    .limit(1);
  if (!left) await resolveToolChanged(deps, orgId, connectionId);
}
