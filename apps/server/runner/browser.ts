import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_BROWSER_SHA256,
  AGENT_BROWSER_VERSION,
  type AgentBrowserTarget,
  type AgentScope,
  agentBrowserAsset,
  BROWSER_LIMITS,
  type BrowserHandoffInfo,
  type BrowserInputEvent,
  type BrowserStreamMode,
  type MachineReplies,
  type MachineRequest,
  parseBrowserInputEvent,
  type RunnerBrowserInfo,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import type { ControlBrowser, ControlBrowserDoing } from "@agenteschat/adapters/runner-control";
import { SECRET_NAME } from "@agenteschat/adapters/secret-box";
import type { DesktopSessions } from "./desktop-session";
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
 * - Chrome: always Chrome for Testing (`agent-browser install` on first use),
 *   never the person's own Chrome or Brave: their updater rewrites the app
 *   while we hold it open, and macOS then blames our app ("agentes was
 *   prevented from modifying apps").
 * - The runner starts that Chrome itself (headless, its own debugging port,
 *   the agent's profile) and every command connects to it (`--cdp`). A Chrome
 *   that `agent-browser` launches carries automation markers
 *   (`navigator.webdriver`, "HeadlessChrome"): measured on a Mac, Google's
 *   sign-in answered "this browser or app may not be secure" and its search
 *   sent the page to /sorry ("unusual traffic"), while the same Chrome started
 *   by the runner and attached reached the account check and the results.
 *   Sites' own rules still apply: a challenge goes to a person through the
 *   help request, never solved by the agent.
 * - Commands run one at a time per session (the daemon does too: a read waits
 *   behind the agent's command). A read never starts Chrome: it needs the
 *   session's Chrome running, and checks the page is reachable unless the
 *   last command just succeeded. Anything else starts Chrome when it isn't.
 * - The runner stops its Chromes itself: after the idle time (not while a
 *   person watches or a help request is open), on `stop`, and when it stops.
 *   Their pids are kept in `<runner home>/browser/chromes.json`, so a runner
 *   that crashed closes what it left on its next start.
 * - The site allowlist is ours: `--allowed-domains` refuses persistent
 *   profiles, so navigations are checked before they go and the page after
 *   each action (top-level pages only; sub-resources aren't filtered).
 * - Live view: the session's local stream (JPEG frames over a WebSocket) is
 *   relayed as `browser.frame` only while the server asked for it, with the
 *   active tab's address and title; a page that isn't repainting gets one
 *   screenshot as its first frame. A stream can't start on a closed browser
 *   (`browser_closed`): a command opens it first.
 */

/** A session with no command for this long is closed (its Chrome stops; the profile stays). */
export const BROWSER_IDLE_MS = 15 * 60_000;
/** How often idle browsers are looked for. */
const SWEEP_MS = 60_000;
/** A Chrome that hasn't opened its debugging port by then is given up. */
const CHROME_START_MS = 20_000;
/** A Chrome asked to quit that is still there after this is killed. */
const CHROME_KILL_MS = 3000;
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
/** One input command on the relay: a click or a key answers in milliseconds. */
const INPUT_TIMEOUT_MS = 5_000;
/** After a failed download or install, wait this long before trying again. */
const RETRY_FAILURE_MS = 10 * 60_000;
const STREAM_OPEN_MS = 5000;
/** A new stream with no frame from Chrome after this sends one screenshot instead (`firstFrame`). */
const FIRST_FRAME_MS = 1000;
/** A session that answered this long before its idle timeout is checked again before a read. */
const ALIVE_MARGIN_MS = 60_000;
/** A capture's file older than this is a leftover (its command timed out): removed by the next capture. */
const CAPTURE_LEFTOVER_MS = 60_000;

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

/** A web address's origin (`https://host[:port]`), or null when it isn't one. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** A bare host (`example.com/login`) is how `agent-browser open` takes it too. */
const asUrl = (raw: string) => (/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);

/**
 * Only web pages: `http:`, `https:` and the blank page. Everything else is
 * refused whatever its case or wrapping (`FILE:///`, `view-source:file:///`,
 * `chrome:`, `devtools:`, `javascript:`, `data:`): those reach the person's
 * files or the browser itself.
 */
export function isWebPage(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" || u.href === "about:blank";
  } catch {
    return false;
  }
}

/** Where `agent-browser install` puts Chrome for Testing. */
const testingChromeDir = (home: string) => path.join(home, ".agent-browser", "browsers");

/** Where the executable sits inside one Chrome for Testing folder (the layouts `agent-browser` looks for). */
function testingChromeBinaries(dir: string, platform: string): string[] {
  if (platform === "darwin") {
    const app = path.join("Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    return [path.join(dir, app), path.join(dir, "chrome-mac-arm64", app), path.join(dir, "chrome-mac-x64", app)];
  }
  if (platform === "win32") return [path.join(dir, "chrome.exe"), path.join(dir, "chrome-win64", "chrome.exe")];
  return [path.join(dir, "chrome"), path.join(dir, "chrome-linux64", "chrome")];
}

/**
 * Chrome for Testing that `agent-browser install` put under the home, newest
 * first, as its executable; null when none is installed. The person's own
 * Chrome is never used (see the top of this file).
 */
export function findChrome(home: string = os.homedir(), platform: string = process.platform): string | null {
  const testing = testingChromeDir(home);
  let entries: string[];
  try {
    entries = readdirSync(testing).filter((e) => e.startsWith("chrome-"));
  } catch {
    return null;
  }
  entries.sort().reverse();
  for (const e of entries) {
    const dir = path.join(testing, e);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = testingChromeBinaries(dir, platform).find((b) => existsSync(b));
    if (found) return found;
  }
  return null;
}

/**
 * Chrome flags on every launch: no first-run screens, nothing updating
 * Chrome's files in the background, and none of the automation markers a
 * launched-for-automation Chrome carries (no `--enable-automation`).
 */
export const CHROME_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-component-update",
];

/**
 * Headless at the desktops' size, or a window filling the agent's desktop
 * (ADR 0056 §7), always on X11 (the desktop's), where `--test-type` hides the
 * bar the automation flag shows.
 */
const SCREEN_ARGS = {
  headless: ["--headless=new", "--window-size=1280,800"],
  headed: ["--start-maximized", "--test-type", "--ozone-platform=x11"],
};

/**
 * A normal Chrome user agent for this Chrome's version (no "HeadlessChrome"),
 * as Chrome itself reduces it: major version only, a fixed platform string.
 * Null when the version can't be read from the path (`…/chrome-155.0.8059.84/…`).
 */
export function chromeUserAgent(exe: string, platform: string = process.platform): string | null {
  const major = /chrome-(\d+)\./.exec(exe)?.[1];
  if (!major) return null;
  const os =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** The computer's language for Chrome (`pt-BR`), or null. */
function osLang(): string | null {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : null;
  } catch {
    return null;
  }
}

/**
 * Where Chrome keeps the key to its cookies and saved logins: never the
 * person's keychain (macOS asks for the login password the first time),
 * a key of its own in the agent's profile instead.
 */
function secretStoreArgs(platform: string): string[] {
  if (platform === "darwin") return ["--use-mock-keychain"];
  if (platform === "linux") return ["--password-store=basic"];
  return [];
}

/**
 * The whole command line for the agent's Chrome: our flags, its own port (0: Chrome picks), its profile;
 * `headed`: in a window on the agent's desktop.
 */
export function chromeLaunchArgs(
  exe: string,
  profile: string,
  {
    platform = process.platform,
    lang = osLang(),
    headed = false,
  }: { platform?: string; lang?: string | null; headed?: boolean } = {},
): string[] {
  const ua = chromeUserAgent(exe, platform);
  return [
    ...CHROME_ARGS,
    ...SCREEN_ARGS[headed ? "headed" : "headless"],
    ...secretStoreArgs(platform),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    ...(ua ? [`--user-agent=${ua}`] : []),
    ...(lang ? [`--lang=${lang}`] : []),
    "about:blank",
  ];
}

/** A Chrome the runner started for one agent. */
export interface OwnChrome {
  pid: number;
  /** Its debugging port (`agent-browser --cdp`). */
  port: number;
  /** Asks it to quit, then kills it if it lingers. */
  kill(): void;
  /** Settles when the process is gone. */
  exited: Promise<void>;
}

/**
 * Starts Chrome and waits for its debugging port (Chrome writes it to
 * `<profile>/DevToolsActivePort` with `--remote-debugging-port=0`). `env`:
 * its whole environment (a desktop's display), else the runner's.
 */
export async function launchChrome(
  exe: string,
  args: string[],
  profile: string,
  env?: NodeJS.ProcessEnv,
): Promise<OwnChrome> {
  const portFile = path.join(profile, "DevToolsActivePort");
  await rm(portFile, { force: true });
  const child = spawn(exe, args, { stdio: "ignore", windowsHide: true, ...(env ? { env } : {}) });
  const events = child as unknown as EventEmitter;
  let gone = false;
  const exited = new Promise<void>((resolve) => {
    events.once("exit", () => {
      gone = true;
      resolve();
    });
    events.once("error", () => {
      gone = true;
      resolve();
    });
  });
  const kill = () => {
    if (gone) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      if (gone) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // gone
      }
    }, CHROME_KILL_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  const deadline = Date.now() + CHROME_START_MS;
  while (Date.now() < deadline) {
    if (gone) throw new Error("Chrome closed while starting (another Chrome may be using this profile)");
    const text = await readFile(portFile, "utf8").catch(() => "");
    const port = Number(text.split("\n")[0]);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      if (!child.pid) break;
      return { pid: child.pid, port, kill, exited };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  kill();
  throw new Error("Chrome didn't open its debugging port in time");
}

/** "Google Chrome", "Chrome for Testing"… for `hello.browser`. */
export function chromeLabel(found: string, home: string = os.homedir()): string {
  if (found === testingChromeDir(home) || isInside(testingChromeDir(home), found)) return "Chrome for Testing";
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

/** Keys pressed and released at once: `press` fills in their codes and text. */
const DISCRETE_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "Delete",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  " ",
]);
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
/** CDP's modifier bits, as `press` spells a chord (`Control+a`). */
const CHORD = [
  [1, "Alt"],
  [2, "Control"],
  [4, "Meta"],
  [8, "Shift"],
] as const;

/** Where a person's pointer is and which modifier keys they hold, per stream. */
export interface InputState {
  pointer?: { x: number; y: number };
  held: Set<string>;
}

/**
 * One person's input event as commands for `agent-browser`'s relay
 * (`POST /api/command` on the stream port). The daemon runs each on the
 * active tab and answers once Chrome has it, unlike the stream socket, whose
 * input goes to the tab it attached to and is never confirmed. Keys go
 * through `press` (it fills in codes and text); a modifier held on its own is
 * a raw key-down/up pair; a tap from the phone is a left click.
 */
export function relayCommands(e: BrowserInputEvent, state: InputState): Record<string, unknown>[] {
  switch (e.kind) {
    case "mouse":
      state.pointer = { x: e.x, y: e.y };
      return [
        {
          action: "input_mouse",
          type: e.type,
          x: e.x,
          y: e.y,
          button: e.button ?? (e.type === "mouseMoved" || e.type === "mouseWheel" ? "none" : "left"),
          clickCount: e.clickCount ?? (e.type === "mousePressed" || e.type === "mouseReleased" ? 1 : 0),
          deltaX: e.deltaX ?? 0,
          deltaY: e.deltaY ?? 0,
          modifiers: e.modifiers ?? 0,
        },
      ];
    case "touch": {
      const at = e.touchPoints[0] ?? state.pointer;
      if (!at) return [];
      state.pointer = { x: at.x, y: at.y };
      const mouse = (type: string, button: string, clickCount: number) => ({
        action: "input_mouse",
        type,
        x: at.x,
        y: at.y,
        button,
        clickCount,
        deltaX: 0,
        deltaY: 0,
        modifiers: e.modifiers ?? 0,
      });
      if (e.type === "touchStart") return [mouse("mouseMoved", "none", 0), mouse("mousePressed", "left", 1)];
      if (e.type === "touchMove") return [mouse("mouseMoved", "left", 0)];
      return [mouse("mouseReleased", "left", 1)];
    }
    case "key": {
      if (e.type === "char") return e.text ? [{ action: "keyboard", subaction: "insertText", text: e.text }] : [];
      if (MODIFIER_KEYS.has(e.key)) {
        if (e.type === "keyDown") state.held.add(e.key);
        else if (!state.held.delete(e.key)) return [];
        return [{ action: "input_keyboard", type: e.type, key: e.key, ...(e.code ? { code: e.code } : {}) }];
      }
      // `press` sends the whole key-down/up pair: the key-up has nothing left to do.
      if (e.type === "keyUp") return [];
      if (!DISCRETE_KEYS.has(e.key) && [...e.key].length !== 1) return [];
      const mods = e.modifiers ?? 0;
      // Shift with one character is that character, already in its shifted form.
      const chord = mods === 8 && [...e.key].length === 1 ? [] : CHORD.filter(([bit]) => mods & bit).map(([, n]) => n);
      return [{ action: "press", key: [...chord, e.key].join("+") }];
    }
    case "text":
      return [{ action: "keyboard", subaction: "insertText", text: e.text }];
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
  /** Tests: how long a new stream waits for Chrome's first frame (`FIRST_FRAME_MS`). */
  firstFrameMs?: number;
  /** Tests: starts the agent's Chrome (default: `launchChrome`). */
  startChrome?: (exe: string, args: string[], profile: string, env?: NodeJS.ProcessEnv) => Promise<OwnChrome>;
  /** Tests: whether a pid left in `chromes.json` is still that Chrome (default: asks the system). */
  isOurChrome?: (pid: number, profile: string) => Promise<boolean>;
  /** What `states()` returns may have changed (the desktop app's tray shows it). */
  onChange?: () => void;
  /**
   * The agents' desktops (ADR 0056 §7): while an agent's desktop runs, its Chrome starts in a window there,
   * so people watching the desktop see the browser too, and using that browser keeps the desktop up.
   */
  desktops?: Pick<DesktopSessions, "running" | "touch">;
}

interface Stream {
  socket: StreamSocket;
  /** The daemon's stream port: frames on its socket, a person's input on its command relay. */
  port: number;
  mode: BrowserStreamMode;
  input: InputState;
  /** Input batches run one after another, in order. */
  inputQueue: Promise<unknown>;
  url?: string;
  /** The active tab's title, from the stream's tab list (cleared when the URL moves on). */
  title?: string;
  /** The page's size in CSS pixels, from the stream's status. */
  viewport?: { width: number; height: number };
  /** A frame went out on this stream. */
  framed?: boolean;
  /** Closed by us (stop, mode off): no `ended` frame for an expected close. */
  closing: boolean;
}

/** What a frame says about the page besides its size: the active tab's address and title. */
const pageMeta = (stream: Stream) => ({
  ...(stream.url ? { url: stream.url } : {}),
  ...(stream.title ? { title: stream.title } : {}),
});

interface Session {
  agentId: string;
  name: string;
  folder: string;
  /** Commands run one at a time. */
  queue: Promise<unknown>;
  lastUsed: number;
  stream?: Stream;
  /** A stream being opened: a second start (or a stop) waits for it instead of opening another socket. */
  streamOpening?: Promise<void>;
  /** When a command last succeeded (the browser was up then); null after an error or a close. */
  aliveAt: number | null;
  /** The Chrome the runner started for this agent, while it runs. */
  chrome?: OwnChrome;
  /** A Chrome being started: a second command waits for it. */
  chromeStarting?: Promise<OwnChrome>;
  /** The desktop display that Chrome runs in a window on; absent: headless. */
  display?: number;
  /** For the desktop app: the page's host, what the agent did last, and the conversation it was for. */
  host?: string;
  doing?: ControlBrowserDoing;
  /** When the agent's last command ran (not a person's input or a viewer). */
  actedAt?: number;
  link?: string;
}

/** What a command is, as the desktop app words it ("lendo a página", "preenchendo"). */
const DOING: Record<string, ControlBrowserDoing> = {
  open: "opening",
  back: "opening",
  snapshot: "reading",
  get: "reading",
  click: "clicking",
  dblclick: "clicking",
  fill: "filling",
  type: "typing",
  press: "typing",
  "agentes:type_secret": "typing",
  select: "choosing",
  check: "choosing",
  uncheck: "choosing",
  scroll: "scrolling",
  wait: "waiting",
  mouse: "clicking",
  keyboard: "typing",
  upload: "uploading",
  screenshot: "capturing",
  pdf: "capturing",
  tab: "tabs",
};

/** `https://app.acme.example/trips` → `app.acme.example`; null for anything that isn't a web page. */
export function pageHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

/** A conversation path we pass on to the app (`/org/…`), nothing else. */
const isLink = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 500 && /^\/org\/[\w-]+\//.test(v) && !v.includes("//");

type ActRequest = Extract<MachineRequest, { op: "browser.act" }>;
type BatchRequest = Extract<MachineRequest, { op: "browser.batch" }>;

/** A command that passed the checks, ready to run. */
interface Prepared {
  command: string;
  args: string[];
  timeoutMs: number;
  tolerate?: boolean;
}

const allowedDomainsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((d): d is string => typeof d === "string" && d.trim() !== "") : [];

/** A JPEG's size from its frame header (SOF0–SOF15, not DHT/JPG/DAC), or null. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1] as number;
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number);
      const width = ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

/** `screenshot --annotate`'s numbered elements, as the protocol carries them. */
export function captureMarks(v: unknown): MachineReplies["browser.capture"]["marks"] {
  if (!Array.isArray(v)) return [];
  const out: MachineReplies["browser.capture"]["marks"] = [];
  for (const a of v.slice(0, 500)) {
    if (!isRecord(a) || typeof a.ref !== "string" || !/^@?e\d{1,6}$/.test(a.ref) || !isRecord(a.box)) continue;
    const box = a.box;
    const n = (k: string) => (typeof box[k] === "number" ? (box[k] as number) : 0);
    out.push({
      ref: a.ref.replace(/^@/, ""),
      number: typeof a.number === "number" ? a.number : 0,
      role: typeof a.role === "string" ? a.role.slice(0, 64) : "",
      ...(typeof a.name === "string" ? { name: a.name.slice(0, 200) } : {}),
      box: { x: n("x"), y: n("y"), width: n("width"), height: n("height") },
    });
  }
  return out;
}

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
  /** A person's turn in each agent's browser, as the server last told (`browser.handoff`). */
  private readonly handoffs = new Map<string, BrowserHandoffInfo>();
  private readonly namespace: string;
  private readonly configFile: string;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly userHome: string;
  private binary: string | null = null;
  /** The Chrome for Testing executable every session launches. */
  private chromePath: string | null = null;
  private ready: Promise<string> | null = null;
  private failure: { reason: string; at: number } | null = null;
  private closed = false;
  /** `<runner home>/browser/chromes.json`: the Chromes this runner home started (pid and profile). */
  private readonly pidFile: string;
  /** Writes to the pid file, one at a time. */
  private pidWrites: Promise<unknown> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: BrowserManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? BROWSER_IDLE_MS;
    this.maxSessions = opts.maxSessions ?? defaultMaxSessions();
    this.userHome = opts.userHome ?? os.homedir();
    // Daemons of this runner home only (another organization's runner on this computer has its own).
    this.namespace = `agentes-${createHash("sha256").update(opts.home).digest("hex").slice(0, 8)}`;
    this.configFile = path.join(opts.home, "browser", "config.json");
    this.pidFile = path.join(opts.home, "browser", "chromes.json");
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

  /** Chrome for Testing to drive: found, or installed once (`agent-browser install`). */
  private async ensureChrome(command: string[]) {
    const find = this.opts.chrome ?? (() => findChrome(this.userHome));
    this.chromePath = find();
    if (this.chromePath) return;
    this.opts.log("installing Chrome for Testing for the agent browser");
    const out = await this.spawn(command, ["install"], { timeoutMs: INSTALL_TIMEOUT_MS, cwd: this.opts.home });
    this.chromePath = find();
    if (this.chromePath) return;
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
    const allowed = allowedDomainsOf(req.allowedDomains);
    const prepared = this.checkCommand(req.command, req.args, req.timeoutSeconds, folder, allowed);
    const session = await this.session(agent, folder);
    return this.enqueue(session, () => this.perform(agent, session, prepared, allowed, req.link, signal));
  }

  /**
   * `browser.batch` (protocol 17): several commands in one round trip, back to
   * back in the agent's session (nothing else runs in between), each checked
   * as `browser.act` checks it. Any command that wouldn't pass refuses the
   * whole batch before anything runs; a failure stops it unless that command
   * tolerates failing.
   */
  async batch(agent: AgentScope, folder: string, req: BatchRequest, signal?: AbortSignal) {
    const list = Array.isArray(req.commands) ? req.commands : [];
    if (list.length === 0 || list.length > BROWSER_LIMITS.batchCommands) {
      throw new RunnerError("bad_request", `A batch takes 1 to ${BROWSER_LIMITS.batchCommands} commands`);
    }
    const allowed = allowedDomainsOf(req.allowedDomains);
    const prepared = list.map((c) => ({
      ...this.checkCommand(c?.command, c?.args, c?.timeoutSeconds, folder, allowed),
      tolerate: c?.tolerate === true,
    }));
    const session = await this.session(agent, folder);
    return this.enqueue(session, async (): Promise<MachineReplies["browser.batch"]> => {
      const answers: BrowserAnswer[] = [];
      for (const p of prepared) {
        if (signal?.aborted) break;
        let answer: BrowserAnswer;
        try {
          answer = await this.perform(agent, session, p, allowed, req.link, signal);
        } catch (err) {
          // Nothing ran yet: refused as a whole (its error code reaches the server).
          if (answers.length === 0) throw err;
          // Something already ran: its answers are kept; this command failed and the batch stops.
          answers.push({
            success: false,
            data: null,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
          });
          break;
        }
        answers.push(answer);
        if (!answer.success && !p.tolerate) break;
      }
      return { answers };
    });
  }

  /**
   * `browser.capture` (protocol 17): the page as a JPEG with its elements
   * numbered and boxed (`screenshot --annotate`), for a judge that sees
   * images. Only a page on the agent's allowed sites is captured. The file is
   * read and removed at once; one a timed-out capture left is removed later.
   */
  async capture(
    agent: AgentScope,
    folder: string,
    allowedDomains?: unknown,
    signal?: AbortSignal,
  ): Promise<MachineReplies["browser.capture"]> {
    const allowed = allowedDomainsOf(allowedDomains);
    const session = await this.session(agent, folder);
    return this.enqueue(session, async () => {
      if (!(await this.browserOpen(session, signal))) {
        throw new RunnerError("bad_request", "The browser isn't open: open a page first");
      }
      // Like every read: a page that moved off the allowed sites by itself isn't looked at.
      if (allowed.length > 0) {
        const left = await this.leftAllowedSites(session, allowed, signal);
        if (left) throw new RunnerError("not_allowed", left);
      }
      const dir = path.join(session.folder, ".agentes", "captures");
      await mkdir(dir, { recursive: true });
      // A screenshot whose command timed out may still be written after its capture ended: cleared here.
      for (const name of readdirSync(dir)) {
        const old = path.join(dir, name);
        try {
          if (this.now() - statSync(old).mtimeMs > CAPTURE_LEFTOVER_MS) await rm(old, { force: true });
        } catch {
          // gone already
        }
      }
      const file = path.join(dir, `${randomUUID()}.jpg`);
      try {
        const shot = await this.run(
          session,
          ["screenshot", file, "--annotate", "--screenshot-format", "jpeg", "--screenshot-quality", "70"],
          { timeoutMs: QUICK_TIMEOUT_MS, ...(signal ? { signal } : {}) },
        );
        if (!shot.success) throw new RunnerError("internal", (shot.error ?? "Couldn't take the picture").slice(0, 400));
        const bytes = await readFile(file);
        const size = jpegSize(bytes);
        if (!size) throw new RunnerError("internal", "The picture isn't a JPEG");
        const sized = await this.run(session, ["eval", "[innerWidth, innerHeight]"], {
          timeoutMs: QUICK_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
        const inner = isRecord(sized.data) && Array.isArray(sized.data.result) ? sized.data.result : [];
        const viewport =
          typeof inner[0] === "number" && typeof inner[1] === "number" && inner[0] > 0 && inner[1] > 0
            ? { width: Math.round(inner[0]), height: Math.round(inner[1]) }
            : size;
        const url = await this.pageUrl(session, signal);
        return {
          data: bytes.toString("base64"),
          width: size.width,
          height: size.height,
          viewport,
          marks: captureMarks(isRecord(shot.data) ? shot.data.annotations : null),
          ...(url ? { url } : {}),
        };
      } finally {
        await rm(file, { force: true }).catch(() => undefined);
      }
    });
  }

  /** One command checked before it runs: known, no flag the runner sets, paths in the folder, URLs allowed. */
  private checkCommand(
    rawCommand: unknown,
    rawArgs: unknown,
    timeoutSeconds: unknown,
    folder: string,
    allowed: string[],
  ): Prepared {
    const command = typeof rawCommand === "string" ? rawCommand : "";
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    if (!command || command.length > BROWSER_LIMITS.command) throw new RunnerError("bad_request", "Missing command");
    if (!args.every((a) => typeof a === "string") || JSON.stringify(args).length > BROWSER_LIMITS.args) {
      throw new RunnerError("bad_request", "args must be a short list of strings");
    }
    const timeoutMs = Math.max(1, Math.min(600, Number(timeoutSeconds) || 60)) * 1000;
    // Checked when it runs (the secret, the site, the field).
    if (command === "agentes:type_secret") return { command, args, timeoutMs };
    if (!COMMANDS.has(command)) throw new RunnerError("bad_request", `The browser doesn't take ${command}`);
    for (const a of args) {
      const flag = a.split("=")[0] as string;
      if (FORBIDDEN_FLAGS.has(flag)) throw new RunnerError("bad_request", `${flag} is set by the runner`);
    }
    return { command, args: this.checkArgs(command, args, folder, allowed), timeoutMs };
  }

  /** Runs one prepared command in the session's queue (the caller holds it). */
  private async perform(
    agent: AgentScope,
    session: Session,
    p: Prepared,
    allowed: string[],
    link: unknown,
    signal?: AbortSignal,
  ): Promise<BrowserAnswer> {
    const { command, args, timeoutMs } = p;
    if (command === "agentes:type_secret") {
      const answer = await this.typeSecret(agent, session, args, timeoutMs, signal);
      this.noteAct(session, command, [], answer, link);
      return answer;
    }
    // A screenshot or PDF into a folder that isn't there yet (`screenshots/…`): made first.
    if (FILE_OUTPUTS.has(command)) {
      for (const a of args) {
        if (path.isAbsolute(a) && isInside(session.folder, a)) await mkdir(path.dirname(a), { recursive: true });
      }
    }
    if (command === "close") {
      // The agent closes its browser: the daemon lets go of it, then its Chrome stops (the profile stays).
      const answer: BrowserAnswer = session.chrome
        ? await this.run(session, ["close"], { timeoutMs: QUICK_TIMEOUT_MS })
        : { success: true, data: { closed: true } };
      await this.stopChrome(session);
      session.aliveAt = null;
      this.noteAct(session, command, args, answer, link);
      return answer;
    }
    if (!READS.has(command)) await this.ensureOwnChrome(session, command === "open");
    if (READS.has(command)) {
      if (!(await this.browserOpen(session, signal))) {
        return { success: false, data: null, error: "The browser isn't open: open a page first" };
      }
      // A page can move off the allowed sites by itself (a script redirect): checked before it is read.
      if (allowed.length > 0) {
        const left = await this.leftAllowedSites(session, allowed, signal);
        if (left) return { success: false, data: null, error: left };
      }
    }
    const answer = await this.run(session, [command, ...args], { timeoutMs, signal });
    // Up when it just answered (the next read skips the check); unknown after an error.
    session.aliveAt = answer.success ? this.now() : null;
    this.noteAct(session, command, args, answer, link);
    // After anything that may move the page (a click, a tab switch, a new tab…): still on an allowed site?
    if (allowed.length > 0 && !READS.has(command)) {
      const left = await this.leftAllowedSites(session, allowed, signal);
      if (left) return { success: false, data: null, error: left };
    }
    return answer;
  }

  /** Paths stay in the agent's folder; URLs go only to allowed sites. Returns the args to run. */
  private checkArgs(command: string, args: string[], folder: string, allowed: string[]): string[] {
    const positional = args.filter((a) => !a.startsWith("-"));
    if (NAVIGATIONS.has(command) && positional[0]) {
      const url = asUrl(positional[0]);
      if (!isWebPage(url))
        throw new RunnerError("not_allowed", "The agent browser only opens web pages (http or https)");
      if (!domainAllowed(url, allowed)) {
        throw new RunnerError("not_allowed", `${hostOf(url)} is outside the sites this agent may use`);
      }
    }
    if (command === "tab" && positional[0] === "new" && positional[1]) {
      const url = asUrl(positional[1]);
      if (!isWebPage(url))
        throw new RunnerError("not_allowed", "The agent browser only opens web pages (http or https)");
      if (!domainAllowed(url, allowed)) {
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
    for (const [id, s] of this.sessions) {
      if (live.includes(s)) continue;
      this.sessions.delete(id);
      void this.stopChrome(s);
    }
    await this.ensureReady();
    await mkdir(path.join(folder, ".agentes", "browser"), { recursive: true });
    // Where screenshots and downloads land: there before the first one (the browser doesn't make them).
    await mkdir(path.join(folder, "screenshots"), { recursive: true });
    await mkdir(path.join(folder, "downloads"), { recursive: true });
    await mkdir(path.dirname(this.configFile), { recursive: true, mode: 0o700 });
    if (!existsSync(this.configFile)) await writeFile(this.configFile, "{}\n", { mode: 0o600 });
    const session: Session = {
      agentId,
      name: `agent-${agentFolderName(agent).suffix.slice(1)}`,
      folder,
      queue: Promise.resolve(),
      lastUsed: this.now(),
      aliveAt: null,
    };
    this.sessions.set(agentId, session);
    this.sweepTimer ??= setInterval(() => void this.sweep(), SWEEP_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
    return session;
  }

  /**
   * The agent's Chrome, started when it isn't running: Chrome for Testing with
   * our flags and the agent's profile; its pid goes in `chromes.json`. While
   * the agent's desktop runs, in a window there (ADR 0056 §7). A headless one
   * moves to a desktop that started since on the agent's next `open`
   * (`opening`), unless a person watches it or a request holds it: a new
   * Chrome loses the open tabs (the profile, and its logins, stay).
   */
  private async ensureOwnChrome(session: Session, opening = false): Promise<OwnChrome> {
    const screen = this.opts.desktops?.running(session.agentId) ?? null;
    const held = session.stream || session.streamOpening || this.handoffs.has(session.agentId);
    if (session.chrome && opening && screen && session.display !== screen.display && !held) {
      await this.run(session, ["close"], { timeoutMs: QUICK_TIMEOUT_MS });
      await this.stopChrome(session);
    }
    if (session.chrome) return session.chrome;
    if (session.chromeStarting) return session.chromeStarting;
    const profile = path.join(session.folder, ".agentes", "browser");
    const starting = (async () => {
      const exe = this.chromePath ?? (this.opts.chrome ?? (() => findChrome(this.userHome)))();
      if (!exe) throw new RunnerError("browser_unavailable", "No browser is installed for the agent yet");
      const start = this.opts.startChrome ?? launchChrome;
      // A runner started inside the person's own session must not put the agent's window there (Wayland, its bus).
      const { WAYLAND_DISPLAY: _wayland, DBUS_SESSION_BUS_ADDRESS: _bus, ...own } = process.env;
      const env = screen ? { ...own, DISPLAY: `:${screen.display}`, XAUTHORITY: screen.xauthority } : undefined;
      let chrome: OwnChrome;
      try {
        chrome = await start(exe, chromeLaunchArgs(exe, profile, { headed: screen !== null }), profile, env);
      } catch (err) {
        throw new RunnerError(
          "internal",
          `Couldn't start the agent's browser: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
        );
      }
      session.chrome = chrome;
      session.display = screen?.display;
      session.aliveAt = null;
      await this.rememberChrome(chrome.pid, profile);
      void chrome.exited.then(() => {
        void this.forgetChrome(chrome.pid);
        if (session.chrome !== chrome) return;
        // It closed under us (a crash, the person quit it, its desktop stopped): the next command starts it again.
        session.chrome = undefined;
        session.display = undefined;
        session.aliveAt = null;
        this.changed();
      });
      return chrome;
    })();
    session.chromeStarting = starting;
    try {
      return await starting;
    } finally {
      if (session.chromeStarting === starting) session.chromeStarting = undefined;
    }
  }

  /** The agent's Chrome stops (the profile, and so its logins, stay). */
  private async stopChrome(session: Session) {
    const chrome = session.chrome ?? (await session.chromeStarting?.catch(() => undefined));
    session.chrome = undefined;
    session.display = undefined;
    session.aliveAt = null;
    if (!chrome) return;
    chrome.kill();
    await chrome.exited;
    await this.forgetChrome(chrome.pid);
  }

  /**
   * Idle browsers close: no command (or frame) for the idle time, nobody
   * watching, and no help request open for that agent. One kept open on its
   * desktop keeps the desktop up too.
   */
  async sweep() {
    for (const [agentId, s] of this.sessions) {
      if (s.stream || s.streamOpening || this.handoffs.has(agentId)) {
        if (s.display !== undefined) this.opts.desktops?.touch(agentId);
        continue;
      }
      if (this.now() - s.lastUsed < this.idleMs) continue;
      this.sessions.delete(agentId);
      this.changed();
      await this.enqueue(s, async () => {
        if (s.chrome) await this.run(s, ["close"], { timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
        await this.stopChrome(s);
      }).catch(() => undefined);
    }
  }

  private readPids(): Promise<{ pid: number; profile: string }[]> {
    return readFile(this.pidFile, "utf8")
      .then((text) => {
        const v = JSON.parse(text) as unknown;
        return Array.isArray(v)
          ? v.filter(
              (e): e is { pid: number; profile: string } =>
                isRecord(e) && Number.isInteger(e.pid) && typeof e.profile === "string",
            )
          : [];
      })
      .catch(() => []);
  }

  private writePids(change: (list: { pid: number; profile: string }[]) => { pid: number; profile: string }[]) {
    const write = this.pidWrites.then(async () => {
      const next = change(await this.readPids());
      await mkdir(path.dirname(this.pidFile), { recursive: true, mode: 0o700 });
      await writeFile(this.pidFile, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    });
    this.pidWrites = write.catch(() => undefined);
    return write.catch(() => undefined);
  }

  private rememberChrome(pid: number, profile: string) {
    return this.writePids((list) => [...list.filter((e) => e.pid !== pid), { pid, profile }]);
  }

  private forgetChrome(pid: number) {
    return this.writePids((list) => list.filter((e) => e.pid !== pid));
  }

  /** Whether a pid from `chromes.json` is still a Chrome on that profile (a pid can be reused). */
  private async isOurChrome(pid: number, profile: string): Promise<boolean> {
    if (this.opts.isOurChrome) return this.opts.isOurChrome(pid, profile);
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (process.platform === "win32") {
      const out = await this.spawn(["tasklist"], ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        timeoutMs: QUICK_TIMEOUT_MS,
        cwd: this.opts.home,
      });
      return /chrome\.exe/i.test(out.stdout);
    }
    const out = await this.spawn(["ps"], ["-p", String(pid), "-o", "command="], {
      timeoutMs: QUICK_TIMEOUT_MS,
      cwd: this.opts.home,
    });
    return out.stdout.includes(`--user-data-dir=${profile}`);
  }

  /** Chromes a previous run of this runner home left (it crashed or was killed): stopped. */
  private async killLeftovers() {
    const live = new Set([...this.sessions.values()].map((s) => s.chrome?.pid).filter((p) => p !== undefined));
    for (const { pid, profile } of await this.readPids()) {
      if (live.has(pid)) continue;
      if (await this.isOurChrome(pid, profile).catch(() => false)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // gone
        }
        await new Promise((r) => setTimeout(r, 500));
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
        } catch {
          // gone
        }
      }
      await this.forgetChrome(pid);
    }
  }

  private enqueue<T>(session: Session, fn: () => Promise<T>): Promise<T> {
    const run = session.queue.catch(() => undefined).then(fn);
    session.queue = run.catch(() => undefined);
    return run;
  }

  /** Flags the runner sets on every command of a session: it connects to the agent's running Chrome. */
  private sessionFlags(session: Session, chrome: OwnChrome): string[] {
    return [
      "--cdp",
      String(chrome.port),
      "--namespace",
      this.namespace,
      "--session",
      session.name,
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
    if (session.display !== undefined) this.opts.desktops?.touch(session.agentId);
    // Never without our Chrome: `agent-browser` would launch its own, with the automation markers.
    const chrome = session.chrome;
    if (!chrome) return { success: false, data: null, error: "The browser isn't open: open a page first" };
    const out = await this.spawn(command, [...this.sessionFlags(session, chrome), ...args], {
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

  /**
   * Whether the session's Chrome is up and reachable (`stream status` never
   * launches one). No Chrome of ours running: not open. The reachability check
   * is skipped when the last command just succeeded.
   */
  private async browserOpen(session: Session, signal?: AbortSignal): Promise<boolean> {
    if (!session.chrome) return false;
    if (session.aliveAt !== null && this.now() - session.aliveAt < this.idleMs - ALIVE_MARGIN_MS) return true;
    const status = await this.run(session, ["stream", "status"], {
      timeoutMs: QUICK_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const open = status.success && isRecord(status.data) && status.data.connected === true;
    session.aliveAt = open ? this.now() : null;
    return open;
  }

  /** The active tab's address, or null when the browser can't say. */
  private async pageUrl(session: Session, signal?: AbortSignal): Promise<string | null> {
    const got = await this.run(session, ["get", "url"], {
      timeoutMs: QUICK_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return isRecord(got.data) && typeof got.data.url === "string" ? got.data.url : null;
  }

  /**
   * The active page left the allowed sites → it goes back, and when going back
   * doesn't help (a new tab has no history, a redirect loops) the tab goes to
   * the blank page, so nothing outside the list stays open to read. Returns
   * what to tell the agent (null when the page is still inside).
   */
  private async leftAllowedSites(session: Session, allowed: string[], signal?: AbortSignal): Promise<string | null> {
    const url = await this.pageUrl(session, signal);
    if (!url || domainAllowed(url, allowed)) return null;
    await this.run(session, ["back"], { timeoutMs: QUICK_TIMEOUT_MS });
    const after = await this.pageUrl(session);
    if (after && domainAllowed(after, allowed)) {
      return `The page went to ${hostOf(url)}, outside the sites this agent may use; it went back`;
    }
    await this.run(session, ["open", "about:blank"], { timeoutMs: QUICK_TIMEOUT_MS });
    return `The page went to ${hostOf(url)}, outside the sites this agent may use; that tab is now blank`;
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
    const [rawRef, name, rawSite] = args;
    const ref = typeof rawRef === "string" && /^@?e\d{1,6}$/.test(rawRef) ? `@${rawRef.replace(/^@/, "")}` : null;
    if (!ref || typeof name !== "string" || !SECRET_NAME.test(name)) {
      throw new RunnerError("bad_request", "agentes:type_secret takes a ref (@e3) and a secret name (DB_PASSWORD)");
    }
    // The one site the secret was asked for (the person saw it): never typed anywhere else.
    const site = typeof rawSite === "string" ? originOf(rawSite) : null;
    if (!site) {
      throw new RunnerError("bad_request", "agentes:type_secret needs the site the secret is for (https://host)");
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
    const at = await this.pageUrl(session, signal);
    if (!at || originOf(at) !== site) {
      return {
        success: false,
        data: null,
        error: `${name} is only for ${new URL(site).host}, and the page is on ${at ? hostOf(at) : "no site"}; it wasn't typed`,
      };
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
    this.changed();
    await this.enqueue(session, async () => {
      if (session.chrome) await this.run(session, ["close"], { timeoutMs: QUICK_TIMEOUT_MS });
      await this.stopChrome(session);
    }).catch(() => undefined);
    return { stopped: true };
  }

  // ── For the desktop app ────────────────────────────────────────────────────

  /** What the last command tells the app: what the agent did, the page's host, the conversation. */
  private noteAct(session: Session, command: string, args: string[], answer: BrowserAnswer, link?: unknown) {
    if (isLink(link)) session.link = link;
    const doing = DOING[command];
    if (doing) session.doing = doing;
    session.actedAt = this.now();
    const url =
      answer.success && isRecord(answer.data) && typeof answer.data.url === "string"
        ? answer.data.url
        : command === "open" && answer.success
          ? args[0]
          : undefined;
    const host = url ? pageHost(url) : null;
    if (host) session.host = host;
    this.changed();
  }

  /** `browser.handoff` from the server: a request waiting, a person in control, or none (null). */
  setHandoff(agentId: string, handoff: BrowserHandoffInfo | null) {
    if (handoff && (handoff.status === "pending" || handoff.status === "active")) {
      this.handoffs.set(agentId, {
        status: handoff.status,
        ...(typeof handoff.controller === "string" ? { controller: handoff.controller.slice(0, 120) } : {}),
        ...(typeof handoff.request === "string" ? { request: handoff.request.slice(0, 300) } : {}),
        ...(isLink(handoff.link) ? { link: handoff.link } : {}),
      });
    } else this.handoffs.delete(agentId);
    this.changed();
  }

  /** The server connection dropped: what it told about handoffs is stale (it says again on reconnect). */
  clearHandoffs() {
    if (this.handoffs.size === 0) return;
    this.handoffs.clear();
    this.changed();
  }

  /**
   * The agents' browsers the tray shows: open ones (answered within the idle
   * window, or being watched) and any with a person's turn, sorted by agent.
   */
  states(): ControlBrowser[] {
    const ids = new Set([...this.sessions.keys(), ...this.handoffs.keys()]);
    const out: ControlBrowser[] = [];
    for (const agentId of [...ids].sort()) {
      const s = this.sessions.get(agentId);
      const handoff = this.handoffs.get(agentId);
      const open = !!s && (!!s.stream || (s.aliveAt !== null && this.now() - s.lastUsed < this.idleMs));
      if (!open && !handoff) continue;
      const host = (s?.stream?.url && pageHost(s.stream.url)) || s?.host;
      out.push({
        agentId,
        open,
        ...(host ? { host } : {}),
        ...(s?.doing ? { doing: s.doing } : {}),
        ...(s?.actedAt ? { actedAt: new Date(s.actedAt).toISOString() } : {}),
        ...(s?.stream ? { mode: s.stream.mode } : {}),
        ...(handoff ? { handoff: { ...handoff } } : {}),
        ...(s?.link ? { link: s.link } : {}),
      });
    }
    return out;
  }

  private changed() {
    this.opts.onChange?.();
  }

  /** Every browser of this runner home closes (the switch went off, the runner stops, or it just started). */
  async closeAll() {
    const sessions = [...this.sessions.values()];
    for (const s of sessions) this.endStream(s, "closed");
    this.sessions.clear();
    this.changed();
    const command = this.presentCommand();
    if (command) {
      // The daemons let go first (and any Chrome an older runner had `agent-browser` launch closes).
      await this.spawn(command, ["--namespace", this.namespace, "--json", "close", "--all"], {
        timeoutMs: QUICK_TIMEOUT_MS,
        cwd: this.opts.home,
      }).catch(() => undefined);
    }
    await Promise.all(sessions.map((s) => this.stopChrome(s).catch(() => undefined)));
    await this.killLeftovers().catch(() => undefined);
  }

  /** The runner stops: streams end, browsers close, nothing new starts. */
  async close() {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.closeAll();
  }

  // ── Live view ──────────────────────────────────────────────────────────────

  /** `browser.stream.start`: relays the session's frames until `stop` (or changes the mode). */
  async streamStart(agent: AgentScope, mode: BrowserStreamMode): Promise<MachineReplies["browser.stream.start"]> {
    if (mode !== "watch" && mode !== "control") throw new RunnerError("bad_request", "mode must be watch or control");
    const session = this.sessions.get(String(agent.id ?? ""));
    if (!session) throw new RunnerError("browser_closed", "The agent's browser isn't open");
    session.lastUsed = this.now();
    // One socket per session: a start while another opens waits for it, then only changes the mode.
    while (session.streamOpening) await session.streamOpening.catch(() => undefined);
    if (session.stream) {
      if (session.stream.mode !== mode) {
        session.stream.mode = mode;
        session.stream.socket.send(JSON.stringify({ type: "config", maxFps: STREAM_FPS[mode] }));
        this.changed();
      }
      return { mode };
    }
    const opening = this.openStream(session, mode);
    session.streamOpening = opening;
    try {
      await opening;
    } finally {
      if (session.streamOpening === opening) session.streamOpening = undefined;
    }
    return { mode };
  }

  private async openStream(session: Session, mode: BrowserStreamMode): Promise<void> {
    const port = await this.enqueue(session, async () => {
      if (!session.chrome) return null;
      let status = await this.run(session, ["stream", "status"], { timeoutMs: QUICK_TIMEOUT_MS });
      if (isRecord(status.data) && status.data.connected !== true) return null;
      if (!isRecord(status.data) || status.data.enabled !== true) {
        await this.run(session, ["stream", "enable"], { timeoutMs: QUICK_TIMEOUT_MS });
        status = await this.run(session, ["stream", "status"], { timeoutMs: QUICK_TIMEOUT_MS });
      }
      return isRecord(status.data) && typeof status.data.port === "number" ? status.data.port : null;
    });
    if (port === null) throw new RunnerError("browser_closed", "The agent's browser isn't open");
    const url = `ws://127.0.0.1:${port}/?maxFps=${STREAM_FPS[mode]}`;
    const socket = (this.opts.connectStream ?? ((u: string) => new WebSocket(u) as unknown as StreamSocket))(url);
    const stream: Stream = {
      socket,
      port,
      mode,
      input: { held: new Set() },
      inputQueue: Promise.resolve(),
      closing: false,
    };
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
    // Never two sockets: one left over (it shouldn't be) is closed quietly.
    const old = session.stream;
    if (old) {
      old.closing = true;
      try {
        old.socket.close();
      } catch {
        // already closed
      }
    }
    session.stream = stream;
    this.changed();
    socket.onmessage = (event) => this.onStreamMessage(session, stream, event.data);
    void this.firstFrame(session, stream);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (session.stream !== stream) return;
      session.stream = undefined;
      this.changed();
      if (!stream.closing) {
        // The browser closed under the stream: the next read checks again.
        session.aliveAt = null;
        this.opts.send({ type: "browser.stream.ended", agentId: session.agentId, reason: "closed" });
      }
    };
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
    const setUrl = (raw: string) => {
      const url = raw.slice(0, BROWSER_LIMITS.url);
      if (url === stream.url) return;
      const before = stream.url ? pageHost(stream.url) : null;
      stream.url = url;
      // Another page: its title comes with the next tab list.
      stream.title = undefined;
      if (pageHost(url) !== before) this.changed();
    };
    if (msg.type === "url" && typeof msg.url === "string") {
      setUrl(msg.url);
      return;
    }
    // Sent on connect and after every command: the active tab's address and title.
    if (msg.type === "tabs" && Array.isArray(msg.tabs)) {
      const active = msg.tabs.find((t) => isRecord(t) && t.active === true);
      if (isRecord(active) && typeof active.url === "string") {
        setUrl(active.url);
        if (typeof active.title === "string" && active.title) {
          stream.title = active.title.slice(0, BROWSER_LIMITS.title);
        }
      }
      return;
    }
    if (msg.type === "status") {
      const width = Number(msg.viewportWidth);
      const height = Number(msg.viewportHeight);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        stream.viewport = { width, height };
      }
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
    stream.framed = true;
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
        ...pageMeta(stream),
      },
    });
  }

  /**
   * Chrome doesn't reliably send a screencast frame for a page that isn't
   * repainting (`agent-browser` seeds its own recordings for that reason), and
   * its stream only replays a frame it already has: an idle page would show
   * nothing. A stream still without a frame after `FIRST_FRAME_MS` sends one
   * screenshot as its first (in the session's queue, after the agent's command).
   */
  private async firstFrame(session: Session, stream: Stream) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.opts.firstFrameMs ?? FIRST_FRAME_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const waiting = () => session.stream === stream && !stream.framed && !this.closed && !!stream.viewport;
    if (!waiting()) return;
    const file = path.join(this.opts.home, "browser", `${session.name}-frame.jpg`);
    await this.enqueue(session, async () => {
      if (!waiting()) return;
      try {
        const shot = await this.run(
          session,
          ["screenshot", file, "--screenshot-format", "jpeg", "--screenshot-quality", "70"],
          { timeoutMs: QUICK_TIMEOUT_MS },
        );
        const data = shot.success ? (await readFile(file)).toString("base64") : "";
        const size = stream.viewport;
        if (!data || data.length > BROWSER_LIMITS.frameBytes || !size || !waiting()) return;
        this.opts.send({
          type: "browser.frame",
          agentId: session.agentId,
          seq: 0,
          data,
          metadata: { deviceWidth: size.width, deviceHeight: size.height, ...pageMeta(stream) },
        });
      } finally {
        await rm(file, { force: true }).catch(() => undefined);
      }
    }).catch(() => undefined);
  }

  /** `browser.stream.stop` (after a stream still opening, so it doesn't outlive the stop). */
  async streamStop(agent: AgentScope): Promise<MachineReplies["browser.stream.stop"]> {
    const session = this.sessions.get(String(agent.id ?? ""));
    while (session?.streamOpening) await session.streamOpening.catch(() => undefined);
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
    this.changed();
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
    this.changed();
  }

  /**
   * `browser.input`: a person's input during a take over, in order, through
   * the daemon's command relay (the active tab, each one confirmed before the
   * next). The stream socket only carries frames.
   */
  async input(agent: AgentScope, events: unknown[]): Promise<MachineReplies["browser.input"]> {
    const session = this.sessions.get(String(agent.id ?? ""));
    const stream = session?.stream;
    if (!session || !stream) throw new RunnerError("bad_request", "Nobody is viewing this agent's browser");
    if (!Array.isArray(events) || events.length > BROWSER_LIMITS.inputEvents) {
      throw new RunnerError("bad_request", `At most ${BROWSER_LIMITS.inputEvents} events at once`);
    }
    session.lastUsed = this.now();
    const parsed = events.map((raw) => parseBrowserInputEvent(raw)).filter((e) => e !== null);
    const run = stream.inputQueue.then(async () => {
      let accepted = 0;
      let failed = 0;
      for (const e of parsed) {
        // The stream ended (the browser closed under it): nothing is sent to a browser that isn't there.
        if (session.stream !== stream) {
          failed += 1;
          continue;
        }
        let ok = true;
        for (const command of relayCommands(e, stream.input)) {
          if (!(await this.relay(stream.port, command))) ok = false;
        }
        if (ok) accepted += 1;
        else failed += 1;
      }
      return failed > 0 ? { accepted, failed } : { accepted };
    });
    stream.inputQueue = run.catch(() => undefined);
    return run;
  }

  /** One command on the daemon's relay (`POST /api/command` on the stream port); true when it ran. */
  private async relay(port: number, command: Record<string, unknown>): Promise<boolean> {
    const origin = `http://127.0.0.1:${port}`;
    try {
      const res = await (this.opts.fetch ?? fetch)(`${origin}/api/command`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(INPUT_TIMEOUT_MS),
        // The relay only takes a same-origin request.
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ id: randomUUID(), ...command }),
      });
      const body = (await res.json().catch(() => null)) as unknown;
      return res.ok && isRecord(body) && body.success !== false && !body.error;
    } catch {
      // Timed out (the command may still be queued in the daemon) or the port closed.
      return false;
    }
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
