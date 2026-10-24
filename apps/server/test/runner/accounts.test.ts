import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { accountCodeAad, type MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { sealSecret } from "@agenteschat/adapters/secret-box";
import {
  AccountManager,
  type AccountManagerOptions,
  parseClaudeLoginUrl,
  parseClaudeStatus,
  parseCodexLogin,
  parseCodexStatus,
  stripAnsi,
} from "../../runner/accounts";
import { describeRequest, type HandlerContext, handleRequest } from "../../runner/handlers";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const FAKE_ENV = ["FAKE_ACCOUNT_MODE", "FAKE_ACCOUNT_LOG", "FAKE_ACCOUNT_CODE", "FAKE_CODEX_DELAY"];
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

test("status commands: signed in with email and plan (short words only), anything else is signed out", () => {
  const good = JSON.stringify({ loggedIn: true, email: "dev@acme.test", subscriptionType: "max" });
  expect(parseClaudeStatus(0, good)).toEqual({ loggedIn: true, email: "dev@acme.test", plan: "max" });
  const odd = JSON.stringify({ loggedIn: true, email: "not an email", subscriptionType: "a b" });
  expect(parseClaudeStatus(0, odd)).toEqual({ loggedIn: true });
  expect(parseClaudeStatus(1, JSON.stringify({ loggedIn: false }))).toEqual({ loggedIn: false });
  expect(parseClaudeStatus(0, "garbage")).toEqual({ loggedIn: false });
  expect(parseCodexStatus(0, `${ESC}[32mLogged in using ChatGPT${ESC}[0m\n`)).toEqual({ loggedIn: true });
  expect(parseCodexStatus(1, "Not logged in\n")).toEqual({ loggedIn: false });
  expect(parseCodexStatus(0, "Not logged in\n")).toEqual({ loggedIn: false });
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
        .map((l) => JSON.parse(l) as { args: string; home: string });
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
      account: { id, kind: "claude_code", loggedIn: true, email: "dev@acme.test", plan: "max" },
    });
    expect(changes()).toBeGreaterThan(0);
    expect(m.accountDir("claude_code", id)).toBe(dir);
    expect(m.accountDir("codex", id)).toBeNull();
    expect(await m.list()).toEqual([{ id, kind: "claude_code", loggedIn: true, email: "dev@acme.test", plan: "max" }]);
    expect(m.snapshot()).toHaveLength(1);
    // The same id can't start again.
    expect(await errorCode(() => m.begin("claude_code", id))).toBe("bad_request");
    expect(await errorCode(() => m.code(id, aad, box))).toBe("bad_request");
  },
  15_000,
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
    expect(m.status(id)).toEqual({ state: "done", account: { id, kind: "codex", loggedIn: true } });
    expect(runs().map((r) => r.args)).toContain("login status");
    expect(await m.list()).toEqual([{ id, kind: "codex", loggedIn: true }]);
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
  expect(await m.list()).toEqual([{ id, kind: "claude_code", loggedIn: true, email: "dev@acme.test", plan: "max" }]);
  const before = changes();
  expect(await m.remove("claude_code", id)).toBe(true);
  expect(runs().find((r) => r.args === "auth logout")?.home).toBe(dir);
  expect(existsSync(dir)).toBe(false);
  expect(changes()).toBeGreaterThan(before);
  expect(await m.list()).toEqual([]);
  expect(await m.remove("claude_code", id)).toBe(false);
});

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
