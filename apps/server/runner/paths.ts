import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { errnoCode, RunnerError } from "./errors";

/** Agents see their computer's root as `/workspace`; on the machine it is the workspace folder. */
const AGENT_ROOT = "/workspace";

/**
 * Turns a request path into a clean relative one (`a/b/c`, `""` for the
 * workspace itself). Backslashes count as separators; `/workspace/…` is
 * accepted; `..`, absolute paths and drive letters are refused.
 */
export function normalizeRequestPath(input: string): string {
  if (typeof input !== "string") throw new RunnerError("bad_request", "The path must be a string");
  if (input.includes("\0")) throw new RunnerError("bad_request", "The path has a null byte");
  let p = input.replace(/\\/g, "/").trim();
  if (p === AGENT_ROOT || p === `${AGENT_ROOT}/`) p = "";
  else if (p.startsWith(`${AGENT_ROOT}/`)) p = p.slice(AGENT_ROOT.length + 1);
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    throw new RunnerError("outside_workspace", `${input} is outside the workspace (paths are relative to it)`);
  }
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.includes("..")) throw new RunnerError("outside_workspace", `${input} leaves the workspace ('..')`);
  return parts.join("/");
}

/** True when `target` is `root` or below it (case-insensitive on Windows). */
export function isInside(root: string, target: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const r = norm(root);
  const t = norm(target);
  if (t === r) return true;
  const withSep = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(withSep);
}

export interface Resolved {
  /** The request path, cleaned (`""` is the workspace). */
  rel: string;
  /** Absolute path to act on (the real path when it exists). */
  abs: string;
  exists: boolean;
}

/**
 * Resolves a request path inside the workspace. `workspaceReal` must already
 * be a real path (fs.realpath). Existing targets are resolved through their
 * symlinks and refused when they leave the workspace; missing targets are
 * checked through their nearest existing parent (so a write can't go through
 * a symlinked folder that points outside).
 */
export async function resolveInWorkspace(workspaceReal: string, input: string): Promise<Resolved> {
  const rel = normalizeRequestPath(input);
  const abs = rel === "" ? workspaceReal : path.join(workspaceReal, ...rel.split("/"));
  const outside = () => new RunnerError("outside_workspace", `${input} points outside the workspace`);
  try {
    const real = await realpath(abs);
    if (!isInside(workspaceReal, real)) throw outside();
    return { rel, abs: real, exists: true };
  } catch (err) {
    if (err instanceof RunnerError) throw err;
    if (errnoCode(err) !== "ENOENT" && errnoCode(err) !== "ENOTDIR") throw err;
  }
  // A dangling symlink: writing would follow it wherever it points.
  try {
    await lstat(abs);
    throw outside();
  } catch (err) {
    if (err instanceof RunnerError) throw err;
  }
  // The nearest parent that exists must be inside the workspace.
  let parent = path.dirname(abs);
  for (;;) {
    try {
      const real = await realpath(parent);
      if (!isInside(workspaceReal, real)) throw outside();
      const rest = path.relative(parent, abs);
      return { rel, abs: path.join(real, rest), exists: false };
    } catch (err) {
      if (err instanceof RunnerError) throw err;
      const code = errnoCode(err);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const up = path.dirname(parent);
      if (up === parent) throw outside();
      parent = up;
    }
  }
}
