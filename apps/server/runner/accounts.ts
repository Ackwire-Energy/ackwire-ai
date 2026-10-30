import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { chmod, lchown, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_WORKER_HOMES } from "@agenteschat/adapters/command-policy";
import {
  ACCOUNT_KINDS,
  ACCOUNT_LOGIN_TTL_MS,
  type AccountKind,
  type AccountLoginState,
  accountCodeAad,
  isAccountId,
  isAccountKind,
  isLoginEmail,
  MAX_MACHINE_ACCOUNTS,
  type MachineReplies,
  OWN_USAGE_ID,
  type OwnPlanUsage,
  type PlanUsage,
  type RunnerAccountInfo,
  type WireSecretBox,
} from "@agenteschat/adapters/machine-protocol";
import { generateSecretKeyPair, openSecret } from "@agenteschat/adapters/secret-box";
import { isPlanId, type PlanId, planKeyFits, planOf } from "@agenteschat/providers/plans";
import { errnoCode, RunnerError } from "./errors";
import { killTree } from "./exec";
import { claudePlan, claudeTier, resolveCommand } from "./executors";
import { readJsonNoFollow } from "./json-file";
import {
  codexUsage,
  fetchPlanKeyUsage,
  probeClaudeUsage,
  probeCodexUsage,
  usageCrossed,
  withRateLimit,
} from "./plan-usage";

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
 *   plan (a Claude Max's tier from the CLI's `.claude.json` there tells Ultra
 *   apart, `claudePlan`), or `failed` (folder removed). After
 *   `ACCOUNT_LOGIN_TTL_MS` the sign-in is killed and its folder removed
 *   (`expired`).
 * - `list` asks each account's CLI (cached for `ACCOUNTS_TTL_MS`), but one a
 *   turn's endpoint refused reads as signed out until it signs in again
 *   (`refused`); `remove` signs out (best effort) and deletes the folder,
 *   `accountDir` is what a brain turn runs with.
 * - Usage (protocol 19, `plan-usage.ts`): what the turns say comes in through
 *   `noteRateLimit` / `noteCodexRateLimits`, and `probeUsage` looks it up on
 *   demand; the list carries it, and the computer's own sign-ins' is `ownUsage`.
 * - Key accounts (protocol 20): a coding plan on Claude Code. `begin` with a
 *   `provider` makes the folder and the key pair only, `code` opens the plan's
 *   key and keeps it in `provider.json` (600); no CLI ever signs in or out
 *   there. It is signed in until a turn's endpoint refuses the key.
 * - System mode (`lending`): a folder belongs to the OS user of the agent
 *   that thinks with it, only while it does (`lendTo`, `keepLent`), else to
 *   root. Root never runs a CLI against what an agent's user could write: such
 *   a folder's status is what its turns said, signing in again starts it over,
 *   and removing it signs nothing out.
 */

/** A fresh look at every account's status happens at most this often (each one runs the CLI). */
export const ACCOUNTS_TTL_MS = 10 * 60_000;
/** An account's usage is probed at most this often. */
export const USAGE_TTL_MS = 5 * 60_000;
/** A provider that answered 429 isn't asked again before this. */
export const USAGE_BACKOFF_MS = 15 * 60_000;
/** What the turns say about usage reaches the server at most this often (unless `usageCrossed`). */
export const USAGE_NOTIFY_MS = 60_000;
const USAGE_PROBES_AT_ONCE = 2;
const SIGN_INS_AT_ONCE = 4;
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
    "The ChatGPT account chosen for this agent isn't on this computer anymore. Choose another account in the agent's settings, or add it again.",
};

/** What would make a CLI think with anything but its folder's sign-in: a key, a token, another endpoint or cloud. */
const STRAY_SIGN_IN =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_(OAUTH_TOKEN|USE_\w+)|OPENAI_API_KEY|CODEX_API_KEY)$/;

/** The env a CLI runs with for an account folder: `base` without any other sign-in, the folder as its home. */
export function accountEnv(kind: AccountKind, dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!STRAY_SIGN_IN.test(k)) env[k] = v;
  env[ENV_VAR[kind]] = dir;
  return env;
}

/**
 * Routes (`brain-route.ts`) running in this process, by sign-in (`signInKey`). A turn or a task about to start a
 * CLI on a sign-in stops the route there first (`yieldRoute`): two processes on one sign-in race on its refresh token.
 */
export const routesRunning = new Map<string, { stop: AbortController; done: Promise<unknown> }>();

/** A sign-in: its account folder, or the computer's own (`home` absent). */
export const signInKey = (kind: AccountKind, home?: string | null) => `${kind}:${home ?? "own"}`;

/** Stops the route running on that sign-in, if any, and resolves once its CLI has exited. */
export async function yieldRoute(kind: AccountKind, home?: string | null): Promise<void> {
  const route = routesRunning.get(signInKey(kind, home));
  route?.stop.abort();
  await route?.done.catch(() => {});
}

/** A key account's plan and key, in its folder (mode 600). */
const PROVIDER_FILE = "provider.json";
/** The longest key kept (plans' keys are tens of characters, MiniMax's JWT-like ones a few hundred). */
const MAX_KEY_CHARS = 2048;

/** System mode: the account folders, outside root's home (its parents 711) so an agent's user reaches the one lent to it. */
export const SYSTEM_ACCOUNTS_ROOT = path.join(AGENT_WORKER_HOMES, "accounts");

/** A key account's plan and key (`provider.json`); null when the folder isn't one. Never through a link or a pipe. */
export async function planKeyOf(dir: string): Promise<{ provider: PlanId; key: string } | null> {
  const o = readJsonNoFollow(path.join(dir, PROVIDER_FILE), MAX_KEY_CHARS + 200) as Record<string, unknown> | null;
  return isPlanId(o?.provider) && typeof o.key === "string" && o.key ? { provider: o.provider, key: o.key } : null;
}

/** System mode, in an agent's worker: the account folders lent to this agent's user; any other is missing. */
export function lentAccounts(root = SYSTEM_ACCOUNTS_ROOT) {
  return {
    accountDir(kind: AccountKind, id: string): string | null {
      if (!isAccountKind(kind) || !isAccountId(id)) return null;
      const dir = path.join(root, kind, id);
      try {
        accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
        return statSync(dir).isDirectory() ? dir : null;
      } catch {
        return null;
      }
    },
  };
}

type Chown = (file: string, uid: number, gid: number) => Promise<void>;

/**
 * A folder tree to `uid`, or back to root (0), never following a link; a file
 * that has other names (`nlink` > 1) or isn't a file, folder or link goes
 * instead. Back to root is top-down: each folder is root's (700) before it is
 * read, so its last owner can't swap what is read next. To an agent it is
 * bottom-up from a tree only root can change, its top last.
 */
async function chownTree(dir: string, uid: number, chown: Chown) {
  const toRoot = uid === 0;
  const walk = async (d: string) => {
    if (toRoot) {
      await chown(d, 0, 0);
      await chmod(d, 0o700);
    }
    for (const name of await readdir(d)) {
      const p = path.join(d, name);
      const st = await lstat(p);
      if (st.isDirectory()) await walk(p);
      else if (st.isSymbolicLink() || (st.isFile() && st.nlink === 1)) await chown(p, uid, toRoot ? 0 : -1);
      else await rm(p, { force: true });
    }
    if (!toRoot) await chown(d, uid, -1);
  };
  await walk(dir);
  if (!toRoot) await chmod(dir, 0o700);
}

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
  return (
    urlsIn(text, (h) => hostIs(h, "claude.com") || hostIs(h, "claude.ai") || hostIs(h, "anthropic.com"), final)[0]
      ?.url ?? null
  );
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

/**
 * `claude auth status --json` → signed in, email and plan (short words only, named by `claudePlan` with the
 * folder's `tier`). Signed in means through claude.ai: a folder that reports an API key isn't the account's own
 * sign-in.
 */
export function parseClaudeStatus(
  status: number | null,
  stdout: string,
  tier: () => unknown = () => undefined,
): Omit<RunnerAccountInfo, "id" | "kind"> {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim() || "null");
  } catch {
    return { loggedIn: false };
  }
  if (!json || typeof json !== "object") return { loggedIn: false };
  const o = json as Record<string, unknown>;
  const email = typeof o.email === "string" && o.email.length <= 254 && EMAIL.test(o.email) ? o.email : undefined;
  const plan = claudePlan(o.subscriptionType, tier);
  return {
    loggedIn: o.loggedIn === true && status === 0 && o.authMethod === "claude.ai",
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
  /** Tests: `USAGE_TTL_MS`, `USAGE_NOTIFY_MS`, how long a probe may take, and the HTTP client of the key probes. */
  usageTtlMs?: number;
  usageNotifyMs?: number;
  usageTimeoutMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** An account was added or removed, a fresh look changed the list (`hello`, the app's status), or usage moved. */
  onChange?: () => void;
  /** System mode: folders are lent to agents' users (`lendTo`); `chown` never follows a link (tests: a fake). */
  lending?: { chown: Chown };
}

/** The real `lending.chown`. */
export const lchownTree: Chown = (file, uid, gid) => lchown(file, uid, gid);

interface Login {
  id: string;
  kind: AccountKind;
  dir: string;
  /** None for a key account: nothing signs in but the key. */
  child?: ChildProcess;
  /** A key account's plan. */
  provider?: PlanId;
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
  /** Signing in again to an existing account: its folder is never removed by this sign-in. */
  again: boolean;
  /** `begin` returned its link: from then on its end removes the folder (before, `begin` itself does). */
  started?: boolean;
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
  /** Usage by account id, or `OWN_USAGE_ID` for the computer's own sign-ins. */
  private readonly usage = new Map<string, PlanUsage>();
  /** When each was last probed, and until when its provider asked us to wait. */
  private readonly probed = new Map<string, number>();
  private readonly backoff = new Map<string, number>();
  private readonly probeQueue: string[] = [];
  private readonly probing = new Set<string>();
  private usageSent = 0;
  private usageTimer: ReturnType<typeof setTimeout> | null = null;

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
    return accountEnv(kind, dir);
  }

  /** A file root keeps beside a folder (`<id>.invalid`, `<id>.lent`), out of reach of whoever the folder is lent to. */
  private marker(kind: AccountKind, id: string, name: "invalid" | "lent") {
    return path.join(this.opts.root, kind, `${id}.${name}`);
  }

  /** System mode: the uid the folder is lent to now; 0 once it is root's again; null when it never was lent. */
  private lentTo(kind: AccountKind, id: string): number | null {
    try {
      const uid = Number(readFileSync(this.marker(kind, id, "lent"), "utf8").trim());
      return Number.isInteger(uid) && uid > 0 ? uid : 0;
    } catch {
      return null;
    }
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
   * Starts the CLI's sign-in in a new folder named `loginId`, or (`again`) in
   * the existing account `loginId` that was signed out: same account, same
   * agents, and its folder stays if this sign-in fails. `email` (Claude Code):
   * the account to sign in to, as the CLI's login hint.
   */
  async begin(
    kind: AccountKind,
    loginId: string,
    again = false,
    email?: string,
    provider?: string,
  ): Promise<MachineReplies["account"]> {
    if (this.closed) throw new RunnerError("internal", "The runner is stopping");
    if (!isAccountKind(kind)) throw new RunnerError("bad_request", "Unknown account kind");
    if (!isAccountId(loginId)) throw new RunnerError("bad_request", "Invalid sign-in id");
    if (email !== undefined && (kind !== "claude_code" || provider !== undefined || !isLoginEmail(email))) {
      throw new RunnerError("bad_request", "That email can't name the account to sign in to");
    }
    if (provider !== undefined && (kind !== "claude_code" || !isPlanId(provider))) {
      throw new RunnerError("bad_request", "This computer doesn't know that plan");
    }
    if (this.logins.get(loginId)?.state === "waiting") {
      throw new RunnerError("bad_request", "This sign-in already exists");
    }
    // Each one is a CLI waiting up to its TTL, and anyone in a workspace can start one on its shared computer.
    const running = [...this.logins.values()].filter((l) => l.state === "waiting" && l.child).length;
    if (!provider && running >= SIGN_INS_AT_ONCE) {
      throw new RunnerError(
        "bad_request",
        "Too many sign-ins are in progress on this computer. Try again in a few minutes.",
      );
    }
    const dir = this.dirOf(kind, loginId);
    if (again) {
      if (!existsSync(dir) || existsSync(path.join(dir, SIGNING_IN))) {
        throw new RunnerError("not_found", "That account is no longer on this computer");
      }
      // What an agent's user could write is never run or written by root: it starts over, as root's.
      if (this.lentTo(kind, loginId) !== null) await this.startOver(kind, loginId);
    } else {
      if (this.logins.has(loginId) || ACCOUNT_KINDS.some((k) => existsSync(this.dirOf(k, loginId)))) {
        throw new RunnerError("bad_request", "This sign-in already exists");
      }
      if ((await this.list().catch(() => [])).length >= MAX_MACHINE_ACCOUNTS) {
        throw new RunnerError("bad_request", "This computer already has too many accounts. Remove one first.");
      }
    }
    // Claude Code: the key the browser seals the pasted code (or a plan's key) to; the private half stays in memory.
    const pair = kind === "claude_code" ? await generateSecretKeyPair() : undefined;
    if (!again) {
      // System mode: agents' users pass through to the one folder lent to each, and list nothing.
      const parents = this.opts.lending ? 0o711 : 0o700;
      for (const d of [this.opts.root, path.dirname(dir)]) {
        await mkdir(d, { recursive: true, mode: parents });
        await chmod(d, parents).catch(() => undefined);
      }
      // Not recursive: two sign-ins with one id can't both create it.
      await mkdir(dir, { mode: 0o700 }).catch((err: unknown) => {
        if (errnoCode(err) === "EEXIST") throw new RunnerError("bad_request", "This sign-in already exists");
        throw err;
      });
      await chmod(dir, 0o700).catch(() => undefined);
      // Until it signs in: a runner that dies mid sign-in leaves this behind, and the list skips (then clears) it.
      await writeFile(path.join(dir, SIGNING_IN), "", { mode: 0o600 });
    }
    if (provider && pair) return this.beginKey(kind, loginId, dir, provider as PlanId, pair, again);

    const command = this.command(kind);
    const [file, ...pre] = command;
    const env = this.env(kind, dir);
    let child: ChildProcess;
    try {
      child = spawn(
        resolveCommand(file ?? "", env.PATH),
        [...pre, ...LOGIN_ARGS[kind], ...(email ? ["--email", email] : [])],
        {
          cwd: dir,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // Its own process group: a kill reaches what it started (posix).
          detached: process.platform !== "win32",
          shell: process.platform === "win32" && command.length === 1,
        },
      );
    } catch (err) {
      if (!again) await rm(dir, { recursive: true, force: true });
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
      again,
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
    login.started = true;
    this.log(`account sign-in ${loginId.slice(0, 8)} (${kind}) started`);
    return {
      url: found.url,
      ...(found.userCode ? { userCode: found.userCode } : {}),
      ...(pair ? { publicKey: pair.publicKey } : {}),
    };
  }

  /** A key account's sign-in: nothing runs; it waits for the plan's key, sealed to `pair`. */
  private beginKey(
    kind: AccountKind,
    loginId: string,
    dir: string,
    provider: PlanId,
    pair: { publicKey: string; privateKey: string },
    again: boolean,
  ): MachineReplies["account"] {
    const login: Login = {
      id: loginId,
      kind,
      dir,
      provider,
      state: "waiting",
      output: "",
      privateKey: pair.privateKey,
      exited: true,
      startedAt: Date.now(),
      timer: null,
      again,
    };
    this.logins.set(loginId, login);
    login.timer = setTimeout(() => this.expire(login), this.opts.ttlMs ?? ACCOUNT_LOGIN_TTL_MS);
    login.timer.unref?.();
    this.log(`account key ${loginId.slice(0, 8)} (${provider}) waiting`);
    return { publicKey: pair.publicKey };
  }

  /** System mode, signing in again where an agent's user had the folder: root takes it back and empties it. */
  private async startOver(kind: AccountKind, id: string) {
    const dir = this.dirOf(kind, id);
    await this.serial(id, async () => {
      if (this.lentTo(kind, id)) await this.reclaimNow(kind, id);
      for (const name of await readdir(dir)) await rm(path.join(dir, name), { recursive: true, force: true });
      await rm(this.marker(kind, id, "lent"), { force: true });
    });
  }

  /** The code the person pasted (Claude Code) or a plan's key, sealed to this sign-in's key: written to the CLI, or kept. */
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
    if (login.provider) return this.keepKey(login, login.provider, code);
    if (!code || code.length > MAX_CODE_CHARS || /[\r\n]/.test(code)) {
      throw new RunnerError("bad_request", "That doesn't look like a sign-in code");
    }
    login.code = code;
    try {
      login.child?.stdin?.write(`${code}\n`);
    } catch {
      throw new RunnerError("internal", `${LABEL[login.kind]} stopped waiting for the code`);
    }
  }

  /** A plan's key, checked and kept in the folder (600, written whole): the account is signed in. Never logged. */
  private async keepKey(login: Login, provider: PlanId, key: string) {
    const plan = planOf(provider);
    if (!plan || !key || key.length > MAX_KEY_CHARS || !planKeyFits(plan, key)) {
      throw new RunnerError(
        "bad_request",
        `That doesn't look like a ${plan?.label ?? "plan"} key. Copy the whole key.`,
      );
    }
    const file = path.join(login.dir, PROVIDER_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ provider, key }), { mode: 0o600 });
    await rename(tmp, file);
    await rm(path.join(login.dir, SIGNING_IN), { force: true });
    await rm(this.marker(login.kind, login.id, "invalid"), { force: true });
    const info: RunnerAccountInfo = {
      id: login.id,
      kind: login.kind,
      loggedIn: true,
      provider,
      keyHint: key.slice(-4),
    };
    this.settle(login, "done");
    login.account = info;
    this.added(info);
    this.log(`account ${login.id.slice(0, 8)} (${provider} key) kept`);
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
    this.settle(login, "expired", "The sign-in took too long. Start again.");
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
        // Signed in anew: a turn refused before (`refused`) says nothing about this sign-in.
        await rm(this.marker(login.kind, login.id, "invalid"), { force: true }).catch(() => undefined);
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
      if (!login.again && login.started) await rm(login.dir, { recursive: true, force: true }).catch(() => undefined);
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
    const child = login.child;
    if (child && !login.exited) {
      killTree(child, "SIGTERM");
      const t = setTimeout(() => {
        if (!login.exited) killTree(child, "SIGKILL");
      }, 3000);
      t.unref?.();
    }
    if (!login.again) await rm(login.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Accounts ───────────────────────────────────────────────────────────────

  /**
   * One account's status (never throws: unknown is signed out). Refused in a turn since it last signed in
   * (`refused`), it is signed out whatever its CLI says. Otherwise a key account is signed in; a folder an agent's
   * user had, as its turns last said; any other, as its CLI says.
   */
  private async lookUp(kind: AccountKind, id: string): Promise<RunnerAccountInfo> {
    const dir = this.dirOf(kind, id);
    const refused = existsSync(this.marker(kind, id, "invalid"));
    const plan = kind === "claude_code" ? await planKeyOf(dir) : null;
    if (plan) return { id, kind, loggedIn: !refused, provider: plan.provider, keyHint: plan.key.slice(-4) };
    if (refused || this.lentTo(kind, id) !== null) return { id, kind, loggedIn: !refused };
    const env = this.env(kind, dir);
    const r = await runCli(this.command(kind), STATUS_ARGS[kind], env, STATUS_TIMEOUT_MS);
    // Codex says it on stderr.
    const status =
      kind === "claude_code"
        ? parseClaudeStatus(r.status, r.stdout, () => claudeTier(dir))
        : parseCodexStatus(r.status, `${r.stdout}\n${r.stderr}`);
    return { id, kind, ...status };
  }

  private async lookAll(): Promise<RunnerAccountInfo[]> {
    const found: { kind: AccountKind; id: string }[] = [];
    for (const kind of ACCOUNT_KINDS) {
      // No folder yet: no accounts. Any other failure fails the look (the server must never read it as "none left").
      const entries = await readdir(path.join(this.opts.root, kind), { withFileTypes: true }).catch((err: unknown) => {
        if (errnoCode(err) === "ENOENT") return [];
        throw err;
      });
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!e.isDirectory() || !isAccountId(e.name)) continue;
        // A new account still signing in isn't one yet; one signing in again still is (listed as it is now).
        const login = this.logins.get(e.name);
        if (login?.state === "waiting" && !login.again) continue;
        // A sign-in that never finished (the runner stopped meanwhile): not an account; gone once it would have
        // expired. A folder lent to an agent was signed in (and is never removed from under it here).
        const marker = path.join(this.opts.root, kind, e.name, SIGNING_IN);
        const started = this.lentTo(kind, e.name) === null ? await lstat(marker).catch(() => null) : null;
        if (started) {
          if (Date.now() - started.mtimeMs > ACCOUNT_LOGIN_TTL_MS) {
            await rm(path.join(this.opts.root, kind, e.name), { recursive: true, force: true }).catch(() => undefined);
          }
          continue;
        }
        found.push({ kind, id: e.name });
      }
    }
    return Promise.all(found.slice(0, MAX_MACHINE_ACCOUNTS).map((a) => this.lookUp(a.kind, a.id)));
  }

  /** Every account on this machine with its status and usage (cached for `ACCOUNTS_TTL_MS`). */
  async list(): Promise<RunnerAccountInfo[]> {
    if (this.cache && Date.now() - this.cache.at <= (this.opts.listTtlMs ?? ACCOUNTS_TTL_MS)) {
      return this.withUsage(this.cache.value);
    }
    return this.withUsage(await this.refresh());
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
    return this.cache ? this.withUsage(this.cache.value) : undefined;
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
    const markers = () =>
      Promise.all([
        rm(this.marker(kind, id, "invalid"), { force: true }),
        rm(this.marker(kind, id, "lent"), { force: true }),
      ]);
    if (!existsSync(dir)) {
      await markers();
      return false;
    }
    const lent = this.lentTo(kind, id) !== null;
    // A key has no sign-in to end; a folder an agent's user had is never run as root (deleting it is the sign-out).
    if (lent) await this.serial(id, () => this.reclaimNow(kind, id));
    else if (!(kind === "claude_code" && (await planKeyOf(dir)))) {
      const r = await runCli(this.command(kind), LOGOUT_ARGS[kind], this.env(kind, dir), STATUS_TIMEOUT_MS);
      if (r.status !== 0) this.log(`account ${id.slice(0, 8)} (${kind}): sign-out didn't finish; removing it anyway`);
    }
    await rm(dir, { recursive: true, force: true });
    await markers();
    if (this.cache) this.cache = { ...this.cache, value: this.cache.value.filter((a) => a.id !== id) };
    this.usage.delete(id);
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

  /**
   * A turn in this account was refused by its endpoint (`not_logged_in`): it reads as signed out until a new key or
   * sign-in. The endpoint decides, not the CLI's status: a CLI may judge by the credentials it keeps, which can still
   * look signed in after the provider ended that sign-in (another login of the same account, ADR 0059 §2), and root
   * never asks one about a folder an agent's user had (system mode).
   */
  async refused(kind: AccountKind, id: string) {
    if (!isAccountKind(kind) || !isAccountId(id) || !existsSync(this.dirOf(kind, id))) return;
    await writeFile(this.marker(kind, id, "invalid"), "", { mode: 0o600 }).catch(() => undefined);
  }

  // ── System mode: folders lent to agents' users ────────────────────────────

  private readonly folderOps = new Map<string, Promise<unknown>>();

  /** One change of a folder's owner at a time. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.folderOps.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.folderOps.set(id, run);
    void run
      .finally(() => {
        if (this.folderOps.get(id) === run) this.folderOps.delete(id);
      })
      .catch(() => undefined);
    return run;
  }

  /**
   * A brain turn of the agent whose OS user is `uid` thinks with this account: its folder becomes that user's
   * (700), taken back from any other agent first. False when it isn't here or still signing in.
   */
  async lendTo(kind: AccountKind, id: string, uid: number): Promise<boolean> {
    const chown = this.opts.lending?.chown;
    if (!chown || !Number.isInteger(uid) || uid <= 0) return false;
    const dir = this.accountDir(kind, id);
    if (!dir || (await lstat(path.join(dir, SIGNING_IN)).catch(() => null))) return false;
    return this.serial(id, async () => {
      const now = this.lentTo(kind, id);
      if (now === uid) return true;
      if (now) await this.reclaimNow(kind, id);
      for (const d of [this.opts.root, path.dirname(dir)]) await chmod(d, 0o711);
      // Marked before the first chown: a folder an agent's user may have written to never runs as root again.
      await writeFile(this.marker(kind, id, "lent"), String(uid), { mode: 0o600 });
      await chownTree(dir, uid, chown);
      this.log(`account ${id.slice(0, 8)} (${kind}) lent to uid ${uid}`);
      return true;
    });
  }

  private async reclaimNow(kind: AccountKind, id: string) {
    const chown = this.opts.lending?.chown;
    if (!chown) return;
    await chownTree(this.dirOf(kind, id), 0, chown);
    await writeFile(this.marker(kind, id, "lent"), "0", { mode: 0o600 });
    this.log(`account ${id.slice(0, 8)} (${kind}) back to root`);
  }

  /**
   * The `agents` frame (system mode): `uids` maps each account an agent thinks with to that agent's uid. A
   * folder lent to any other user goes back to root now, so an agent never keeps another's sign-in.
   */
  async keepLent(uids: ReadonlyMap<string, number>) {
    if (!this.opts.lending) return;
    for (const kind of ACCOUNT_KINDS) {
      const entries = await readdir(path.join(this.opts.root, kind)).catch(() => [] as string[]);
      for (const name of entries) {
        const id = name.endsWith(".lent") ? name.slice(0, -5) : "";
        if (!isAccountId(id)) continue;
        const uid = this.lentTo(kind, id);
        if (!uid || uids.get(id) === uid) continue;
        await this.serial(id, async () => {
          if (this.lentTo(kind, id) === uid) await this.reclaimNow(kind, id);
        }).catch((err: unknown) =>
          this.log(
            `account ${id.slice(0, 8)}: couldn't take it back (${err instanceof Error ? err.message : String(err)})`,
          ),
        );
      }
    }
  }

  // ── Usage (protocol 19) ────────────────────────────────────────────────────

  private withUsage(list: RunnerAccountInfo[]): RunnerAccountInfo[] {
    return list.map((a) => {
      const usage = this.usage.get(a.id);
      return usage ? { ...a, usage } : a;
    });
  }

  /** The usage of the computer's own sign-ins, as far as known. */
  ownUsage(): OwnPlanUsage {
    const out: OwnPlanUsage = {};
    for (const kind of ACCOUNT_KINDS) {
      const usage = this.usage.get(OWN_USAGE_ID[kind]);
      if (usage) out[kind] = usage;
    }
    return out;
  }

  /** A Claude Code turn's `rate_limit_event` (`rate_limit_info`), for an account id or `OWN_USAGE_ID.claude_code`. */
  noteRateLimit(key: string, info: unknown) {
    const prev = this.usage.get(key);
    const next = withRateLimit(prev, info);
    if (next) this.noted(key, prev, next);
  }

  /** Codex's `account/rateLimits/updated` during a turn (`rateLimits`), for an account id or `OWN_USAGE_ID.codex`. */
  noteCodexRateLimits(key: string, rateLimits: unknown) {
    const next = codexUsage(rateLimits, "turn");
    if (next) this.noted(key, this.usage.get(key), next);
  }

  /** What a turn said: the server hears it at most every `USAGE_NOTIFY_MS`, at once when people should know. */
  private noted(key: string, prev: PlanUsage | undefined, next: PlanUsage) {
    this.usage.set(key, next);
    const wait = (this.opts.usageNotifyMs ?? USAGE_NOTIFY_MS) - (Date.now() - this.usageSent);
    if (usageCrossed(prev, next) || wait <= 0) return this.usageChanged();
    this.usageTimer ??= setTimeout(() => this.usageChanged(), wait);
    this.usageTimer.unref?.();
  }

  private usageChanged() {
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = null;
    this.usageSent = Date.now();
    this.changed();
  }

  /**
   * `list.fresh`: these accounts' (ids or `OWN_USAGE_ID`s) usage is looked up now, in the background, at most
   * `USAGE_PROBES_AT_ONCE` at a time; one known for less than `USAGE_TTL_MS`, or whose provider asked us to
   * wait, isn't. Each result reaches the server at once (a person is looking).
   */
  probeUsage(ids: readonly string[]) {
    const now = Date.now();
    const own = Object.values(OWN_USAGE_ID);
    for (const id of ids.slice(0, MAX_MACHINE_ACCOUNTS + own.length)) {
      if (!isAccountId(id) && !own.includes(id)) continue;
      if (this.probeQueue.includes(id) || this.probing.has(id) || (this.backoff.get(id) ?? 0) > now) continue;
      const known = Math.max(Date.parse(this.usage.get(id)?.at ?? "") || 0, this.probed.get(id) ?? 0);
      if (now - known < (this.opts.usageTtlMs ?? USAGE_TTL_MS)) continue;
      this.probeQueue.push(id);
    }
    this.nextProbes();
  }

  private nextProbes() {
    while (!this.closed && this.probing.size < USAGE_PROBES_AT_ONCE && this.probeQueue.length > 0) {
      const id = this.probeQueue.shift() as string;
      this.probing.add(id);
      this.probed.set(id, Date.now());
      void this.probeOne(id)
        .catch(() => null)
        .then((found) => {
          if (found === "backoff") this.backoff.set(id, Date.now() + USAGE_BACKOFF_MS);
          else if (found && !this.closed) {
            this.usage.set(id, found);
            this.usageChanged();
          }
        })
        .finally(() => {
          this.probing.delete(id);
          this.nextProbes();
        });
    }
  }

  private async probeOne(id: string): Promise<PlanUsage | "backoff" | null> {
    const timeoutMs = this.opts.usageTimeoutMs;
    const own = ACCOUNT_KINDS.find((k) => OWN_USAGE_ID[k] === id);
    // The computer's own sign-in runs from the runner's home, never a project of the person's.
    const target = own
      ? { kind: own, cwd: path.dirname(this.opts.root), env: process.env }
      : ACCOUNT_KINDS.flatMap((k) => {
          const dir = this.accountDir(k, id);
          return dir ? [{ kind: k, cwd: dir, env: this.env(k, dir) }] : [];
        })[0];
    if (!target) return null;
    const limits = timeoutMs ? { timeoutMs } : {};
    const plan = own || target.kind !== "claude_code" ? null : await planKeyOf(target.cwd);
    if (plan) {
      return fetchPlanKeyUsage(plan.provider, plan.key, {
        ...limits,
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      });
    }
    if (!own && this.lentTo(target.kind, id) !== null) return null;
    const probe = { command: this.command(target.kind), cwd: target.cwd, env: target.env, ...limits };
    return target.kind === "codex" ? probeCodexUsage(probe) : probeClaudeUsage(probe);
  }

  /** The runner is exiting: sign-ins in progress stop and their folders go. */
  async close() {
    this.closed = true;
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.probeQueue.length = 0;
    const waiting = [...this.logins.values()].filter((l) => l.state === "waiting");
    for (const l of waiting) this.settle(l, "failed", "The runner stopped");
    await Promise.all(waiting.map((l) => this.drop(l)));
    for (const l of this.logins.values()) if (l.timer) clearTimeout(l.timer);
    this.logins.clear();
  }
}
