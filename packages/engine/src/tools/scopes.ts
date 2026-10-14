import { and, asc, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { caches } from "../cache";
import { NotFoundError, ValidationError } from "../errors";
import { requirePermission } from "../organizations";

const { agentScopes, agents } = schema;

/**
 * Scopes of built-in tools (no connector). Connector scopes come from each
 * connector's catalog (`connectors/catalog.ts`).
 */
export const BUILTIN_SCOPES: Record<string, { label: string; description: string; sensitive?: boolean }> = {
  "context:read": {
    label: "Ler o contexto",
    description: "Buscar mensagens, resumos e fatos nos canais do agente.",
  },
  "memory:write": { label: "Lembrar", description: "Guardar e esquecer as próprias notas (memórias)." },
  "drive:read": { label: "Ler arquivos", description: "Ler arquivos do Drive." },
  "drive:write": {
    label: "Escrever arquivos",
    description: "Criar relatórios, tabelas, organogramas, diffs e páginas no Drive.",
  },
  "issues:read": { label: "Ler issues", description: "Listar e ler issues." },
  "issues:write": { label: "Issues", description: "Criar e atualizar issues." },
  "sandbox:exec": { label: "Rodar código", description: "Rodar comandos num ambiente isolado." },
};

/**
 * Granted to every new agent: reading context, keeping its own notes, and
 * reading and writing Drive files (low risk). Admins and owners can revoke them.
 */
export const DEFAULT_AGENT_SCOPES = ["context:read", "memory:write", "drive:read", "drive:write"];

export interface ScopeGrant {
  connectionId: string | null;
  scope: string;
}

/** Key of a grant in sets: built-in scopes have no connection. */
export const grantKey = (connectionId: string | null | undefined, scope: string) =>
  `${connectionId ?? "builtin"}|${scope}`;

/** The agent's grants, read from the database (never from a prompt). */
export async function grantedScopeKeys(db: Executor, orgId: string, agentId: string): Promise<Set<string>> {
  return caches.scopes.getOrLoad(`${orgId}:${agentId}`, () => loadScopeKeys(db, orgId, agentId)) as Promise<
    Set<string>
  >;
}

async function loadScopeKeys(db: Executor, orgId: string, agentId: string): Promise<Set<string>> {
  const rows = await db
    .select({ connectionId: agentScopes.connectionId, scope: agentScopes.scope })
    .from(agentScopes)
    .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId)));
  return new Set(rows.map((r) => grantKey(r.connectionId, r.scope)));
}

export async function hasScope(
  db: Executor,
  orgId: string,
  agentId: string,
  connectionId: string | null | undefined,
  scope: string,
) {
  const [row] = await db
    .select({ id: agentScopes.id })
    .from(agentScopes)
    .where(
      and(
        eq(agentScopes.orgId, orgId),
        eq(agentScopes.agentId, agentId),
        connectionId ? eq(agentScopes.connectionId, connectionId) : isNull(agentScopes.connectionId),
        eq(agentScopes.scope, scope),
      ),
    );
  return row !== undefined;
}

export async function listAgentScopes(db: Database, orgId: string, agentId: string): Promise<ScopeGrant[]> {
  return db
    .select({ connectionId: agentScopes.connectionId, scope: agentScopes.scope })
    .from(agentScopes)
    .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId)))
    .orderBy(asc(agentScopes.createdAt));
}

/**
 * Checks that a grant names a scope that exists: a built-in scope, or one of
 * the connection's catalog scopes. Set by the connectors module.
 */
export type GrantValidator = (db: Database, orgId: string, grant: ScopeGrant) => Promise<string | null>;

const builtinOnly: GrantValidator = async (_db, _orgId, grant) =>
  grant.connectionId === null && !BUILTIN_SCOPES[grant.scope] ? `Unknown scope ${grant.scope}` : null;

/**
 * Replaces an agent's grants (admins: `manage_agents`). Each grant is checked
 * against the scope catalogs; nothing outside them can be granted.
 */
export async function setAgentScopes(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  grants: ScopeGrant[],
  validate: GrantValidator = builtinOnly,
) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  for (const grant of grants) {
    const problem =
      (await builtinOnly(db, orgId, grant)) ?? (grant.connectionId ? await validate(db, orgId, grant) : null);
    if (problem) throw new ValidationError(problem);
  }
  caches.scopes.delete(`${orgId}:${agentId}`);
  await db.transaction(async (tx) => {
    await tx.delete(agentScopes).where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId)));
    const unique = new Map(grants.map((g) => [grantKey(g.connectionId, g.scope), g]));
    if (unique.size > 0) {
      await tx.insert(agentScopes).values(
        [...unique.values()].map((g) => ({
          orgId,
          agentId,
          connectionId: g.connectionId,
          scope: g.scope,
          grantedByUserId: actorId,
        })),
      );
    }
  });
  caches.scopes.delete(`${orgId}:${agentId}`);
}

/** Adds grants without permission checks: for internal setup (new agents, tests). */
export async function grantScopes(db: Executor, orgId: string, agentId: string, grants: ScopeGrant[]) {
  if (grants.length === 0) return;
  caches.scopes.delete(`${orgId}:${agentId}`);
  await db
    .insert(agentScopes)
    .values(grants.map((g) => ({ orgId, agentId, connectionId: g.connectionId, scope: g.scope })))
    .onConflictDoNothing();
}
