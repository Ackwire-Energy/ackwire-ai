import {
  type DatabaseClient,
  type DatabaseDriver,
  DatabaseError,
  type DatabaseRun,
  type DatabaseTarget,
  type KeyWrapper,
} from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { openSecret, sealSecret } from "../crypto";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { publicHostAddress, type ResolveHost, resolveHostDns } from "../net-guard";
import { requirePermission } from "../organizations";
import { identPath } from "./identifiers";

const { dbConnections, agentScopes } = schema;

export type DbConnectionRow = typeof dbConnections.$inferSelect;

/** What the database code needs (connections, tools). */
export interface DatabaseDeps {
  db: Database;
  /** Current wrapper first (seals), then legacy ones (open only). */
  keyWrappers: KeyWrapper[];
  /** Null/absent = the database connector is off on this server. */
  databases?: DatabaseDriver | null;
  /** DNS for the address guard (tests: fake). */
  resolveHost?: ResolveHost;
  now?: () => Date;
}

/** The one scope an agent holds on a database (`agent_scopes.connection_id` = the connection). Read-only for now. */
export const DATABASE_SCOPE = "database:read";

/** What people turn on or off for a database ("O que faz"); one tool each. */
export const DB_ACTIONS = ["list_tables", "describe_table", "query"] as const;
export type DbAction = (typeof DB_ACTIONS)[number];

/** Where the database lives (only for the help shown when connecting). */
export const DB_PROVIDERS = ["supabase", "neon", "railway", "rds", "render", "other"] as const;
export type DbProvider = (typeof DB_PROVIDERS)[number];

/** Why a connection test failed. */
export type DbTestError = "auth" | "unreachable" | "blocked_host" | "tls" | "unknown";

export interface DatabaseConnectionView {
  id: string;
  label: string;
  provider: DbProvider;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: "require" | "disable";
  status: "active" | "needs_reconnect";
  lastError: string | null;
  /** The user can change data: the app recommends a read-only one (agents only read anyway). */
  canWrite: boolean;
  createdAt: string;
  offActions: DbAction[];
  /** Columns hidden by default in agents' rules (`schema.table.column`). */
  suggestedHidden: string[];
  /** Agents that can read it. */
  agents: { agentId: string }[];
}

const aadFor = (orgId: string, id: string) => `db-connection|${orgId}|${id}`;

export function dbConnectionView(row: DbConnectionRow, agentIds?: Set<string>): DatabaseConnectionView {
  return {
    id: row.id,
    label: row.label,
    provider: ((DB_PROVIDERS as readonly string[]).includes(row.provider) ? row.provider : "other") as DbProvider,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    sslmode: row.sslmode === "disable" ? "disable" : "require",
    status: row.status === "needs_reconnect" ? "needs_reconnect" : "active",
    lastError: row.lastError,
    canWrite: row.canWrite,
    createdAt: row.createdAt.toISOString(),
    offActions: row.offActions.filter((a): a is DbAction => (DB_ACTIONS as readonly string[]).includes(a)),
    suggestedHidden: row.suggestedHidden,
    agents: [...(agentIds ?? [])].map((agentId) => ({ agentId })),
  };
}

/** Agents that can read each database (connection id → agent ids). */
export async function dbGrants(db: Database, orgId: string, connectionIds: string[]) {
  const out = new Map<string, Set<string>>();
  if (connectionIds.length === 0) return out;
  const rows = await db
    .select({ connectionId: agentScopes.connectionId, agentId: agentScopes.agentId })
    .from(agentScopes)
    .where(
      and(
        eq(agentScopes.orgId, orgId),
        inArray(agentScopes.connectionId, connectionIds),
        eq(agentScopes.scope, DATABASE_SCOPE),
      ),
    );
  for (const r of rows) {
    if (!r.connectionId) continue;
    const set = out.get(r.connectionId) ?? new Set<string>();
    set.add(r.agentId);
    out.set(r.connectionId, set);
  }
  return out;
}

/** The org's databases (not disconnected), oldest first. */
export async function orgDbConnections(db: Database, orgId: string) {
  return db
    .select()
    .from(dbConnections)
    .where(and(eq(dbConnections.orgId, orgId), isNull(dbConnections.revokedAt)))
    .orderBy(asc(dbConnections.createdAt), asc(dbConnections.id));
}

export async function listDatabaseConnections(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await orgDbConnections(db, orgId);
  const grants = await dbGrants(
    db,
    orgId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => dbConnectionView(r, grants.get(r.id)));
}

export async function loadDbConnection(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(dbConnections)
    .where(and(eq(dbConnections.id, id), eq(dbConnections.orgId, orgId), isNull(dbConnections.revokedAt)));
  if (!row) throw new NotFoundError("Database not found", "database.not_found");
  return row;
}

export async function getDatabaseConnectionView(db: Database, orgId: string, id: string) {
  const row = await loadDbConnection(db, orgId, id);
  return dbConnectionView(row, (await dbGrants(db, orgId, [row.id])).get(row.id));
}

// ── Input ───────────────────────────────────────────────────────────────────

export interface DatabaseConnectionInput {
  label?: string;
  provider?: string;
  /** `postgres://user:password@host:port/database?sslmode=…`; the fields below win over it. */
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  sslmode?: "require" | "disable";
}

interface Settings {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslmode: "require" | "disable";
}

/** The address and fields as one set of settings; throws on anything missing or malformed. */
export function databaseSettings(input: DatabaseConnectionInput, fallback?: Partial<Settings>): Settings {
  let fromUrl: Partial<Settings> = {};
  if (input.url?.trim()) {
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      throw new ValidationError(
        "The address must look like postgres://user:password@host:5432/database",
        "database.url",
      );
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
      throw new ValidationError("The address must start with postgres://", "database.url");
    const ssl = url.searchParams.get("sslmode");
    fromUrl = {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port ? Number(url.port) : undefined,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      sslmode: ssl === "disable" ? "disable" : ssl ? "require" : undefined,
    };
  }
  const pick = <K extends keyof Settings>(k: K) => (input[k] ?? fromUrl[k] ?? fallback?.[k]) as Settings[K] | undefined;
  const host = String(pick("host") ?? "")
    .trim()
    .toLowerCase();
  const port = Number(pick("port") ?? 5432);
  const database = String(pick("database") ?? "").trim() || "postgres";
  const username = String(pick("username") ?? "").trim();
  const password = String(pick("password") ?? "");
  const sslmode = pick("sslmode") === "disable" ? "disable" : "require";
  if (!host) throw new ValidationError("Give the database server", "database.host_required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("Invalid port", "database.port");
  if (!username) throw new ValidationError("Give the database user", "database.user_required");
  if (!password) throw new ValidationError("Give the database password", "database.password_required");
  if (host.length > 253 || database.length > 63 || username.length > 63)
    throw new ValidationError("Too long", "database.too_long");
  return { host, port, database, username, password, sslmode };
}

// ── Opening ─────────────────────────────────────────────────────────────────

/** Columns whose names say they hold secrets or personal data: hidden by default in agents' rules. */
const SENSITIVE_COLUMN =
  /(pass(word|wd)?|pwd|hash|secret|token|api_?key|private_?key|salt|otp|cpf|cnpj|ssn|passport|phone|telefone|celular|whatsapp|card|cartao|cvv|iban|account_number|tax_id|birth|nascimento)/i;

export const LIST_TABLES_SQL = `select n.nspname as schema, c.relname as name,
  case c.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end as kind,
  greatest(c.reltuples, 0)::bigint as rows_estimate,
  obj_description(c.oid, 'pg_class') as comment
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'f')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'
  and has_table_privilege(c.oid, 'SELECT')
order by 1, 2
limit 1000`;

const COLUMNS_SQL = `select n.nspname, c.relname, a.attname
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'f') and a.attnum > 0 and not a.attisdropped
  and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
order by 1, 2, a.attnum
limit 20000`;

const CAN_WRITE_SQL = `select coalesce((select rolsuper from pg_roles where rolname = current_user), false)
  or exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg_toast%'
      and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE') or has_table_privilege(c.oid, 'DELETE'))
  ) as can_write`;

/** The limits of the connection test and the tools' catalog reads. */
export const CATALOG_LIMITS = { statementTimeoutMs: 10_000, searchPath: "public" };

const driverOf = (deps: Pick<DatabaseDeps, "databases">) => {
  if (!deps.databases) throw new ConflictError("Databases are off on this server", "database.disabled");
  return deps.databases;
};

/** Where to connect for these settings: a checked public address, or why not. */
async function targetFor(
  deps: DatabaseDeps,
  s: Settings,
): Promise<{ ok: true; target: DatabaseTarget } | { ok: false; error: DbTestError }> {
  const r = await publicHostAddress(s.host, deps.resolveHost ?? resolveHostDns);
  if (!r.ok) return { ok: false, error: r.reason === "blocked" ? "blocked_host" : "unreachable" };
  return { ok: true, target: { ...s, address: r.address } };
}

const testErrorOf = (error: unknown): DbTestError => {
  if (error instanceof DatabaseError) {
    if (error.code === "auth" || error.code === "unreachable" || error.code === "tls") return error.code;
    if (error.code === "timeout") return "unreachable";
  }
  return "unknown";
};

export interface DatabaseTestResult {
  version: string;
  tables: number;
  canWrite: boolean;
  suggestedHidden: string[];
}

/** Connects, reads the version, counts the tables, and checks whether the user can change data. */
async function testSettings(
  deps: DatabaseDeps,
  s: Settings,
): Promise<{ ok: true; result: DatabaseTestResult } | { ok: false; error: DbTestError }> {
  const t = await targetFor(deps, s);
  if (!t.ok) return t;
  let client: DatabaseClient | null = null;
  try {
    client = await driverOf(deps).open(t.target);
    const result = await client.readOnly(CATALOG_LIMITS, async (run) => {
      const version = String((await run("select version()")).rows[0]?.[0] ?? "");
      const tables = (await run(LIST_TABLES_SQL)).rows.length;
      const canWrite = (await run(CAN_WRITE_SQL)).rows[0]?.[0] === true;
      return { version, tables, canWrite, suggestedHidden: await sensitiveColumns(run) };
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: testErrorOf(error) };
  } finally {
    await client?.close().catch(() => {});
  }
}

async function sensitiveColumns(run: DatabaseRun) {
  const rows = (await run(COLUMNS_SQL)).rows;
  return rows
    .filter((r) => SENSITIVE_COLUMN.test(String(r[2] ?? "")))
    .map((r) => identPath([String(r[0]), String(r[1]), String(r[2])]))
    .slice(0, 200);
}

/** Pooled clients (one per connection version), closed after 5 minutes unused; re-resolved when reopened. */
const clients = new Map<string, { key: string; client: Promise<DatabaseClient>; usedAt: number }>();
const IDLE_MS = 5 * 60_000;

async function passwordOf(deps: DatabaseDeps, row: DbConnectionRow) {
  return openSecret(
    deps.keyWrappers,
    { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    aadFor(row.orgId, row.id),
  );
}

/** A client for a connection (backend only), from the pool. */
export async function clientFor(deps: DatabaseDeps, row: DbConnectionRow): Promise<DatabaseClient> {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.usedAt > IDLE_MS) {
      clients.delete(id);
      void c.client.then((x) => x.close()).catch(() => {});
    }
  }
  const key = `${row.id}:${row.updatedAt.getTime()}`;
  const cached = clients.get(row.id);
  if (cached?.key === key) {
    cached.usedAt = now;
    return cached.client;
  }
  if (cached) void cached.client.then((x) => x.close()).catch(() => {});
  const client = (async () => {
    const s: Settings = {
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      password: await passwordOf(deps, row),
      sslmode: row.sslmode === "disable" ? "disable" : "require",
    };
    const t = await targetFor(deps, s);
    if (!t.ok)
      throw new DatabaseError(
        t.error === "blocked_host" ? "This server is not allowed." : "The database server didn't answer.",
        "unreachable",
      );
    return driverOf(deps).open(t.target);
  })();
  clients.set(row.id, { key, client, usedAt: now });
  client.catch(() => clients.get(row.id)?.client === client && clients.delete(row.id));
  return client;
}

/** Forgets a connection's pooled client (disconnect, new password). */
export function dropClient(connectionId: string) {
  const c = clients.get(connectionId);
  clients.delete(connectionId);
  void c?.client.then((x) => x.close()).catch(() => {});
}

// ── Changes ─────────────────────────────────────────────────────────────────

/**
 * Connects a database (admins): tested first (address guard, TLS, login,
 * what the user can do); the password is sealed bound to (org, connection).
 * Returns the test's error instead of saving when it fails.
 */
export async function createDatabaseConnection(
  deps: DatabaseDeps,
  actorId: string,
  orgId: string,
  input: DatabaseConnectionInput,
): Promise<{ ok: true; connection: DatabaseConnectionView } | { ok: false; error: DbTestError }> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  driverOf(deps);
  const s = databaseSettings(input);
  const tested = await testSettings(deps, s);
  if (!tested.ok) return tested;
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  const sealed = await sealSecret(wrapper, s.password, aadFor(orgId, id));
  const provider = (DB_PROVIDERS as readonly string[]).includes(input.provider ?? "") ? input.provider : "other";
  const [row] = await deps.db
    .insert(dbConnections)
    .values({
      id,
      orgId,
      label: input.label?.trim().slice(0, 80) || s.database,
      provider,
      host: s.host,
      port: s.port,
      database: s.database,
      username: s.username,
      sslmode: s.sslmode,
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      status: "active",
      canWrite: tested.result.canWrite,
      suggestedHidden: tested.result.suggestedHidden,
      createdByUserId: actorId,
    })
    .returning();
  if (!row) throw new Error("database connection insert returned nothing");
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "database.connected",
    target: { type: "db_connection", id },
    details: { host: s.host, database: s.database, username: s.username, canWrite: tested.result.canWrite },
  });
  return { ok: true, connection: dbConnectionView(row) };
}

/** Renames, turns tools on or off, or (tested first) replaces the address or password. */
export async function updateDatabaseConnection(
  deps: DatabaseDeps,
  actorId: string,
  orgId: string,
  connectionId: string,
  input: DatabaseConnectionInput & { offActions?: string[] },
): Promise<{ ok: true; connection: DatabaseConnectionView } | { ok: false; error: DbTestError }> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await loadDbConnection(deps.db, orgId, connectionId);
  const set: Partial<typeof dbConnections.$inferInsert> = {};
  if (input.label !== undefined) set.label = input.label.trim().slice(0, 80) || row.database;
  if (input.offActions !== undefined) {
    const unknown = input.offActions.filter((a) => !(DB_ACTIONS as readonly string[]).includes(a));
    if (unknown.length > 0) throw new ValidationError(`Unknown actions: ${unknown.join(", ")}`, "database.action");
    set.offActions = [...new Set(input.offActions)];
  }
  const reconnect = [input.url, input.host, input.port, input.database, input.username, input.password, input.sslmode];
  if (reconnect.some((v) => v !== undefined)) {
    const s = databaseSettings(input, {
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      password: input.password ?? (input.url ? undefined : await passwordOf(deps, row)),
      sslmode: row.sslmode === "disable" ? "disable" : "require",
    });
    const tested = await testSettings(deps, s);
    if (!tested.ok) return tested;
    const wrapper = deps.keyWrappers[0];
    if (!wrapper) throw new Error("no key wrapper");
    const sealed = await sealSecret(wrapper, s.password, aadFor(orgId, row.id));
    Object.assign(set, {
      host: s.host,
      port: s.port,
      database: s.database,
      username: s.username,
      sslmode: s.sslmode,
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      canWrite: tested.result.canWrite,
      status: "active",
      lastError: null,
    });
    dropClient(row.id);
  }
  if (Object.keys(set).length > 0) {
    await deps.db
      .update(dbConnections)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(dbConnections.id, row.id));
    if (set.secretCiphertext) {
      await recordAudit(deps.db, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "database.reconnected",
        target: { type: "db_connection", id: row.id },
      });
    }
  }
  return { ok: true, connection: await getDatabaseConnectionView(deps.db, orgId, row.id) };
}

/** Disconnects a database (admins): agents lose access; the password is forgotten. */
export async function revokeDatabaseConnection(
  deps: DatabaseDeps,
  actorId: string,
  orgId: string,
  connectionId: string,
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await loadDbConnection(deps.db, orgId, connectionId);
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    await tx
      .update(dbConnections)
      .set({ revokedAt: now, updatedAt: now, secretCiphertext: "", wrappedDataKey: "", kekId: "" })
      .where(eq(dbConnections.id, row.id));
    await tx.delete(agentScopes).where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.connectionId, row.id)));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "database.disconnected",
      target: { type: "db_connection", id: row.id },
      details: { host: row.host, database: row.database },
    });
  });
  dropClient(row.id);
  caches.scopes.deletePrefix(`${orgId}:`);
}

/** The password was refused: a person must reconnect. */
export async function markDatabaseNeedsReconnect(db: Database, connectionId: string, reason: string) {
  await db
    .update(dbConnections)
    .set({ status: "needs_reconnect", lastError: reason.slice(0, 300) })
    .where(and(eq(dbConnections.id, connectionId), isNull(dbConnections.revokedAt)));
}

export interface DatabaseTable {
  schema: string;
  name: string;
  kind: string;
  rowsEstimate: number;
}

/** A database's tables (agents' rules picker) (admins). */
export async function listDatabaseTables(deps: DatabaseDeps, actorId: string, orgId: string, connectionId: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const row = await loadDbConnection(deps.db, orgId, connectionId);
  const client = await clientFor(deps, row);
  const rows = await client.readOnly(CATALOG_LIMITS, async (run) => (await run(LIST_TABLES_SQL)).rows);
  return rows.map(
    (r): DatabaseTable => ({
      schema: String(r[0]),
      name: String(r[1]),
      kind: String(r[2]),
      rowsEstimate: Number(r[3] ?? 0),
    }),
  );
}

/** Every database connection id of an org, connected or not (grants on them are managed only by the database API). */
export const dbConnectionIdsSql = (orgId: string) =>
  sql`(select ${dbConnections.id} from ${dbConnections} where ${dbConnections.orgId} = ${orgId})`;
