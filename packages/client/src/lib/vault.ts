import type { VaultAccess, VaultItem, VaultKeysImportInput, VaultScope } from "../vault/types";
import { MAX_SECRET_BYTES } from "./secret-box";

/*
 * The Vault's rules the web and the phone share (ADR 0144 §11): a key's name, who may move an item, and a .env file
 * (or a JSON object of names and values) read in the app for "Import .env". Pure: a file's text comes in, names and
 * values come out, and nothing here keeps, logs or sends anything. The values leave the app only in the save request.
 */

/**
 * Whether this person may move an item between Personal and Team: one kept here (not a password manager's), which
 * they edit, while they manage the team's. The server checks the same.
 */
export const canMoveVaultItem = (item: Pick<VaultItem, "connectionId" | "can">, canManageTeam: boolean) =>
  canManageTeam && item.connectionId === null && item.can.edit;

/** No agent may use it: neither all of them nor any one picked. */
export const vaultNoAgents = (access: Pick<VaultAccess, "allAgents" | "agentIds">) =>
  !access.allAgents && access.agentIds.length === 0;

/** A key's variable name, as the computer takes it (`SECRET_NAME` in `packages/adapters/src/secret-box.ts`). */
export const VAULT_KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Names a key can't have: they decide where an AI tool's sign-in or requests go. Mirrors `isReservedSecretName`
 * (`packages/adapters/src/secret-box.ts`), so a form says it before the server refuses.
 */
export const isReservedKeyName = (name: string) =>
  /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|OPENCODE_|XAI_|GROK_|GEMINI_|AGY_|GOOGLE_(?:API_KEY$|GEMINI_|GENAI_)|NODE_|SSL_CERT_|LD_|DYLD_)|_PROXY$/.test(
    name.toUpperCase(),
  );

/** The largest file an import reads, and the most keys one import saves (the server checks the same). */
export const ENV_MAX_BYTES = 512 * 1024;
export const ENV_MAX_KEYS = 200;

/** Why a line can't become a key: its name isn't a variable's, is reserved, or its value is empty or too large. */
export type EnvProblem = "name" | "reserved" | "empty" | "tooLarge";

export interface EnvEntry {
  name: string;
  value: string;
  problem: EnvProblem | null;
}

export interface EnvFile {
  format: "env" | "json";
  /** One per name, in the file's order: a name written twice keeps its last value. */
  entries: EnvEntry[];
  /** The names written more than once. */
  duplicates: string[];
}

const utf8 = new TextEncoder();

function problemOf(name: string, value: string): EnvProblem | null {
  if (!VAULT_KEY_NAME.test(name)) return "name";
  if (isReservedKeyName(name)) return "reserved";
  // The server trims a key's value: one that is only spaces is none.
  if (!value.trim()) return "empty";
  if (utf8.encode(value.trim()).byteLength > MAX_SECRET_BYTES) return "tooLarge";
  return null;
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/** `NAME=value` lines, as dotenv reads them. */
function envPairs(src: string): [string, string][] {
  const pairs: [string, string][] = [];
  const line = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=/;
  let at = 0;
  while (at < src.length) {
    const end = src.indexOf("\n", at);
    const stop = end < 0 ? src.length : end;
    const text = src.slice(at, stop);
    const head = line.exec(text);
    if (!head) {
      // Blank, a comment, or nothing this reads.
      at = stop + 1;
      continue;
    }
    const name = head[1] as string;
    const afterEquals = at + head[0].length;
    const start = afterEquals + (/^[ \t]*/.exec(src.slice(afterEquals, stop)) as RegExpExecArray)[0].length;
    const quote = src[start];
    if (quote === '"' || quote === "'" || quote === "`") {
      // A quoted value runs to its closing quote, across lines. Only double quotes take escapes.
      let i = start + 1;
      let value = "";
      let closed = false;
      for (; i < src.length; i++) {
        const c = src[i] as string;
        if (c === "\\" && quote === '"' && i + 1 < src.length) {
          const next = src[i + 1] as string;
          value += ESCAPES[next] ?? `\\${next}`;
          i++;
        } else if (c === quote) {
          closed = true;
          break;
        } else value += c;
      }
      if (closed) {
        pairs.push([name, value]);
        const rest = src.indexOf("\n", i);
        at = rest < 0 ? src.length : rest + 1;
        continue;
      }
      // No closing quote: the quote is part of a plain value on this one line.
    }
    // A plain value ends at the line's end, or at a comment after a space: `NAME= # note` has no value, while a
    // `#` inside a value (a password's) stays.
    pairs.push([
      name,
      src
        .slice(afterEquals, stop)
        .replace(/[ \t]+#.*$/, "")
        .trim(),
    ]);
    at = stop + 1;
  }
  return pairs;
}

/** A JSON object's text values (numbers and booleans as their text), or null when the text isn't such an object. */
function jsonPairs(src: string): [string, string][] | null {
  if (!src.trimStart().startsWith("{")) return null;
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(data)) {
    if (typeof value === "string") pairs.push([name, value]);
    else if (typeof value === "number" || typeof value === "boolean") pairs.push([name, String(value)]);
  }
  return pairs;
}

/**
 * Reads a .env file's text: `NAME=value` lines, an `export ` before a name, `#` comments (a whole line, or after a
 * plain value and a space), blank lines, values in double quotes (with `\n`, `\t`, `\"`, `\\`), single quotes or
 * backticks (as written), a quoted value over several lines, CRLF, a byte order mark. Or a JSON object of names and
 * values. A name written twice keeps its last value, at its first place.
 */
export function parseEnvFile(text: string): EnvFile {
  const src = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  const json = jsonPairs(src);
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const [name, value] of json ?? envPairs(src)) {
    if (values.has(name)) duplicates.add(name);
    values.set(name, value);
  }
  return {
    format: json ? "json" : "env",
    entries: [...values].map(([name, value]) => ({ name, value, problem: problemOf(name, value) })),
    duplicates: [...duplicates],
  };
}

/** A line of the review list: a key to save (`new`), one whose name is already saved there (`exists`), or neither. */
export interface EnvReviewRow extends EnvEntry {
  state: "new" | "exists" | "problem";
}

/** The names of the keys already kept in the Vault itself, in one scope, as this person sees them. */
export function savedKeyNames(items: readonly VaultItem[], scope: VaultScope): Set<string> {
  const names = new Set<string>();
  for (const item of items)
    if (item.kind === "key" && item.scope === scope && item.connectionId === null && item.keyName)
      names.add(item.keyName);
  return names;
}

export function envReview(file: Pick<EnvFile, "entries">, saved: ReadonlySet<string>): EnvReviewRow[] {
  return file.entries.map((entry) => ({
    ...entry,
    state: entry.problem ? "problem" : saved.has(entry.name) ? "exists" : "new",
  }));
}

/**
 * What the save sends: the new keys, and the saved ones the person chose to replace. One left as it is isn't sent
 * at all, so its value never leaves the app.
 */
export function envImportInput(
  rows: readonly EnvReviewRow[],
  replace: ReadonlySet<string>,
  scope: VaultScope,
  access: VaultAccess,
): VaultKeysImportInput {
  const keys = rows
    .filter((row) => row.state === "new" || (row.state === "exists" && replace.has(row.name)))
    .map((row) => ({ keyName: row.name, secret: row.value.trim(), replace: row.state === "exists" }));
  return { scope, access, keys };
}
