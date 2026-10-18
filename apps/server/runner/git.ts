import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentScope,
  GIT_CHECKOUTS_DIR,
  GIT_SYNC_LIMITS,
  type GitSyncRepo,
  type GitSyncRequest,
  isGitRepoName,
  type MachineReplies,
} from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { resolveInWorkspace } from "./paths";

/**
 * `git.sync` (protocol 11, ADR 0024 addendum): an agent's checkouts of
 * GitHub repositories, in its own folder, through the server's git proxy.
 *
 * - Our proxy credential (never a GitHub token) is written to
 *   `<runner home>/git/<agent id>.token` (mode 600, outside the agent's
 *   folder) and refreshed with every request. Each checkout's local config
 *   resets the machine's credential helpers and adds one that prints that
 *   file, so `git fetch` and `git push` there use it; nothing global changes
 *   on the machine.
 * - The remote is the proxy URL (`…/api/git/{org}/{connection}/owner/name.git`);
 *   the proxy checks the agent's repositories and lets it push only to
 *   `agentes/<handle>/…`.
 * - A new clone is partial (`--filter=blob:none`) with progress; an existing
 *   checkout is fetched and its default branch fast-forwarded (never a
 *   merge, never over local changes). Failures (offline, refused) come back
 *   per repository; the request itself fails only on a bad request.
 */

const TOKEN = /^agtgit1\.[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{20,100}$/;
const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface GitContext {
  /** The agent's folder (real path). */
  folder: string;
  /** `<runner home>/git`: where the agents' proxy credentials are kept. */
  gitDir: string;
  agent: AgentScope;
  signal: AbortSignal;
  /** git's progress, when the request asked for it. */
  output?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** The git command (tests: a path to a fake). */
  gitCommand?: string;
}

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A path as one word for `sh` (the credential helper is a shell snippet; Windows paths with `/`). */
const shWord = (p: string) => `'${p.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;

/** The credential helper our checkouts use: prints the agent's proxy credential, only for `get`. */
export function credentialHelper(tokenFile: string) {
  return `!f() { test "$1" = get || exit 0; echo username=agentes; printf 'password=%s\\n' "$(cat ${shWord(tokenFile)})"; }; f`;
}

/** `-c` options for one git command: no credential helper of the machine, only ours. */
const authArgs = (helper: string) => ["-c", "credential.helper=", "-c", `credential.helper=${helper}`];

/** The proxy URL must be ours: http(s), a `/api/git/` path, no credentials in it. */
function checkProxy(proxy: GitSyncRequest["proxy"] | undefined) {
  if (!proxy || typeof proxy.base !== "string" || typeof proxy.token !== "string") {
    throw new RunnerError("bad_request", "proxy is required");
  }
  let url: URL;
  try {
    url = new URL(proxy.base);
  } catch {
    throw new RunnerError("bad_request", "proxy.base is not a URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.pathname.includes("/api/git/")) {
    throw new RunnerError("bad_request", "proxy.base is not a git proxy URL");
  }
  if (!TOKEN.test(proxy.token)) throw new RunnerError("bad_request", "proxy.token is not a proxy credential");
  return { base: proxy.base.endsWith("/") ? proxy.base : `${proxy.base}/`, token: proxy.token };
}

/** Runs git with an argv (no shell), a deadline and the request's cancel. Never throws on git's own failure. */
function runGit(ctx: GitContext, args: string[], opts: { cwd: string; deadline: number; progress?: boolean }) {
  return new Promise<GitRun>((resolve) => {
    const ms = Math.max(1000, opts.deadline - Date.now());
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ctx.gitCommand ?? "git", args, {
        cwd: opts.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          LC_ALL: "C",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const keep = (s: string, add: string) => (s.length > 64_000 ? s.slice(-32_000) : s) + add;
    child.stdout?.on("data", (d: Buffer) => {
      stdout = keep(stdout, d.toString("utf8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stderr = keep(stderr, text);
      if (opts.progress) ctx.output?.("stderr", text);
    });
    const stop = () => killTree(child, "SIGTERM");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, ms);
    ctx.signal.addEventListener("abort", stop, { once: true });
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr, timedOut });
    };
    // Through EventEmitter: some @types/node versions lose ChildProcess's event methods.
    const events = child as unknown as EventEmitter;
    events.on("error", (err: NodeJS.ErrnoException) => {
      stderr = keep(stderr, err.code === "ENOENT" ? "git is not installed" : err.message);
      done(null);
    });
    events.on("close", (code: number | null) => done(code));
  });
}

/** git's last meaningful line (progress lines dropped), for people. */
function why(run: GitRun, fallback: string) {
  if (run.timedOut) return "it took too long (network slow or offline)";
  const lines = run.stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(
      (l) => l && !/^(remote: )?(Counting|Compressing|Receiving|Resolving|Enumerating|Total|Updating files)/.test(l),
    );
  const fatal = lines.filter((l) => /^(fatal|error|agentes):/i.test(l) || /^remote: agentes:/.test(l));
  return ((fatal.at(-1) ?? lines.at(-1) ?? fallback) || fallback).slice(0, GIT_SYNC_LIMITS.message);
}

/** Writes the agent's proxy credential (mode 600) and returns its file. */
function writeToken(gitDir: string, agentId: string, token: string) {
  if (!AGENT_ID.test(agentId)) throw new RunnerError("bad_request", "agent.id is invalid");
  mkdirSync(gitDir, { recursive: true, mode: 0o700 });
  const file = path.join(gitDir, `${agentId}.token`);
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Each checkout's own settings: our remote, only our credential helper, the agent as author. */
async function configure(
  ctx: GitContext,
  cwd: string,
  input: { url: string; helper: string; author: GitSyncRequest["author"] },
  deadline: number,
) {
  const set = (...args: string[]) => runGit(ctx, ["config", "--local", ...args], { cwd, deadline });
  await set("--unset-all", "credential.helper");
  const steps: string[][] = [
    ["remote.origin.url", input.url],
    ["--add", "credential.helper", ""],
    ["--add", "credential.helper", input.helper],
    ["credential.useHttpPath", "false"],
    ["user.name", input.author.name],
    ["user.email", input.author.email],
    ["push.autoSetupRemote", "true"],
  ];
  for (const s of steps) {
    const r = await set(...s);
    if (r.code !== 0) throw new Error(why(r, "git config failed"));
  }
}

const trimOut = (r: GitRun) => r.stdout.trim();

/** HEAD, the current branch and the remote's default branch of a checkout. */
async function describeCheckout(ctx: GitContext, cwd: string, deadline: number) {
  const [head, branch, remoteHead] = await Promise.all([
    runGit(ctx, ["rev-parse", "--short", "HEAD"], { cwd, deadline }),
    runGit(ctx, ["branch", "--show-current"], { cwd, deadline }),
    runGit(ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd, deadline }),
  ]);
  const def = remoteHead.code === 0 ? trimOut(remoteHead).replace(/^origin\//, "") : "";
  return {
    head: head.code === 0 ? trimOut(head) : "",
    branch: branch.code === 0 ? trimOut(branch) : "",
    defaultBranch: def,
  };
}

/** Fetches and fast-forwards the default branch (checked out and clean, or just its ref). Returns a warning, if any. */
async function update(ctx: GitContext, cwd: string, helper: string, deadline: number): Promise<string | undefined> {
  const fetched = await runGit(ctx, [...authArgs(helper), "fetch", "--prune", "--quiet", "origin"], {
    cwd,
    deadline,
  });
  if (fetched.code !== 0) throw new Error(why(fetched, "git fetch failed"));
  const now = await describeCheckout(ctx, cwd, deadline);
  const branch = now.branch;
  let defaultBranch = now.defaultBranch;
  if (!defaultBranch) {
    await runGit(ctx, [...authArgs(helper), "remote", "set-head", "origin", "--auto"], { cwd, deadline });
    defaultBranch = (await describeCheckout(ctx, cwd, deadline)).defaultBranch;
  }
  if (!defaultBranch) return "the remote's default branch is unknown";
  const remote = `refs/remotes/origin/${defaultBranch}`;
  if (branch === defaultBranch) {
    const ff = await runGit(ctx, ["merge", "--ff-only", "--quiet", remote], { cwd, deadline });
    if (ff.code !== 0) return `${defaultBranch} wasn't moved: it has local changes or commits of its own`;
    return undefined;
  }
  const local = `refs/heads/${defaultBranch}`;
  const exists = await runGit(ctx, ["rev-parse", "--verify", "--quiet", local], { cwd, deadline });
  if (exists.code !== 0) return undefined;
  const ancestor = await runGit(ctx, ["merge-base", "--is-ancestor", local, remote], { cwd, deadline });
  if (ancestor.code !== 0) return `${defaultBranch} wasn't moved: it has commits of its own`;
  const moved = await runGit(ctx, ["update-ref", local, remote], { cwd, deadline });
  if (moved.code !== 0) return `${defaultBranch} wasn't moved`;
  return undefined;
}

/** The checkouts already in `repos/` (one `owner/name` level, with a `.git`). */
function existingCheckouts(folder: string): string[] {
  const root = path.join(folder, GIT_CHECKOUTS_DIR);
  const found: string[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const owner of dirs(root)) {
    for (const name of dirs(path.join(root, owner))) {
      const repo = `${owner}/${name}`;
      if (isGitRepoName(repo) && existsSync(path.join(root, owner, name, ".git"))) found.push(repo);
    }
  }
  return found.slice(0, GIT_SYNC_LIMITS.repos);
}

/** `git.sync`: clones or updates the request's repositories (one at a time, within the deadline). */
export async function gitSync(ctx: GitContext, req: GitSyncRequest): Promise<MachineReplies["git.sync"]> {
  const proxy = checkProxy(req.proxy);
  const author = {
    name: typeof req.author?.name === "string" ? req.author.name.slice(0, 200) : "",
    email: typeof req.author?.email === "string" ? req.author.email.slice(0, 200) : "",
  };
  if (!author.name || !author.email) throw new RunnerError("bad_request", "author is required");
  if (!Array.isArray(req.repos)) throw new RunnerError("bad_request", "repos must be a list");
  const wanted: { repo: string; dir: string; clone: boolean }[] = [];
  for (const r of req.repos.slice(0, GIT_SYNC_LIMITS.repos)) {
    if (!isGitRepoName(r?.repo)) throw new RunnerError("bad_request", "repo must be owner/name");
    const dir = typeof r.dir === "string" && r.dir.trim() ? r.dir.trim() : `${GIT_CHECKOUTS_DIR}/${r.repo}`;
    wanted.push({ repo: r.repo, dir, clone: r.clone === true });
  }
  if (req.existing === true) {
    const seen = new Set(wanted.map((w) => w.dir.toLowerCase()));
    for (const repo of existingCheckouts(ctx.folder)) {
      const dir = `${GIT_CHECKOUTS_DIR}/${repo}`;
      if (!seen.has(dir.toLowerCase())) wanted.push({ repo, dir, clone: false });
    }
  }
  const seconds = Math.max(1, Math.min(GIT_SYNC_LIMITS.maxSeconds, Math.floor(Number(req.timeoutSeconds) || 60)));
  const deadline = Date.now() + seconds * 1000;
  const tokenFile = writeToken(ctx.gitDir, String(ctx.agent.id), proxy.token);
  const helper = credentialHelper(tokenFile);
  const out: GitSyncRepo[] = [];
  for (const w of wanted) {
    const base: GitSyncRepo = { repo: w.repo, dir: w.dir, status: "failed" };
    try {
      if (ctx.signal.aborted) throw new Error("canceled");
      // Inside the agent's folder, never the folder itself (links that leave it are refused).
      const target = await resolveInWorkspace(ctx.folder, w.dir);
      if (target.rel === "") throw new RunnerError("bad_request", "dir can't be your folder itself");
      base.dir = target.rel;
      base.path = target.abs;
      const url = `${proxy.base}${w.repo}.git`;
      if (!target.exists) {
        if (!w.clone) {
          out.push({ ...base, status: "missing" });
          continue;
        }
        mkdirSync(path.dirname(target.abs), { recursive: true });
        const cloned = await runGit(
          ctx,
          [...authArgs(helper), "clone", "--filter=blob:none", "--progress", "--origin", "origin", url, target.abs],
          { cwd: path.dirname(target.abs), deadline, progress: true },
        );
        if (cloned.code !== 0) throw new Error(why(cloned, "git clone failed"));
        await configure(ctx, target.abs, { url, helper, author }, deadline);
        const d = await describeCheckout(ctx, target.abs, deadline);
        out.push({
          ...base,
          status: "cloned",
          ...(d.branch ? { branch: d.branch } : {}),
          ...(d.defaultBranch ? { defaultBranch: d.defaultBranch } : {}),
          ...(d.head ? { head: d.head } : {}),
        });
        continue;
      }
      if (!statSync(target.abs).isDirectory() || !existsSync(path.join(target.abs, ".git"))) {
        throw new Error(`${target.rel} exists and isn't a git checkout`);
      }
      await configure(ctx, target.abs, { url, helper, author }, deadline);
      let warning: string | undefined;
      let failure: string | undefined;
      try {
        warning = await update(ctx, target.abs, helper, deadline);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      const d = await describeCheckout(ctx, target.abs, deadline);
      out.push({
        ...base,
        status: failure ? "failed" : "updated",
        ...(d.branch ? { branch: d.branch } : {}),
        ...(d.defaultBranch ? { defaultBranch: d.defaultBranch } : {}),
        ...(d.head ? { head: d.head } : {}),
        ...((failure ?? warning) ? { message: (failure ?? warning ?? "").slice(0, GIT_SYNC_LIMITS.message) } : {}),
      });
    } catch (err) {
      if (err instanceof RunnerError && err.code === "bad_request") throw err;
      out.push({
        ...base,
        message: (err instanceof Error ? err.message : String(err)).slice(0, GIT_SYNC_LIMITS.message),
      });
    }
  }
  return { repos: out };
}
