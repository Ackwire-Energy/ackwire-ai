import { handleFrom } from "@agenteschat/client/lib/text";
import { AGENT_ACCESSORIES, AGENT_COLORS, AGENT_EYES, type AgentAppearance, type AgentColor } from "@agenteschat/ui";
import { parse as parseYaml } from "yaml";

/**
 * Bringing agents from another app (onboarding step "Trazer seus agentes").
 * Pure parsers over the files' text; nothing here touches the network.
 *
 * - OpenMausBot (github.com/milind-soni/OpenMausBot): the team file from
 *   "Share team…", `openmaus.package` version 2 (`<team>-<version>.openmaus.json`),
 *   or version 1 (the same JSON, or the BotMRR Markdown playbook: YAML
 *   frontmatter with `botmrr: 1`). Format: `shared/package-format.ts`,
 *   `docs/team-sharing.md`, fixtures in `shared/package-fixtures/`. The file
 *   never holds keys, model choices or chat history.
 * - OpenBot (github.com/CopilotKit/openbot): a tenant package's `agents.yaml`
 *   (`agents:` list) and `agents/*.yaml` (one coworker, or an `agents:` list);
 *   `model.yaml` holds the package's model. Format: `docs/configuration.md`
 *   ("Tenant package"), `examples/fintech/`.
 *
 * What maps: name, handle (the source's key/id), role (title), instructions
 * (soul / system prompt, plus the agent's playbooks and the team's shared
 * instructions), a look, and a model when it's one of ours. Everything else
 * is listed under "what doesn't come along".
 */

export type ImportSource = "openmausbot" | "openbot";
export const IMPORT_SOURCES: ImportSource[] = ["openmausbot", "openbot"];
/** Brand names (not translated). */
export const SOURCE_NAME: Record<ImportSource, string> = { openmausbot: "OpenMausBot", openbot: "OpenBot" };
/** The source's own mark (docs/design/telas/assets/README.md). */
export const SOURCE_ICON: Record<ImportSource, string> = {
  openmausbot: "/brands/openmausbot.png",
  openbot: "/brands/openbot.png",
};
/** What the file picker offers. */
export const SOURCE_ACCEPT: Record<ImportSource, string> = {
  openmausbot: ".json,.md,.markdown,application/json,text/markdown",
  openbot: ".yaml,.yml",
};

/** OpenMausBot's limit for a package (PACKAGE_MAX_BYTES). */
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
/** Our agent fields (apps/server/src/routes/app/agents.ts). */
const MAX_NAME = 80;
const MAX_ROLE = 200;
const MAX_INSTRUCTIONS = 50_000;

export interface ImportFile {
  name: string;
  text: string;
}

export interface ImportedAgent {
  /** The source's key (OpenMausBot) or id (OpenBot). */
  key: string;
  name: string;
  handle: string;
  role: string;
  description: string;
  instructions: string;
  /** A model of ours the source names, else null (the workspace's suggestion). */
  model: string | null;
  appearance: Required<AgentAppearance>;
  /** Playbooks folded into the instructions. */
  playbooks: number;
}

export type LeftOutKind =
  | "skill"
  | "routine"
  | "room"
  | "connection"
  | "app"
  | "notes"
  | "picture"
  | "preset"
  | "remote"
  | "model"
  | "secret"
  | "redacted"
  | "file";

export interface LeftOut {
  kind: LeftOutKind;
  /** What it is, in the source's words (a name, a key, a file). */
  label: string;
}

export interface ImportResult {
  source: ImportSource;
  /** The files read (for the header). */
  files: string[];
  /** The team's name (OpenMausBot), or null. */
  team: string | null;
  agents: ImportedAgent[];
  leftOut: LeftOut[];
}

export type ImportErrorCode = "empty" | "tooLarge" | "notOpenMausBot" | "newerVersion" | "notOpenBot" | "noAgents";

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
    this.name = "ImportError";
  }
}

export interface ParseOptions {
  /** Model ids of our catalog; a source model outside it isn't used. */
  models?: string[];
}

/** Reads the files for that source. Throws `ImportError` when they aren't what it expects. */
export function parseImport(source: ImportSource, files: ImportFile[], options: ParseOptions = {}): ImportResult {
  const usable = files.filter((f) => f.text.trim());
  if (usable.length === 0) throw new ImportError("empty");
  if (usable.some((f) => new TextEncoder().encode(f.text).byteLength > IMPORT_MAX_BYTES)) {
    throw new ImportError("tooLarge");
  }
  const result = source === "openmausbot" ? parseOpenMausBot(usable) : parseOpenBot(usable, options);
  if (result.agents.length === 0) throw new ImportError("noAgents");
  return { ...result, source, agents: uniqueHandles(result.agents), leftOut: dedupe(result.leftOut) };
}

// ── OpenMausBot ───────────────────────────────────────────────────────────────

const PACKAGE_FORMAT = "openmaus.package";
/** OpenMausBot's colors (package-format.ts COLORS) in our palette. */
const MAUS_COLORS: Record<string, AgentColor> = {
  green: "green",
  blue: "indigo",
  red: "rose",
  orange: "amber",
  purple: "violet",
  cyan: "sky",
  pink: "rose",
  yellow: "amber",
  teal: "teal",
  coral: "rose",
};

/** The package object of an OpenMausBot file (JSON v1/v2, or BotMRR Markdown v1), or null. */
function mausPackage(text: string): { version: number; pkg: Record<string, unknown> } | null {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("{")) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const o = obj(doc);
    if (o.format !== PACKAGE_FORMAT) return null;
    if (typeof o.version !== "number") return null;
    if (o.version > 2) throw new ImportError("newerVersion");
    return { version: o.version, pkg: obj(o.package) };
  }
  // BotMRR Markdown: `---\n<yaml>\n---` with `botmrr: 1`, then the playbook prose (not needed here).
  const front = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) return null;
  let meta: unknown;
  try {
    meta = parseYaml(front[1] ?? "");
  } catch {
    return null;
  }
  const m = obj(meta);
  if (m.botmrr === undefined) return null;
  if (m.botmrr !== 1) throw new ImportError("newerVersion");
  const { botmrr: _version, ...pkg } = m;
  return { version: 1, pkg };
}

function parseOpenMausBot(files: ImportFile[]): Omit<ImportResult, "source"> {
  let found: { file: ImportFile; pkg: Record<string, unknown> } | null = null;
  for (const file of files) {
    const p = mausPackage(file.text);
    if (p) {
      found = { file, pkg: p.pkg };
      break;
    }
  }
  if (!found) throw new ImportError("notOpenMausBot");
  const { pkg } = found;
  const leftOut: LeftOut[] = [];
  const team = obj(pkg.team);
  const teamName = str(team.name) || str(pkg.name) || null;
  const brief = str(team.brief);
  const playbooks = new Map(
    list(pkg.playbooks)
      .map(obj)
      .map((p) => [str(p.key), p] as const),
  );

  const agents: ImportedAgent[] = [];
  const names = new Map<string, string>();
  for (const raw of list(pkg.agents).map(obj)) {
    const key = str(raw.key);
    const name = str(raw.name);
    if (!name) continue;
    names.set(key, name);
    const appearance = obj(raw.appearance);
    const own = list(raw.playbooks)
      .map((k) => playbooks.get(str(k)))
      .filter((p): p is Record<string, unknown> => Boolean(p));
    const sections = [
      str(raw.soul) || str(raw.description),
      ...own.map((p) => section(str(p.name), [str(p.summary), str(p.instructions)])),
      brief ? section(teamName ?? "", [brief]) : "",
    ];
    const { text: instructions, redacted } = scrubSecrets(join(sections));
    if (redacted) leftOut.push({ kind: "redacted", label: name });
    agents.push({
      key,
      name: name.slice(0, MAX_NAME),
      handle: handleOf(key, name),
      role: str(raw.title).slice(0, MAX_ROLE),
      description: str(raw.description),
      instructions: instructions.slice(0, MAX_INSTRUCTIONS),
      model: null,
      appearance: lookFor(key || name, MAUS_COLORS[str(appearance.color)]),
      playbooks: own.length,
    });
    for (const skill of list(raw.skills)) leftOut.push({ kind: "skill", label: str(skill) });
    if (obj(appearance.avatar).data) leftOut.push({ kind: "picture", label: name });
    const memory = obj(obj(raw.seed).memory);
    if (Object.keys(memory).length > 0) leftOut.push({ kind: "notes", label: name });
  }
  // Skills the package ships but no agent lists (a preset's, say).
  for (const skill of list(obj(pkg.skills).entries).map(obj)) leftOut.push({ kind: "skill", label: str(skill.name) });
  for (const routine of list(pkg.routines).map(obj)) {
    const owner = names.get(str(routine.agent));
    leftOut.push({ kind: "routine", label: owner ? `${str(routine.name)} (${owner})` : str(routine.name) });
  }
  for (const room of list(pkg.rooms).map(obj)) leftOut.push({ kind: "room", label: str(room.name) });
  for (const c of list(pkg.connections).map(obj)) {
    const host = hostOf(str(obj(c.mcp).url));
    leftOut.push({ kind: "connection", label: host ? `${str(c.label) || str(c.key)} (${host})` : str(c.label) });
  }
  for (const app of list(obj(pkg.requirements).apps).map(obj)) {
    leftOut.push({ kind: "app", label: str(app.label) || str(app.slug) });
  }
  for (const preset of list(pkg.presets).map(obj)) leftOut.push({ kind: "preset", label: str(preset.name) });
  return { files: [found.file.name], team: teamName, agents, leftOut: leftOut.filter((l) => l.label) };
}

// ── OpenBot ───────────────────────────────────────────────────────────────────

/** Package files that aren't agents; read by OpenBot's server, not by us. */
const OPENBOT_PACKAGE_FILES = new Set(["brand.yaml", "channels.yaml", "knowledge.yaml", "skills.yaml"]);
const OPENBOT_TYPES = new Set(["built-in", "remote-ag-ui", "remote-mastra"]);

/** `${NAME:-fallback}` → fallback, `${NAME}` → "" (OpenBot reads them from its own environment). */
export function interpolateEnv(text: string): string {
  return text.replace(
    /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-([^}]*))?\}/g,
    (_, fallback: string | undefined) => fallback ?? "",
  );
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function parseOpenBot(files: ImportFile[], options: ParseOptions): Omit<ImportResult, "source"> {
  const leftOut: LeftOut[] = [];
  const read: string[] = [];
  const rows: Record<string, unknown>[] = [];
  let model: string | null = null;
  let recognized = false;
  for (const file of files) {
    const name = baseName(file.name);
    if (!/\.ya?ml$/i.test(name)) continue;
    let doc: unknown;
    try {
      doc = parseYaml(interpolateEnv(file.text));
    } catch {
      continue;
    }
    const o = obj(doc);
    if (name === "model.yaml" || name === "model.yml") {
      const m = obj(o.model);
      if (!m.provider && !m.default_model) continue;
      recognized = true;
      read.push(name);
      const wanted = str(m.default_model);
      if (wanted && options.models?.includes(wanted)) model = wanted;
      else if (wanted || m.provider) {
        leftOut.push({ kind: "model", label: [str(m.provider), wanted].filter(Boolean).join(" · ") });
      }
      if (m.credential_secret_ref) leftOut.push({ kind: "secret", label: str(m.credential_secret_ref) });
      continue;
    }
    if (OPENBOT_PACKAGE_FILES.has(name)) {
      recognized = true;
      read.push(name);
      leftOut.push({ kind: "file", label: name });
      continue;
    }
    // agents.yaml (an `agents:` list) or agents/<one>.yaml (one coworker, or the same list).
    const found = Array.isArray(o.agents) ? list(o.agents).map(obj) : o.id && o.type ? [o] : [];
    if (found.length === 0) continue;
    recognized = true;
    read.push(file.name);
    rows.push(...found);
  }
  if (!recognized) throw new ImportError("notOpenBot");

  const agents: ImportedAgent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = str(row.id);
    const name = str(row.name) || id;
    // Two rows with one id stop OpenBot's server; here the first wins.
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const type = str(row.type);
    for (const skill of list(row.skills)) leftOut.push({ kind: "skill", label: str(skill) });
    // A remote coworker runs on its own server (AG-UI / Mastra): only its endpoint, nothing to bring.
    if (type !== "built-in") {
      leftOut.push({ kind: "remote", label: OPENBOT_TYPES.has(type) ? `${name} (${type})` : name });
      continue;
    }
    const { text: instructions, redacted } = scrubSecrets(str(row.system_prompt) || str(row.role_description));
    if (redacted) leftOut.push({ kind: "redacted", label: name });
    agents.push({
      key: id,
      name: name.slice(0, MAX_NAME),
      handle: handleOf(id, name),
      role: str(row.title).slice(0, MAX_ROLE),
      description: str(row.role_description),
      instructions: instructions.slice(0, MAX_INSTRUCTIONS),
      model,
      appearance: lookFor(str(row.avatar_seed) || id),
      playbooks: 0,
    });
  }
  return { files: read, team: null, agents, leftOut: leftOut.filter((l) => l.label) };
}

// ── Shared ────────────────────────────────────────────────────────────────────

/** Text that looks like a key never travels (OpenMausBot already redacts; OpenBot prompts are free text). */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];
const REDACTED = "[redacted]";

export function scrubSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return { text: out, redacted: out !== text };
}

/** Our handle rule (HANDLE_PATTERN in packages/engine/src/agents.ts): the source key when it fits. */
function handleOf(key: string, name: string): string {
  const k = key
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(k) ? k : handleFrom(name);
}

/** Handles unique within the import (`scout`, `scout2`…). */
function uniqueHandles(agents: ImportedAgent[]): ImportedAgent[] {
  const used = new Set<string>();
  return agents.map((a) => {
    const handle = uniqueHandle(a.handle, used);
    used.add(handle);
    return { ...a, handle };
  });
}

/** `base`, else `base2`, `base3`… not in `used` (≤ 32 characters). */
export function uniqueHandle(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 32 - String(n).length)}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A stable look from a seed: the source's color when it has one; eyes and accessory from the seed. */
function lookFor(seed: string, color?: AgentColor): Required<AgentAppearance> {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  const at = <T>(items: readonly T[], shift: number) => items[(h >>> shift) % items.length] as T;
  return {
    color: color ?? at(AGENT_COLORS, 0),
    eyes: at(AGENT_EYES, 8),
    accessory: at(AGENT_ACCESSORIES, 16),
  };
}

function section(title: string, parts: string[]): string {
  const body = join(parts);
  if (!body) return "";
  return title ? `## ${title}\n\n${body}` : body;
}

const join = (parts: string[]) =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function dedupe(items: LeftOut[]): LeftOut[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.kind}\u0000${i.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** The model an imported agent is created with: its own when it's in the catalog, else the suggestion. */
export function importedModel(agent: ImportedAgent, models: string[], suggested: string | undefined) {
  return agent.model && models.includes(agent.model) ? agent.model : suggested;
}

/** Leftovers grouped by kind, in a fixed order (for the "what doesn't come along" list). */
export const LEFT_OUT_ORDER: LeftOutKind[] = [
  "skill",
  "routine",
  "room",
  "connection",
  "app",
  "notes",
  "picture",
  "preset",
  "remote",
  "model",
  "secret",
  "redacted",
  "file",
];
export function groupLeftOut(items: LeftOut[]): { kind: LeftOutKind; labels: string[] }[] {
  return LEFT_OUT_ORDER.map((kind) => ({
    kind,
    labels: items.filter((i) => i.kind === kind).map((i) => i.label),
  })).filter((g) => g.labels.length > 0);
}
