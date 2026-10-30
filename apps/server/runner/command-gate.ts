import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import {
  approvalNeeded,
  type GitPush,
  gitPushes,
  type RepoFacts,
  simpleCommands,
} from "@agenteschat/adapters/command-policy";
import { HARDENED_GIT_ARGS } from "./git-guard";

/**
 * The command policy's git side (ADR 0053 §3, amended 2026-10-30): where a push goes, read on the computer
 * that runs it. Every path that runs a command here asks `commandApproval` first: the brain's own commands
 * (the prompt tool), `exec` (run_code, skill scripts) and background tasks.
 */

/** A local git read; asking the remote for its `HEAD` may take this long (offline: unknown, so the push waits). */
const GIT_MS = 5000;
const REMOTE_MS = 10_000;
/** The most of a script `exec` reads to check it. */
const SCRIPT_MAX_BYTES = 1024 * 1024;

/** git's stdout trimmed, or null on any failure. Never asks for a credential; the repository's hooks never run. */
function git(cwd: string, args: string[], timeout = GIT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...HARDENED_GIT_ARGS, ...args],
      {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" },
      },
      (err, stdout) => resolve(err ? null : String(stdout).trim()),
    );
  });
}

const once = <T>(read: () => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => {
    value ??= read();
    return value;
  };
};

/** `RepoFacts` for the repository at `dir`, read with git when a decision needs them. */
export function repoFacts(dir: string): RepoFacts {
  const current = once(async () => (await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null);
  const defaults = new Map<string, Promise<string | null>>();
  return {
    current,
    pushTarget: once(async () => {
      const branch = await current();
      if (!branch) return null;
      // `matching` pushes every branch both sides have: no single target.
      if ((await git(dir, ["config", "--get", "push.default"])) === "matching") return null;
      const line = await git(dir, [
        "for-each-ref",
        "--format=%(push:remotename)%00%(push:remoteref)%00%(push)",
        `refs/heads/${branch}`,
      ]);
      if (line === null) return null;
      const [remote = "", remoteRef = "", tracking = ""] = line.split("\0");
      const named = remote || null;
      if (remoteRef.startsWith("refs/heads/")) return { remote: named, branch: remoteRef.slice("refs/heads/".length) };
      const prefix = `refs/remotes/${remote || "origin"}/`;
      if (tracking.startsWith(prefix)) return { remote: named, branch: tracking.slice(prefix.length) };
      // No upstream yet: git pushes it under its own name, or refuses.
      return { remote: named, branch };
    }),
    defaultBranch(remote) {
      let known = defaults.get(remote);
      if (!known) {
        known = (async () => {
          if (remote.startsWith("-")) return null;
          const ref = `refs/remotes/${remote}/`;
          const local = await git(dir, ["symbolic-ref", "--quiet", `${ref}HEAD`]);
          if (local?.startsWith(ref)) return local.slice(ref.length) || null;
          const listed = await git(dir, ["ls-remote", "--symref", remote, "HEAD"], REMOTE_MS);
          return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed ?? "")?.[1] ?? null;
        })();
        defaults.set(remote, known);
      }
      return known;
    },
    protectedBranches: once(async () =>
      ((await git(dir, ["config", "--get-all", "agentes.protectedBranch"])) ?? "")
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  };
}

/** Where nothing can be read: every push there waits. */
const UNKNOWN: RepoFacts = {
  current: async () => null,
  pushTarget: async () => null,
  defaultBranch: async () => null,
  protectedBranches: async () => [],
};

/** Interpreters whose script `exec` reads to check it: shells read it as commands, the others as code. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETERS = new Set(["python", "python3", "node", "bun", "deno", "ruby", "perl"]);

/** The script an `<interpreter> <file>` command runs (`run_code`, a skill's script): its text and how it reads. */
async function scriptOf(command: string, cwd: string): Promise<{ text: string; code: boolean } | null> {
  const cmds = simpleCommands(command);
  const [bin = "", file] = cmds?.length === 1 ? (cmds[0]?.argv ?? []) : [];
  const name = path.basename(bin);
  if (!file || file.startsWith("-") || !(SHELLS.has(name) || INTERPRETERS.has(name))) return null;
  const abs = path.resolve(cwd, file);
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    const handle = await open(abs, "r");
    try {
      const buffer = Buffer.alloc(Math.min(st.size, SCRIPT_MAX_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      return { text: buffer.toString("utf8"), code: !SHELLS.has(name) };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Why a command waits for a person before it runs here, as the agent reads it (`how`: what it does to ask
 * them), or null: the command itself and, for `<interpreter> <file>`, the script it runs. `cwd`: where it
 * runs (null: unknown, so every push waits); `own`: the agent's branch prefixes; `head`: the branch it runs
 * on when that isn't the folder's (a task's new worktree).
 */
export async function commandApproval(
  command: string,
  opts: { cwd: string | null; own: readonly string[]; how: string; head?: string; script?: boolean },
): Promise<string | null> {
  const cwd = opts.cwd;
  const facts = new Map<string, RepoFacts>();
  const factsAt = (dir: string | null): RepoFacts => {
    if (cwd === null || dir === null) return UNKNOWN;
    const abs = path.resolve(cwd, dir);
    let known = facts.get(abs);
    if (!known) {
      known = repoFacts(abs);
      if (opts.head && abs === path.resolve(cwd)) {
        const head = opts.head;
        known = { ...known, current: async () => head, pushTarget: async () => ({ remote: null, branch: head }) };
      }
      facts.set(abs, known);
    }
    return known;
  };
  const held = await approvalNeeded(command, opts.how, { own: opts.own, facts: factsAt });
  if (held || !opts.script || cwd === null) return held;
  const script = await scriptOf(command, cwd);
  return script ? approvalNeeded(script.text, opts.how, { code: script.code, own: opts.own, facts: factsAt }) : null;
}

/** git options that run another program or read another config: such a push is never let through by the computer alone. */
const RUNS_PROGRAM = /^(-c|--config-env|--receive-pack|--exec|--exec-path)(=|$)/;

/**
 * A command that is one push and nothing else, as written: `git` itself first (no wrapper, whose variables can
 * name a program, and no shell, which runs more than the push), no option that runs a program; null otherwise.
 */
export function lonePush(command: string): GitPush | null {
  const cmds = simpleCommands(command);
  if (cmds?.length !== 1 || cmds[0]?.argv[0] !== "git" || cmds[0].argv.some((w) => RUNS_PROGRAM.test(w))) return null;
  const pushes = gitPushes(command);
  return pushes?.length === 1 ? (pushes[0] ?? null) : null;
}

/** Every ref of a push names one of the agent's own branches (`own` prefixes) as written. */
export const pushesOwnBranches = (push: GitPush, own: readonly string[]) =>
  push.refs.length > 0 &&
  !push.every &&
  !push.prune &&
  push.refs.every(
    (r) =>
      !r.delete && r.branch !== null && r.branch !== "HEAD" && own.some((p) => p && r.branch?.startsWith(p) === true),
  );

/** The branches that are an agent's own (what our git proxy lets it push): `agentes/<handle>/`. */
export const ownBranches = (agent: { handle?: unknown } | undefined, ...more: (string | undefined)[]) => [
  ...(typeof agent?.handle === "string" && /^[A-Za-z0-9_.-]+$/.test(agent.handle) ? [`agentes/${agent.handle}/`] : []),
  ...more.filter((p): p is string => Boolean(p)),
];
