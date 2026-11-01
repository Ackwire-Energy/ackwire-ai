import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineReplies, MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { credentialHelper, directCredentialHelper, MAX_CLONES, WAITING_FOR_CLONE } from "../../runner/git";
import { type HandlerContext, handleRequest, type RequestScope } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import { removeDirs, tempDir } from "./helpers";

/**
 * ADR 0116 with real git and no network: the proxy URL and github.com are both rewritten to local bare
 * repositories (`url.<file>.insteadOf`), each to its own copy, so a test can tell where a fetch or a push went.
 */

const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0001", handle: "dev", name: "Dev" };
const OTHER = { id: "0193cccc-bbbb-7ccc-8ddd-eeeeffff0002", handle: "ops", name: "Ops" };
const BASE = "http://proxy.test/api/git/org/conn/";
const TOKEN = `agtgit1.${"a".repeat(40)}.${"b".repeat(43)}`;
const GH_TOKEN = `ghs_${"c".repeat(36)}`;
const AUTHOR = { name: "Dev (agentes)", email: "dev@agents.agentes.chat" };

const dirs: string[] = [];
let root = "";
let proxied = "";
let github = "";
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: process.env }).trim();

/** A bare `owner/name` in both the proxy's and GitHub's copies, with one commit. */
function remoteRepo(repo: string) {
  const src = path.join(root, "src", repo);
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(path.join(src, "README.md"), `${repo}\n`);
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "first");
  for (const where of [proxied, github]) git(root, "clone", "-q", "--bare", src, path.join(where, `${repo}.git`));
}

beforeAll(() => {
  root = tempDir("gitclone-");
  proxied = path.join(root, "proxied");
  github = path.join(root, "github");
  const globalConfig = path.join(root, "gitconfig");
  writeFileSync(
    globalConfig,
    [
      "[user]",
      "\tname = Test",
      "\temail = test@example.com",
      "[init]",
      "\tdefaultBranch = main",
      `[url "file://${proxied}/"]`,
      `\tinsteadOf = ${BASE}`,
      `[url "file://${github}/"]`,
      "\tinsteadOf = https://github.com/",
      '[protocol "file"]',
      "\tallow = always",
      "",
    ].join("\n"),
  );
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const repo of ["acme/app", "acme/one", "acme/two", "acme/three", "acme/cached"]) remoteRepo(repo);
});

afterAll(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
  removeDirs([root]);
});
afterEach(() => removeDirs(dirs));

function setup(extra: Partial<HandlerContext> = {}) {
  const ws = tempDir("ws-");
  const home = tempDir("home-");
  dirs.push(ws, home);
  const ctx: HandlerContext = {
    workspaceReal: ws,
    exec: false,
    token: "agm_x",
    gitDir: path.join(home, "git"),
    ...extra,
  };
  return { ws, home, ctx };
}

const scope = (output: string[] = []): RequestScope => ({
  signal: new AbortController().signal,
  output: (_s, chunk) => output.push(chunk),
});

const sync = async (
  ctx: HandlerContext,
  repos: { repo: string; clone: boolean; github?: string }[],
  opts: { agent?: typeof AGENT; timeoutSeconds?: number; output?: string[] } = {},
) =>
  (
    (await handleRequest(
      ctx,
      {
        op: "git.sync",
        agent: opts.agent ?? AGENT,
        proxy: { base: BASE, token: TOKEN },
        author: AUTHOR,
        repos: repos.map((r) => ({ dir: `repos/${r.repo}`, ...r })),
        timeoutSeconds: opts.timeoutSeconds ?? 60,
        stream: true,
      } as MachineRequest,
      scope(opts.output),
    )) as MachineReplies["git.sync"]
  ).repos;

const localConfig = (cwd: string, key: string) => {
  try {
    return execFileSync("git", ["config", "--local", "--get-all", key], { cwd, encoding: "utf8", env: process.env })
      .replace(/\n$/, "")
      .split("\n");
  } catch {
    return [];
  }
};

test("with a GitHub App token: fetches straight from github.com, pushes through the proxy; without one, back to the proxy", async () => {
  const { ctx } = setup();
  const [cloned] = await sync(ctx, [{ repo: "acme/app", clone: true, github: GH_TOKEN }]);
  expect(cloned?.status).toBe("cloned");
  const folder = await agentWorkspace(ctx.workspaceReal, AGENT);
  const checkout = path.join(folder, "repos", "acme", "app");
  expect(localConfig(checkout, "remote.origin.url")).toEqual(["https://github.com/acme/app.git"]);
  expect(localConfig(checkout, "remote.origin.pushurl")).toEqual([`${BASE}acme/app.git`]);

  // Each host gets only its own credential; the machine's helpers are reset.
  const proxyFile = path.join(ctx.gitDir as string, `${AGENT.id}.token`);
  const githubFile = path.join(ctx.gitDir as string, "github", AGENT.id, "acme", "app.token");
  const helper = directCredentialHelper(proxyFile, githubFile);
  expect(localConfig(checkout, "credential.helper")).toEqual(["", helper]);
  const ask = (host: string) =>
    // As git runs `!…` helpers: `sh -c '<snippet> "$@"' <snippet> get`, the request on stdin.
    execFileSync("sh", ["-c", `${helper.slice(1)} "$@"`, helper.slice(1), "get"], {
      input: `protocol=https\nhost=${host}\n\n`,
      encoding: "utf8",
    });
  expect(ask("github.com")).toBe(`username=x-access-token\npassword=${GH_TOKEN}\n`);
  expect(ask("proxy.test")).toBe(`username=agentes\npassword=${TOKEN}\n`);
  expect(readFileSync(githubFile, "utf8")).toBe(GH_TOKEN);
  if (process.platform !== "win32") expect(statSync(githubFile).mode & 0o777).toBe(0o600);
  expect(githubFile.startsWith(folder)).toBe(false);

  // A push lands at the proxy (which polices it), never straight on GitHub.
  git(checkout, "checkout", "-q", "-b", "agentes/dev/fix");
  writeFileSync(path.join(checkout, "fix.md"), "fix\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "fix");
  git(checkout, "push", "-q", "origin", "agentes/dev/fix");
  expect(git(path.join(proxied, "acme", "app.git"), "branch", "--list", "agentes/dev/fix")).toContain(
    "agentes/dev/fix",
  );
  expect(git(path.join(github, "acme", "app.git"), "branch", "--list", "agentes/dev/fix")).toBe("");

  // A later sync with a fresh token rewrites it; one without (the App gone) puts the checkout back on the proxy.
  const fresh = `ghs_${"d".repeat(36)}`;
  expect((await sync(ctx, [{ repo: "acme/app", clone: false, github: fresh }]))[0]?.status).toBe("updated");
  expect(readFileSync(githubFile, "utf8")).toBe(fresh);
  expect((await sync(ctx, [{ repo: "acme/app", clone: false }]))[0]?.status).toBe("updated");
  expect(localConfig(checkout, "remote.origin.url")).toEqual([`${BASE}acme/app.git`]);
  expect(localConfig(checkout, "remote.origin.pushurl")).toEqual([]);
  expect(localConfig(checkout, "credential.helper")).toEqual(["", credentialHelper(proxyFile)]);

  // Anything that isn't an App installation token is refused.
  expect(sync(ctx, [{ repo: "acme/app", clone: false, github: "gho_oauthtoken1234567890abcdef" }])).rejects.toThrow(
    "GitHub App token",
  );
});

test(`at most ${MAX_CLONES} clones at once; the rest wait, and a clone outlives the request that started it`, async () => {
  const { home, ctx } = setup();
  const log = path.join(home, "clones.log");
  const release = path.join(home, "release");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const fake = path.join(home, "fake-git");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'for a in "$@"; do',
      '  if [ "$a" = clone ]; then',
      `    echo start >> '${log}'`,
      `    while [ ! -f '${release}' ]; do sleep 0.05; done`,
      "    break",
      "  fi",
      "done",
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  ctx.gitCommand = fake;
  const starts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);

  // Three agents' clones at once, each request giving up after a second: all still going, one waiting its turn.
  const answers = await Promise.all(
    ["acme/one", "acme/two", "acme/three"].map((repo) => sync(ctx, [{ repo, clone: true }], { timeoutSeconds: 1 })),
  );
  expect(answers.map((a) => a[0]?.status)).toEqual(["cloning", "cloning", "cloning"]);
  expect(starts()).toBe(MAX_CLONES);
  expect(answers.filter((a) => a[0]?.message?.includes(WAITING_FOR_CLONE))).toHaveLength(1);

  // The downloads go on without anyone waiting; asking again waits for the same clone (no second one).
  writeFileSync(release, "");
  const output: string[] = [];
  const again = await sync(ctx, [{ repo: "acme/three", clone: true }], { output });
  expect(again[0]?.status).toBe("cloned");
  for (const repo of ["acme/one", "acme/two"]) {
    expect((await sync(ctx, [{ repo, clone: true }]))[0]?.status).toMatch(/^(cloned|updated)$/);
  }
  expect(starts()).toBe(3);
  const folder = await agentWorkspace(ctx.workspaceReal, AGENT);
  expect(readFileSync(path.join(folder, "repos", "acme", "three", "README.md"), "utf8")).toBe("acme/three\n");
});

test("the shared cache: fetched with the agent's own credentials, borrowed by clones, never pruned; no access, no clone", async () => {
  const cache = tempDir("cache-");
  dirs.push(cache);
  const { ctx } = setup({ gitCache: cache });
  const [first] = await sync(ctx, [{ repo: "acme/cached", clone: true, github: GH_TOKEN }]);
  expect(first?.status).toBe("cloned");
  const mirror = path.join(cache, "conn", "acme", "cached.git");
  expect(git(root, "--git-dir", mirror, "config", "gc.pruneExpire")).toBe("never");
  expect(git(root, "--git-dir", mirror, "rev-parse", "refs/heads/main")).toBe(
    git(path.join(github, "acme", "cached.git"), "rev-parse", "main"),
  );
  // The checkout is whole (no partial-clone filter) and borrows the cache's objects.
  const folder = await agentWorkspace(ctx.workspaceReal, AGENT);
  const checkout = path.join(folder, "repos", "acme", "cached");
  expect(readFileSync(path.join(checkout, ".git", "objects", "info", "alternates"), "utf8").trim()).toBe(
    path.join(mirror, "objects"),
  );
  expect(localConfig(checkout, "remote.origin.partialclonefilter")).toEqual([]);

  // Another agent whose fetch is refused (here: the repository is gone for it) gets nothing from the cache.
  const gone = path.join(root, "gone");
  mkdirSync(gone, { recursive: true });
  renameSync(path.join(github, "acme", "cached.git"), path.join(gone, "cached.git"));
  renameSync(path.join(proxied, "acme", "cached.git"), path.join(gone, "cached-proxy.git"));
  try {
    const [refused] = await sync(ctx, [{ repo: "acme/cached", clone: true, github: GH_TOKEN }], { agent: OTHER });
    expect(refused?.status).toBe("failed");
    const otherFolder = await agentWorkspace(ctx.workspaceReal, OTHER);
    expect(existsSync(path.join(otherFolder, "repos", "acme", "cached"))).toBe(false);
  } finally {
    renameSync(path.join(gone, "cached.git"), path.join(github, "acme", "cached.git"));
    renameSync(path.join(gone, "cached-proxy.git"), path.join(proxied, "acme", "cached.git"));
  }
});
