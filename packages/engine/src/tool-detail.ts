import { commandOf, commandParts, normalizedCommand, PERMISSION_TOOL, redactCommon } from "@agenteschat/adapters";
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

/** What a permission check (`permission_prompt`) asks about; null when the runner asks again (`request_id` only). */
function promptAsked(i: Record<string, unknown>): { tool: string; input: Record<string, unknown> } | null {
  const inner = i.input;
  if (typeof i.tool_name !== "string" || !i.tool_name) return null;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  return { tool: i.tool_name, input: inner as Record<string, unknown> };
}

/** The runner asking again about a command waiting on a person: no step of its own, its answer is the first ask's. */
export const promptPoll = (name: string, input: Record<string, unknown> | undefined) =>
  name === PERMISSION_TOOL && typeof input?.request_id === "string";

/** Parts of a command line that only set up the next one (`cd repo && npm test`). */
const SETUP = new Set(["cd", "pushd", "popd", "export", "source", ".", "set", "unset"]);
/** Where a command's own words end: an option or a redirection. */
const OPTION = /^-|[<>]/;

/**
 * A command line in a few words: its first program (past `cd` and the like, wrappers and env assignments left out)
 * and its main argument, the words before its first option ("npm run build", "git commit"), else its last word
 * ("rm dist"). Never an option's value, and a web address keeps its site and path only.
 */
function commandGist(command: string): string | undefined {
  for (const part of commandParts(command)) {
    const words = part
      .split(" ")
      .map((w) => w.replace(/^["'`]+|["'`]+$/g, ""))
      .filter(Boolean);
    const start = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (start < 0) continue;
    const [program = "", ...rest] = normalizedCommand(words.slice(start)).split(" ");
    if (!program || SETUP.has(program)) continue;
    const lead: string[] = [];
    for (const w of rest) {
      if (OPTION.test(w) || lead.length === 2) break;
      lead.push(w);
    }
    const last = rest.at(-1);
    const args = lead.length > 0 ? lead : last && !OPTION.test(last) ? [last] : [];
    return [program, ...args].map((w) => siteOf(w) ?? w).join(" ");
  }
  return undefined;
}

/** A permission check's label: Claude Code's own one-line description of the command, else the command in a few words. */
function promptLabel(i: Record<string, unknown>): string | undefined {
  const asked = promptAsked(i);
  if (!asked) return undefined;
  const said = typeof asked.input.description === "string" ? asked.input.description.trim() : "";
  const what = said || commandGist(commandOf(asked.tool, asked.input));
  return what ? short(redactCredentials(what)) : undefined;
}

/** The whole command a permission check (`permission_prompt`) is about, as one line, credentials masked. */
export function toolCommand(name: string, input: Record<string, unknown> | undefined): string | undefined {
  const asked = name === PERMISSION_TOOL ? promptAsked(input ?? {}) : null;
  return asked ? redactCredentials(commandOf(asked.tool, asked.input)) || undefined : undefined;
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
    case PERMISSION_TOOL:
      return promptLabel(i);
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

/** `maskCredentials` and the shapes `redactCommon` knows (bearer headers, `token=` values): text that leaves its place. */
export const redactCredentials = (text: string) => redactCommon(maskCredentials(text));

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
