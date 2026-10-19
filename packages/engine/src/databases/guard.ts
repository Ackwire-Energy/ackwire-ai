import { parse } from "libpg-query";

/**
 * What an agent's SQL may be (ADR 0039), checked with Postgres's own parser
 * (libpg-query, WASM) before anything reaches the database:
 * one statement; a `SELECT` (with `WITH`) or an `EXPLAIN` of one without
 * `ANALYZE`; no other statement anywhere (data-changing CTEs, `SELECT INTO`,
 * `FOR UPDATE`); no function that sleeps, reads files, signals backends or
 * runs SQL from text; and the agent's rules (tables, hidden columns). The
 * read-only transaction and the role are the other layers.
 */

/** A relation as `schema.table` (lowercase; unqualified = `public`). */
export type RelationName = string;

export interface SqlRules {
  /** `schema.table`; empty = every table. */
  tables: string[];
  /** `schema.table.column`. */
  hiddenColumns: string[];
}

export type GuardResult =
  | { ok: true; kind: "select" | "explain"; body: string; relations: RelationName[] }
  | { ok: false; reason: string };

const BLOCKED_FUNCTIONS = new Set([
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_ls_archive_statusdir",
  "pg_logdir_ls",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_switch_wal",
  "pg_promote",
  "pg_notify",
  "set_config",
  "pg_drop_replication_slot",
  "dblink",
]);
/** Families refused by prefix: large objects, dblink, advisory locks, SQL-from-text XML, admin files, replication. */
const BLOCKED_PREFIXES = [
  "lo_",
  "dblink_",
  "pg_advisory_",
  "pg_try_advisory_",
  "query_to_xml",
  "cursor_to_xml",
  "table_to_xml",
  "schema_to_xml",
  "database_to_xml",
  "pg_file_",
  "pg_create_",
  "pg_replication_",
  "pg_logical_",
];
/** Catalogs that hold data values (statistics) or secrets: never read. */
const BLOCKED_RELATIONS = new Set([
  "pg_catalog.pg_statistic",
  "pg_catalog.pg_statistic_ext",
  "pg_catalog.pg_statistic_ext_data",
  "pg_catalog.pg_stats",
  "pg_catalog.pg_stats_ext",
  "pg_catalog.pg_stats_ext_exprs",
  "pg_catalog.pg_authid",
  "pg_catalog.pg_shadow",
  "pg_catalog.pg_user_mapping",
  "pg_catalog.pg_user_mappings",
]);
const CATALOG_SCHEMAS = new Set(["pg_catalog", "information_schema"]);

const lower = (s: string) => s.toLowerCase();
/** `schema.table` → `schema.table` lowercase; `table` → `public.table`. */
export function relationName(name: string): RelationName {
  const parts = name.trim().toLowerCase().split(".");
  return parts.length >= 2 ? `${parts.at(-2)}.${parts.at(-1)}` : `public.${parts[0]}`;
}

type Node = Record<string, unknown>;
const isObject = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const svalsOf = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.map((n) => (isObject(n) && isObject(n.String) ? String(n.String.sval ?? "") : "")).filter(Boolean)
    : [];

/** Every node of the tree with its key (`SelectStmt`, `FuncCall`…). */
function walk(value: unknown, visit: (key: string, node: Node) => void) {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isObject(child)) visit(key, child);
    walk(child, visit);
  }
}

/** Checks one agent query; `rules` are the agent's tables and hidden columns there. */
export async function guardSql(text: string, rules: SqlRules): Promise<GuardResult> {
  const sqlText = text.trim();
  if (!sqlText) return { ok: false, reason: "The query is empty." };
  if (sqlText.length > 20_000) return { ok: false, reason: "The query is too long (at most 20,000 characters)." };
  let tree: { stmts?: { stmt: Node; stmt_location?: number; stmt_len?: number }[] };
  try {
    tree = await parse(sqlText);
  } catch (error) {
    return { ok: false, reason: `Postgres can't parse this query: ${error instanceof Error ? error.message : error}` };
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) return { ok: false, reason: "Send exactly one statement per call." };
  const first = stmts[0];
  if (!first) return { ok: false, reason: "The query is empty." };
  const top = first.stmt;
  let kind: "select" | "explain";
  if (isObject(top.SelectStmt)) kind = "select";
  else if (isObject(top.ExplainStmt)) {
    const explain = top.ExplainStmt;
    if (!isObject(explain.query) || !isObject(explain.query.SelectStmt))
      return { ok: false, reason: "Only EXPLAIN of a SELECT is allowed." };
    const analyze = (Array.isArray(explain.options) ? explain.options : []).some(
      (o) => isObject(o) && isObject(o.DefElem) && lower(String(o.DefElem.defname ?? "")) === "analyze",
    );
    if (analyze) return { ok: false, reason: "EXPLAIN ANALYZE runs the query; use EXPLAIN without ANALYZE." };
    kind = "explain";
  } else {
    return {
      ok: false,
      reason: "Only SELECT queries (and EXPLAIN of a SELECT) are allowed: this database is read-only.",
    };
  }

  const problems: string[] = [];
  const ctes = new Set<string>();
  const relations: { name: RelationName; alias: string | null }[] = [];
  const functions: string[] = [];
  const columnRefs: string[][] = [];
  let star = false;
  walk(top, (key, node) => {
    if (key.endsWith("Stmt") && key !== "SelectStmt" && key !== "ExplainStmt")
      problems.push(`${key.replace(/Stmt$/, "").toUpperCase()} is not allowed: this database is read-only.`);
    if (key === "SelectStmt") {
      if (node.intoClause) problems.push("SELECT INTO is not allowed.");
      if (node.lockingClause) problems.push("FOR UPDATE / FOR SHARE is not allowed.");
    }
    if (key === "CommonTableExpr" && typeof node.ctename === "string") ctes.add(lower(node.ctename));
    if (key === "RangeVar" && typeof node.relname === "string") {
      const schema = typeof node.schemaname === "string" ? lower(node.schemaname) : null;
      const alias =
        isObject(node.alias) && typeof node.alias.aliasname === "string" ? lower(node.alias.aliasname) : null;
      relations.push({ name: schema ? `${schema}.${lower(node.relname)}` : `?${lower(node.relname)}`, alias });
    }
    if (key === "FuncCall") functions.push(lower(svalsOf(node.funcname).at(-1) ?? ""));
    if (key === "ColumnRef" && Array.isArray(node.fields)) {
      const fields = node.fields as unknown[];
      if (fields.some((f) => isObject(f) && "A_Star" in f)) star = true;
      columnRefs.push(svalsOf(fields).map(lower));
    }
  });
  if (problems[0]) return { ok: false, reason: problems[0] };

  for (const fn of functions) {
    if (BLOCKED_FUNCTIONS.has(fn) || BLOCKED_PREFIXES.some((p) => fn.startsWith(p)))
      return { ok: false, reason: `The function ${fn}() is not allowed here.` };
  }

  // Unqualified names that aren't CTEs are tables in `public` (the search path we set), or catalogs (pg_*).
  const resolved = relations
    .filter((r) => !(r.name.startsWith("?") && ctes.has(r.name.slice(1))))
    .map((r) => {
      if (!r.name.startsWith("?")) return r;
      const bare = r.name.slice(1);
      return { ...r, name: bare.startsWith("pg_") ? `pg_catalog.${bare}` : `public.${bare}` };
    });
  const allowed = new Set(rules.tables.map(relationName));
  for (const r of resolved) {
    if (BLOCKED_RELATIONS.has(r.name)) return { ok: false, reason: `${r.name} is not allowed (it holds data values).` };
    const schema = r.name.split(".")[0] ?? "";
    if (CATALOG_SCHEMAS.has(schema)) continue;
    if (allowed.size > 0 && !allowed.has(r.name))
      return {
        ok: false,
        reason: `Not allowed: this agent may only read the tables ${[...allowed].join(", ")}.`,
      };
  }

  // Hidden columns of the tables this query reads: never named, never through * or a whole-row reference.
  const hiddenByTable = new Map<string, Set<string>>();
  for (const h of rules.hiddenColumns) {
    const parts = h.trim().toLowerCase().split(".");
    const column = parts.at(-1);
    if (!column || parts.length < 2) continue;
    const table = relationName(parts.slice(0, -1).join("."));
    const set = hiddenByTable.get(table) ?? new Set<string>();
    set.add(column);
    hiddenByTable.set(table, set);
  }
  const touched = resolved.filter((r) => hiddenByTable.has(r.name));
  if (touched.length > 0) {
    const hidden = new Set(touched.flatMap((r) => [...(hiddenByTable.get(r.name) ?? [])]));
    const rowNames = new Set(touched.flatMap((r) => [r.alias, r.name.split(".")[1]]).filter((x): x is string => !!x));
    const list = touched.map((r) => `${r.name}: ${[...(hiddenByTable.get(r.name) ?? [])].join(", ")}`).join("; ");
    if (star)
      return {
        ok: false,
        reason: `Some columns are hidden from this agent (${list}). Name the columns you need instead of *.`,
      };
    for (const ref of columnRefs) {
      const last = ref.at(-1);
      if (last && hidden.has(last))
        return { ok: false, reason: `The column ${last} is hidden from this agent (${list}).` };
      if (ref.length === 1 && last && rowNames.has(last))
        return { ok: false, reason: `Some columns are hidden from this agent (${list}); name the columns you need.` };
    }
  }

  const start = first.stmt_location ?? 0;
  const body = (first.stmt_len ? sqlText.slice(start, start + first.stmt_len) : sqlText.slice(start))
    .trim()
    .replace(/;+\s*$/, "");
  return { ok: true, kind, body, relations: [...new Set(resolved.map((r) => r.name))] };
}
