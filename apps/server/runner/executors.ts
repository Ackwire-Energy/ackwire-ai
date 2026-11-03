import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { CursorModelInfo, RunnerInfo } from "@agenteschat/adapters/machine-protocol";
import { isOpencodeFreeModel, OPENCODE_FREE_MODELS } from "@agenteschat/providers/plans";
import { readSmallJson } from "./json-file";
import { SHARED_BIN_ENV } from "./shared-folder";

/**
 * Which coding CLIs this machine has (protocol 7, ADR 0029): `claude` and
 * `codex` on the PATH the runner (and so its tasks) sees, with the first line
 * of `--version`. Best effort and cached: `hello` carries it on every
 * connection, and a fresh look happens at most every `EXECUTORS_TTL_MS`.
 */
export const EXECUTORS_TTL_MS = 10 * 60_000;

type Run = (command: string, args: string[]) => { status: number | null; stdout: string; error?: unknown };

/**
 * `command`'s full path on the current `process.env.PATH`, or the bare name. The app mode adopts the login
 * shell's PATH after start (`adoptLoginPath`); a compiled runner still looks commands up on the PATH it
 * started with (macOS's bare one from Finder) unless told otherwise, so we resolve it ourselves.
 */
export function resolveCommand(
  command: string,
  pathList = process.env.PATH ?? "",
  sharedBin = process.env[SHARED_BIN_ENV],
): string {
  if (process.platform === "win32" || command.includes("/")) return command;
  const dirs = pathList.split(delimiter).filter((dir) => dir && dir !== sharedBin);
  for (const dir of dirs) {
    const full = join(dir, command);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {}
  }
  // A bare name would be looked up on the PATH again, shared `bin/` included: a path that isn't there fails the same.
  return sharedBin && dirs[0] ? join(dirs[0], command) : command;
}

const defaultRun: Run = (command, args) => {
  const r = spawnSync(resolveCommand(command), args, {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    env: process.env,
    // Windows finds `claude.cmd` / `codex.cmd` only through the shell.
    shell: process.platform === "win32",
  });
  return { status: r.status, stdout: `${r.stdout ?? ""}`, error: r.error };
};

const word = (v: unknown) => (typeof v === "string" && /^[\w.-]{1,40}$/.test(v) ? v : undefined);

/**
 * The rate-limit tier of the plan Anthropic sold as Max 20x, called Ultra since 2026-10-30 (claude.com/pricing);
 * the old Max 5x, now Max, is `default_claude_max_5x`.
 */
const ULTRA_TIER = "default_claude_max_20x";
/** `.claude.json` also holds the CLI's projects: one larger than this isn't read. */
const CLAUDE_CONFIG_MAX_BYTES = 4 * 1024 * 1024;
/** Claude Code's `subscriptionType` for each organization type, as the CLI maps them. */
const CLAUDE_ORG_PLANS = new Map([
  ["claude_pro", "pro"],
  ["claude_max", "max"],
  ["claude_team", "team"],
  ["claude_enterprise", "enterprise"],
]);

/**
 * Claude's plan as Anthropic names it (`pro`, `max`, `ultra`, `team`, `enterprise`): Claude Code's
 * `subscriptionType`, which says `max` for both Max and Ultra, told apart by the organization's rate-limit tier
 * (`tier`, read only for a `max`). A `max` whose tier is unknown stays `max`.
 */
export function claudePlan(subscriptionType: unknown, tier: () => unknown): string | undefined {
  const plan = word(subscriptionType);
  return plan === "max" && tier() === ULTRA_TIER ? "ultra" : plan;
}

/**
 * The organization Claude Code is signed in to, as the CLI keeps it in its config folder's `.claude.json`
 * (`oauthAccount`): its type and rate-limit tier, which `auth status` doesn't say. Its sign-in writes both, and they
 * are missing only where its bootstrap call there failed or was skipped (offline, nonessential traffic off, another
 * provider). `own`: the computer's own config, read through a link as Claude Code reads it; an account folder's never
 * is.
 */
function claudeOrganization(configDir: string, own = false) {
  const config = readSmallJson(join(configDir, ".claude.json"), CLAUDE_CONFIG_MAX_BYTES, own) as {
    oauthAccount?: { organizationType?: unknown; organizationRateLimitTier?: unknown };
  } | null;
  return config?.oauthAccount;
}

/** The rate-limit tier of the organization Claude Code is signed in to (`claudeOrganization`). */
export const claudeTier = (configDir: string, own = false): unknown =>
  claudeOrganization(configDir, own)?.organizationRateLimitTier;

/** The plan as `claudePlan` names it from `.claude.json` alone, for a folder where no CLI may run. */
export function claudeKeptPlan(configDir: string): string | undefined {
  const org = claudeOrganization(configDir);
  const type = typeof org?.organizationType === "string" ? CLAUDE_ORG_PLANS.get(org.organizationType) : undefined;
  return claudePlan(type, () => org?.organizationRateLimitTier);
}

/**
 * Protocol 8: whether Claude Code is logged in (`claude auth status --json`:
 * `loggedIn`, `authMethod`, `subscriptionType`, the plan as `claudePlan` names
 * it). Only these three leave the machine (never the email or the
 * organization). Unknown on any failure.
 */
export function claudeAuth(
  run: Run = defaultRun,
  tier: () => unknown = () => claudeTier(process.env.CLAUDE_CONFIG_DIR || homedir(), true),
): { loggedIn?: boolean; authMethod?: string; plan?: string } {
  try {
    const r = run("claude", ["auth", "status", "--json"]);
    if (r.error) return {};
    const json = JSON.parse(r.stdout.trim() || "null") as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return r.status !== 0 ? { loggedIn: false } : {};
    const authMethod = word(json.authMethod);
    const plan = claudePlan(json.subscriptionType, tier);
    return {
      ...(typeof json.loggedIn === "boolean" ? { loggedIn: json.loggedIn } : {}),
      ...(authMethod ? { authMethod } : {}),
      ...(plan ? { plan } : {}),
    };
  } catch {
    return {};
  }
}

/** Cursor's CLI, named `agent` since it was renamed from `cursor-agent`. */
export const CURSOR_BIN = "agent";

/**
 * `agent models` → the models its sign-in lists. One per line, `<id> - <label>` (or the id alone); a line that says
 * the plan includes it (`included`) marks it `inPlan`. Headers and anything that isn't a model id are skipped.
 */
export function parseCursorModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  for (const raw of clean.split("\n")) {
    const line = raw.replace(/^[\s*•>-]+/, "").trim();
    const m = /^([a-z0-9][\w.:/-]{0,79})(?:\s+[-–—:]\s+(.+))?$/i.exec(line);
    if (!m?.[1] || !/[\d-]/.test(m[1]) || out.some((x) => x.id === m[1])) continue;
    const rest = m[2]?.trim() ?? "";
    const inPlan = /\bincluded\b/i.test(rest);
    const label = rest
      .replace(/\(?\s*(?:current|default|included(?: in (?:your )?plan)?)\s*\)?/gi, "")
      .trim()
      .slice(0, 80);
    out.push({ id: m[1], ...(label ? { label } : {}), ...(inPlan ? { inPlan: true } : {}) });
    if (out.length >= 60) break;
  }
  return out;
}

/** Cursor's CLI versions are dated (`2026.10.28-1a2b3c4`): an `agent` on the PATH that isn't Cursor's is skipped. */
const CURSOR_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}\b/;

/**
 * Protocol 36 (ADR 0114): Cursor's CLI (`agent`) and the models its sign-in lists (`agent models`, which asks
 * Cursor: none when signed out or offline).
 */
function detectCursor(run: Run): NonNullable<RunnerInfo["executors"]>["cursor"] {
  const r = run(CURSOR_BIN, ["--version"]);
  if (r.error || r.status !== 0) return undefined;
  const version = r.stdout.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";
  if (!CURSOR_VERSION.test(version)) return undefined;
  const m = run(CURSOR_BIN, ["models"]);
  const models = !m.error && m.status === 0 ? parseCursorModels(m.stdout) : [];
  return { version, ...(models.length ? { models } : {}) };
}

/** OpenCode's CLI (`opencode-ai` on npm). */
export const OPENCODE_BIN = "opencode";

/**
 * `opencode models` → the models it can run: one `provider/model` per line (its own sort, OpenCode's first). With no
 * key that is OpenCode's free tier and whatever providers the computer's own config signs in; `free` marks the free
 * tier's. Anything that isn't a `provider/model` id is skipped.
 */
export function parseOpencodeModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  for (const raw of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const id = raw.trim();
    if (!/^[\w.-]{1,40}\/[\w.:-]{1,79}$/.test(id) || id.length > 80 || out.some((x) => x.id === id)) continue;
    const label = OPENCODE_FREE_MODELS.find((m) => m.id === id)?.label;
    out.push({ id, ...(label ? { label } : {}), ...(isOpencodeFreeModel(id) ? { free: true } : {}) });
    if (out.length >= 60) break;
  }
  return out;
}

/** OpenCode's versions are plain semver (`1.19.5`): an `opencode` on the PATH that says anything else is skipped. */
const OPENCODE_VERSION = /^v?\d+\.\d+\.\d+\b/;

/** Protocol 39 (ADR 0132): OpenCode's CLI and the models it lists (`opencode models`: the free tier with no key). */
function detectOpencode(run: Run): NonNullable<RunnerInfo["executors"]>["opencode"] {
  const r = run(OPENCODE_BIN, ["--version"]);
  if (r.error || r.status !== 0) return undefined;
  const version = r.stdout.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";
  if (!OPENCODE_VERSION.test(version)) return undefined;
  const m = run(OPENCODE_BIN, ["models"]);
  const models = !m.error && m.status === 0 ? parseOpencodeModels(m.stdout) : [];
  return { version, ...(models.length ? { models } : {}) };
}

export function detectExecutors(run: Run = defaultRun): NonNullable<RunnerInfo["executors"]> {
  const out: NonNullable<RunnerInfo["executors"]> = {};
  for (const name of ["claude", "codex"] as const) {
    try {
      const r = run(name, ["--version"]);
      if (r.error || r.status !== 0) continue;
      const version = r.stdout.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";
      if (version) out[name] = { version, ...(name === "claude" ? claudeAuth(run) : {}) };
    } catch {
      // not installed
    }
  }
  try {
    const cursor = detectCursor(run);
    if (cursor) out.cursor = cursor;
  } catch {
    // not installed
  }
  try {
    const opencode = detectOpencode(run);
    if (opencode) out.opencode = opencode;
  } catch {
    // not installed
  }
  return out;
}

/** `detectExecutors`, looked up again only after the TTL. */
export function cachedExecutors(now: () => number = Date.now, run?: Run) {
  let cache: { at: number; value: NonNullable<RunnerInfo["executors"]> } | null = null;
  return () => {
    if (!cache || now() - cache.at > EXECUTORS_TTL_MS) cache = { at: now(), value: detectExecutors(run) };
    return cache.value;
  };
}
