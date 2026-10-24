import { and, type Database, eq, isNull, schema } from "@agenteschat/db";

const MAX = 80;

function short(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t;
}

/** "https://shop.example/checkout?token=…" → "shop.example/checkout". */
function siteOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^https?:\/\/([^/?#\s]+)([^?#\s]*)/i.exec(v.trim());
  if (!m) return undefined;
  const host = (m[1] ?? "").replace(/^[^@]*@/, "").toLowerCase();
  const path = (m[2] ?? "").replace(/\/$/, "");
  return short(`${host}${path}`);
}

function issueRef(v: unknown) {
  const t = short(v);
  if (!t) return undefined;
  const n = /^#?(\d+)$/.exec(t);
  return n ? `#${n[1]}` : t;
}

/**
 * A short, safe label for the `agent.tool` event ("lendo a skill relatorio",
 * "issue #131"). Only these fields of built-in tools are ever shown: never
 * other inputs, and nothing from connector (MCP) tools.
 */
export function toolDetail(name: string, input: Record<string, unknown> | undefined): string | undefined {
  const i = input ?? {};
  switch (name) {
    case "load_skill":
      return short(i.name);
    case "read_skill_file": {
      const skill = short(i.name);
      const path = typeof i.path === "string" ? i.path : "";
      return skill ? short(path ? `${skill}/${path}` : skill) : undefined;
    }
    case "create_issue":
      return short(i.title);
    case "update_issue":
    case "comment_issue":
      return issueRef(i.issue);
    case "create_artifact":
      return short(i.title);
    case "update_artifact":
      return short(i.title);
    case "run_code":
      return short(i.language);
    case "write_file":
    case "read_file":
    case "list_files":
    case "export_file":
    case "upload_file":
      return short(i.path);
    case "run_skill_script": {
      const skill = short(i.skill);
      return skill ? short(typeof i.path === "string" ? `${skill}/${i.path}` : skill) : undefined;
    }
    // The agent browser (ADR 0040): the site it opens, never the query string (it can carry tokens).
    case "browser_open":
    case "browser_tabs":
      return siteOf(i.url);
    default:
      return undefined;
  }
}

/** Drive tools by id: the file's title, only when it belongs to this same channel (so no title leaks elsewhere). */
export async function artifactToolDetail(
  db: Database,
  orgId: string,
  channelId: string,
  name: string,
  input: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  if (!["read_artifact", "update_artifact", "share_artifact", "import_file"].includes(name)) return undefined;
  const id = input?.artifact_id;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [a] = await db
    .select({ title: schema.artifacts.title, channelId: schema.artifacts.channelId })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.orgId, orgId), isNull(schema.artifacts.deletedAt)));
  return a && a.channelId === channelId ? short(a.title) : undefined;
}

/** Things that look like credentials, masked in previews and live output (agents should never have any). */
const SECRET =
  /\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,})/g;

export const maskSecrets = (text: string) => text.replace(SECRET, "••••");

/** A private key, by its first line. */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Whether a value carries a credential by its format (an API key, a token, a private key): what a run
 * nobody is behind never sends anywhere (ADR 0053 §3).
 */
export function carriesCredential(value: unknown): boolean {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return PRIVATE_KEY.test(text) || text.replace(SECRET, "") !== text;
}

/** `maskSecrets`, private keys too (from their first line on): text people read that must hold none. */
export const maskCredentials = (text: string) =>
  maskSecrets(text).replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "••••");

export const PREVIEW_CODE_CHARS = 4096;

/** `run_code`'s code for the activity bar (≤ 4 KB, secrets masked). File tools show their path in `detail`. */
export function toolCode(
  name: string,
  input: Record<string, unknown> | undefined,
): { language: string; source: string } | undefined {
  if (name !== "run_code") return undefined;
  const i = input ?? {};
  const code = maskSecrets(typeof i.code === "string" ? i.code : "");
  return {
    language: typeof i.language === "string" ? i.language : "",
    source: code.length > PREVIEW_CODE_CHARS ? `${code.slice(0, PREVIEW_CODE_CHARS)}\n…` : code,
  };
}
