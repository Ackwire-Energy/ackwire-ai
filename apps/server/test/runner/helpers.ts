import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunnerError } from "../../runner/errors";

/** A fresh temp folder (real path, so macOS /var → /private/var doesn't matter). */
export function tempDir(prefix = "runner-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function removeDirs(dirs: string[]) {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** The RunnerError code a promise or function fails with (or "ok"). */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return err instanceof RunnerError ? err.code : `other: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
