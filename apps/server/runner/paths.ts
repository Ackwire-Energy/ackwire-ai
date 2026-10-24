import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import type { AgentScope } from "@agenteschat/adapters/machine-protocol";
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
  /** Protocol 10, absolute requests only: the allowed folder (real path) it was found in. */
  root?: string;
}

/**
 * Whether a request path is absolute on this machine (protocol 10: allowed
 * when it falls inside a folder the person allowed for the agent).
 * `/workspace/…` is the agent's own folder, never absolute.
 */
export function isAbsoluteRequest(input: unknown): input is string {
  if (typeof input !== "string") return false;
  const p = input.trim().replace(/\\/g, "/");
  if (p === AGENT_ROOT || p.startsWith(`${AGENT_ROOT}/`)) return false;
  return p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
}

/**
 * Resolves `abs` (absolute, normalized) through its symlinks and returns it
 * when it lands inside one of `roots` (real paths). Missing targets are
 * checked through their nearest existing parent (so a write can't go
 * through a symlinked folder that points outside); a dangling symlink is
 * refused (writing would follow it wherever it points).
 */
async function resolveWithin(
  roots: string[],
  abs: string,
  rel: string,
  outside: () => RunnerError,
  withRoot: boolean,
): Promise<Resolved> {
  const rootOf = (real: string) => roots.find((r) => isInside(r, real));
  const found = (r: Resolved, root: string): Resolved => (withRoot ? { ...r, root } : r);
  try {
    const real = await realpath(abs);
    const root = rootOf(real);
    if (!root) throw outside();
    return found({ rel, abs: real, exists: true }, root);
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
  // The nearest parent that exists must be inside.
  let parent = path.dirname(abs);
  for (;;) {
    try {
      const real = await realpath(parent);
      const root = rootOf(real);
      if (!root) throw outside();
      const rest = path.relative(parent, abs);
      return found({ rel, abs: path.join(real, rest), exists: false }, root);
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

/**
 * Resolves a request path inside the workspace. `workspaceReal` must already
 * be a real path (fs.realpath). Existing targets are resolved through their
 * symlinks and refused when they leave the workspace; missing targets are
 * checked through their nearest existing parent.
 */
export async function resolveInWorkspace(workspaceReal: string, input: string): Promise<Resolved> {
  const rel = normalizeRequestPath(input);
  const abs = rel === "" ? workspaceReal : path.join(workspaceReal, ...rel.split("/"));
  return resolveWithin(
    [workspaceReal],
    abs,
    rel,
    () => new RunnerError("outside_workspace", `${input} points outside the workspace`),
    false,
  );
}

/**
 * Protocol 10: an absolute request path inside one of the folders allowed
 * for the agent (`rootsReal`: real paths). Symlinks are resolved before the
 * check, so a link inside an allowed folder that points elsewhere is refused
 * (`not_allowed`). The result's `rel` is the absolute path itself (what the
 * agent uses again, e.g. the entries of a listing).
 */
export async function resolveInRoots(rootsReal: string[], input: string): Promise<Resolved> {
  if (typeof input !== "string") throw new RunnerError("bad_request", "The path must be a string");
  if (input.includes("\0")) throw new RunnerError("bad_request", "The path has a null byte");
  const abs = path.resolve(input.trim());
  const notAllowed = () =>
    new RunnerError(
      "not_allowed",
      `${input} is outside your folder and outside every folder allowed for you on this computer (ask for it with request_folder_access)`,
    );
  if (rootsReal.length === 0) throw notAllowed();
  const shown = process.platform === "win32" ? abs : abs.split(path.sep).join("/");
  return resolveWithin(rootsReal, abs, shown, notAllowed, true);
}

/**
 * A request path for an agent: relative to its folder (`workspaceReal`), or
 * absolute inside one of its allowed folders when `grants` is given
 * (protocol 10). Without `grants` an absolute path is refused as before.
 */
export function resolveForAgent(workspaceReal: string, grants: string[] | undefined, input: string) {
  if (grants && isAbsoluteRequest(input)) return resolveInRoots(grants, input);
  return resolveInWorkspace(workspaceReal, input);
}

/** The first 8 letters and digits of an agent's id, lower case: what names on the machine keep across renames. */
export function agentId8(id: unknown): string {
  const id8 = String(id ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  if (id8.length < 8) throw new RunnerError("bad_request", "The agent id is not valid");
  return id8;
}

/** `<handle>-<first 8 of id>`: readable, and the id part survives a rename. */
export function agentFolderName(agent: AgentScope): { name: string; suffix: string } {
  const id = agentId8(agent.id);
  const handle = String(agent.handle ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 40);
  const suffix = `-${id}`;
  return { name: `${handle || "agent"}${suffix}`, suffix };
}

/**
 * The agent's own folder in the workspace (created on first use), as a real
 * path: the request's workspace from then on. A folder from before a rename
 * (same id, other handle) is renamed, or used as is when the new name is taken.
 */
export async function agentWorkspace(workspaceReal: string, agent: AgentScope): Promise<string> {
  const { name, suffix } = agentFolderName(agent);
  let folder = name;
  try {
    await lstat(path.join(workspaceReal, name));
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
    const entries = await readdir(workspaceReal, { withFileTypes: true });
    const old = entries.find((e) => e.isDirectory() && e.name.endsWith(suffix));
    if (old) {
      await rename(path.join(workspaceReal, old.name), path.join(workspaceReal, name)).catch(() => {
        folder = old.name;
      });
    } else {
      await mkdir(path.join(workspaceReal, name), { recursive: true });
    }
  }
  const abs = path.join(workspaceReal, folder);
  const st = await lstat(abs);
  if (!st.isDirectory()) throw new RunnerError("bad_request", `${folder} in the workspace is not a folder`);
  const real = await realpath(abs);
  if (real === workspaceReal || !isInside(workspaceReal, real)) {
    throw new RunnerError("outside_workspace", `${folder} points outside the workspace`);
  }
  return real;
}
