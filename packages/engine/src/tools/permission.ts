import { and, eq, isNull, schema } from "@agenteschat/db";
import {
  ALL_TOOLS,
  BUILTIN_SCOPES,
  CONNECTOR_ALL,
  grantedScopeKeys,
  grantKey,
  grantScopes,
  impliedByWrite,
  mailConnectionIds,
} from "./scopes";
import type { ToolContext, ToolDefinition, ToolSource } from "./types";

export const REQUEST_PERMISSION_TOOL = "request_permission";

/** Scopes "all tools" never covers (kept in step with `toolAccess`). */
const OUTSIDE_ALL = new Set(["sandbox:run", "browser:use"]);

export interface MissingPermission {
  /** A built-in scope (`browser:use`) or `connector:<connectionId>`. */
  id: string;
  label: string;
  connectionId: string | null;
  scope: string;
}

/**
 * What the agent could still be given: built-in scopes it doesn't hold (nor
 * through "all tools" or a write scope), and the org's connectors it has no
 * grant on at all (mailboxes and databases have their own screens).
 */
export async function missingPermissions(ctx: Pick<ToolContext, "db" | "orgId" | "agentId">) {
  const granted = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
  const all = granted.has(grantKey(null, ALL_TOOLS));
  const out: MissingPermission[] = [];
  for (const [scope, info] of Object.entries(BUILTIN_SCOPES)) {
    if (granted.has(grantKey(null, scope))) continue;
    const write = impliedByWrite(scope);
    if (write && granted.has(grantKey(null, write))) continue;
    if (all && !OUTSIDE_ALL.has(scope)) continue;
    out.push({ id: scope, label: info.label, connectionId: null, scope });
  }
  const connections = await ctx.db
    .select({ id: schema.connectorConnections.id, label: schema.connectorConnections.label })
    .from(schema.connectorConnections)
    .where(and(eq(schema.connectorConnections.orgId, ctx.orgId), isNull(schema.connectorConnections.revokedAt)));
  const own = await mailConnectionIds(
    ctx.db,
    ctx.orgId,
    connections.map((c) => c.id),
  );
  const held = new Set([...granted].map((k) => k.split("|")[0]));
  for (const c of connections) {
    if (own.has(c.id) || held.has(c.id) || all) continue;
    out.push({ id: `connector:${c.id}`, label: c.label, connectionId: c.id, scope: CONNECTOR_ALL });
  }
  return out;
}

/**
 * `request_permission`: an agent that lacks something a request needs asks
 * for it instead of failing. Always an approval (the existing card, "Esperando
 * você", push); approving turns it on for the agent (a connector: all its
 * tools, sensitive ones still ask every time). Only the agent's owner and
 * admins decide, the same people who change its access. Always listed (an
 * approved card still finds it once nothing is missing), with what is.
 */
export function createPermissionToolSource(): ToolSource {
  return {
    name: "permissions",
    async tools(ctx) {
      const missing = await missingPermissions(ctx).catch(() => []);
      const labels = new Map(missing.map((m) => [m.id, m.label]));
      const tool: ToolDefinition = {
        name: REQUEST_PERMISSION_TOOL,
        description: `Ask a person to turn on something you don't have yet, when the request needs it: instead of giving up, working around it or telling the person to do it themselves. A card asks the agent's owner or an admin; your turn pauses until they decide. ${
          missing.length
            ? `Not yet on for you: ${missing.map((m) => `${m.id} (${m.label})`).join("; ")}.`
            : "Everything you can be given is already on."
        }`,
        scope: "",
        sensitive: true,
        inputSchema: {
          type: "object",
          properties: {
            permission: missing.length
              ? { type: "string", enum: missing.map((m) => m.id) }
              : { type: "string", maxLength: 200 },
            reason: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description: "What you need it for, in one short sentence the person reads on the card.",
            },
          },
          required: ["permission", "reason"],
          additionalProperties: false,
        },
        describe(input) {
          const id = String(input.permission ?? "");
          return { title: `Turn on: ${labels.get(id) ?? id}`, detail: String(input.reason ?? "") };
        },
        async execute(input, c) {
          const id = String(input.permission ?? "");
          // Read again: it may have been turned on (or the connector removed) while the card waited.
          const wanted = (await missingPermissions(c)).find((m) => m.id === id);
          if (!wanted) return { content: `Nothing to turn on: ${labels.get(id) ?? id} is already on for you, or no longer exists.` };
          await grantScopes(c.db, c.orgId, c.agentId, [{ connectionId: wanted.connectionId, scope: wanted.scope }]);
          return {
            content: `Turned on: ${wanted.label}. Its tools are yours from your next step; carry on with the request.`,
          };
        },
      };
      return [tool];
    },
  };
}
