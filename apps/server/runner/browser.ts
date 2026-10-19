import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_BROWSER_SHA256,
  AGENT_BROWSER_VERSION,
  type AgentBrowserTarget,
  type AgentScope,
  agentBrowserAsset,
  BROWSER_LIMITS,
  type BrowserInputEvent,
  type BrowserStreamMode,
  type MachineReplies,
  type MachineRequest,
  parseBrowserInputEvent,
  type RunnerBrowserInfo,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { SECRET_NAME } from "@agenteschat/adapters/secret-box";
import { RunnerError } from "./errors";
import { agentFolderName, isInside } from "./paths";

/**
 * The agent browser (protocol 12, ADR 0040). The runner drives the pinned
 * `agent-browser` (a Rust CLI + daemon speaking CDP to a local Chrome), one
 * headless session per agent with a persistent profile in the agent's folder,
 * so a login done once stays. Agents never reach the CLI: the server sends
 * one command at a time (`browser.act`) and the runner adds the flags that
 * matter (session, profile, our empty config, output limits) and refuses the
 * ones that would widen what the browser reaches (another profile, CDP,
 * plugins, the vault, the dashboard, chat).
 *
 * - Binary: the desktop app's sidecar next to the runner, else a download of
 *   the pinned release into `<runner home>/bin/`, checked against its SHA-256
 *   before it is ever run.
 * - Chrome: the one installed (Chrome, Brave, Chromium) or Chrome for Testing
 *   (`agent-browser install`) on first use.
 * - Commands run one at a time per session (the daemon does too: a read waits
 *   behind the agent's command). Reads first check the browser is open, since
 *   most commands relaunch a Chrome that died on a blank page.
 * - The site allowlist is ours: `--allowed-domains` refuses persistent
 *   profiles, so navigations are checked before they go and the page after
 *   each action (top-level pages only; sub-resources aren't filtered).
 * - Live view: the session's local stream (JPEG frames over a WebSocket) is
 *   relayed as `browser.frame` only while the server asked for it, and a
 *   person's input goes back over the same socket.
 */

/** A session with no command for this long is closed by `agent-browser` itself. */
export const BROWSER_IDLE_MS = 15 * 60_000;
/** Memory one live browser takes, roughly (the per-machine cap). */
const SESSION_BYTES = 300 * 1024 * 1024;
/** Frames a second per stream mode. */
export const STREAM_FPS: Record<BrowserStreamMode, number> = { watch: 1, control: 15 };
/** Characters of page output (snapshots, text) one command returns at most. */
const MAX_OUTPUT_CHARS = 50_000;
/** Bytes of stdout read from one command (a full-page screenshot as JSON stays well under). */
const MAX_STDOUT = 8 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const QUICK_TIMEOUT_MS = 15_000;
/** After a failed download or install, wait this long before trying again. */
const RETRY_FAILURE_MS = 10 * 60_000;
const STREAM_OPEN_MS = 5000;

/** What the server may ask for: everything else (vault, plugins, chat, dashboard, sessions, installs) is refused. */
const COMMANDS = new Set([
  "open",
  "goto",
  "navigate",
  "back",
  "forward",
  "reload",
  "read",
  "snapshot",
  "click",
  "dblclick",
  "focus",
  "type",
  "fill",
  "press",
  "key",
  "keyboard",
  "keydown",
  "keyup",
  "hover",
  "select",
  "check",
  "uncheck",
  "scroll",
  "scrollintoview",
  "scrollinto",
  "drag",
  "upload",
  "screenshot",
  "pdf",
  "get",
  "is",
  "find",
  "wait",
  "tab",
  "frame",
  "dialog",
  "eval",
  "console",
  "errors",
  "set",
  "mouse",
  "close",
]);

/** Commands that only look: they need an open browser and must not launch a blank one. */
const READS = new Set(["snapshot", "get", "is", "screenshot", "pdf", "console", "errors"]);
/** Commands whose argument is a URL to go to. */
const NAVIGATIONS = new Set(["open", "goto", "navigate", "read"]);
/** Commands that write files (paths must stay in the agent's folder). */
const FILE_OUTPUTS = new Set(["screenshot", "pdf"]);

/**
 * Global flags an argument may not carry: the runner sets them, or they reach
 * outside the agent's own browser (another profile, a running Chrome, plugins,
 * local files, a proxy, a visible window).
 */
const FORBIDDEN_FLAGS = new Set([
  "--session",
  "--session-name",
  "--profile",
  "--state",
  "--restore",
  "--restore-save",
  "--restore-check-url",
  "--restore-check-text",
  "--restore-check-fn",
  "--namespace",
  "--config",
  "--cdp",
  "--auto-connect",
  "--executable-path",
  "--extension",
  "--init-script",
  "--enable",
  "--args",
  "--user-agent",
  "--proxy",
  "--proxy-bypass",
  "--ignore-https-errors",
  "--ca-cert",
  "--no-ca-cert",
  "--use-system-ca",
  "--allow-file-access",
  "--provider",
  "-p",
  "--device",
  "--headed",
  "--webgpu",
  "--engine",
  "--model",
  "--allowed-domains",
  "--action-policy",
  "--confirm-actions",
  "--confirm-interactive",
  "--content-boundaries",
  "--max-output",
  "--json",
  "--debug",
  "--idle-timeout",
  "--download-path",
  "--screenshot-dir",
  "--pin-tab",
  "--no-pin-tab",
  "--no-webmcp",
]);

/** `agent-browser`'s answer to one command (`--json`). */
export interface BrowserAnswer {
  success: boolean;
  data: unknown;
  error?: string;
  code?: string;
}

/** The release asset this computer runs, or null when there is none. */
export function agentBrowserTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): AgentBrowserTarget | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `darwin-${arch}`;
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) return `linux-${arch}`;
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return null;
}

/** Live browsers this computer takes: a quarter of its memory at ~300 MB each, 1 to 8. */
export function defaultMaxSessions(totalBytes: number = os.totalmem()): number {
  return Math.max(1, Math.min(8, Math.floor((totalBytes * 0.25) / SESSION_BYTES)));
}

/**
 * Whether `url` is on a site the agent may use. `example.com` is that host;
 * `*.example.com` is the host and its subdomains (like `agent-browser`'s own
 * allowlist). `about:blank` and `data:` pages are always allowed.
 */
export function domainAllowed(url: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol === "about:" || u.protocol === "data:") return true;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!p) return false;
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === p;
  });
}

/** A bare host (`example.com/login`) is how `agent-browser open` takes it too. */
const asUrl = (raw: string) => (/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);

/** Where `agent-browser install` puts Chrome for Testing. */
const testingChromeDir = (home: string) => path.join(home, ".agent-browser", "browsers");

/**
 * The Chrome `agent-browser` would launch, as a path, or null (same order as
 * its own search: Chrome for Testing it installed, then the system's).
 */
export function findChrome(home: string = os.homedir(), platform: string = process.platform): string | null {
  const testing = testingChromeDir(home);
  try {
    if (readdirSync(testing).some((e) => statSync(path.join(testing, e)).isDirectory())) return testing;
  } catch {
    // none installed
  }
  const candidates: string[] = [];
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
  } else if (platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      candidates.push(
        path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      );
    }
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    );
  } else {
    const which = (name: string) => (typeof Bun !== "undefined" ? Bun.which(name) : null);
    for (const name of [
      "google-chrome",
      "google-chrome-stable",
      "chromium-browser",
      "chromium",
      "brave-browser",
      "brave-browser-stable",
    ]) {
      const found = which(name);
      if (found) return found;
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** "Google Chrome", "Chrome for Testing"… for `hello.browser`. */
export function chromeLabel(found: string, home: string = os.homedir()): string {
  if (found === testingChromeDir(home)) return "Chrome for Testing";
  const base = path.basename(found).replace(/\.exe$/i, "");
  const names: Record<string, string> = {
    chrome: "Google Chrome",
    "google-chrome": "Google Chrome",
    "google-chrome-stable": "Google Chrome",
    "chromium-browser": "Chromium",
    chromium: "Chromium",
    brave: "Brave",
    "brave-browser": "Brave",
    "brave-browser-stable": "Brave",
  };
  return names[base] ?? base;
}

/** Virtual key codes and text the stream's `input_keyboard` needs (it sends none of its own). */
const SPECIAL_KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: "\r" },
  Tab: { code: 9 },
  Backspace: { code: 8 },
  Escape: { code: 27 },
  Delete: { code: 46 },
  ArrowLeft: { code: 37 },
  ArrowUp: { code: 38 },
  ArrowRight: { code: 39 },
  ArrowDown: { code: 40 },
  Home: { code: 36 },
  End: { code: 35 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
  " ": { code: 32, text: " " },
  Shift: { code: 16 },
  Control: { code: 17 },
  Alt: { code: 18 },
  Meta: { code: 91 },
};

/**
 * One person's input event as the stream's WebSocket message. Keys get the
 * virtual key code and text CDP needs (Enter would otherwise submit nothing,
 * a letter would type nothing); text goes through a command instead (null).
 */
export function streamMessage(e: BrowserInputEvent): Record<string, unknown> | null {
  switch (e.kind) {
    case "mouse":
      return {
        type: "input_mouse",
        eventType: e.type,
        x: e.x,
        y: e.y,
        button: e.button ?? (e.type === "mouseMoved" || e.type === "mouseWheel" ? "none" : "left"),
        clickCount: e.clickCount ?? (e.type === "mousePressed" || e.type === "mouseReleased" ? 1 : 0),
        deltaX: e.deltaX ?? 0,
        deltaY: e.deltaY ?? 0,
        modifiers: e.modifiers ?? 0,
      };
    case "touch":
      return { type: "input_touch", eventType: e.type, touchPoints: e.touchPoints, modifiers: e.modifiers ?? 0 };
    case "key": {
      const special = SPECIAL_KEYS[e.key];
      const printable = !special && [...e.key].length === 1;
      const code = special?.code ?? (printable ? e.key.toUpperCase().charCodeAt(0) : 0);
      // Text only on the press of a key that types, never with Control/Meta (shortcuts).
      const shortcut = ((e.modifiers ?? 0) & (2 | 4)) !== 0;
      const text =
        e.type === "keyUp" || shortcut ? undefined : (e.text ?? special?.text ?? (printable ? e.key : undefined));
      return {
        type: "input_keyboard",
        eventType: e.type,
        key: e.key,
        ...(e.code ? { code: e.code } : {}),
        ...(text !== undefined ? { text } : {}),
        windowsVirtualKeyCode: code,
        modifiers: e.modifiers ?? 0,
      };
    }
    case "text":
      return null;
  }
}

/** The subset of a WebSocket the stream relay uses (a fake in tests). */
export interface StreamSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface BrowserManagerOptions {
  /** The runner's home: `bin/` for the downloaded binary, `browser/` for our config. */
  home: string;
  log: (line: string) => void;
  /** Sends a frame on the current connection; false when it is down. */
  send: (frame: RunnerFrame) => boolean;
  /** A secret delivered to the agent (ADR 0027), by name, or null. */
  secret: (agent: AgentScope, name: string) => Promise<string | null>;
  /** Tests: how to start `agent-browser` (default: the sidecar or the downloaded binary). */
  command?: string[];
  /** The runner's executable (the sidecar sits next to it). */
  execPath?: string;
  fetch?: typeof fetch;
  /** Tests: the Chrome lookup. */
  chrome?: () => string | null;
  /** Tests: the computer's home (Chrome for Testing lives under it). */
  userHome?: string;
  maxSessions?: number;
  idleMs?: number;
  now?: () => number;
  /** Tests: opens the session's stream socket. */
  connectStream?: (url: string) => StreamSocket;
}

interface Stream {
  socket: StreamSocket;
  mode: BrowserStreamMode;
  url?: string;
  /** Closed by us (stop, mode off): no `ended` frame for an expected close. */
  closing: boolean;
}

interface Session {
  agentId: string;
  name: string;
  folder: string;
  /** Commands run one at a time. */
  queue: Promise<unknown>;
  lastUsed: number;
  stream?: Stream;
}

type ActRequest = Extract<MachineRequest, { op: "browser.act" }>;

const exeName = (platform: string = process.platform) => `agent-browser${platform === "win32" ? ".exe" : ""}`;

const sha256File = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** `agent-browser`'s JSON answer, or a failure built from what it printed. */
function parseAnswer(stdout: string, stderr: string, exitCode: number | null): BrowserAnswer {
  const text = stdout.trim();
  for (const candidate of [text, text.split("\n").at(-1) ?? ""]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate) as unknown;
      if (isRecord(v) && typeof v.success === "boolean") {
        return {
          success: v.success,
          data: v.data ?? null,
          ...(typeof v.error === "string" && v.error ? { error: v.error } : {}),
          ...(typeof v.code === "string" && v.code ? { code: v.code } : {}),
        };
      }
      if (Array.isArray(v)) return { success: exitCode === 0, data: v };
    } catch {
      // not JSON: fall through
    }
  }
  const why = (stderr.trim() || text).split("\n").find((l) => l.trim()) ?? `agent-browser exited with ${exitCode}`;
  return { success: false, data: null, error: why.slice(0, 2000) };
}

export class BrowserManager {
  private readonly sessions = new Map<string, Session>();
  private readonly namespace: string;
  private readonly configFile: string;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly userHome: string;
  private binary: string | null = null;
  private ready: Promise<string> | null = null;
  private failure: { reason: string; at: number } | null = null;
  private closed = false;

  constructor(private readonly opts: BrowserManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? BROWSER_IDLE_MS;
    this.maxSessions = opts.maxSessions ?? defaultMaxSessions();
    this.userHome = opts.userHome ?? os.homedir();
    // Daemons of this runner home only (another organization's runner on this computer has its own).
    this.namespace = `agentes-${createHash("sha256").update(opts.home).digest("hex").slice(0, 8)}`;
    this.configFile = path.join(opts.home, "browser", "config.json");
  }

  // ── Readiness ──────────────────────────────────────────────────────────────

  /** `hello.browser`: whether this computer can serve the agent browser (cheap: nothing is started). */
  info(): RunnerBrowserInfo {
    const chrome = (this.opts.chrome ?? (() => findChrome(this.userHome)))();
    const recent = this.failure && this.now() - this.failure.at < RETRY_FAILURE_MS ? this.failure : null;
    if (!this.opts.command && !this.bundled() && !agentBrowserTarget()) {
      return {
        available: false,
        reason: `The agent browser doesn't run on this system (${process.platform} ${process.arch})`,
      };
    }
    if (recent) return { available: false, version: AGENT_BROWSER_VERSION, reason: recent.reason };
    return {
      available: true,
      version: AGENT_BROWSER_VERSION,
      ...(chrome ? { chrome: chromeLabel(chrome, this.userHome) } : {}),
    };
  }

  /** The desktop app's sidecar next to the runner, if there is one. */
  private bundled(): string | null {
    const file = path.join(path.dirname(this.opts.execPath ?? process.execPath), exeName());
    return existsSync(file) ? file : null;
  }

  private downloadedPath() {
    return path.join(
      this.opts.home,
      "bin",
      `agent-browser-${AGENT_BROWSER_VERSION}${exeName().slice("agent-browser".length)}`,
    );
  }

  /** How to start `agent-browser`, without downloading anything (null: not here yet). */
  private presentCommand(): string[] | null {
    if (this.opts.command) return this.opts.command;
    if (this.binary) return [this.binary];
    const bundled = this.bundled();
    if (bundled) return [bundled];
    const downloaded = this.downloadedPath();
    return existsSync(downloaded) ? [downloaded] : null;
  }

  /** The binary (downloaded and checked if needed) and a Chrome; throws `browser_unavailable` with the reason. */
  private ensureReady(): Promise<string[]> {
    if (this.opts.command) return this.ensureChrome(this.opts.command).then(() => this.opts.command as string[]);
    const recent = this.failure && this.now() - this.failure.at < RETRY_FAILURE_MS ? this.failure : null;
    if (recent) return Promise.reject(new RunnerError("browser_unavailable", recent.reason));
    this.ready ??= this.prepare().finally(() => {
      this.ready = null;
    });
    return this.ready.then(async (bin) => {
      await this.ensureChrome([bin]);
      return [bin];
    });
  }

  private async prepare(): Promise<string> {
    if (this.binary) return this.binary;
    const bundled = this.bundled();
    if (bundled) {
      this.binary = bundled;
      return bundled;
    }
    const target = agentBrowserTarget();
    if (!target) {
      throw this.fail(`The agent browser doesn't run on this system (${process.platform} ${process.arch})`);
    }
    const file = this.downloadedPath();
    const want = AGENT_BROWSER_SHA256[target];
    if (existsSync(file) && (await sha256File(file).catch(() => "")) === want) {
      this.binary = file;
      return file;
    }
    await this.download(target, file, want);
    this.binary = file;
    return file;
  }

  /** The pinned release from GitHub; refused unless its SHA-256 is the one we pinned. */
  private async download(target: AgentBrowserTarget, file: string, want: string) {
    const url = `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${agentBrowserAsset(target)}`;
    this.opts.log(`downloading the agent browser ${AGENT_BROWSER_VERSION} (${target})`);
    let bytes: Buffer;
    try {
      const res = await (this.opts.fetch ?? fetch)(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw this.fail(
        `Couldn't download the agent browser: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
      );
    }
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw this.fail("The agent browser download didn't match its checksum; it was not used");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o755 });
    await chmod(tmp, 0o755).catch(() => undefined);
    await rename(tmp, file);
  }

  /** A Chrome to drive: the one found, or Chrome for Testing installed once. */
  private async ensureChrome(command: string[]) {
    const find = this.opts.chrome ?? (() => findChrome(this.userHome));
    if (find()) return;
    this.opts.log("no Chrome found; installing Chrome for Testing for the agent browser");
    const out = await this.spawn(command, ["install"], { timeoutMs: INSTALL_TIMEOUT_MS, cwd: this.opts.home });
    if (find()) return;
    const hint =
      process.platform === "linux"
        ? `; Chrome's libraries may be missing: run ${command.join(" ")} install --with-deps`
        : "";
    throw this.fail(`Couldn't install a browser for the agent${hint} (${firstLine(out.stderr || out.stdout)})`);
  }

  private fail(reason: string) {
    this.failure = { reason: reason.slice(0, BROWSER_LIMITS.message), at: this.now() };
    return new RunnerError("browser_unavailable", this.failure.reason);
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  /** `browser.act`: one command in the agent's session, after the checks. */
  async act(agent: AgentScope, folder: string, req: ActRequest, signal?: AbortSignal): Promise<BrowserAnswer> {
    const command = typeof req.command === "string" ? req.command : "";
    const args = Array.isArray(req.args) ? req.args : [];
    if (!command || command.length > BROWSER_LIMITS.command) throw new RunnerError("bad_request", "Missing command");
    if (!args.every((a) => typeof a === "string") || JSON.stringify(args).length > BROWSER_LIMITS.args) {
      throw new RunnerError("bad_request", "args must be a short list of strings");
    }
    const allowed = Array.isArray(req.allowedDomains)
      ? req.allowedDomains.filter((d): d is string => typeof d === "string" && d.trim() !== "")
      : [];
    const timeoutMs = Math.max(1, Math.min(600, Number(req.timeoutSeconds) || 60)) * 1000;
    if (command === "agentes:type_secret") {
      const session = await this.session(agent, folder);
      return this.enqueue(session, () => this.typeSecret(agent, session, args, timeoutMs, signal));
    }
    if (!COMMANDS.has(command)) throw new RunnerError("bad_request", `The browser doesn't take ${command}`);
    for (const a of args) {
      const flag = a.split("=")[0] as string;
      if (FORBIDDEN_FLAGS.has(flag)) throw new RunnerError("bad_request", `${flag} is set by the runner`);
    }
    const checked = this.checkArgs(command, args, folder, allowed);
    const session = await this.session(agent, folder);
    return this.enqueue(session, async () => {
      if (READS.has(command) && !(await this.browserOpen(session, signal))) {
        return { success: false, data: null, error: "The browser isn't open: open a page first" };
      }
      const answer = await this.run(session, [command, ...checked], { timeoutMs, signal });
      if (allowed.length > 0 && !READS.has(command) && command !== "close") {
        const left = await this.leftAllowedSites(session, allowed, signal);
        if (left) return { success: false, data: null, error: left };
      }
      return answer;
    });
  }

  /** Paths stay in the agent's folder; URLs go only to allowed sites. Returns the args to run. */
  private checkArgs(command: string, args: string[], folder: string, allowed: string[]): string[] {
    const positional = args.filter((a) => !a.startsWith("-"));
    if (NAVIGATIONS.has(command) && positional[0]) {
      const url = asUrl(positional[0]);
      if (url.startsWith("file:")) throw new RunnerError("not_allowed", "The agent browser doesn't open local files");
      if (!domainAllowed(url, allowed)) {
        throw new RunnerError("not_allowed", `${hostOf(url)} is outside the sites this agent may use`);
      }
    }
    if (command === "tab" && positional[0] === "new" && positional[1]) {
      const url = asUrl(positional[1]);
      if (!domainAllowed(url, allowed) || url.startsWith("file:")) {
        throw new RunnerError("not_allowed", `${hostOf(url)} is outside the sites this agent may use`);
      }
    }
    const inFolder = (p: string) => {
      const abs = path.resolve(folder, p);
      if (!isInside(folder, abs)) throw new RunnerError("outside_workspace", `${p} is outside the agent's folder`);
      return abs;
    };
    if (command === "upload") {
      // `upload <selector> <file…>`: the files come from the agent's folder.
      let seenSelector = false;
      return args.map((a) => {
        if (a.startsWith("-")) return a;
        if (!seenSelector) {
          seenSelector = true;
          return a;
        }
        return inFolder(a);
      });
    }
    if (FILE_OUTPUTS.has(command)) {
      return args.map((a) => (a.startsWith("-") || !/[/\\]|\.(png|jpe?g|pdf)$/i.test(a) ? a : inFolder(a)));
    }
    return args;
  }

  /** The agent's session (created on first use, within the per-machine cap). */
  private async session(agent: AgentScope, folder: string): Promise<Session> {
    if (this.closed) throw new RunnerError("browser_unavailable", "The runner is stopping");
    const agentId = String(agent.id ?? "");
    const existing = this.sessions.get(agentId);
    if (existing) {
      existing.lastUsed = this.now();
      return existing;
    }
    const live = [...this.sessions.values()].filter((s) => this.now() - s.lastUsed < this.idleMs);
    if (live.length >= this.maxSessions) {
      throw new RunnerError(
        "browser_unavailable",
        `This computer already has ${live.length} agent browsers open (its limit); try again in a few minutes`,
      );
    }
    for (const [id, s] of this.sessions) if (!live.includes(s)) this.sessions.delete(id);
    await this.ensureReady();
    await mkdir(path.join(folder, ".agentes", "browser"), { recursive: true });
    await mkdir(path.dirname(this.configFile), { recursive: true, mode: 0o700 });
    if (!existsSync(this.configFile)) await writeFile(this.configFile, "{}\n", { mode: 0o600 });
    const session: Session = {
      agentId,
      name: `agent-${agentFolderName(agent).suffix.slice(1)}`,
      folder,
      queue: Promise.resolve(),
      lastUsed: this.now(),
    };
    this.sessions.set(agentId, session);
    return session;
  }

  private enqueue<T>(session: Session, fn: () => Promise<T>): Promise<T> {
    const run = session.queue.catch(() => undefined).then(fn);
    session.queue = run.catch(() => undefined);
    return run;
  }

  /** Flags the runner sets on every command of a session. */
  private sessionFlags(session: Session): string[] {
    return [
      "--namespace",
      this.namespace,
      "--session",
      session.name,
      "--profile",
      path.join(session.folder, ".agentes", "browser"),
      "--config",
      this.configFile,
      "--json",
      "--content-boundaries",
      "--max-output",
      String(MAX_OUTPUT_CHARS),
      "--idle-timeout",
      `${Math.round(this.idleMs / 1000)}s`,
      "--no-webmcp",
      "--download-path",
      path.join(session.folder, "downloads"),
      "--screenshot-dir",
      path.join(session.folder, "screenshots"),
    ];
  }

  private async run(
    session: Session,
    args: string[],
    opts: { timeoutMs: number; signal?: AbortSignal; stdin?: string },
  ): Promise<BrowserAnswer> {
    const command = this.presentCommand() ?? (await this.ensureReady());
    session.lastUsed = this.now();
    const out = await this.spawn(command, [...this.sessionFlags(session), ...args], {
      timeoutMs: opts.timeoutMs,
      cwd: session.folder,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    });
    if (out.timedOut) {
      return {
        success: false,
        data: null,
        error: `The browser didn't answer within ${Math.round(opts.timeoutMs / 1000)} s`,
      };
    }
    return parseAnswer(out.stdout, out.stderr, out.exitCode);
  }

  /** Whether the session's Chrome is up (`stream status` never launches one). */
  private async browserOpen(session: Session, signal?: AbortSignal): Promise<boolean> {
    const status = await this.run(session, ["stream", "status"], {
      timeoutMs: QUICK_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return status.success && isRecord(status.data) && status.data.connected === true;
  }

  /** After an action: the page left the allowed sites → go back and say so (null when still inside). */
  private async leftAllowedSites(session: Session, allowed: string[], signal?: AbortSignal): Promise<string | null> {
    const got = await this.run(session, ["get", "url"], {
      timeoutMs: QUICK_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const url = isRecord(got.data) && typeof got.data.url === "string" ? got.data.url : null;
    if (!url || domainAllowed(url, allowed)) return null;
    await this.run(session, ["back"], { timeoutMs: QUICK_TIMEOUT_MS });
    return `The page went to ${hostOf(url)}, outside the sites this agent may use; it went back`;
  }

  /**
   * `agentes:type_secret [ref, NAME]`: types a secret delivered with
   * `request_secret` into a password or one-time-code field. The value goes
   * to `agent-browser` on stdin (never on a command line) and never back.
   */
  private async typeSecret(
    agent: AgentScope,
    session: Session,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BrowserAnswer> {
    const [rawRef, name] = args;
    const ref = typeof rawRef === "string" && /^@?e\d{1,6}$/.test(rawRef) ? `@${rawRef.replace(/^@/, "")}` : null;
    if (!ref || typeof name !== "string" || !SECRET_NAME.test(name)) {
      throw new RunnerError("bad_request", "agentes:type_secret takes a ref (@e3) and a secret name (DB_PASSWORD)");
    }
    const value = await this.opts.secret(agent, name);
    if (value === null) {
      return {
        success: false,
        data: null,
        error: `No secret named ${name} was delivered to this agent; ask for it with request_secret first`,
      };
    }
    if (!(await this.browserOpen(session, signal))) {
      return { success: false, data: null, error: "The browser isn't open: open a page first" };
    }
    const attr = async (a: string) => {
      const got = await this.run(session, ["get", "attr", ref, a], {
        timeoutMs: QUICK_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      return got.success && isRecord(got.data) && typeof got.data.value === "string"
        ? got.data.value.toLowerCase()
        : "";
    };
    const type = await attr("type");
    const autocomplete = type === "password" ? "" : await attr("autocomplete");
    if (type !== "password" && !/\b(current-password|new-password|one-time-code)\b/.test(autocomplete)) {
      return {
        success: false,
        data: null,
        error: `${ref} isn't a password or one-time-code field; secrets are only typed into those`,
      };
    }
    const out = await this.run(session, ["batch", "--bail"], {
      timeoutMs,
      stdin: JSON.stringify([["fill", ref, value]]),
      ...(signal ? { signal } : {}),
    });
    const first = Array.isArray(out.data) && isRecord(out.data[0]) ? out.data[0] : null;
    const ok = first ? first.success === true : out.success;
    const error = first && typeof first.error === "string" ? first.error : out.error;
    const clean = (s: string) => s.split(value).join("[secret]");
    return ok
      ? { success: true, data: { typed: name, into: ref } }
      : { success: false, data: null, error: clean(error ?? "Couldn't type the secret") };
  }

  /** `browser.stop`: closes the agent's browser (its profile stays). */
  async stop(agent: AgentScope): Promise<MachineReplies["browser.stop"]> {
    const agentId = String(agent.id ?? "");
    const session = this.sessions.get(agentId);
    if (!session) return { stopped: false };
    this.endStream(session, "stopped");
    this.sessions.delete(agentId);
    await this.enqueue(session, () => this.run(session, ["close"], { timeoutMs: QUICK_TIMEOUT_MS })).catch(
      () => undefined,
    );
    return { stopped: true };
  }

  /** Every browser of this runner home closes (the switch went off, the runner stops, or it just started). */
  async closeAll() {
    for (const s of this.sessions.values()) this.endStream(s, "closed");
    this.sessions.clear();
    const command = this.presentCommand();
    if (!command) return;
    await this.spawn(command, ["--namespace", this.namespace, "--json", "close", "--all"], {
      timeoutMs: QUICK_TIMEOUT_MS,
      cwd: this.opts.home,
    }).catch(() => undefined);
  }

  /** The runner stops: streams end, browsers close, nothing new starts. */
  async close() {
    this.closed = true;
    await this.closeAll();
  }

  // ── Live view ──────────────────────────────────────────────────────────────

  /** `browser.stream.start`: relays the session's frames until `stop` (or changes the mode). */
  async streamStart(agent: AgentScope, mode: BrowserStreamMode): Promise<MachineReplies["browser.stream.start"]> {
    if (mode !== "watch" && mode !== "control") throw new RunnerError("bad_request", "mode must be watch or control");
    const session = this.sessions.get(String(agent.id ?? ""));
    if (!session) throw new RunnerError("bad_request", "The agent's browser isn't open");
    session.lastUsed = this.now();
    if (session.stream) {
      if (session.stream.mode !== mode) {
        session.stream.mode = mode;
        session.stream.socket.send(JSON.stringify({ type: "config", maxFps: STREAM_FPS[mode] }));
      }
      return { mode };
    }
    const port = await this.enqueue(session, async () => {
      let status = await this.run(session, ["stream", "status"], { timeoutMs: QUICK_TIMEOUT_MS });
      if (isRecord(status.data) && status.data.connected !== true) return null;
      if (!isRecord(status.data) || status.data.enabled !== true) {
        await this.run(session, ["stream", "enable"], { timeoutMs: QUICK_TIMEOUT_MS });
        status = await this.run(session, ["stream", "status"], { timeoutMs: QUICK_TIMEOUT_MS });
      }
      return isRecord(status.data) && typeof status.data.port === "number" ? status.data.port : null;
    });
    if (port === null) throw new RunnerError("bad_request", "The agent's browser isn't open");
    const url = `ws://127.0.0.1:${port}/?maxFps=${STREAM_FPS[mode]}`;
    const socket = (this.opts.connectStream ?? ((u: string) => new WebSocket(u) as unknown as StreamSocket))(url);
    const stream: Stream = { socket, mode, closing: false };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.onopen = null;
        socket.close();
        reject(new RunnerError("internal", "The browser's live view didn't open"));
      }, STREAM_OPEN_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new RunnerError("internal", "The browser's live view didn't open"));
      };
    });
    session.stream = stream;
    socket.onmessage = (event) => this.onStreamMessage(session, stream, event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (session.stream !== stream) return;
      session.stream = undefined;
      if (!stream.closing) this.opts.send({ type: "browser.stream.ended", agentId: session.agentId, reason: "closed" });
    };
    return { mode };
  }

  private onStreamMessage(session: Session, stream: Stream, raw: unknown) {
    if (session.stream !== stream) return;
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    if (msg.type === "url" && typeof msg.url === "string") {
      stream.url = msg.url.slice(0, BROWSER_LIMITS.url);
      return;
    }
    if (msg.type !== "frame" || typeof msg.data !== "string" || msg.data.length > BROWSER_LIMITS.frameBytes) return;
    const m = isRecord(msg.metadata) ? msg.metadata : {};
    const width = Number(m.deviceWidth);
    const height = Number(m.deviceHeight);
    const seq = Number(msg.seq);
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(seq)) return;
    const scale = Number(m.pageScaleFactor);
    session.lastUsed = this.now();
    // Newest wins: a frame the connection can't take now is dropped, never queued.
    this.opts.send({
      type: "browser.frame",
      agentId: session.agentId,
      seq,
      data: msg.data,
      metadata: {
        deviceWidth: width,
        deviceHeight: height,
        ...(Number.isFinite(scale) ? { pageScaleFactor: scale } : {}),
        ...(stream.url ? { url: stream.url } : {}),
      },
    });
  }

  /** `browser.stream.stop`. */
  streamStop(agent: AgentScope): MachineReplies["browser.stream.stop"] {
    const session = this.sessions.get(String(agent.id ?? ""));
    if (!session?.stream) return { stopped: false };
    this.endStream(session, "stopped");
    return { stopped: true };
  }

  /** The connection to the server dropped: frames have nowhere to go; the server asks again when it is back. */
  stopStreams() {
    for (const s of this.sessions.values()) {
      if (!s.stream) continue;
      s.stream.closing = true;
      s.stream.socket.close();
      s.stream = undefined;
    }
  }

  private endStream(session: Session, reason: "stopped" | "closed") {
    const stream = session.stream;
    if (!stream) return;
    stream.closing = true;
    session.stream = undefined;
    try {
      stream.socket.close();
    } catch {
      // already closed
    }
    this.opts.send({ type: "browser.stream.ended", agentId: session.agentId, reason });
  }

  /** `browser.input`: a person's input during a take over, in order (text through `keyboard inserttext`). */
  async input(agent: AgentScope, events: unknown[]): Promise<MachineReplies["browser.input"]> {
    const session = this.sessions.get(String(agent.id ?? ""));
    if (!session?.stream) throw new RunnerError("bad_request", "Nobody is viewing this agent's browser");
    if (!Array.isArray(events) || events.length > BROWSER_LIMITS.inputEvents) {
      throw new RunnerError("bad_request", `At most ${BROWSER_LIMITS.inputEvents} events at once`);
    }
    session.lastUsed = this.now();
    let accepted = 0;
    for (const raw of events) {
      const e = parseBrowserInputEvent(raw);
      if (!e) continue;
      const message = streamMessage(e);
      if (message) {
        session.stream?.socket.send(JSON.stringify(message));
      } else if (e.kind === "text") {
        // Whole text at once (accents, paste, the app's own field), on stdin: it may be a password.
        await this.enqueue(session, () =>
          this.run(session, ["batch"], {
            timeoutMs: QUICK_TIMEOUT_MS,
            stdin: JSON.stringify([["keyboard", "inserttext", e.text]]),
          }),
        );
      }
      accepted += 1;
    }
    return { accepted };
  }

  // ── Processes ──────────────────────────────────────────────────────────────

  /** Runs `agent-browser` with a clean environment (none of its own settings from ours or the person's shell). */
  private spawn(
    command: string[],
    args: string[],
    opts: { timeoutMs: number; cwd: string; signal?: AbortSignal; stdin?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith("AGENT_BROWSER_") || k.startsWith("AI_GATEWAY_")) continue;
      env[k] = v;
    }
    const [bin, ...pre] = command as [string, ...string[]];
    return new Promise((resolve) => {
      const child = spawn(bin, [...pre, ...args], {
        cwd: opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let size = 0;
      let timedOut = false;
      let done = false;
      const finish = (exitCode: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode, timedOut });
      };
      const kill = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // gone
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
      const onAbort = () => kill();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size <= MAX_STDOUT) stdout += chunk.toString("utf8");
        else kill();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString("utf8");
      });
      // Through EventEmitter: some @types/node versions lose ChildProcess's event methods.
      const events = child as unknown as EventEmitter;
      events.on("error", (err: Error) => {
        stderr += err.message;
        finish(null);
      });
      events.on("close", (code: number | null) => finish(code));
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.stdin ?? "");
    });
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname || url.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
};

const firstLine = (s: string) => (s.trim().split("\n")[0] ?? "").slice(0, 200);
