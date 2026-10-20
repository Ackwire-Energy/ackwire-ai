import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ACCOUNT_KINDS,
  ACCOUNT_LOGIN_TTL_MS,
  type AccountKind,
  type AccountLoginState,
  accountCodeAad,
  isAccountId,
  isAccountKind,
  type MachineReplies,
  type RunnerAccountInfo,
  type WireSecretBox,
} from "@agenteschat/adapters/machine-protocol";
import { generateSecretKeyPair, openSecret } from "@agenteschat/adapters/secret-box";
import { errnoCode, RunnerError } from "./errors";
import { killTree } from "./exec";
import { resolveCommand } from "./executors";

/**
 * The computer brains' accounts on this machine (ADR 0041). An account is a
 * folder `<runner home>/accounts/<kind>/<id>` (mode 700) used as
 * `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex): the CLI signs
 * in there and keeps its own sign-in; the runner never reads it.
 *
 * - `begin` starts the CLI's own sign-in with plain pipes (`claude auth login`,
 *   `codex login --device-auth`) in a new folder and reads what it printed:
 *   Claude Code's URL (plus an ephemeral key the browser seals the pasted code
 *   with), or Codex's device URL and one-time code.
 * - `code` opens the sealed Claude code and writes it to the waiting CLI.
 * - When the CLI exits, its status command (`claude auth status --json`,
 *   `codex login status`) in that folder decides: `done` with the email and
 *   plan, or `failed` (folder removed). After `ACCOUNT_LOGIN_TTL_MS` the sign-in
 *   is killed and its folder removed (`expired`).
 * - `list` asks each account's CLI (cached for `ACCOUNTS_TTL_MS`), `remove` signs
 *   out (best effort) and deletes the folder, `accountDir` is what a brain turn
 *   runs with.
 */

/** A fresh look at every account's status happens at most this often (each one runs the CLI). */
export const ACCOUNTS_TTL_MS = 10 * 60_000;
/** How long `begin` waits for the CLI to print its URL (and Codex its code). */
export const ACCOUNT_BEGIN_WAIT_MS = 15_000;
/** A finished sign-in still answers `status` this long (a late poll gets the result). */
export const ACCOUNT_FINISHED_KEEP_MS = 5 * 60_000;
/** Status and sign-out commands are killed after this. */
const STATUS_TIMEOUT_MS = 10_000;
/** The longest Claude code accepted (they are a few dozen characters). */
const MAX_CODE_CHARS = 2000;
const OUTPUT_KEEP = 16_000;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const WORD = /^[\w.-]{1,40}$/;

const LABEL: Record<AccountKind, string> = { claude_code: "Claude Code", codex: "Codex" };
const ENV_VAR: Record<AccountKind, string> = { claude_code: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const LOGIN_ARGS: Record<AccountKind, string[]> = {
  claude_code: ["auth", "login"],
  codex: ["login", "--device-auth"],
};
const STATUS_ARGS: Record<AccountKind, string[]> = {
  claude_code: ["auth", "status", "--json"],
  codex: ["login", "status"],
};
const LOGOUT_ARGS: Record<AccountKind, string[]> = { claude_code: ["auth", "logout"], codex: ["logout"] };

/** What a brain turn says when its account folder is gone (people read it). */
export const ACCOUNT_MISSING_MESSAGE: Record<AccountKind, string> = {
  claude_code:
    "The Claude account chosen for this agent isn't on this computer anymore. Choose another account in the agent's settings, or add it again.",
  codex:
    "The Codex account chosen for this agent isn't on this computer anymore. Choose another account in the agent's settings, or add it again.",
};

/** The env a CLI runs with for an account folder. */
export const accountEnv = (kind: AccountKind, dir: string): Record<string, string> => ({ [ENV_VAR[kind]]: dir });

// ── Reading what the CLIs print ──────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** OSC (hyperlinks, titles), ended by BEL or ST (`ESC \\`). */
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
/** CSI (colors, cursor moves). */
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
/** Any other two-character escape. */
const FE = new RegExp(`${ESC}[@-_]`, "g");

/** Terminal escapes out (an OSC 8 hyperlink keeps only its text), carriage returns too. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(FE, "").replace(/\r/g, "");
}

/** An https URL up to whitespace, a quote or an escape that wasn't stripped (a hyperlink still arriving). */
const URL_RE = new RegExp(`https://[^\\s"'<>\`${ESC}${BEL}]+`, "g");

/**
 * The https URLs in `text` whose host matches, in order. Without `final`, a
 * URL that runs to the end of the text may still be arriving: it waits.
 */
function urlsIn(text: string, host: (h: string) => boolean, final: boolean) {
  const out: { url: string; end: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    if (!final && end >= text.length) continue;
    const raw = m[0].replace(/[.,;:)\]}>]+$/, "");
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && host(u.hostname.toLowerCase())) out.push({ url: raw, end });
    } catch {
      // not a URL
    }
  }
  return out;
}

const toUrl = (url: string | null) => (url ? { url } : null);
/** In an account folder while its sign-in runs (removed when it signs in). */
const SIGNING_IN = ".signing-in";

const hostIs = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`);

/**
 * Claude Code's sign-in URL (`If the browser didn't open, visit: <url>`): the
 * first complete https URL on claude.com, claude.ai or anthropic.com, escapes removed.
 */
export function parseClaudeLoginUrl(output: string, final = false): string | null {
  const text = stripAnsi(output);
  return urlsIn(text, (h) => hostIs(h, "claude.com") || hostIs(h, "claude.ai") || hostIs(h, "anthropic.com"), final)[0]?.url ?? null;
}

const CODE = /(?:^|[^A-Z0-9-])([A-Z0-9]{4}-[A-Z0-9]{4,6})(?=\s)/;
const CODE_AT_END = /(?:^|[^A-Z0-9-])([A-Z0-9]{4}-[A-Z0-9]{4,6})(?![A-Z0-9-])/;

/** Codex's device sign-in: the first auth.openai.com URL, then the one-time code (`7HYC-J6JGM`). */
export function parseCodexLogin(output: string, final = false): { url: string; userCode: string } | null {
  const text = stripAnsi(output);
  const first = urlsIn(text, (h) => h === "auth.openai.com", final)[0];
  if (!first) return null;
  const rest = text.slice(first.end);
  // Complete only once something follows it (or the output ended).
  const m = (final ? CODE_AT_END : CODE).exec(rest);
  return m?.[1] ? { url: first.url, userCode: m[1] } : null;
}

/** `claude auth status --json` → signed in, email and plan (short words only). */
export function parseClaudeStatus(status: number | null, stdout: string): Omit<RunnerAccountInfo, "id" | "kind"> {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim() || "null");
  } catch {
    return { loggedIn: false };
  }
  if (!json || typeof json !== "object") return { loggedIn: false };
  const o = json as Record<string, unknown>;
  const email = typeof o.email === "string" && o.email.length <= 254 && EMAIL.test(o.email) ? o.email : undefined;
  const plan = typeof o.subscriptionType === "string" && WORD.test(o.subscriptionType) ? o.subscriptionType : undefined;
  return {
    loggedIn: o.loggedIn === true && status === 0,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

/** `codex login status` (`Logged in using ChatGPT`, on either stream): signed in when it exits 0 and says so. */
export function parseCodexStatus(status: number | null, output: string): Omit<RunnerAccountInfo, "id" | "kind"> {
  const text = stripAnsi(output);
  return { loggedIn: status === 0 && /logged in/i.test(text) && !/not logged in/i.test(text) };
}

// ── Running the CLIs ─────────────────────────────────────────────────────────

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a CLI to the end (killed after `timeoutMs`); never throws. */
function runCli(command: string[], args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    const [file, ...pre] = command;
    let child: ChildProcess;
    try {
      child = spawn(resolveCommand(file ?? "", env.PATH), [...pre, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Windows finds `claude.cmd` / `codex.cmd` only through the shell (argv: fixed words).
        shell: process.platform === "win32" && command.length === 1,
      });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout = (stdout + c).slice(-OUTPUT_KEEP);
    });
    child.stderr?.on("data", (c: string) => {
      stderr = (stderr + c).slice(-OUTPUT_KEEP);
    });
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    const events = child as unknown as EventEmitter;
    events.on("error", (err: Error) => {
      stderr += err.message;
      finish(null);
    });
    events.on("close", (code: number | null) => finish(code));
  });
}

// ── The manager ──────────────────────────────────────────────────────────────

export interface AccountManagerOptions {
  /** `<runner home>/accounts`. */
  root: string;
  /** The organization this machine is paired with (a sealed code's AAD names it); unknown before pairing. */
  orgId?: () => string | undefined;
  /** How to start each CLI (tests: a fake script). Default `["claude"]` / `["codex"]`. */
  commands?: Partial<Record<AccountKind, string[]>>;
  beginWaitMs?: number;
  ttlMs?: number;
  finishedKeepMs?: number;
  listTtlMs?: number;
  log?: (line: string) => void;
  /** An account was added or removed, or a fresh look changed the list (`hello`, the app's status). */
  onChange?: () => void;
}

interface Login {
  id: string;
  kind: AccountKind;
  dir: string;
  child: ChildProcess;
  state: AccountLoginState;
  output: string;
  /** Claude Code: the ephemeral key the pasted code is sealed to (in memory only). */
  privateKey?: string;
  /** The code last written, only to keep it out of an error message; dropped when the sign-in ends. */
  code?: string;
  /** The process failed to start (`ENOENT`: not installed). */
  spawnError?: string;
  exited: boolean;
  account?: RunnerAccountInfo;
  error?: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** `begin` waits on this for the printed URL. */
  watch?: () => void;
}

export class AccountManager {
  private readonly logins = new Map<string, Login>();
  private cache: { at: number; value: RunnerAccountInfo[] } | null = null;
  private listing: Promise<RunnerAccountInfo[]> | null = null;
  private announce = false;
  private closed = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: AccountManagerOptions) {
    this.log = opts.log ?? (() => {});
  }

  private command(kind: AccountKind): string[] {
    return this.opts.commands?.[kind] ?? [kind === "codex" ? "codex" : "claude"];
  }

  private dirOf(kind: AccountKind, id: string) {
    return path.join(this.opts.root, kind, id);
  }

  private env(kind: AccountKind, dir: string): NodeJS.ProcessEnv {
    return { ...process.env, ...accountEnv(kind, dir) };
  }

  /** An account's folder for a brain turn; null when it isn't here (or is still signing in). */
  accountDir(kind: AccountKind, id: string): string | null {
    if (!isAccountKind(kind) || !isAccountId(id)) return null;
    if (this.logins.get(id)?.state === "waiting") return null;
    const dir = this.dirOf(kind, id);
    try {
      return statSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  }

  // ── Sign-in ────────────────────────────────────────────────────────────────

  /**
   * Starts the CLI's sign-in in a new folder named `loginId` (the account id
   * once it is signed in) and waits for what the person needs.
   */
  async begin(kind: AccountKind, loginId: string): Promise<MachineReplies["account"]> {
    if (this.closed) throw new RunnerError("internal", "The runner is stopping");
    if (!isAccountKind(kind)) throw new RunnerError("bad_request", "Unknown account kind");
    if (!isAccountId(loginId)) throw new RunnerError("bad_request", "Invalid sign-in id");
    if (this.logins.has(loginId) || ACCOUNT_KINDS.some((k) => existsSync(this.dirOf(k, loginId)))) {
      throw new RunnerError("bad_request", "This sign-in already exists");
    }
    // Claude Code: the key the browser seals the pasted code to (the private half stays in memory).
    const pair = kind === "claude_code" ? await generateSecretKeyPair() : undefined;
    const dir = this.dirOf(kind, loginId);
    for (const d of [this.opts.root, path.dirname(dir)]) {
      await mkdir(d, { recursive: true, mode: 0o700 });
      await chmod(d, 0o700).catch(() => undefined);
    }
    // Not recursive: two sign-ins with one id can't both create it.
    await mkdir(dir, { mode: 0o700 }).catch((err: unknown) => {
      if (errnoCode(err) === "EEXIST") throw new RunnerError("bad_request", "This sign-in already exists");
      throw err;
    });
    await chmod(dir, 0o700).catch(() => undefined);
    // Until it signs in: a runner that dies mid sign-in leaves this behind, and the list skips (then clears) it.
    await writeFile(path.join(dir, SIGNING_IN), "", { mode: 0o600 });

    const command = this.command(kind);
    const [file, ...pre] = command;
    const env = this.env(kind, dir);
    let child: ChildProcess;
    try {
      child = spawn(resolveCommand(file ?? "", env.PATH), [...pre, ...LOGIN_ARGS[kind]], {
        cwd: dir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Its own process group: a kill reaches what it started (posix).
        detached: process.platform !== "win32",
        shell: process.platform === "win32" && command.length === 1,
      });
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      const why = err instanceof Error ? err.message : String(err);
      throw new RunnerError("internal", `${LABEL[kind]} couldn't start: ${why}`);
    }
    const login: Login = {
      id: loginId,
      kind,
      dir,
      child,
      state: "waiting",
      output: "",
      ...(pair ? { privateKey: pair.privateKey } : {}),
      exited: false,
      startedAt: Date.now(),
      timer: null,
    };
    this.logins.set(loginId, login);
    const onData = (chunk: string) => {
      login.output = (login.output + chunk).slice(-OUTPUT_KEEP);
      login.watch?.();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => {});
    const events = child as unknown as EventEmitter;
    events.on("error", (err: Error) => {
      login.spawnError = (err as NodeJS.ErrnoException).code ?? err.message;
      this.exited(login, null);
    });
    events.on("close", (code: number | null) => this.exited(login, code));
    login.timer = setTimeout(() => this.expire(login), this.opts.ttlMs ?? ACCOUNT_LOGIN_TTL_MS);
    login.timer.unref?.();

    const found = await new Promise<{ url: string; userCode?: string } | null>((resolve) => {
      const parse = (final: boolean) =>
        kind === "codex" ? parseCodexLogin(login.output, final) : toUrl(parseClaudeLoginUrl(login.output, final));
      let done = false;
      const finish = (v: { url: string; userCode?: string } | null) => {
        if (done) return;
        done = true;
        clearTimeout(wait);
        login.watch = undefined;
        resolve(v);
      };
      const wait = setTimeout(() => finish(parse(true)), this.opts.beginWaitMs ?? ACCOUNT_BEGIN_WAIT_MS);
      wait.unref?.();
      login.watch = () => {
        if (login.exited || login.state !== "waiting") return finish(parse(true));
        const v = parse(false);
        if (v) finish(v);
      };
      login.watch();
    });
    if (!found || login.state !== "waiting") {
      const missing = login.spawnError === "ENOENT";
      const message = missing
        ? `${LABEL[kind]} is not installed on this computer.`
        : `${LABEL[kind]} didn't show a sign-in link. Update it, or add the account from the agentes app on this computer.`;
      this.log(`account sign-in ${loginId.slice(0, 8)} (${kind}) didn't start`);
      // Nobody polls a sign-in that never started.
      this.settle(login, "failed", message);
      this.logins.delete(loginId);
      await this.drop(login);
      throw new RunnerError("internal", message);
    }
    this.log(`account sign-in ${loginId.slice(0, 8)} (${kind}) started`);
    return {
      url: found.url,
      ...(found.userCode ? { userCode: found.userCode } : {}),
      ...(pair ? { publicKey: pair.publicKey } : {}),
    };
  }

  /** The code the person pasted (Claude Code), sealed to this sign-in's key: opened and written to the CLI. */
  async code(loginId: string, aad: string, box: WireSecretBox): Promise<void> {
    const login = this.waiting(loginId);
    if (login.kind !== "claude_code" || !login.privateKey) {
      throw new RunnerError("bad_request", "This sign-in doesn't take a code");
    }
    const org = this.opts.orgId?.();
    const a = String(aad ?? "");
    // Without a known organization (an older pairing), the AAD must still name this sign-in.
    const fits = org
      ? a === accountCodeAad(loginId, org)
      : a.startsWith(`${loginId}|`) && a.endsWith("|account") && a.split("|").length === 3;
    if (!fits) throw new RunnerError("bad_request", "The code doesn't match its sign-in");
    let code: string;
    try {
      code = (await openSecret(login.privateKey, box, a)).trim();
    } catch {
      throw new RunnerError("bad_request", "The code couldn't be opened (wrong key or altered on the way)");
    }
    if (!code || code.length > MAX_CODE_CHARS || /[\r\n]/.test(code)) {
      throw new RunnerError("bad_request", "That doesn't look like a sign-in code");
    }
    login.code = code;
    try {
      login.child.stdin?.write(`${code}\n`);
    } catch {
      throw new RunnerError("internal", `${LABEL[login.kind]} stopped waiting for the code`);
    }
  }

  /** Where a sign-in is: `waiting`, `done` (with the account), `failed` or `expired`. */
  status(loginId: string): MachineReplies["account"] {
    const login = this.logins.get(loginId);
    if (!login) throw new RunnerError("not_found", "This sign-in is gone (it expired or was canceled)");
    if (login.state === "waiting" && Date.now() - login.startedAt > (this.opts.ttlMs ?? ACCOUNT_LOGIN_TTL_MS)) {
      this.expire(login);
    }
    return {
      state: login.state,
      ...(login.account ? { account: login.account } : {}),
      ...(login.error ? { error: login.error } : {}),
    };
  }

  /** Stops a sign-in and removes its folder; false when there was nothing to stop. */
  async cancel(loginId: string): Promise<boolean> {
    const login = this.logins.get(loginId);
    if (!login) return false;
    if (login.state !== "waiting") return false;
    this.settle(login, "failed", "Canceled");
    await this.drop(login);
    this.log(`account sign-in ${loginId.slice(0, 8)} canceled`);
    return true;
  }

  private waiting(loginId: string): Login {
    const login = this.logins.get(loginId);
    if (!login) throw new RunnerError("not_found", "This sign-in is gone (it expired or was canceled)");
    if (login.state !== "waiting") throw new RunnerError("bad_request", "This sign-in already ended");
    return login;
  }

  private expire(login: Login) {
    if (login.state !== "waiting") return;
    this.settle(login, "expired", "The sign-in took too long; start again");
    void this.drop(login);
    this.log(`account sign-in ${login.id.slice(0, 8)} expired`);
  }

  /** The CLI exited: its status command in that folder says whether it signed in. */
  private exited(login: Login, code: number | null) {
    if (login.exited) return;
    login.exited = true;
    login.watch?.();
    if (login.state !== "waiting") return;
    void (async () => {
      if (code === 0) {
        const info = await this.lookUp(login.kind, login.id);
        if (login.state !== "waiting") return;
        if (info.loggedIn) {
          await rm(path.join(login.dir, SIGNING_IN), { force: true }).catch(() => undefined);
          this.settle(login, "done");
          login.account = info;
          this.added(info);
          this.log(`account ${login.id.slice(0, 8)} (${login.kind}) signed in`);
          return;
        }
        this.settle(login, "failed", `${LABEL[login.kind]} finished, but the account isn't signed in. Try again.`);
      } else {
        const tail = stripAnsi(login.output)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1);
        // Never the pasted code back (a CLI may repeat what it refused).
        const safe = tail && !(login.code && tail.includes(login.code)) ? tail.slice(0, 200) : "";
        this.settle(
          login,
          "failed",
          login.spawnError === "ENOENT"
            ? `${LABEL[login.kind]} is not installed on this computer.`
            : `${LABEL[login.kind]} couldn't sign in${login.code ? " with that code" : ""}${safe ? `: ${safe}` : ""}`,
        );
      }
      await rm(login.dir, { recursive: true, force: true }).catch(() => undefined);
    })();
  }

  private settle(login: Login, state: AccountLoginState, error?: string) {
    login.state = state;
    if (error) login.error = error;
    login.privateKey = undefined;
    login.code = undefined;
    if (login.timer) clearTimeout(login.timer);
    login.timer = setTimeout(() => {
      if (this.logins.get(login.id) === login) this.logins.delete(login.id);
    }, this.opts.finishedKeepMs ?? ACCOUNT_FINISHED_KEEP_MS);
    login.timer.unref?.();
  }

  /** Kills a sign-in's CLI and removes its folder (the entry stays for `status` until it is cleaned up). */
  private async drop(login: Login) {
    if (!login.exited) {
      killTree(login.child, "SIGTERM");
      const t = setTimeout(() => {
        if (!login.exited) killTree(login.child, "SIGKILL");
      }, 3000);
      t.unref?.();
    }
    await rm(login.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Accounts ───────────────────────────────────────────────────────────────

  /** One account's status from its CLI (never throws: unknown is signed out). */
  private async lookUp(kind: AccountKind, id: string): Promise<RunnerAccountInfo> {
    const env = this.env(kind, this.dirOf(kind, id));
    const r = await runCli(this.command(kind), STATUS_ARGS[kind], env, STATUS_TIMEOUT_MS);
    // Codex says it on stderr.
    const status =
      kind === "claude_code"
        ? parseClaudeStatus(r.status, r.stdout)
        : parseCodexStatus(r.status, `${r.stdout}\n${r.stderr}`);
    return { id, kind, ...status };
  }

  private async lookAll(): Promise<RunnerAccountInfo[]> {
    const found: { kind: AccountKind; id: string }[] = [];
    for (const kind of ACCOUNT_KINDS) {
      const entries = await readdir(path.join(this.opts.root, kind), { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!e.isDirectory() || !isAccountId(e.name)) continue;
        if (this.logins.get(e.name)?.state === "waiting") continue; // still signing in
        // A sign-in that never finished (the runner stopped meanwhile): not an account; gone once it would have expired.
        const marker = path.join(this.opts.root, kind, e.name, SIGNING_IN);
        const started = await stat(marker).catch(() => null);
        if (started) {
          if (Date.now() - started.mtimeMs > ACCOUNT_LOGIN_TTL_MS) {
            await rm(path.join(this.opts.root, kind, e.name), { recursive: true, force: true }).catch(() => undefined);
          }
          continue;
        }
        found.push({ kind, id: e.name });
      }
    }
    return Promise.all(found.map((a) => this.lookUp(a.kind, a.id)));
  }

  /** Every account on this machine with its status (cached for `ACCOUNTS_TTL_MS`). */
  async list(): Promise<RunnerAccountInfo[]> {
    if (this.cache && Date.now() - this.cache.at <= (this.opts.listTtlMs ?? ACCOUNTS_TTL_MS)) return this.cache.value;
    return this.refresh();
  }

  /** A fresh look (one at a time). `announce`: tell the observer even when nothing changed (the server may think otherwise). */
  refresh(announce = false): Promise<RunnerAccountInfo[]> {
    if (announce) this.announce = true;
    if (this.listing) return this.listing;
    const run = this.lookAll()
      .then((value) => {
        if (this.listing === run) {
          const changed = JSON.stringify(value) !== JSON.stringify(this.cache?.value ?? []);
          this.cache = { at: Date.now(), value };
          if (changed || this.announce) this.changed();
          this.announce = false;
        }
        return value;
      })
      .finally(() => {
        if (this.listing === run) this.listing = null;
      });
    this.listing = run;
    return run;
  }

  /** For `hello`: the last known list (a stale one is looked again in the background); undefined before the first look. */
  snapshot(): RunnerAccountInfo[] | undefined {
    if (!this.cache || Date.now() - this.cache.at > (this.opts.listTtlMs ?? ACCOUNTS_TTL_MS)) {
      this.refresh().catch(() => undefined);
    }
    return this.cache?.value;
  }

  /** The next `list` asks the CLIs again (an account turned out signed out in a turn). */
  invalidate() {
    if (this.cache) this.cache = { ...this.cache, at: 0 };
  }

  private added(info: RunnerAccountInfo) {
    if (this.cache) this.cache = { ...this.cache, value: [...this.cache.value.filter((a) => a.id !== info.id), info] };
    this.listing = null;
    this.changed();
  }

  /** Signs the account out (best effort) and deletes its folder. */
  async remove(kind: AccountKind, id: string): Promise<boolean> {
    if (!isAccountKind(kind)) throw new RunnerError("bad_request", "Unknown account kind");
    if (!isAccountId(id)) throw new RunnerError("bad_request", "Invalid account id");
    const login = this.logins.get(id);
    if (login?.state === "waiting") return this.cancel(id);
    const dir = this.dirOf(kind, id);
    if (!existsSync(dir)) return false;
    const r = await runCli(this.command(kind), LOGOUT_ARGS[kind], this.env(kind, dir), STATUS_TIMEOUT_MS);
    if (r.status !== 0) this.log(`account ${id.slice(0, 8)} (${kind}): sign-out didn't finish; removing it anyway`);
    await rm(dir, { recursive: true, force: true });
    if (this.cache) this.cache = { ...this.cache, value: this.cache.value.filter((a) => a.id !== id) };
    this.listing = null;
    this.log(`account ${id.slice(0, 8)} (${kind}) removed`);
    this.changed();
    return true;
  }

  private changed() {
    try {
      this.opts.onChange?.();
    } catch {
      // an observer never breaks the manager
    }
  }

  /** The runner is exiting: sign-ins in progress stop and their folders go. */
  async close() {
    this.closed = true;
    const waiting = [...this.logins.values()].filter((l) => l.state === "waiting");
    for (const l of waiting) this.settle(l, "failed", "The runner stopped");
    await Promise.all(waiting.map((l) => this.drop(l)));
    for (const l of this.logins.values()) if (l.timer) clearTimeout(l.timer);
    this.logins.clear();
  }
}
