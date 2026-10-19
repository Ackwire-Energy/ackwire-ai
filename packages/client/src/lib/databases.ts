/**
 * Databases for agents (ADR 0039): the rules the screens share. DOM-free.
 */
import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type {
  DatabaseActionName,
  DatabaseConnectError,
  DatabaseConnection,
  DatabasePolicy,
  DatabaseProvider,
  ToolDecision,
} from "../api/types";
import type { ReviewTool } from "./tool-review";

/** "Onde fica o banco", in the order the connect step offers them. */
export const DATABASE_PROVIDERS: DatabaseProvider[] = ["supabase", "neon", "railway", "rds", "render", "other"];

/** Where each provider shows the address (for the "Abrir" link); null = nothing to link. */
export const DATABASE_PROVIDER_URLS: Record<DatabaseProvider, string | null> = {
  supabase: "https://supabase.com/dashboard/project/_/settings/database",
  neon: "https://console.neon.tech",
  railway: "https://railway.com/dashboard",
  rds: "https://console.aws.amazon.com/rds/home",
  render: "https://dashboard.render.com",
  other: null,
};

export const DATABASE_ERRORS: DatabaseConnectError[] = ["auth", "unreachable", "blocked_host", "tls", "unknown"];

/** The error code of a failed connect or reconnect (`422 { error }`); anything else is `unknown`. */
export function databaseErrorOf(error: unknown): DatabaseConnectError {
  if (error instanceof ApiError) {
    const code = error.code as DatabaseConnectError;
    if (DATABASE_ERRORS.includes(code)) return code;
  }
  return "unknown";
}

/** A user that can only read, to paste in the provider's SQL editor (the password is the person's to choose). */
export function readOnlyRoleSql(database: string) {
  const db = /^[a-z_][a-z0-9_$]*$/i.test(database) ? database : `"${database.replace(/"/g, '""')}"`;
  return [
    "create role agentes_leitura login password 'troque-esta-senha';",
    `grant connect on database ${db} to agentes_leitura;`,
    "grant usage on schema public to agentes_leitura;",
    "grant select on all tables in schema public to agentes_leitura;",
    "alter default privileges in schema public grant select on tables to agentes_leitura;",
  ].join("\n");
}

/** `postgres://…` looks complete enough to try (the server says exactly what's wrong). */
export const isDatabaseUrl = (value: string) => /^postgres(ql)?:\/\/[^/\s]+/.test(value.trim());

/** A new agent's rules for a database: every table, the sensitive columns found when connecting hidden. */
export const defaultDatabasePolicy = (connection?: Pick<DatabaseConnection, "suggestedHidden">): DatabasePolicy => ({
  tables: [],
  hiddenColumns: [...(connection?.suggestedHidden ?? [])],
  dailyQueryCap: null,
  timeoutSeconds: 15,
});

/** The time limits people can pick, in seconds. */
export const DATABASE_TIMEOUTS = [15, 30, 60] as const;

/** `table.column` or `schema.table.column`, as the rules store them (`public` when no schema). */
export function hiddenColumnOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  const parts = v.split(".");
  const ok = parts.every((p) => /^[a-z_][a-z0-9_$]*$/.test(p));
  if (!ok || parts.length < 2 || parts.length > 3) return null;
  return parts.length === 2 ? `public.${v}` : v;
}

/** Typed text → the columns in it (split on commas, spaces, semicolons). */
export function splitColumns(text: string): { valid: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const c = hiddenColumnOf(p);
    if (c) valid.push(c);
    else invalid.push(p);
  }
  return { valid, invalid };
}

/** How many rules narrow what the agent reads (the "Regras" summary). */
export const databaseRulesCount = (p: DatabasePolicy) =>
  [p.tables.length > 0, p.hiddenColumns.length > 0, p.dailyQueryCap !== null, p.timeoutSeconds !== 15].filter(Boolean)
    .length;

const ACTIONS: DatabaseActionName[] = ["list_tables", "describe_table", "query"];

/** A database's tools as the standard tool review shows them: each only reads (Consulta · Desligada). */
export function databaseReviewTools(t: TFunction, connection: Pick<DatabaseConnection, "offActions">): ReviewTool[] {
  return ACTIONS.map((name) => {
    const label = t(`database.action.${name}.name`);
    const level: ToolDecision = connection.offActions.includes(name) ? "off" : "read";
    return {
      name,
      label,
      description: t(`database.action.${name}.text`),
      subject: "database",
      level,
      suggested: "read",
      reason: null,
      sensitive: false,
      pending: false,
      savedLabel: label,
      levels: ["read", "off"],
    };
  });
}

/** The tools the review turned off. */
export function databaseOffActions(tools: ReviewTool[], levels: Record<string, ToolDecision>) {
  return tools.filter((tool) => (levels[tool.name] ?? tool.level) === "off").map((t) => t.name as DatabaseActionName);
}
