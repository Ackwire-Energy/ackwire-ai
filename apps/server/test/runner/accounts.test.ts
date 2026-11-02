import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { accountCodeAad, type MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { sealSecret } from "@agenteschat/adapters/secret-box";
import {
  AccountManager,
  type AccountManagerOptions,
  accountEnv,
  agentAccountHome,
  codexAuthOf,
  grantOf,
  lentAccounts,
  parseClaudeLoginUrl,
  parseClaudeStatus,
  parseCodexLogin,
  parseCodexStatus,
  parseSetupToken,
  placeCodexAuth,
  planKeyOf,
  Screen,
  stripAnsi,
  tokenOf,
  watchCodexAuth,
} from "../../runner/accounts";
import { claudePlan } from "../../runner/executors";
import { describeRequest, type HandlerContext, handleRequest } from "../../runner/handlers";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const FAKE_ENV = [
  "FAKE_ACCOUNT_MODE",
  "FAKE_ACCOUNT_LOG",
  "FAKE_ACCOUNT_CODE",
  "FAKE_CODEX_DELAY",
  "FAKE_CODEX_REFRESHED",
];
const dirs: string[] = [];
const managers: AccountManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  for (const k of FAKE_ENV) delete process.env[k];
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-account-cli.mjs");
const ORG = "0193dddd-0000-7000-8000-000000000001";
const LOGIN = (n: number) => `0193eeee-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ESC = "\x1b";
const URL_CLAUDE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=st4te";

// ── Reading the CLIs' output ─────────────────────────────────────────────────

test("Claude Code's sign-in URL: escapes and the OSC 8 hyperlink stripped, only once the URL is whole", () => {
  const out = `Opening browser to sign in…\nIf the browser didn't open, visit: ${ESC}]8;;${URL_CLAUDE}${ESC}\\${URL_CLAUDE}${ESC}]8;;${ESC}\\\nPaste code here if prompted > `;
  expect(stripAnsi(`${ESC}[1mbold${ESC}[0m ${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("bold link");
  expect(parseClaudeLoginUrl(out)).toBe(URL_CLAUDE);
  // BEL-terminated hyperlinks too.
  const bel = `visit: ${ESC}]8;;${URL_CLAUDE}\x07${URL_CLAUDE}${ESC}]8;;\x07\n`;
  expect(parseClaudeLoginUrl(bel)).toBe(URL_CLAUDE);
  // Still arriving: nothing yet; the whole output at the end takes it.
  const cut = `visit: ${URL_CLAUDE.slice(0, 60)}`;
  expect(parseClaudeLoginUrl(cut)).toBeNull();
  expect(parseClaudeLoginUrl(`visit: ${URL_CLAUDE}`)).toBeNull();
  expect(parseClaudeLoginUrl(`visit: ${URL_CLAUDE}`, true)).toBe(URL_CLAUDE);
  // Only Claude's and Anthropic's hosts.
  expect(parseClaudeLoginUrl("see https://example.com/docs and https://evil.test/claude.com\n", true)).toBeNull();
  expect(parseClaudeLoginUrl("visit: https://console.anthropic.com/oauth/authorize?x=1\n")).toBe(
    "https://console.anthropic.com/oauth/authorize?x=1",
  );
});

test("Codex's device sign-in: the link and the one-time code, colors stripped, the code only when whole", () => {
  const out = [
    "1. Open this link in your browser and sign in to your account",
    `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
    "",
    `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
    `   ${ESC}[94m7HYC-J6JGM${ESC}[0m`,
    "",
  ].join("\n");
  expect(parseCodexLogin(out)).toEqual({ url: "https://auth.openai.com/codex/device", userCode: "7HYC-J6JGM" });
  const partial = out.slice(0, out.indexOf("7HYC-J6JG") + "7HYC-J6JG".length);
  expect(parseCodexLogin(partial)).toBeNull();
  expect(parseCodexLogin(partial, true)?.userCode).toBe("7HYC-J6JG");
  expect(parseCodexLogin("1. https://auth.openai.com/codex/device\n")).toBeNull();
  expect(parseCodexLogin("ABCD-EFGH\nhttps://example.com/device\n", true)).toBeNull();
});

test("status commands: signed in through claude.ai with email and plan (short words only), anything else is signed out", () => {
  const good = JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "dev@acme.test",
    subscriptionType: "max",
  });
  expect(parseClaudeStatus(0, good)).toEqual({ loggedIn: true, email: "dev@acme.test", plan: "max" });
  expect(parseClaudeStatus(0, good, () => "default_claude_max_20x")).toMatchObject({ plan: "ultra" });
  const odd = JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "not an email",
    subscriptionType: "a b",
  });
  expect(parseClaudeStatus(0, odd)).toEqual({ loggedIn: true });
  // An API key (in the env, or the folder's) isn't the account's own sign-in; nor is an unknown method.
  expect(parseClaudeStatus(0, JSON.stringify({ loggedIn: true, authMethod: "api_key" }))).toEqual({ loggedIn: false });
  expect(parseClaudeStatus(0, JSON.stringify({ loggedIn: true, subscriptionType: "max" }))).toEqual({
    loggedIn: false,
    plan: "max",
  });
  expect(parseClaudeStatus(1, JSON.stringify({ loggedIn: false }))).toEqual({ loggedIn: false });
  expect(parseClaudeStatus(0, "garbage")).toEqual({ loggedIn: false });
  expect(parseCodexStatus(0, `${ESC}[32mLogged in using ChatGPT${ESC}[0m\n`)).toEqual({ loggedIn: true });
  expect(parseCodexStatus(1, "Not logged in\n")).toEqual({ loggedIn: false });
  expect(parseCodexStatus(0, "Not logged in\n")).toEqual({ loggedIn: false });
});

test("Claude's plans by Anthropic's names: a Max on the 20x tier is Ultra, every other word as the CLI says it", () => {
  const tier = (value?: string) => () => value;
  expect(claudePlan("pro", tier("default_claude_ai"))).toBe("pro");
  expect(claudePlan("max", tier("default_claude_max_5x"))).toBe("max");
  expect(claudePlan("max", tier("default_claude_max_20x"))).toBe("ultra");
  // No tier known: a Max stays Max.
  expect(claudePlan("max", tier())).toBe("max");
  // A Team seat on the premium tier is still Team.
  expect(claudePlan("team", tier("default_claude_max_20x"))).toBe("team");
  expect(claudePlan("enterprise", tier())).toBe("enterprise");
  expect(claudePlan("ultra", tier())).toBe("ultra");
  expect(claudePlan(null, tier("default_claude_max_20x"))).toBeUndefined();
  expect(claudePlan("a b", tier())).toBeUndefined();
  // The tier is read only for a Max.
  let reads = 0;
  claudePlan("pro", () => reads++);
  expect(reads).toBe(0);
});

// ── The manager with fake CLIs ───────────────────────────────────────────────

function setup(over: Partial<AccountManagerOptions> = {}) {
  const home = tempDir("accounts-home-");
  dirs.push(home);
  const logFile = path.join(home, "cli.log");
  process.env.FAKE_ACCOUNT_LOG = logFile;
  let changes = 0;
  const m = new AccountManager({
    root: path.join(home, "accounts"),
    orgId: () => ORG,
    commands: { claude_code: [process.execPath, FAKE], codex: [process.execPath, FAKE] },
    onChange: () => {
      changes++;
    },
    ...over,
  });
  managers.push(m);
  const runs = () => {
    try {
      return readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string; home: string; terminal?: boolean });
    } catch {
      return [];
    }
  };
  return { m, root: path.join(home, "accounts"), runs, changes: () => changes };
}

const sealed = async (publicKey: string, loginId: string, code: string, org = ORG) => {
  const aad = accountCodeAad(loginId, org);
  return { aad, box: await sealSecret(publicKey, code, aad) };
};

test.if(posix)(
  "Claude Code: begin gives the URL and a key, the sealed code signs in, the account is listed with its email and plan",
  async () => {
    const { m, root, runs, changes } = setup();
    const id = LOGIN(1);
    const begun = await m.begin("claude_code", id);
    expect(begun.url).toStartWith("https://claude.com/cai/oauth/authorize?");
    expect(begun.url).toContain("state=st4te");
    expect(typeof begun.publicKey).toBe("string");
    expect(begun.userCode).toBeUndefined();
    const dir = path.join(root, "claude_code", id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(root, "claude_code")).mode & 0o777).toBe(0o700);
    // The CLI ran in that folder as its Claude Code home.
    expect(runs()[0]).toEqual({ args: "auth login", home: dir });
    expect(m.status(id)).toEqual({ state: "waiting" });
    // Not usable while it signs in, and not listed.
    expect(m.accountDir("claude_code", id)).toBeNull();
    expect(await m.list()).toEqual([]);

    // A box for another organization or sign-in is refused before it is opened.
    const other = await sealed(begun.publicKey as string, id, "good-code", "0193dddd-0000-7000-8000-000000000999");
    expect(await errorCode(() => m.code(id, other.aad, other.box))).toBe("bad_request");
    const tampered = await sealed(begun.publicKey as string, id, "good-code");
    const otherIv = btoa("twelve bytes");
    expect(await errorCode(() => m.code(id, tampered.aad, { ...tampered.box, iv: otherIv }))).toBe("bad_request");

    const { aad, box } = await sealed(begun.publicKey as string, id, "  good-code \n");
    await m.code(id, aad, box);
    await waitFor(() => m.status(id).state !== "waiting", 5000);
    expect(m.status(id)).toEqual({
      state: "done",
      account: { id, kind: "claude_code", loggedIn: true, email: "dev@acme.test", plan: "max", shared: true },
    });
    expect(changes()).toBeGreaterThan(0);
    expect(m.accountDir("claude_code", id)).toBe(dir);
    expect(m.accountDir("codex", id)).toBeNull();
    expect(await m.list()).toEqual([
      { id, kind: "claude_code", loggedIn: true, email: "dev@acme.test", plan: "max", shared: true },
    ]);
    expect(m.snapshot()).toHaveLength(1);
    // The same id can't start again.
    expect(await errorCode(() => m.begin("claude_code", id))).toBe("bad_request");
    expect(await errorCode(() => m.code(id, aad, box))).toBe("bad_request");
  },
  15_000,
);

test.if(posix)(
  "a sign-in its endpoint refused in a turn reads as signed out, though its CLI still says signed in, until it signs in again",
  async () => {
    const { m } = setup();
    const id = LOGIN(13);
    const signIn = async (again: boolean) => {
      const begun = await m.begin("claude_code", id, again);
      const { aad, box } = await sealed(begun.publicKey as string, id, "good-code");
      await m.code(id, aad, box);
      await waitFor(() => m.status(id).state !== "waiting", 5000);
    };
    await signIn(false);
    const account = {
      id,
      kind: "claude_code" as const,
      loggedIn: true,
      email: "dev@acme.test",
      plan: "max",
      shared: true,
    };
    expect(await m.list()).toEqual([account]);
    // Another login of the same account ended this one: its credentials stay, the turn's refusal decides.
    await m.refused("claude_code", id);
    m.invalidate();
    expect(await m.list()).toEqual([{ id, kind: "claude_code", loggedIn: false, shared: true }]);
    await signIn(true);
    expect(m.status(id)).toEqual({ state: "done", account });
    m.invalidate();
    expect(await m.list()).toEqual([account]);
  },
  15_000,
);

test.if(posix)(
  "a key, token or other endpoint in the runner's env never reaches an account: its CLI sees only the folder's sign-in",
  async () => {
    const stray = {
      ANTHROPIC_API_KEY: "sk-ant-stray",
      ANTHROPIC_BASE_URL: "https://proxy.test",
      OPENAI_API_KEY: "sk-x",
    };
    Object.assign(process.env, stray);
    try {
      const { m, root } = setup();
      const id = LOGIN(9);
      const dir = path.join(root, "claude_code", id);
      mkdirSync(dir, { recursive: true });
      // Signed out there: the key in the runner's env would have made it "signed in" (and billed the key).
      expect(await m.list()).toEqual([{ id, kind: "claude_code", loggedIn: false, shared: true }]);
      const env = accountEnv("claude_code", dir);
      expect(env.CLAUDE_CONFIG_DIR).toBe(dir);
      for (const k of Object.keys(stray)) expect(env[k]).toBeUndefined();
      expect(accountEnv("codex", dir, { PATH: "/bin", CODEX_API_KEY: "x", CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual({
        PATH: "/bin",
        CODEX_HOME: dir,
      });
    } finally {
      for (const k of Object.keys(stray)) delete process.env[k];
    }
  },
);

test.if(posix)(
  "Claude Code: a refused code fails the sign-in, removes its folder and never repeats the code",
  async () => {
    const { m, root } = setup();
    const id = LOGIN(2);
    const begun = await m.begin("claude_code", id);
    const { aad, box } = await sealed(begun.publicKey as string, id, "wrong-secret-code");
    await m.code(id, aad, box);
    await waitFor(() => m.status(id).state !== "waiting", 5000);
    const st = m.status(id);
    expect(st.state).toBe("failed");
    expect(st.error).toContain("couldn't sign in");
    expect(st.error).not.toContain("wrong-secret-code");
    await waitFor(() => !existsSync(path.join(root, "claude_code", id)));
    expect(await m.list()).toEqual([]);
  },
  15_000,
);

test.if(posix)(
  "Codex: begin gives the device link and code; it finishes by itself and is listed (no email from Codex)",
  async () => {
    const { m, root, runs } = setup();
    const id = LOGIN(3);
    const begun = await m.begin("codex", id);
    expect(begun).toEqual({ url: "https://auth.openai.com/codex/device", userCode: "7HYC-J6JGM" });
    const dir = path.join(root, "codex", id);
    expect(runs()[0]).toEqual({ args: "login --device-auth", home: dir });
    // Codex takes no pasted code.
    expect(await errorCode(() => m.code(id, accountCodeAad(id, ORG), { v: 1, epk: "", iv: "", ct: "" }))).toBe(
      "bad_request",
    );
    await waitFor(() => m.status(id).state !== "waiting", 5000);
    expect(m.status(id)).toEqual({ state: "done", account: { id, kind: "codex", loggedIn: true, shared: true } });
    expect(runs().map((r) => r.args)).toContain("login status");
    expect(await m.list()).toEqual([{ id, kind: "codex", loggedIn: true, shared: true }]);
  },
  15_000,
);

test.if(posix)(
  "the account to sign in to: a plain email reaches the CLI as its login hint; any other is refused",
  async () => {
    const { m, root, runs } = setup();
    await m.begin("claude_code", LOGIN(31), false, "ana.silva+work@acme.com.br");
    expect(runs()[0]).toEqual({
      args: "auth login --email ana.silva+work@acme.com.br",
      home: path.join(root, "claude_code", LOGIN(31)),
    });
    // On Windows the CLI starts through the shell: nothing it would read as a command gets that far.
    for (const [kind, email] of [
      ["claude_code", "a&calc&x@y.z"],
      ["claude_code", "a|b@y.z"],
      ["claude_code", "%COMSPEC%@y.z"],
      ["claude_code", "a@y.z\nrm"],
      ["codex", "ana@example.com"],
    ] as const) {
      expect(await errorCode(() => m.begin(kind, LOGIN(32), false, email))).toBe("bad_request");
    }
    expect(runs().length).toBe(1);
    expect(existsSync(path.join(root, "claude_code", LOGIN(32)))).toBe(false);
    // Through the op too.
    const ws = tempDir("accounts-ws-");
    dirs.push(ws);
    const ctx: HandlerContext = { workspaceReal: ws, exec: true, token: "t", accounts: m };
    const req = { op: "account", action: "begin", kind: "claude_code", loginId: LOGIN(33), email: "a;b@y.z" };
    expect(
      await errorCode(() =>
        handleRequest(ctx, req as unknown as MachineRequest, {
          signal: new AbortController().signal,
          output: () => {},
        }),
      ),
    ).toBe("bad_request");
  },
);

test.if(posix)("a Codex sign-in that fails is failed and its folder goes", async () => {
  process.env.FAKE_ACCOUNT_MODE = "fail";
  const { m, root } = setup();
  const id = LOGIN(4);
  await m.begin("codex", id);
  await waitFor(() => m.status(id).state !== "waiting", 5000);
  expect(m.status(id).state).toBe("failed");
  await waitFor(() => !existsSync(path.join(root, "codex", id)));
});

test.if(posix)("a CLI that prints no link, or isn't installed, fails the begin and leaves nothing", async () => {
  process.env.FAKE_ACCOUNT_MODE = "silent";
  const { m, root } = setup({ beginWaitMs: 300 });
  const id = LOGIN(5);
  const err = await m.begin("claude_code", id).then(
    () => null,
    (e: Error) => e,
  );
  expect(err?.message).toContain("didn't show a sign-in link");
  expect(existsSync(path.join(root, "claude_code", id))).toBe(false);
  expect(await errorCode(() => m.status(id))).toBe("not_found");

  const missing = setup({ commands: { claude_code: ["/nonexistent/claude-xyz"] } });
  const err2 = await missing.m.begin("claude_code", LOGIN(6)).then(
    () => null,
    (e: Error) => e,
  );
  expect(err2?.message).toContain("not installed");
  expect(existsSync(path.join(missing.root, "claude_code", LOGIN(6)))).toBe(false);
});

test.if(posix)("a sign-in nobody finishes expires: the CLI is killed and the folder removed", async () => {
  const { m, root } = setup({ ttlMs: 400 });
  const id = LOGIN(7);
  await m.begin("claude_code", id);
  await waitFor(() => m.status(id).state !== "waiting", 3000);
  expect(m.status(id).state).toBe("expired");
  await waitFor(() => !existsSync(path.join(root, "claude_code", id)));
});

test.if(posix)("a computer runs at most four sign-ins at once; a key's waits on no CLI", async () => {
  const { m, root } = setup();
  for (let n = 60; n < 64; n++) await m.begin("claude_code", LOGIN(n));
  expect(await errorCode(() => m.begin("codex", LOGIN(64)))).toBe("bad_request");
  expect(existsSync(path.join(root, "codex", LOGIN(64)))).toBe(false);
  expect((await m.begin("claude_code", LOGIN(65), false, undefined, "zai")).publicKey).toBeTruthy();
  await m.cancel(LOGIN(60));
  expect((await m.begin("claude_code", LOGIN(64))).url).toBeTruthy();
});

test.if(posix)("cancel stops a sign-in and removes its folder; a second cancel has nothing to stop", async () => {
  const { m, root } = setup();
  const id = LOGIN(8);
  await m.begin("claude_code", id);
  expect(await m.cancel(id)).toBe(true);
  expect(m.status(id).state).toBe("failed");
  expect(existsSync(path.join(root, "claude_code", id))).toBe(false);
  expect(await m.cancel(id)).toBe(false);
  expect(await m.cancel(LOGIN(99))).toBe(false);
});

test.if(posix)("remove signs out in the account's folder and deletes it; ids that aren't UUIDs fail", async () => {
  const { m, root, runs, changes } = setup();
  for (const bad of ["../../etc", "x", "", LOGIN(1).toUpperCase()]) {
    expect(await errorCode(() => m.remove("claude_code", bad))).toBe("bad_request");
    expect(await errorCode(() => m.begin("claude_code", bad))).toBe("bad_request");
  }
  expect(await errorCode(() => m.remove("vim" as never, LOGIN(1)))).toBe("bad_request");
  expect(m.accountDir("claude_code", "../x")).toBeNull();

  // An account signed in earlier (a folder with its sign-in), and a stray folder that isn't one.
  const id = LOGIN(9);
  const dir = path.join(root, "claude_code", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "signed-in"), "");
  mkdirSync(path.join(root, "claude_code", "notes"), { recursive: true });
  expect(await m.list()).toEqual([
    { id, kind: "claude_code", loggedIn: true, email: "dev@acme.test", plan: "max", shared: true },
  ]);
  const before = changes();
  expect(await m.remove("claude_code", id)).toBe(true);
  expect(runs().find((r) => r.args === "auth logout")?.home).toBe(dir);
  expect(existsSync(dir)).toBe(false);
  expect(changes()).toBeGreaterThan(before);
  expect(await m.list()).toEqual([]);
  expect(await m.remove("claude_code", id)).toBe(false);
});

test.if(posix)(
  "a Max on the 20x tier lists as Ultra, by the tier Claude Code keeps in the folder, never through a link",
  async () => {
    const { m, root } = setup();
    const dir = path.join(root, "claude_code", LOGIN(61));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "signed-in"), "");
    const config = path.join(dir, ".claude.json");
    const ultra = JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" } });
    const plan = async () => {
      m.invalidate();
      return (await m.list())[0]?.plan;
    };
    // No tier kept there (the CLI's sign-in couldn't fetch it): Max.
    expect(await plan()).toBe("max");
    writeFileSync(config, ultra);
    expect(await plan()).toBe("ultra");
    writeFileSync(config, JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_max_5x" } }));
    expect(await plan()).toBe("max");
    const elsewhere = path.join(path.dirname(root), "elsewhere.json");
    writeFileSync(elsewhere, ultra);
    rmSync(config);
    symlinkSync(elsewhere, config);
    expect(await plan()).toBe("max");
  },
);

test.if(posix)("list is cached: a second look doesn't run the CLIs again", async () => {
  const { m, root, runs } = setup();
  const id = LOGIN(10);
  mkdirSync(path.join(root, "codex", id), { recursive: true });
  const first = await m.list();
  expect(first).toHaveLength(1);
  const n = runs().length;
  await m.list();
  expect(runs().length).toBe(n);
  m.invalidate();
  await m.list();
  expect(runs().length).toBe(n + 1);
});

// ── Coding plans' keys (protocol 20) ─────────────────────────────────────────

const GLM_KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";

test.if(posix)(
  "a plan's key: begin makes the folder and a key pair (no CLI), the sealed key is kept (600) and listed; refused, signed out",
  async () => {
    const lines: string[] = [];
    const { m, root, runs, changes } = setup({ log: (l) => lines.push(l) });
    const id = LOGIN(40);
    const begun = await m.begin("claude_code", id, false, undefined, "zai");
    expect(begun.url).toBeUndefined();
    expect(typeof begun.publicKey).toBe("string");
    const dir = path.join(root, "claude_code", id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(m.status(id)).toEqual({ state: "waiting" });
    expect(m.accountDir("claude_code", id)).toBeNull();
    expect(await m.list()).toEqual([]);

    // Not a key: refused, and the error never repeats what was pasted.
    const wrong = await sealed(begun.publicKey as string, id, "my password 1234");
    const err = await m.code(id, wrong.aad, wrong.box).catch((e: Error & { code?: string }) => e);
    expect(err).toMatchObject({ code: "bad_request" });
    expect((err as Error).message).not.toContain("password");
    expect(m.status(id).state).toBe("waiting");

    const { aad, box } = await sealed(begun.publicKey as string, id, `  ${GLM_KEY}\n`);
    const before = changes();
    await m.code(id, aad, box);
    const account = {
      id,
      kind: "claude_code" as const,
      loggedIn: true,
      provider: "zai",
      keyHint: "MnOp",
      shared: true,
    };
    expect(m.status(id)).toEqual({ state: "done", account });
    expect(changes()).toBeGreaterThan(before);
    const file = path.join(dir, "provider.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ provider: "zai", key: GLM_KEY });
    expect(existsSync(path.join(dir, ".signing-in"))).toBe(false);
    expect(m.accountDir("claude_code", id)).toBe(dir);
    // Signed in without asking any CLI.
    m.invalidate();
    expect(await m.list()).toEqual([account]);
    expect(runs()).toHaveLength(0);

    // Its endpoint refused the key in a turn: signed out until another key comes.
    await m.refused("claude_code", id);
    m.invalidate();
    expect(await m.list()).toEqual([{ ...account, loggedIn: false }]);
    const again = await m.begin("claude_code", id, true, undefined, "zai");
    const next = await sealed(again.publicKey as string, id, `${GLM_KEY}9`);
    await m.code(id, next.aad, next.box);
    m.invalidate();
    expect(await m.list()).toEqual([{ ...account, keyHint: "nOp9" }]);

    // Removed: nothing to sign out of, the folder goes.
    expect(await m.remove("claude_code", id)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(runs()).toHaveLength(0);
    // The key never reached a log line.
    expect(lines.join("\n")).not.toContain("0123456789abcdef");
    expect(lines.join("\n")).not.toContain("AbCdEf");

    // Only Claude Code takes a plan, and only one this computer knows.
    expect(await errorCode(() => m.begin("claude_code", LOGIN(41), false, undefined, "nope"))).toBe("bad_request");
    expect(await errorCode(() => m.begin("codex", LOGIN(42), false, undefined, "zai"))).toBe("bad_request");
    expect(await errorCode(() => m.begin("claude_code", LOGIN(43), false, "a@b.co", "zai"))).toBe("bad_request");
    // OpenCode Go's keys start with oc_sk_.
    const oc = await m.begin("claude_code", LOGIN(44), false, undefined, "opencode");
    const notOc = await sealed(oc.publicKey as string, LOGIN(44), GLM_KEY);
    expect(await errorCode(() => m.code(LOGIN(44), notOc.aad, notOc.box))).toBe("bad_request");
  },
);

test.if(posix)("a key sign-in nobody finishes expires and leaves no folder", async () => {
  const { m, root } = setup({ ttlMs: 300 });
  const id = LOGIN(45);
  await m.begin("claude_code", id, false, undefined, "minimax");
  await waitFor(() => m.status(id).state === "expired", 3000);
  await waitFor(() => !existsSync(path.join(root, "claude_code", id)));
});

// ── System mode: folders lent to agents' users ───────────────────────────────

test.if(posix)(
  "system mode: a folder goes to the agent's user bottom-up and back to root top-down, never through a link, and root runs no CLI there again",
  async () => {
    const calls: [string, number, number][] = [];
    const chown = async (file: string, uid: number, gid: number) => {
      calls.push([file, uid, gid]);
    };
    const { m, root, runs } = setup({ lending: { chown } });
    const id = LOGIN(50);
    const dir = path.join(root, "claude_code", id);
    mkdirSync(path.join(dir, "projects", "p1"), { recursive: true });
    writeFileSync(path.join(dir, "signed-in"), "");
    writeFileSync(path.join(dir, "projects", "p1", "s.jsonl"), "{}");
    // A file with another name elsewhere and a link out: neither is handed over.
    const outside = path.join(root, "..", "outside.txt");
    writeFileSync(outside, "mine");
    linkSync(outside, path.join(dir, "hardlink"));
    symlinkSync(outside, path.join(dir, "symlink"));

    expect(await m.lendTo("claude_code", id, 21001)).toBe(true);
    const order = (file: string) => calls.findIndex((c) => c[0] === file);
    // Bottom-up, the top last; the uid only (the group stays root's).
    expect(calls.at(-1)).toEqual([dir, 21001, -1]);
    expect(order(path.join(dir, "projects", "p1", "s.jsonl"))).toBeLessThan(order(path.join(dir, "projects", "p1")));
    expect(order(path.join(dir, "projects", "p1"))).toBeLessThan(order(path.join(dir, "projects")));
    expect(calls.find((c) => c[0] === path.join(dir, "symlink"))).toEqual([path.join(dir, "symlink"), 21001, -1]);
    expect(order(path.join(dir, "hardlink"))).toBe(-1);
    expect(existsSync(path.join(dir, "hardlink"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("mine");
    // Its user passes through to it and lists nothing else.
    expect(statSync(path.join(root, "claude_code")).mode & 0o777).toBe(0o711);
    expect(statSync(root).mode & 0o777).toBe(0o711);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    // The same user again: nothing to do.
    calls.length = 0;
    expect(await m.lendTo("claude_code", id, 21001)).toBe(true);
    expect(calls).toHaveLength(0);
    // Its status is what its turns say: root never runs the CLI on what the agent's user could write.
    const ran = runs().length;
    m.invalidate();
    expect(await m.list()).toEqual([{ id, kind: "claude_code", loggedIn: true }]);
    await m.refused("claude_code", id);
    m.invalidate();
    expect(await m.list()).toEqual([{ id, kind: "claude_code", loggedIn: false }]);
    m.probeUsage([id]);
    await new Promise((r) => setTimeout(r, 100));
    expect(runs().length).toBe(ran);

    // Another agent: back to root top-down (each folder root's before it is read), then to the other user.
    calls.length = 0;
    expect(await m.lendTo("claude_code", id, 21002)).toBe(true);
    expect(calls[0]).toEqual([dir, 0, 0]);
    const back = calls.findIndex((c) => c[1] === 21002);
    expect(order(path.join(dir, "projects"))).toBeLessThan(order(path.join(dir, "projects", "p1")));
    expect(calls.slice(0, back).every((c) => c[1] === 0 && c[2] === 0)).toBe(true);
    expect(calls.at(-1)).toEqual([dir, 21002, -1]);

    // The agents frame still says so: it stays; once it doesn't, it is root's at once.
    calls.length = 0;
    await m.keepLent(new Map([[id, 21002]]));
    expect(calls).toHaveLength(0);
    await m.keepLent(new Map([[id, 21003]]));
    expect(calls[0]).toEqual([dir, 0, 0]);
    expect(calls.every((c) => c[1] === 0)).toBe(true);

    // Signing in again starts it over, as root's; removing it signs nothing out as root.
    expect(await m.lendTo("claude_code", id, 21002)).toBe(true);
    expect(await m.remove("claude_code", id)).toBe(true);
    expect(runs().some((r) => r.args === "auth logout")).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(root, "claude_code", `${id}.lent`))).toBe(false);
  },
);

test.if(posix)("system mode: a pipe an agent's user leaves where a key would be never hangs root", async () => {
  const { m, root } = setup({ lending: { chown: async () => {} } });
  const id = LOGIN(55);
  const dir = path.join(root, "claude_code", id);
  mkdirSync(dir, { recursive: true });
  expect(await m.lendTo("claude_code", id, 21001)).toBe(true);
  expect(spawnSync("mkfifo", [path.join(dir, "provider.json")]).status).toBe(0);
  expect(spawnSync("mkfifo", [path.join(dir, ".claude.json")]).status).toBe(0);
  expect(await planKeyOf(dir)).toBeNull();
  m.invalidate();
  const listed = await Promise.race([m.list(), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
  expect(listed).toEqual([{ id, kind: "claude_code", loggedIn: true }]);
});

test.if(posix)(
  "system mode: a folder an agent's user had lists the plan Claude Code keeps there, never through a link, with no CLI",
  async () => {
    const { m, root, runs } = setup({ lending: { chown: async () => {} } });
    const id = LOGIN(56);
    const dir = path.join(root, "claude_code", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "signed-in"), "");
    const config = path.join(dir, ".claude.json");
    const kept = (organizationType: string, organizationRateLimitTier?: string) =>
      JSON.stringify({ oauthAccount: { organizationType, organizationRateLimitTier } });
    const listed = async () => {
      m.invalidate();
      return (await m.list())[0];
    };
    expect(await m.lendTo("claude_code", id, 21001)).toBe(true);
    // Nothing kept there: no plan, so the server keeps the one it knew.
    expect(await listed()).toEqual({ id, kind: "claude_code", loggedIn: true });
    writeFileSync(config, kept("claude_max", "default_claude_max_20x"));
    expect(await listed()).toEqual({ id, kind: "claude_code", loggedIn: true, plan: "ultra" });
    writeFileSync(config, kept("claude_max", "default_claude_max_5x"));
    expect((await listed())?.plan).toBe("max");
    writeFileSync(config, kept("claude_team", "default_claude_max_20x"));
    expect((await listed())?.plan).toBe("team");
    // Root's again (no agent thinks with it now): still read, never run.
    await m.keepLent(new Map());
    writeFileSync(config, kept("claude_max", "default_claude_max_20x"));
    expect((await listed())?.plan).toBe("ultra");
    const elsewhere = path.join(path.dirname(root), "elsewhere.json");
    writeFileSync(elsewhere, kept("claude_pro"));
    rmSync(config);
    symlinkSync(elsewhere, config);
    expect(await listed()).toEqual({ id, kind: "claude_code", loggedIn: true });
    expect(runs()).toHaveLength(0);
  },
);

test.if(posix)("system mode: a sign-in in progress is lent to nobody; without lending nothing is", async () => {
  const chown = async () => {};
  const { m } = setup({ lending: { chown } });
  await m.begin("claude_code", LOGIN(51));
  expect(await m.lendTo("claude_code", LOGIN(51), 21001)).toBe(false);
  expect(await m.lendTo("claude_code", LOGIN(52), 21001)).toBe(false);
  const plain = setup();
  mkdirSync(path.join(plain.root, "claude_code", LOGIN(53)), { recursive: true });
  expect(await plain.m.lendTo("claude_code", LOGIN(53), 21001)).toBe(false);
});

test.if(posix)("a worker finds only the folders its user can open", () => {
  const root = tempDir("lent-");
  dirs.push(root);
  const mine = path.join(root, "claude_code", LOGIN(54));
  mkdirSync(mine, { recursive: true });
  const lent = lentAccounts(root);
  expect(lent.accountDir("claude_code", LOGIN(54))).toBe(mine);
  expect(lent.accountDir("codex", LOGIN(54))).toBeNull();
  expect(lent.accountDir("claude_code", "../x")).toBeNull();
});

// ── The `account` op ─────────────────────────────────────────────────────────

test.if(posix)("op account: machine-wide, a new sign-in is refused while paused, the rest answers", async () => {
  process.env.FAKE_CODEX_DELAY = "10000";
  const { m } = setup();
  const ws = tempDir("accounts-ws-");
  dirs.push(ws);
  let paused = true;
  const ctx: HandlerContext = { workspaceReal: ws, exec: true, token: "t", accounts: m, paused: () => paused };
  const scope = { signal: new AbortController().signal, output: () => {} };
  const req = (r: Record<string, unknown>) => ({ op: "account", ...r }) as unknown as MachineRequest;
  expect(await handleRequest(ctx, req({ action: "list" }), scope)).toEqual({ accounts: [] });
  const begin = req({ action: "begin", kind: "codex", loginId: LOGIN(11) });
  expect(await errorCode(() => handleRequest(ctx, begin, scope))).toBe("paused");
  paused = false;
  const begun = (await handleRequest(ctx, begin, scope)) as Record<string, unknown>;
  expect(begun.userCode).toBe("7HYC-J6JGM");
  expect(await handleRequest(ctx, req({ action: "status", loginId: LOGIN(11) }), scope)).toEqual({ state: "waiting" });
  expect(await handleRequest(ctx, req({ action: "cancel", loginId: LOGIN(11) }), scope)).toEqual({});
  expect(await errorCode(() => handleRequest(ctx, req({ action: "status", loginId: LOGIN(12) }), scope))).toBe(
    "not_found",
  );
  expect(await errorCode(() => handleRequest(ctx, req({ action: "nope" }), scope))).toBe("bad_request");
  const bare: HandlerContext = { workspaceReal: ws, exec: true, token: "t" };
  expect(await errorCode(() => handleRequest(bare, req({ action: "list" }), scope))).toBe("bad_request");
  // The log line names the action and the sign-in, never a code.
  expect(
    describeRequest(req({ action: "code", loginId: LOGIN(11), aad: "x", box: { v: 1, epk: "e", iv: "i", ct: "c" } })),
  ).toBe(`account code ${LOGIN(11).slice(0, 8)}`);
});

// ── One sign-in for all of an owner's agents (protocol 29) ───────────────────

const TOKEN = "sk-ant-oat01-fake-token-for-tests-only";

test("a terminal's screen: words apart by cursor moves, a line drawn in pieces, cut escapes and erases", () => {
  const s = new Screen();
  s.write(`${ESC}[2GYour${ESC}[7GOAuth${ESC}[13Gtoken:\r\r\n${ESC}[33m${ESC}[2Gsk-ant-oat01-ab`);
  // Half a token, nothing drawn under it yet: not it.
  expect(parseSetupToken(s.text())).toBeNull();
  s.write(`${ESC}[17Gcdefgh${ESC}[39m\r\r\n\r\r\n${ESC}[2GStore${ESC}[8Gthis${ESC}[13Gtoken`);
  expect(s.text()).toBe(" Your OAuth token:\n sk-ant-oat01-abcdefgh\n\n Store this token");
  expect(parseSetupToken(s.text())).toBe("sk-ant-oat01-abcdefgh");
  // An escape cut between two pieces waits for the rest; a hyperlink keeps only its text.
  const t = new Screen();
  t.write(`ab${ESC}[3`);
  t.write(`8;5;246mcd ${ESC}]8;id=x;https://x.test\x07link${ESC}]8;;\x07`);
  expect(t.text()).toBe("abcd link");
  // Moving up and erasing redraws a line in place.
  const u = new Screen();
  u.write("one\r\ntwo\r\n");
  u.write(`${ESC}[2A${ESC}[2K${ESC}[1Gthree`);
  expect(u.text()).toBe("three\ntwo");
  // Only a token after "OAuth token"; once the CLI ended, without the line under it.
  expect(parseSetupToken(`${TOKEN}\nYour OAuth token:\nStore this token`)).toBeNull();
  expect(parseSetupToken(`Your OAuth token:\n${TOKEN}`, true)).toBe(TOKEN);
  // A grant off root's frame: only whole tokens, known plans.
  expect(grantOf({ kind: "token", token: TOKEN })).toEqual({ kind: "token", token: TOKEN });
  expect(grantOf({ kind: "token", token: `${TOKEN} x` })).toBeNull();
  expect(grantOf({ kind: "key", provider: "nope", key: "k" })).toBeNull();
  expect(grantOf({ kind: "none" })).toEqual({ kind: "none" });
  expect(grantOf(undefined)).toBeNull();
});

test("Claude Code 2.1.314's own setup-token screen, read in pieces: its link and the prompt, words where they show", () => {
  const raw = JSON.parse(
    readFileSync(path.join(import.meta.dir, "fixtures", "setup-token", "claude-2.1.314.json"), "utf8"),
  ) as string;
  const s = new Screen();
  for (let i = 0; i < raw.length; i += 37) s.write(raw.slice(i, i + 37));
  const text = s.text();
  expect(text).toContain("This will guide you through long-lived (1-year) auth token setup for your Claude account.");
  // The spinner's line was drawn over by the link's.
  expect(text).not.toContain("Opening browser");
  expect(text.trimEnd().endsWith("Paste code here if prompted >")).toBe(true);
  const url = parseClaudeLoginUrl(text);
  expect(url).toStartWith("https://claude.com/cai/oauth/authorize?code=true&client_id=");
  expect(url).toEndWith("&state=fake-state-for-tests-00000000000000000000000");
  expect(url).toContain("scope=user%3Ainference");
});

test.if(posix)(
  "system mode, Claude for all agents: setup-token signs in in a terminal, root keeps only its token (600), never lent",
  async () => {
    const lines: string[] = [];
    const { m, root, runs } = setup({ lending: { chown: async () => {} }, log: (l) => lines.push(l) });
    const id = LOGIN(70);
    const begun = await m.begin("claude_code", id, false, undefined, undefined, true);
    expect(begun.url).toStartWith("https://claude.com/cai/oauth/authorize?");
    expect(begun.url).toContain("scope=user%3Ainference");
    expect(typeof begun.publicKey).toBe("string");
    const dir = path.join(root, "claude_code", id);
    expect(runs()[0]).toEqual({ args: "setup-token", home: dir, terminal: true });
    const { aad, box } = await sealed(begun.publicKey as string, id, "good-code");
    await m.code(id, aad, box);
    await waitFor(() => m.status(id).state !== "waiting", 8000);
    const account = { id, kind: "claude_code" as const, loggedIn: true, shared: true };
    expect(m.status(id)).toEqual({ state: "done", account });
    const file = path.join(dir, "token.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: TOKEN });
    expect(await tokenOf(dir)).toBe(TOKEN);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(path.join(dir, ".signing-in"))).toBe(false);
    m.invalidate();
    expect(await m.list()).toEqual([account]);
    // Each turn gets the token from root; the folder is never an agent's, and no CLI asks about it as root.
    expect(await m.grant("claude_code", id)).toEqual({ kind: "token", token: TOKEN });
    expect(await m.lendTo("claude_code", id, 21001)).toBe(false);
    m.probeUsage([id]);
    await new Promise((r) => setTimeout(r, 100));
    expect(runs().map((r) => r.args)).toEqual(["setup-token"]);
    // A turn's endpoint refused it: signed out for every agent, nothing to hand over, until it signs in again.
    await m.refused("claude_code", id);
    m.invalidate();
    expect(await m.list()).toEqual([{ ...account, loggedIn: false }]);
    expect(await m.grant("claude_code", id)).toEqual({ kind: "none" });
    const again = await m.begin("claude_code", id, true, undefined, undefined, true);
    const next = await sealed(again.publicKey as string, id, "good-code");
    await m.code(id, next.aad, next.box);
    await waitFor(() => m.status(id).state !== "waiting", 8000);
    expect(m.status(id)).toEqual({ state: "done", account });
    expect(await m.grant("claude_code", id)).toEqual({ kind: "token", token: TOKEN });
    // Never in a log line.
    expect(lines.join("\n")).not.toContain("oat01");
    // Removed: nothing runs as root (only Claude's settings end a token), the folder and its markers go.
    expect(await m.remove("claude_code", id)).toBe(true);
    expect(runs().map((r) => r.args)).toEqual(["setup-token", "setup-token"]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.shared`)).toBe(false);
    expect(existsSync(`${dir}.invalid`)).toBe(false);
  },
  20_000,
);

test.if(posix)(
  "a token sign-in that fails or shows no token keeps nothing, and never says the code or a token back",
  async () => {
    const { m, root } = setup({ lending: { chown: async () => {} } });
    const id = LOGIN(73);
    const begun = await m.begin("claude_code", id, false, undefined, undefined, true);
    const wrong = await sealed(begun.publicKey as string, id, "wrong-secret-code");
    await m.code(id, wrong.aad, wrong.box);
    await waitFor(() => m.status(id).state !== "waiting", 8000);
    const failed = m.status(id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("couldn't sign in");
    expect(failed.error).not.toContain("wrong-secret-code");
    await waitFor(() => !existsSync(path.join(root, "claude_code", id)));
    expect(existsSync(path.join(root, "claude_code", `${id}.shared`))).toBe(false);

    process.env.FAKE_ACCOUNT_MODE = "notoken";
    const other = LOGIN(74);
    const b = await m.begin("claude_code", other, false, undefined, undefined, true);
    const good = await sealed(b.publicKey as string, other, "good-code");
    await m.code(other, good.aad, good.box);
    await waitFor(() => m.status(other).state !== "waiting", 8000);
    expect(m.status(other)).toMatchObject({ state: "failed", error: expect.stringContaining("didn't show its token") });
    await waitFor(() => !existsSync(path.join(root, "claude_code", other)));
    expect(await m.list()).toEqual([]);
  },
  20_000,
);

test.if(posix)(
  "system mode: a plan's key for all agents is handed over, never lent; one agent's login starts over when signed in for all",
  async () => {
    const chowned: string[] = [];
    const { m, root, runs } = setup({ lending: { chown: async (file) => void chowned.push(file) } });
    const all = LOGIN(75);
    const begun = await m.begin("claude_code", all, false, undefined, "zai", true);
    const k = await sealed(begun.publicKey as string, all, GLM_KEY);
    await m.code(all, k.aad, k.box);
    const account = { id: all, kind: "claude_code" as const, loggedIn: true, provider: "zai", keyHint: "MnOp" };
    expect(m.status(all)).toEqual({ state: "done", account: { ...account, shared: true } });
    expect(await m.grant("claude_code", all)).toEqual({ kind: "key", provider: "zai", key: GLM_KEY });
    expect(await m.lendTo("claude_code", all, 21001)).toBe(false);
    expect(chowned).toEqual([]);

    // Made for one agent (before protocol 29, or with the switch off): lent, never handed over.
    const one = LOGIN(76);
    const b1 = await m.begin("claude_code", one, false, undefined, "zai");
    const k1 = await sealed(b1.publicKey as string, one, GLM_KEY);
    await m.code(one, k1.aad, k1.box);
    expect(m.status(one).account).toEqual({ ...account, id: one });
    expect(await m.grant("claude_code", one)).toBeNull();
    expect(await m.lendTo("claude_code", one, 21001)).toBe(true);
    // Signed in again for all agents: root takes it back and empties it first, then it is for all.
    const b2 = await m.begin("claude_code", one, true, undefined, "zai", true);
    expect(existsSync(path.join(root, "claude_code", `${one}.lent`))).toBe(false);
    expect(existsSync(path.join(root, "claude_code", one, "provider.json"))).toBe(false);
    const k2 = await sealed(b2.publicKey as string, one, GLM_KEY);
    await m.code(one, k2.aad, k2.box);
    expect(await m.grant("claude_code", one)).toEqual({ kind: "key", provider: "zai", key: GLM_KEY });
    m.invalidate();
    expect((await m.list()).map((a) => a.shared)).toEqual([true, true]);

    // ChatGPT's for all agents too: root signs in, never lends it, and hands each turn its auth.json.
    const codex = LOGIN(77);
    await m.begin("codex", codex, false, undefined, undefined, true);
    await waitFor(() => m.status(codex).state !== "waiting", 5000);
    expect(m.status(codex)).toEqual({
      state: "done",
      account: { id: codex, kind: "codex", loggedIn: true, shared: true },
    });
    const granted = await m.grant("codex", codex);
    expect(granted?.kind).toBe("codex_auth");
    expect(grantOf(granted)).toEqual(granted);
    expect(await m.lendTo("codex", codex, 21001)).toBe(false);
    expect(runs().map((r) => r.args)).toEqual(["login --device-auth", "login status"]);
    // One for one agent stays lent per turn, as before.
    const single = LOGIN(79);
    await m.begin("codex", single);
    await waitFor(() => m.status(single).state !== "waiting", 5000);
    expect(m.status(single).account?.shared).toBeUndefined();
    expect(await m.grant("codex", single)).toBeNull();
  },
  20_000,
);

const codexAuth = (refresh: string, at: number, account = "acct-fake") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { id_token: "i", access_token: "a", refresh_token: refresh, account_id: account },
    last_refresh: new Date(at).toISOString(),
  });

test.if(posix)(
  "system mode: a ChatGPT sign-in for all agents takes refreshed copies back, and one due for its refresh goes to one turn first",
  async () => {
    const DAY = 24 * 3600_000;
    let clock = Date.parse("2026-11-02T12:00:00Z");
    process.env.FAKE_CODEX_REFRESHED = new Date(clock - 9 * DAY).toISOString();
    const { m, root } = setup({ lending: { chown: async () => {} }, now: () => clock });
    const id = LOGIN(80);
    await m.begin("codex", id, false, undefined, undefined, true);
    await waitFor(() => m.status(id).state !== "waiting", 5000);
    const stale = await m.grant("codex", id);
    expect(stale?.kind).toBe("codex_auth");
    // Due: a second turn waits for the first one's refreshed copy, and gets it.
    let second: unknown = null;
    const waiting = m.grant("codex", id).then((g) => {
      second = g;
    });
    await Bun.sleep(50);
    expect(second).toBeNull();
    // Older, or another ChatGPT account: never kept.
    expect(m.keepCodexAuth(id, codexAuth("old", clock - 10 * DAY))).toBe(false);
    expect(m.keepCodexAuth(id, codexAuth("other", clock, "acct-someone-else"))).toBe(false);
    expect(m.keepCodexAuth(id, "not json")).toBe(false);
    // Written by hand in the agent's Codex home: dated ahead, or the same refresh token, is no refresh.
    expect(m.keepCodexAuth(id, codexAuth("fake-refresh-x", Date.parse("2099-01-01T00:00:00Z")))).toBe(false);
    expect(m.keepCodexAuth(id, codexAuth("fake-refresh-1", clock))).toBe(false);
    expect(m.keepCodexAuth(id, codexAuth("fake-refresh-2", clock))).toBe(true);
    await waiting;
    expect(second).toEqual({ kind: "codex_auth", auth: codexAuth("fake-refresh-2", clock) });
    const kept = JSON.parse(readFileSync(path.join(root, "codex", id, "auth.json"), "utf8"));
    expect(kept.tokens.refresh_token).toBe("fake-refresh-2");
    expect(statSync(path.join(root, "codex", id, "auth.json")).mode & 0o777).toBe(0o600);
    // Fresh: turns at once all get it, nobody waits.
    clock += DAY;
    const both = await Promise.all([m.grant("codex", id), m.grant("codex", id)]);
    expect(both.map((g) => g?.kind)).toEqual(["codex_auth", "codex_auth"]);
    // A refreshed copy for an account made for one agent is never taken.
    expect(m.keepCodexAuth(LOGIN(81), codexAuth("x", clock + DAY))).toBe(false);
  },
  20_000,
);

test("in an agent's worker: root's copy goes in unless the agent's is newer, and a refreshed one goes back", async () => {
  const home = tempDir("codex-home-");
  dirs.push(home);
  const file = path.join(home, "auth.json");
  placeCodexAuth(home, codexAuth("r1", 1000));
  expect(JSON.parse(readFileSync(file, "utf8")).tokens.refresh_token).toBe("r1");
  // This agent's Codex refreshed it already: root's older copy doesn't overwrite it.
  writeFileSync(file, codexAuth("r2", 2000));
  placeCodexAuth(home, codexAuth("r1", 1000));
  expect(JSON.parse(readFileSync(file, "utf8")).tokens.refresh_token).toBe("r2");
  placeCodexAuth(home, codexAuth("r3", 3000));
  expect(JSON.parse(readFileSync(file, "utf8")).tokens.refresh_token).toBe("r3");
  expect(codexAuthOf("{}")).toBeNull();

  const sent: string[] = [];
  const watch = watchCodexAuth(home, codexAuth("r3", 3000), (a) => sent.push(a), 10);
  await Bun.sleep(30);
  expect(sent).toEqual([]);
  writeFileSync(file, codexAuth("r4", 4000));
  await waitFor(() => sent.length > 0, 2000);
  watch.stop();
  expect(sent.map((a) => JSON.parse(a).tokens.refresh_token)).toEqual(["r4"]);
});

test.if(posix)("where every agent is the runner's own user, every account thinks for all of them", async () => {
  const { m, root } = setup();
  const id = LOGIN(78);
  const dir = path.join(root, "claude_code", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "signed-in"), "");
  expect(await m.list()).toEqual([
    { id, kind: "claude_code", loggedIn: true, email: "dev@acme.test", plan: "max", shared: true },
  ]);
  // Nothing to hand over: every agent's CLI opens the folder itself.
  expect(await m.grant("claude_code", id)).toBeNull();
});

test.if(posix)(
  "a worker's own folder for an account root keeps; a pipe where a token would be never hangs root",
  async () => {
    const home = tempDir("worker-home-");
    dirs.push(home);
    const own = agentAccountHome(home, "claude_code", LOGIN(79));
    expect(own).toBe(path.join(home, "accounts", "claude_code", LOGIN(79)));
    expect(statSync(own as string).mode & 0o777).toBe(0o700);
    expect(agentAccountHome(home, "claude_code", "../x")).toBeNull();
    expect(spawnSync("mkfifo", [path.join(own as string, "token.json")]).status).toBe(0);
    const read = await Promise.race([tokenOf(own as string), new Promise((r) => setTimeout(() => r("hung"), 3000))]);
    expect(read).toBeNull();
  },
);

test.if(posix)(
  "system mode: while an account for all agents signs in again, turns still get what it has, and closing the dialog changes nothing",
  async () => {
    const { m } = setup({ lending: { chown: async () => {} } });
    const key = LOGIN(80);
    const begun = await m.begin("claude_code", key, false, undefined, "zai", true);
    const k = await sealed(begun.publicKey as string, key, GLM_KEY);
    await m.code(key, k.aad, k.box);
    const kept = { kind: "key", provider: "zai", key: GLM_KEY } as const;
    expect(await m.grant("claude_code", key)).toEqual(kept);
    // New key, its dialog open: the key it has still thinks.
    await m.begin("claude_code", key, true, undefined, "zai", true);
    expect(await m.grant("claude_code", key)).toEqual(kept);
    // Closed with no key pasted: as it was.
    expect(await m.cancel(key)).toBe(true);
    expect(await m.grant("claude_code", key)).toEqual(kept);

    const token = LOGIN(81);
    const t = await m.begin("claude_code", token, false, undefined, undefined, true);
    const c = await sealed(t.publicKey as string, token, "good-code");
    await m.code(token, c.aad, c.box);
    await waitFor(() => m.status(token).state !== "waiting", 8000);
    // Sign in again started while the token still works: turns keep it meanwhile.
    await m.begin("claude_code", token, true, undefined, undefined, true);
    expect(await m.grant("claude_code", token)).toEqual({ kind: "token", token: TOKEN });
    expect(await m.cancel(token)).toBe(true);
    m.invalidate();
    expect((await m.list()).map((a) => [a.id, a.loggedIn])).toEqual([
      [key, true],
      [token, true],
    ]);
  },
  20_000,
);
