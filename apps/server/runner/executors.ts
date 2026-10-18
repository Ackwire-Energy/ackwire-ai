import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { RunnerInfo } from "@agenteschat/adapters/machine-protocol";

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
export function resolveCommand(command: string, pathList = process.env.PATH ?? ""): string {
  if (process.platform === "win32" || command.includes("/")) return command;
  for (const dir of pathList.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, command);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {}
  }
  return command;
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

/**
 * Protocol 8: whether Claude Code is logged in (`claude auth status --json`:
 * `loggedIn`, `authMethod`, `subscriptionType`). Only these three leave the
 * machine (never the email or the organization). Unknown on any failure.
 */
export function claudeAuth(run: Run = defaultRun): { loggedIn?: boolean; authMethod?: string; plan?: string } {
  try {
    const r = run("claude", ["auth", "status", "--json"]);
    if (r.error) return {};
    const json = JSON.parse(r.stdout.trim() || "null") as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return r.status !== 0 ? { loggedIn: false } : {};
    const word = (v: unknown) => (typeof v === "string" && /^[\w.-]{1,40}$/.test(v) ? v : undefined);
    const authMethod = word(json.authMethod);
    const plan = word(json.subscriptionType);
    return {
      ...(typeof json.loggedIn === "boolean" ? { loggedIn: json.loggedIn } : {}),
      ...(authMethod ? { authMethod } : {}),
      ...(plan ? { plan } : {}),
    };
  } catch {
    return {};
  }
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
