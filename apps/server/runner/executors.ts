import { spawnSync } from "node:child_process";
import type { RunnerInfo } from "@agenteschat/adapters/machine-protocol";

/**
 * Which coding CLIs this machine has (protocol 7, ADR 0029): `claude` and
 * `codex` on the PATH the runner (and so its tasks) sees, with the first line
 * of `--version`. Best effort and cached: `hello` carries it on every
 * connection, and a fresh look happens at most every `EXECUTORS_TTL_MS`.
 */
export const EXECUTORS_TTL_MS = 10 * 60_000;

type Run = (command: string, args: string[]) => { status: number | null; stdout: string; error?: unknown };

const defaultRun: Run = (command, args) => {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    // Windows finds `claude.cmd` / `codex.cmd` only through the shell.
    shell: process.platform === "win32",
  });
  return { status: r.status, stdout: `${r.stdout ?? ""}`, error: r.error };
};

export function detectExecutors(run: Run = defaultRun): NonNullable<RunnerInfo["executors"]> {
  const out: NonNullable<RunnerInfo["executors"]> = {};
  for (const name of ["claude", "codex"] as const) {
    try {
      const r = run(name, ["--version"]);
      if (r.error || r.status !== 0) continue;
      const version = r.stdout.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";
      if (version) out[name] = { version };
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
