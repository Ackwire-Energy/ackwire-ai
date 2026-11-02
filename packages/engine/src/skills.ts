import type { BlobStoreResolver } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { activeConnections, type ConnectorDeps } from "./connectors/connections";
import { type ErrorParams, ForbiddenError, NotFoundError, TooManyError, ValidationError } from "./errors";
import { connectionToken } from "./git/branches";
import { appTokenForRepo, boundInstallations, type GitHubAppConfig, type GitHubHttp } from "./git/github-app";
import { assertStorageRoom } from "./limits";
import { assertPublicHttpsUrl, type ResolveHost } from "./net-guard";
import { can, requirePermission } from "./organizations";
import { inflateZipEntry, listZip, readZip, type ZipListing } from "./zip";

const { skills, skillFiles, agentSkills } = schema;

export type SkillRow = typeof skills.$inferSelect;

export const SKILL_LIMITS = { maxFiles: 200, maxBytes: 2 * 1024 * 1024, bodyChars: 200_000, fileReadChars: 40_000 };
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Files we store and can show the model; everything else (scripts, binaries) is listed as ignored. */
const SHOWABLE: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
};

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  metadata: Record<string, unknown>;
}

function unquote(v: string) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Past this many values a frontmatter is refused as YAML (aliases can make a few lines stand for millions). */
const FRONTMATTER_MAX_NODES = 10_000;

/** The frontmatter as YAML (nested maps such as `metadata.openclaw`, block scalars, lists); null when it isn't. */
function yamlFields(yaml: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yaml);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Every alias is the same object (possibly cyclic): a plain copy, within the budget, is what gets stored.
  let nodes = 0;
  try {
    return JSON.parse(
      JSON.stringify(parsed, (_key, value) => {
        if (++nodes > FRONTMATTER_MAX_NODES) throw new Error("frontmatter too large");
        return value;
      }),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Top-level `key: value`, quoted strings, `|`/`>` blocks and `- item` lists, line by line. */
function lineFields(yaml: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] as string;
    const value = kv[2] ?? "";
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? "")) block.push((lines[++i] ?? "").trim());
      fields[key] = value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else if (value === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1] ?? "")) {
        items.push(unquote((lines[++i] ?? "").replace(/^\s+-\s+/, "")));
      }
      fields[key] = items.length > 0 ? items : "";
    } else fields[key] = unquote(value);
  }
  return fields;
}

/**
 * Parses a `SKILL.md`: YAML frontmatter and the Markdown body. `name` and
 * `description` are required (kebab-case ≤ 64; ≤ 1024 characters); other
 * fields are kept as metadata, nested ones included.
 */
export function parseSkillMarkdown(text: string): ParsedSkill {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) throw new ValidationError("SKILL.md needs a frontmatter block (--- name/description ---)");
  const lines = lineFields(m[1] ?? "");
  // Many published skills aren't valid YAML (`description: Use when: …`): they keep the line reading.
  const { name, description, ...metadata } = yamlFields(m[1] ?? "") ?? lines;
  // YAML reads `description: Yes` as a boolean and `name: 1.0` as a number: then the text as written.
  const written = (value: unknown, key: "name" | "description") =>
    (typeof value === "string" ? value : typeof lines[key] === "string" ? (lines[key] as string) : "").trim();
  const parsed = {
    name: written(name, "name"),
    description: written(description, "description"),
    body: (m[2] ?? "").trim(),
    metadata,
  };
  validateSkill(parsed);
  return parsed;
}

export function validateSkill(s: { name: string; description: string; body: string }) {
  if (!SKILL_NAME.test(s.name) || s.name.length > 64) {
    throw new ValidationError(
      "name: kebab-case (lowercase letters, numbers and hyphens), up to 64 characters",
      "skill.invalid_name",
      { max: 64 },
    );
  }
  if (!s.description || s.description.length > 1024)
    throw new ValidationError("description: 1 to 1024 characters", "skill.invalid_description", { max: 1024 });
  if (s.body.length > SKILL_LIMITS.bodyChars) throw new ValidationError("The skill body is too long");
}

/** Scripts we keep (never shown to the model) so `run_skill_script` can run them on the agent's computer (ADR 0021). */
export const SKILL_SCRIPTS: Record<string, string> = {
  py: "text/x-python",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
};

export type SkillFileStatus = "stored" | "script" | "ignored";

/** `stored`: text the model may read; `script`: kept for the agent's computer, never shown; `ignored`: listed only. */
export function classifyFile(path: string): { mime: string; status: SkillFileStatus } {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const mime = SHOWABLE[ext];
  if (mime) return { mime, status: "stored" };
  const script = SKILL_SCRIPTS[ext];
  if (script) return { mime: script, status: "script" };
  return { mime: "application/octet-stream", status: "ignored" };
}

function safePath(path: string) {
  const clean = path.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  if (!clean || clean.split("/").some((p) => p === ".." || p === "") || clean.startsWith("/")) {
    throw new ValidationError(`Invalid path in the skill: ${path}`);
  }
  return clean;
}

export interface SkillFileInput {
  path: string;
  data: Uint8Array;
}

/** A skill folder's files → the SKILL.md (found at the root, or under one top folder) and the rest. */
export function splitSkillFolder(files: SkillFileInput[]) {
  const normalized = files.map((f) => ({ path: safePath(f.path), data: f.data }));
  const firstSegments = new Set(normalized.map((f) => f.path.split("/")[0]));
  let root = "";
  if (!normalized.some((f) => f.path.toLowerCase() === "skill.md") && firstSegments.size === 1) {
    root = `${[...firstSegments][0]}/`;
  }
  const inRoot = normalized
    .filter((f) => f.path.startsWith(root) && !f.path.split("/").some((p) => p.startsWith(".") && p !== "."))
    .map((f) => ({ path: f.path.slice(root.length), data: f.data }));
  const main = inRoot.find((f) => f.path.toLowerCase() === "skill.md");
  if (!main) throw new ValidationError("No SKILL.md at the top of the skill folder");
  return { skillMd: new TextDecoder().decode(main.data), files: inRoot.filter((f) => f !== main) };
}

export interface SkillDeps {
  db: Database;
  blobs: BlobStoreResolver;
  /** Tests: fake HTTP and DNS for URL imports. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  resolveHost?: ResolveHost;
  /** The workspace's GitHub (its connection, the GitHub App), for private repositories. None: public ones only. */
  github?: { connectors: ConnectorDeps; app?: GitHubAppConfig | null };
}

/** Which of the workspace's GitHub connections read a private repository: the GitHub App, or the GitHub connector. */
export type SkillVia = "github_app" | "github";

export interface SkillView {
  id: string;
  name: string;
  description: string;
  version: number;
  source: string;
  sourceUrl: string | null;
  sourceVia: SkillVia | null;
  defaultForNewAgents: boolean;
  metadata: Record<string, unknown>;
  /** `person` or `agent` (promoted from an agent's how-tos, ADR 0120). */
  origin: "person" | "agent";
  ownerAgentId: string | null;
  locked: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail extends SkillView {
  body: string;
  files: { path: string; size: number; mime: string; status: SkillFileStatus }[];
}

const view = (s: SkillRow): SkillView => ({
  id: s.id,
  name: s.name,
  description: s.description,
  version: s.version,
  source: s.source,
  sourceUrl: s.sourceUrl,
  sourceVia: s.sourceVia as SkillVia | null,
  defaultForNewAgents: s.defaultForNewAgents,
  metadata: s.metadata,
  origin: s.origin === "agent" ? "agent" : "person",
  ownerAgentId: s.ownerAgentId,
  locked: s.locked,
  useCount: s.useCount,
  lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

/** Files of the skill's current version. */
export async function skillFilesOf(db: Database, s: SkillRow) {
  const rows = await db
    .select()
    .from(skillFiles)
    .where(and(eq(skillFiles.skillId, s.id), eq(skillFiles.version, s.version)))
    .orderBy(asc(skillFiles.path));
  return rows.map((f) => ({ path: f.path, size: f.size, mime: f.mime, status: f.status as SkillFileStatus }));
}

async function loadSkill(db: Database, orgId: string, id: string) {
  const [s] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.orgId, orgId), isNull(skills.deletedAt)));
  if (!s) throw new NotFoundError("Skill not found");
  return s;
}

/**
 * A skill whose files have these paths and sizes within the limits, refused as an upload is. Ignored files (binaries
 * such as images and videos) are only listed, never stored: they count as files, not toward the size.
 */
function assertSkillSize(files: { path: string; size: number }[]) {
  if (files.length > SKILL_LIMITS.maxFiles) {
    throw new ValidationError(`Too many files (max ${SKILL_LIMITS.maxFiles})`, "skill.too_many_files", {
      max: SKILL_LIMITS.maxFiles,
    });
  }
  if (files.reduce((n, f) => n + (classifyFile(f.path).status === "ignored" ? 0 : f.size), 0) > SKILL_LIMITS.maxBytes) {
    throw new ValidationError("The skill is too large (max 2 MB)", "skill.too_large", {
      max: SKILL_LIMITS.maxBytes / 1024 / 1024,
    });
  }
}

/** Where a version's files go and how each is kept, refused before the skill or any file is written. */
async function planFiles(deps: SkillDeps, orgId: string, files: SkillFileInput[]) {
  assertSkillSize(files.map((f) => ({ path: f.path, size: f.data.byteLength })));
  // Two entries that normalize to the same path would share one blob key: the second's bytes overwrite
  // the first on disk while its row insert is dropped on the unique key, so the stored size stops matching disk.
  const normalized = files.map((f) => ({ path: safePath(f.path), data: f.data }));
  const seen = new Set<string>();
  for (const { path } of normalized) {
    if (seen.has(path)) throw new ValidationError(`Two files share the path ${path}`, "skill.duplicate_path");
    seen.add(path);
  }
  const location = await deps.blobs.forOrg(orgId);
  const planned = normalized.map((n) => ({ ...n, ...classifyFile(n.path) }));
  // The workspace's own bucket counts against no limit of ours. Storing no file (the skill's text is in the database)
  // takes no room, even past a limit lowered below what the workspace already keeps.
  const stored = planned.filter((p) => p.status !== "ignored").reduce((n, p) => n + p.data.byteLength, 0);
  if (location.storageConfigId === null && stored > 0) await assertStorageRoom(deps.db, orgId, stored);
  return { location, files: planned };
}

/** Stores a version's files: showable ones in the blob store, the rest only listed as ignored. */
async function storeFiles(
  deps: SkillDeps,
  s: { id: string; orgId: string },
  version: number,
  { location, files }: Awaited<ReturnType<typeof planFiles>>,
) {
  for (const { path, data, mime, status } of files) {
    let blobKey: string | null = null;
    if (status !== "ignored") {
      blobKey = `${location.prefix}skills/${s.id}/v${version}/${path}`;
      await location.store.put(blobKey, data, { contentType: mime });
    }
    await deps.db.insert(skillFiles).values({
      orgId: s.orgId,
      skillId: s.id,
      version,
      path,
      size: data.byteLength,
      mime,
      status,
      storageConfigId: status !== "ignored" ? location.storageConfigId : null,
      blobKey,
    });
  }
}

/**
 * Installs or updates a skill from parsed content (admins, `manage_agents`).
 * The same name again is a new version of that skill; every change is audited.
 */
export async function saveSkill(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  input: ParsedSkill & {
    source: "upload" | "url" | "manual";
    sourceUrl?: string | null;
    sourceVia?: SkillVia | null;
    files?: SkillFileInput[];
    defaultForNewAgents?: boolean;
  },
): Promise<SkillDetail> {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  validateSkill(input);
  const files = await planFiles(deps, orgId, input.files ?? []);
  const [existing] = await deps.db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, orgId), eq(skills.slug, input.name)));
  let row: SkillRow;
  if (existing) {
    // Same name: a new version of that skill. A deleted one comes back (with its agents' assignments).
    const [updated] = await deps.db
      .update(skills)
      .set({
        description: input.description,
        body: input.body,
        metadata: input.metadata,
        source: input.source,
        sourceUrl: input.sourceUrl ?? existing.sourceUrl,
        // A link read again says how it was read; an edit or an upload keeps what updating reads through.
        sourceVia: input.source === "url" ? (input.sourceVia ?? null) : existing.sourceVia,
        // Incremented in SQL (not from the value read above) so two concurrent saves take distinct versions.
        version: sql`${skills.version} + 1`,
        ...(input.defaultForNewAgents !== undefined ? { defaultForNewAgents: input.defaultForNewAgents } : {}),
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, existing.id))
      .returning();
    if (!updated) throw new Error("skill update returned nothing");
    row = updated;
  } else {
    const [created] = await deps.db
      .insert(skills)
      .values({
        orgId,
        slug: input.name,
        name: input.name,
        description: input.description,
        body: input.body,
        metadata: input.metadata,
        source: input.source,
        sourceUrl: input.sourceUrl ?? null,
        sourceVia: input.sourceVia ?? null,
        defaultForNewAgents: input.defaultForNewAgents ?? false,
        createdByUserId: actorId,
      })
      .returning();
    if (!created) throw new Error("skill insert returned nothing");
    row = created;
  }
  await storeFiles(deps, row, row.version, files);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: existing && !existing.deletedAt ? "skill.updated" : existing ? "skill.restored" : "skill.installed",
    target: { type: "skill", id: row.id },
    details: {
      name: row.name,
      version: row.version,
      source: row.source,
      sourceUrl: row.sourceUrl,
      ...(row.sourceVia ? { sourceVia: row.sourceVia } : {}),
    },
  });
  return { ...view(row), body: row.body, files: await skillFilesOf(deps.db, row) };
}

/** Import from a zip of the skill folder (`SKILL.md` + files). */
export async function importSkillZip(deps: SkillDeps, actorId: string, orgId: string, zip: Uint8Array) {
  const entries = readZip(
    zip,
    { maxFiles: SKILL_LIMITS.maxFiles, maxBytes: SKILL_LIMITS.maxBytes },
    (path) => classifyFile(path).status === "ignored",
  );
  const { skillMd, files } = splitSkillFolder(entries);
  return saveSkill(deps, actorId, orgId, { ...parseSkillMarkdown(skillMd), source: "upload", files });
}

const GITHUB_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "api.github.com", "codeload.github.com"]);

/** Outbound HTTP and DNS for GitHub reads (tests: fakes). */
export interface GithubFetchDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  resolveHost?: ResolveHost;
}

export interface GithubFetchOptions {
  maxBytes: number;
  tooLarge: string;
  /** Redirects followed, each hop checked as the first request is. None by default: a redirect is refused. */
  redirects?: number;
  /** Over the whole exchange, body included (default 15 s). */
  timeoutMs?: number;
}

/**
 * Minutes until GitHub stops limiting this server, or null when it isn't. GitHub answers 403 or 429 and says when
 * to retry in `retry-after` (seconds), else in `x-ratelimit-reset` once none remain, else "at least one minute"
 * (docs.github.com, "Rate limits for the REST API").
 */
function githubWaitMinutes(res: Response): number | null {
  const retryAfter = Number(res.headers.get("retry-after"));
  const spent = res.headers.get("x-ratelimit-remaining") === "0";
  if (res.status !== 429 && !(res.status === 403 && (spent || retryAfter > 0))) return null;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const seconds = retryAfter > 0 ? retryAfter : spent && reset > 0 ? reset - Date.now() / 1000 : 60;
  return Math.max(1, Math.ceil(seconds / 60));
}

const GITHUB_API = "https://api.github.com";

/** GitHub didn't answer (no answer, a 5xx while making a token): trying again later may read it. */
const unreachable = () => new ValidationError("Could not reach GitHub", "github.unreachable");

/**
 * One GET to a GitHub host through the SSRF guard (on every hop); GitHub limiting this server is refused as such.
 * `token` goes to api.github.com only: the archive it redirects to carries a short-lived link of its own.
 */
async function githubGet(
  deps: GithubFetchDeps,
  url: string,
  accept: string,
  options: GithubFetchOptions,
  token?: string,
) {
  const http = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const redirects = options.redirects ?? 0;
  let next = url;
  for (let hop = 0; ; hop++) {
    const at = await assertPublicHttpsUrl(next, deps.resolveHost);
    if (!GITHUB_HOSTS.has(at.hostname)) throw new ValidationError("Only GitHub URLs can be imported for now");
    const headers: Record<string, string> = { accept, "user-agent": "agentes.chat" };
    if (token && at.origin === GITHUB_API) headers.authorization = `Bearer ${token}`;
    const res = await http(at.toString(), {
      headers,
      redirect: redirects > 0 ? "manual" : "error",
      signal,
    }).catch(() => {
      throw unreachable();
    });
    const location = res.headers.get("location");
    if (hop < redirects && res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      next = new URL(location, at).toString();
      continue;
    }
    const minutes = githubWaitMinutes(res);
    if (minutes !== null) {
      throw new TooManyError(`GitHub is limiting downloads for now. Try again in ${minutes} min.`, "github.limited", {
        count: minutes,
      });
    }
    return { res, at };
  }
}

/** A success's body, refused past `maxBytes` while it streams (codeload sends no length). */
async function githubBody(res: Response, at: URL, options: GithubFetchOptions) {
  if (!res.ok) throw new ValidationError(`GitHub answered ${res.status} for ${at.pathname}`);
  if (Number(res.headers.get("content-length") ?? 0) > options.maxBytes) throw new ValidationError(options.tooLarge);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > options.maxBytes) throw new ValidationError(options.tooLarge);
        chunks.push(chunk);
      }
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw unreachable();
  }
  return Buffer.concat(chunks);
}

/**
 * GET one GitHub URL (github.com, raw.githubusercontent.com, api.github.com or codeload.github.com only), with the
 * SSRF guard, no redirects unless `options.redirects`, a timeout and a size cap.
 */
export async function fetchGithub(deps: GithubFetchDeps, url: string, accept: string, options: GithubFetchOptions) {
  const { res, at } = await githubGet(deps, url, accept, options);
  return githubBody(res, at, options);
}

/**
 * Where a GitHub URL points: a folder (the repository, or `/tree/{ref}/{path}`) or a file (`/blob/…` or
 * raw.githubusercontent), with its path decoded. No ref is the default branch (`HEAD`).
 */
export function parseGithubUrl(url: string) {
  let u: URL;
  let segments: string[];
  try {
    u = new URL(url);
    segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new ValidationError("Unrecognized GitHub URL");
  }
  if (u.hostname === "raw.githubusercontent.com") {
    const [owner, repo, ...rest] = segments;
    // GitHub's Raw button spells the branch out: `refs/heads/main/…`.
    const [ref, ...path] = rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") ? rest.slice(2) : rest;
    if (!owner || !repo || !ref || path.length === 0) throw new ValidationError("Unrecognized GitHub URL");
    return { kind: "file" as const, owner, repo, ref, path: path.join("/") };
  }
  if (u.hostname !== "github.com") throw new ValidationError("Only GitHub URLs can be imported for now");
  const [owner, name, mode, ref, ...rest] = segments;
  const repo = name?.replace(/\.git$/, "");
  if (!owner || !repo) throw new ValidationError("Unrecognized GitHub URL");
  if (mode === "blob" && ref) return { kind: "file" as const, owner, repo, ref, path: rest.join("/") };
  if (mode === "tree" && ref) return { kind: "folder" as const, owner, repo, ref, path: rest.join("/") };
  return { kind: "folder" as const, owner, repo, ref: "HEAD", path: "" };
}

type GithubTarget = ReturnType<typeof parseGithubUrl>;

/** A repository's archive is downloaded whole: past this size a link into it can't be read. */
const ARCHIVE: GithubFetchOptions = {
  maxBytes: 50 * 1024 * 1024,
  tooLarge: "The repository is too large to download (max 50 MB). Upload the skill's folder as a .zip instead.",
  // github.com redirects to codeload.github.com, and first to the new name of a renamed repository.
  redirects: 3,
  timeoutMs: 60_000,
};

/** How deep below a link a SKILL.md is looked for, and how many skills one link may hold. */
const SKILL_SEARCH = { depth: 6, max: 100 };

/** A path for a URL: each segment percent-encoded, the slashes kept. */
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The key of `folders` that is `dir` or a folder above it ("" the root), if any: one lookup a level. */
function folderOf(folders: ReadonlyMap<string, unknown>, dir: string): string | undefined {
  for (let at = dir; ; at = parentOf(at)) {
    if (folders.has(at)) return at;
    if (!at) return undefined;
  }
}

const refMissing = (target: GithubTarget) => {
  const repo = `${target.owner}/${target.repo}`;
  return new ValidationError(`${repo} has no branch, tag or commit ${target.ref}`, "github.ref_missing", {
    repo,
    ref: target.ref,
  });
};

/** An archive's files by path from the repository's root, symbolic links left out. */
function repositoryOf(zip: Uint8Array) {
  const files = new Map<string, ZipListing>();
  for (const entry of listZip(zip)) {
    // Every path starts with the archive's own folder (`{repo}-{ref}/`, `{owner}-{repo}-{commit}/` from the API).
    const slash = entry.path.indexOf("/");
    if (!entry.symlink && slash > 0) files.set(entry.path.slice(slash + 1), entry);
  }
  return { zip, files };
}

type GithubRepository = ReturnType<typeof repositoryOf>;

/**
 * The repository at the link's ref, from its zip archive (`github.com/{owner}/{repo}/archive/{ref}.zip`, served by
 * codeload.github.com): one download, outside the REST API, where unauthenticated calls share one limit per server
 * address (60 an hour) that every workspace's imports would spend. Null when github.com hides it (private, or
 * missing).
 */
async function publicRepository(deps: SkillDeps, target: GithubTarget) {
  const archive = `https://github.com/${encodePath(`${target.owner}/${target.repo}`)}/archive/${encodePath(target.ref)}.zip`;
  const { res, at } = await githubGet(deps, archive, "application/zip", ARCHIVE);
  if (res.status === 404) {
    await res.body?.cancel();
    // Past github.com's redirect, codeload lacks the ref.
    if (at.hostname === "codeload.github.com" && target.ref !== "HEAD") throw refMissing(target);
    return null;
  }
  return repositoryOf(await githubBody(res, at, ARCHIVE));
}

/**
 * The repository's archive read with one of the workspace's tokens (`api.github.com/repos/{repo}/zipball/{ref}`, on
 * the token's own limit). Null when the token works and can't read it (403, an organization's SSO say, or 404),
 * `refused` when GitHub no longer takes it (401). The API answers 404 alike for a ref the repository lacks and for a
 * repository the token can't see: asking for the repository tells them apart.
 */
async function tokenRepository(deps: SkillDeps, target: GithubTarget, token: string) {
  const repo = `${GITHUB_API}/repos/${encodePath(target.owner)}/${encodePath(target.repo)}`;
  const ref = target.ref === "HEAD" ? "" : `/${encodePath(target.ref)}`;
  const { res, at } = await githubGet(deps, `${repo}/zipball${ref}`, "application/vnd.github+json", ARCHIVE, token);
  if (res.ok) return repositoryOf(await githubBody(res, at, ARCHIVE));
  await res.body?.cancel();
  if (res.status === 404 && target.ref !== "HEAD") {
    const seen = await githubGet(deps, repo, "application/vnd.github+json", ARCHIVE, token);
    await seen.res.body?.cancel();
    if (seen.res.ok) throw refMissing(target);
  }
  if (res.status === 401) return "refused" as const;
  if (res.status === 403 || res.status === 404) return null;
  throw new ValidationError(`GitHub answered ${res.status} for ${at.pathname}`);
}

/** An account or repository name as GitHub allows it, so building an API path from one never climbs out of it. */
const GITHUB_NAME = /^(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

/** A link a token may go with: its owner, repository and ref can't climb out of the repository's API path. */
const tokenSafe = (target: GithubTarget) =>
  GITHUB_NAME.test(target.owner) &&
  GITHUB_NAME.test(target.repo) &&
  !target.ref.split("/").some((s) => s === "." || s === "..");

/**
 * The GitHub App's token for the repository (only from an installation on its account bound to this workspace), and
 * whether GitHub left one of the requests for it unanswered (no answer, or a 5xx).
 */
async function appToken(deps: SkillDeps, orgId: string, app: GitHubAppConfig, target: GithubTarget) {
  const seen = { unanswered: false };
  const send = deps.fetch ?? fetch;
  const http: GitHubHttp = {
    apiUrl: GITHUB_API,
    fetch: (async (url: string, init?: RequestInit) => {
      const res = await send(url, init).catch((err) => {
        seen.unanswered = true;
        throw err;
      });
      if (res.status >= 500) seen.unanswered = true;
      return res;
    }) as typeof fetch,
  };
  const tenant = { db: deps.db, orgId };
  const read = { contents: "read" } as const;
  const token = await appTokenForRepo(app, http, tenant, target.owner, target.repo, read).catch(() => null);
  return { token, unanswered: seen.unanswered };
}

/** The workspace's GitHub connection: none, one GitHub refuses (a token it no longer takes), or one that works. */
type GithubConnectionState = "none" | "refused" | "ok";

/**
 * The repository a link points into, and which of the workspace's GitHub connections read it (null: none was
 * needed). A repository github.com hides is read with the workspace's tokens, which never leave the server: the
 * GitHub App's for it, then the GitHub connection's, each made only when the one before can't read it. `through`: how
 * a skill installed before was read, tried first and with no read without credentials before it (the other
 * connection follows it, so a skill never stays stuck on one the workspace replaced).
 *
 * None reads it: `github.unreachable` when GitHub left a token request unanswered, `skill.connection_gone` when the
 * workspace no longer has the connection `through` names, else `github.repo_missing` with the connection's state and
 * whether the GitHub App is installed on some account (`app`).
 */
async function readRepository(deps: SkillDeps, orgId: string, target: GithubTarget, through: SkillVia | null) {
  const repo = `${target.owner}/${target.repo}`;
  if (!through) {
    const open = await publicRepository(deps, target);
    if (open) return { ...open, via: null };
  }
  const github = deps.github;
  const connection = github && (await activeConnections(deps.db, orgId)).find((c) => c.connector === "github");
  let state: GithubConnectionState = connection ? "ok" : "none";
  let unanswered = false;
  if (github && tokenSafe(target)) {
    const order: SkillVia[] = through === "github" ? ["github", "github_app"] : ["github_app", "github"];
    for (const via of order) {
      let token: string | null = null;
      if (via === "github_app" && github.app) {
        const made = await appToken(deps, orgId, github.app, target);
        token = made.token;
        unanswered ||= made.unanswered;
      } else if (via === "github" && connection) {
        const made = await connectionToken(github.connectors, connection).then(
          (value) => ({ value, failed: false }),
          // A refresh the provider refused needs connecting again; one that got no answer may work later.
          (err: unknown) => ({ value: null, failed: !(err instanceof ValidationError) }),
        );
        token = made.value;
        unanswered ||= made.failed;
        if (!token && !made.failed) state = "refused";
      }
      if (!token) continue;
      const found = await tokenRepository(deps, target, token);
      if (found === "refused") {
        if (via === "github") state = "refused";
      } else if (found) return { ...found, via };
    }
  }
  if (unanswered) throw unreachable();
  const installations = github?.app ? await boundInstallations(deps.db, orgId) : [];
  const owner = target.owner.toLowerCase();
  const gone =
    through === "github"
      ? !connection
      : through === "github_app" && !installations.some((i) => i.accountLogin.toLowerCase() === owner);
  if (gone) {
    throw new ValidationError(`The GitHub connection that read ${repo} is gone`, "skill.connection_gone", { repo });
  }
  throw new ValidationError(`${repo} is private or doesn't exist on GitHub`, "github.repo_missing", {
    repo,
    connection: state,
    app: installations.length > 0,
  });
}

/**
 * The skill folders at or below `folder`, each with its SKILL.md, by path. A SKILL.md inside another skill's folder
 * is a file of that skill, not a skill of its own.
 */
function skillFolders(files: GithubRepository["files"], folder: string) {
  const depth = (dir: string) => (dir ? dir.split("/").length : 0);
  const prefix = folder ? `${folder}/` : "";
  const found = [...files]
    .filter(([path]) => path.startsWith(prefix) && /(^|\/)skill\.md$/i.test(path))
    .map(([path, entry]) => [parentOf(path), entry] as const)
    .filter(([dir]) => depth(dir) - depth(folder) <= SKILL_SEARCH.depth)
    .sort(([a], [b]) => depth(a) - depth(b));
  const skills = new Map<string, ZipListing>();
  for (const [dir, entry] of found) if (folderOf(skills, dir) === undefined) skills.set(dir, entry);
  return new Map([...skills].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** A skill folder of the repository (`inside`: its files) as an upload's: binaries are listed, never inflated. */
function repositorySkill(zip: Uint8Array, dir: string, inside: [string, ZipListing][]) {
  const prefix = dir ? `${dir}/` : "";
  const { skillMd, files } = splitSkillFolder(
    inside.map(([path, entry]) => {
      const relative = path.slice(prefix.length);
      const ignored = classifyFile(relative).status === "ignored";
      return { path: relative, data: ignored ? new Uint8Array() : inflateZipEntry(zip, entry) };
    }),
  );
  return { ...parseSkillMarkdown(skillMd), files };
}

/** A skill a GitHub link holds, offered to pick when it holds several. `path`: its folder from the repository's root. */
export interface SkillChoice {
  path: string;
  name: string;
  description: string;
}

/** A skill a GitHub link holds that can't be installed, with the refusal: its code, English text and params. */
export interface SkillSkipped {
  path: string;
  code: string;
  message: string;
  params?: ErrorParams;
}

/**
 * What a GitHub link holds: the repository, how it was read, and the skill folders at or below the link (a file's:
 * its folder's).
 */
async function readGithubLink(deps: SkillDeps, orgId: string, url: string, through: SkillVia | null = null) {
  const target = parseGithubUrl(url);
  const repository = await readRepository(deps, orgId, target, through);
  const folder = target.kind === "file" ? parentOf(target.path) : target.path;
  const folders = skillFolders(repository.files, folder);
  const repo = `${target.owner}/${target.repo}`;
  if (folders.size === 0) {
    const where = folder ? `${repo}/${folder}` : repo;
    throw new ValidationError(`No SKILL.md in ${where} or the folders inside it`, "skill.no_skill_md", { path: where });
  }
  if (folders.size > SKILL_SEARCH.max) {
    throw new ValidationError(
      `That link holds more than ${SKILL_SEARCH.max} skills. Link one of its folders.`,
      "skill.too_many_skills",
      { max: SKILL_SEARCH.max },
    );
  }
  const found = new Map([...folders].map(([dir, skillMd]) => [dir, { skillMd, files: [] as [string, ZipListing][] }]));
  // Every skill's files in one pass: no skill folder holds another.
  for (const file of repository.files) {
    const dir = folderOf(found, parentOf(file[0]));
    if (dir !== undefined) found.get(dir)?.files.push(file);
  }
  /** The skill at `dir`, refused past the skill limits. */
  const skillIn = (dir: string) => {
    const skill = found.get(dir);
    if (!skill) throw new ValidationError(`That link holds no skill at ${dir}`);
    assertSkillSize(skill.files.map(([path, entry]) => ({ path, size: entry.size })));
    return skill;
  };
  /** The skill at `dir` from its SKILL.md alone, refused as installing it would be for its limits or its text. */
  const about = (dir: string) =>
    parseSkillMarkdown(new TextDecoder().decode(inflateZipEntry(repository.zip, skillIn(dir).skillMd)));
  /** The skill at `dir`, ready to save: from the link itself when it points at the skill, else from its folder. */
  const skillAt = (dir: string) => ({
    ...repositorySkill(repository.zip, dir, skillIn(dir).files),
    source: "url" as const,
    sourceUrl:
      dir === folder ? url : `https://github.com/${encodePath(repo)}/tree/${encodePath(target.ref)}/${encodePath(dir)}`,
    sourceVia: repository.via,
  });
  return { found, about, skillAt, via: repository.via };
}

/**
 * A GitHub link holding several skills: those that can be installed, to pick, and those that can't, with why. `via`:
 * which of the workspace's GitHub connections read it, when the repository needed one.
 */
export interface SkillPick {
  choices: SkillChoice[];
  skipped?: SkillSkipped[];
  via?: SkillVia;
}

/**
 * Import from a GitHub link, read by the backend from the repository's archive (only GitHub hosts, the SSRF guard
 * on every request, 200 files a skill and 2 MB of the text and scripts it keeps, binaries only listed): the skill
 * folder it points at (a file's folder), or the one skill below it. A link that holds several answers with them to
 * pick from (`importPickedSkills`), nothing installed, and with those that can't be installed (past the limits, or a
 * SKILL.md that doesn't parse) apart, each with why; `list` answers so for one skill too. Installing a skill whose
 * name is already installed makes a new version. A private repository is read through the workspace's GitHub (the
 * GitHub App, else the connection): installing skills (`manage_agents`) is what lets a person read through it.
 * `through`: that connection first, with no read without credentials (a skill updated from the link it came from).
 */
export async function importSkillFromUrl(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  url: string,
  options: { list?: boolean; through?: SkillVia | null } = {},
): Promise<SkillDetail | SkillPick> {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const link = await readGithubLink(deps, orgId, url, options.through);
  const [only, ...more] = link.found.keys();
  if (!options.list && only !== undefined && more.length === 0) {
    return saveSkill(deps, actorId, orgId, link.skillAt(only));
  }
  const choices: SkillChoice[] = [];
  const skipped: SkillSkipped[] = [];
  let refused: unknown;
  for (const path of link.found.keys()) {
    try {
      const { name, description } = link.about(path);
      choices.push({ path, name, description });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      refused ??= err;
      skipped.push({ path, code: err.code, message: err.message, ...(err.params ? { params: err.params } : {}) });
    }
  }
  if (choices.length === 0) throw refused;
  return { choices, ...(skipped.length > 0 ? { skipped } : {}), ...(link.via ? { via: link.via } : {}) };
}

/** Installs the skills picked among a link's choices (`paths`, as `importSkillFromUrl` gave them). */
export async function importPickedSkills(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  url: string,
  paths: string[],
) {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const link = await readGithubLink(deps, orgId, url);
  // Every pick is checked before any is saved; a refusal names the skill's folder.
  const skills = [...new Set(paths)].map((dir) => {
    if (!link.found.has(dir)) throw new ValidationError(`That link holds no skill at ${dir}`);
    try {
      return link.skillAt(dir);
    } catch (err) {
      if (err instanceof ValidationError) throw new ValidationError(`${dir}: ${err.message}`, err.code, err.params);
      throw err;
    }
  });
  const twin = skills.find((s, i) => skills.findIndex((other) => other.name === s.name) !== i);
  if (twin) throw new ValidationError(`Two of the skills picked are named ${twin.name}. Pick one of them.`);
  const installed: SkillDetail[] = [];
  for (const skill of skills) installed.push(await saveSkill(deps, actorId, orgId, skill));
  return installed;
}

/**
 * Imports the skill again from where it came (a new version). A skill a GitHub connection read is read through it
 * first, then through the workspace's other one, and keeps the one that read it (`skill.connection_gone` when the
 * workspace no longer has the first and the other can't read it).
 */
export async function reimportSkill(deps: SkillDeps, actorId: string, orgId: string, id: string) {
  const s = await loadSkill(deps.db, orgId, id);
  if (!s.sourceUrl) throw new ValidationError("This skill wasn't imported from a URL");
  const through = s.sourceVia as SkillVia | null;
  const again = await importSkillFromUrl(deps, actorId, orgId, s.sourceUrl, { through });
  if ("choices" in again) {
    throw new ValidationError("Its link holds several skills now. Install this one again from its own folder.");
  }
  return again;
}

export async function listSkills(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, orgId), isNull(skills.deletedAt)))
    .orderBy(asc(skills.name));
  const counts = await db
    .select({ skillId: agentSkills.skillId, n: sql<number>`count(*)::int` })
    .from(agentSkills)
    .innerJoin(schema.agents, eq(schema.agents.id, agentSkills.agentId))
    .where(and(eq(agentSkills.orgId, orgId), eq(agentSkills.enabled, true), isNull(schema.agents.archivedAt)))
    .groupBy(agentSkills.skillId);
  const byId = new Map(counts.map((c) => [c.skillId, Number(c.n)]));
  /** How many active agents have each skill on. */
  return rows.map((r) => ({ ...view(r), agentsCount: byId.get(r.id) ?? 0 }));
}

export async function getSkill(db: Database, actorId: string, orgId: string, id: string): Promise<SkillDetail> {
  await requirePermission(db, actorId, orgId, "read");
  const s = await loadSkill(db, orgId, id);
  return { ...view(s), body: s.body, files: await skillFilesOf(db, s) };
}

/** Edits by hand (a new version); renaming isn't allowed (the name is the skill's identity). */
export async function updateSkill(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  id: string,
  input: { description?: string; body?: string; defaultForNewAgents?: boolean },
) {
  const s = await loadSkill(deps.db, orgId, id);
  if (input.description === undefined && input.body === undefined && input.defaultForNewAgents !== undefined) {
    await requirePermission(deps.db, actorId, orgId, "manage_agents");
    await deps.db
      .update(skills)
      .set({ defaultForNewAgents: input.defaultForNewAgents, updatedAt: new Date() })
      .where(eq(skills.id, s.id));
    return getSkill(deps.db, actorId, orgId, id);
  }
  return saveSkill(deps, actorId, orgId, {
    name: s.name,
    description: input.description ?? s.description,
    body: input.body ?? s.body,
    metadata: s.metadata,
    source: "manual",
    sourceUrl: s.sourceUrl,
    defaultForNewAgents: input.defaultForNewAgents,
  });
}

export async function deleteSkill(db: Database, actorId: string, orgId: string, id: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const s = await loadSkill(db, orgId, id);
  // Soft delete: agents stop seeing it at once; their assignments come back if the skill is installed again.
  await db.update(skills).set({ deletedAt: new Date() }).where(eq(skills.id, s.id));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "skill.deleted",
    target: { type: "skill", id: s.id },
    details: { name: s.name },
  });
}

/**
 * A skill's body as a new version, its files carried over to it (they are stored per version). For changes that
 * come from use, not from a person's editor: an agent's own skill (`update_skill`), an accepted proposal, an undo.
 */
export async function writeSkillBody(db: Database, s: SkillRow, body: string): Promise<SkillRow> {
  const [row] = await db
    .update(skills)
    .set({ body, version: sql`${skills.version} + 1`, updatedAt: new Date() })
    .where(eq(skills.id, s.id))
    .returning();
  if (!row) throw new NotFoundError("Skill not found");
  await db.execute(sql`insert into skill_files (org_id, skill_id, version, path, size, mime, status, storage_config_id, blob_key)
    select org_id, skill_id, ${row.version}, path, size, mime, status, storage_config_id, blob_key
    from skill_files where skill_id = ${s.id}::uuid and version = ${row.version - 1}`);
  return row;
}

/** A person locks or unlocks a skill: a locked one agents can't change and is never archived for disuse. */
export async function setSkillLocked(db: Database, actorId: string, orgId: string, id: string, locked: boolean) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const s = await loadSkill(db, orgId, id);
  await db.update(skills).set({ locked, updatedAt: new Date() }).where(eq(skills.id, s.id));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: locked ? "skill.locked" : "skill.unlocked",
    target: { type: "skill", id: s.id },
    details: { name: s.name },
  });
  return getSkill(db, actorId, orgId, id);
}

/** Brings back a skill archived for disuse (or deleted), with its agents' assignments. */
export async function restoreSkill(db: Database, actorId: string, orgId: string, id: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const [s] = await db
    .update(skills)
    .set({ deletedAt: null, lastUsedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(skills.id, id), eq(skills.orgId, orgId)))
    .returning();
  if (!s) throw new NotFoundError("Skill not found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "skill.restored",
    target: { type: "skill", id: s.id },
    details: { name: s.name },
  });
  return getSkill(db, actorId, orgId, id);
}

/** The skills an agent made itself (`origin` agent), archived ones too, newest first: "What it learned". */
export async function agentMadeSkills(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, orgId), eq(skills.origin, "agent"), eq(skills.ownerAgentId, agentId)))
    .orderBy(sql`${skills.createdAt} desc`);
  return rows.map((r) => ({ ...view(r), body: r.body, archived: r.deletedAt !== null }));
}

/** The org's skills with whether this agent has each one on. */
export async function agentSkillList(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  const [all, mine] = await Promise.all([
    listSkills(db, actorId, orgId),
    db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.orgId, orgId), eq(agentSkills.agentId, agentId))),
  ]);
  const on = new Map(mine.map((m) => [m.skillId, m.enabled]));
  return all.map((s) => ({ ...s, enabled: on.get(s.id) ?? false }));
}

/** Turns skills on or off for an agent (admins or its owner). */
export async function setAgentSkills(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  input: { skillId: string; enabled: boolean }[],
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can change its skills");
  }
  const ids = [...new Set(input.map((i) => i.skillId))];
  if (ids.length > 0) {
    const found = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.orgId, orgId), inArray(skills.id, ids), isNull(skills.deletedAt)));
    if (found.length !== ids.length) throw new ValidationError("Every skill must belong to this organization");
  }
  for (const i of input) {
    await db
      .insert(agentSkills)
      .values({ orgId, agentId, skillId: i.skillId, enabled: i.enabled })
      .onConflictDoUpdate({ target: [agentSkills.agentId, agentSkills.skillId], set: { enabled: i.enabled } });
  }
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.skills_changed",
    target: { type: "agent", id: agentId },
    details: { skills: input },
  });
  return agentSkillList(db, actorId, orgId, agentId);
}

/** The agent's enabled skills (name and description only: the body loads on demand). */
export async function enabledSkills(db: Database, orgId: string, agentId: string) {
  return db
    .select({ id: skills.id, name: skills.name, description: skills.description, version: skills.version })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(
      and(
        eq(agentSkills.orgId, orgId),
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.enabled, true),
        eq(skills.orgId, orgId),
        isNull(skills.deletedAt),
      ),
    )
    .orderBy(asc(skills.name));
}

/** A skill this agent has on, by name, with its files (for `load_skill` / `read_skill_file`). */
export async function agentSkillByName(db: Database, orgId: string, agentId: string, name: string) {
  const [row] = await db
    .select({ skill: skills })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(
      and(
        eq(agentSkills.orgId, orgId),
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.enabled, true),
        eq(skills.orgId, orgId),
        eq(skills.slug, name.trim().toLowerCase()),
        isNull(skills.deletedAt),
      ),
    );
  return row?.skill ?? null;
}

export async function skillFileText(deps: SkillDeps, s: SkillRow, path: string, version = s.version) {
  const [f] = await deps.db
    .select()
    .from(skillFiles)
    .where(and(eq(skillFiles.skillId, s.id), eq(skillFiles.version, version), eq(skillFiles.path, path)));
  if (!f) throw new NotFoundError(`No file ${path} in this skill`);
  if (f.status === "script") {
    throw new NotFoundError(`${path} is a script: it is never shown, only run on your computer with run_skill_script`);
  }
  if (f.status !== "stored" || !f.blobKey) {
    throw new NotFoundError(`${path} is not available: binaries are listed only, never stored`);
  }
  const store = await deps.blobs.forConfig(s.orgId, f.storageConfigId);
  const object = await store.get(f.blobKey);
  if (!object) throw new NotFoundError(`The stored file ${path} is missing`);
  return new TextDecoder().decode(object.body);
}

/** `GET …/skills/{id}/files/{path}`: a stored text file of a version (default: current). */
export async function getSkillFile(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  skillId: string,
  path: string,
  version?: number,
) {
  await requirePermission(deps.db, actorId, orgId, "read");
  const s = await loadSkill(deps.db, orgId, skillId);
  const text = await skillFileText(deps, s, path, version ?? s.version);
  const { mime } = classifyFile(path);
  return { path, version: version ?? s.version, mime, content: text };
}

/**
 * Every kept file of the skill's version (text and scripts), with bytes: what `run_skill_script` copies onto
 * the computer.
 */
export async function skillFolderFiles(deps: SkillDeps, s: SkillRow) {
  const rows = await deps.db
    .select()
    .from(skillFiles)
    .where(and(eq(skillFiles.skillId, s.id), eq(skillFiles.version, s.version)));
  const out: { path: string; status: SkillFileStatus; data: Uint8Array }[] = [];
  for (const f of rows) {
    if (f.status === "ignored" || !f.blobKey) continue;
    const store = await deps.blobs.forConfig(s.orgId, f.storageConfigId);
    const object = await store.get(f.blobKey);
    if (object) out.push({ path: f.path, status: f.status as SkillFileStatus, data: object.body });
  }
  return out;
}
