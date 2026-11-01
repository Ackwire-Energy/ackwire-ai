import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_BROWSER_PROFILE } from "@agenteschat/adapters/command-policy";
import { cgroupCounters } from "@agenteschat/adapters/host-stats";
import {
  AGENT_BROWSER_SHA256,
  AGENT_BROWSER_VERSION,
  type AgentBrowserTarget,
  type AgentScope,
  agentBrowserUrl,
  BROWSER_LIMITS,
  type BrowserHandoffInfo,
  type BrowserInputEvent,
  type BrowserSetup,
  type BrowserStreamMode,
  type MachineReplies,
  type MachineRequest,
  parseBrowserInputEvent,
  type RunnerBrowserInfo,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import type { ControlBrowser, ControlBrowserDoing } from "@agenteschat/adapters/runner-control";
import { SECRET_NAME } from "@agenteschat/adapters/secret-box";
import type { BrowserPorts } from "./browser-ports";
import { type CrashedPage, countChromeTraffic, type TrafficCounter } from "./browser-traffic";
import { BROWSER_WM_CLASS } from "./desktop-look";
import type { DesktopSessions } from "./desktop-session";
import { RunnerError } from "./errors";
import { SYSTEM_BROWSER_DIR } from "./install-script";
import { readJson, writeJson } from "./json-file";
import { acquireLock } from "./lock";
import { agentFolderName, isInside, ownedSafely } from "./paths";
import type { Spawn } from "./scope-gate";

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
 * - Binary: the desktop app's sidecar next to the runner, else the shared
 *   install's (`SYSTEM_BROWSER_DIR`, which `install.sh --system` fills and
 *   only root can change), else a download of the pinned release into
 *   `<runner home>/bin/`, checked against its SHA-256 before it is ever run.
 * - Chrome: always Chrome for Testing, the newest of the shared install's and
 *   the one `agent-browser install` puts in the user's home (run when there is
 *   neither); never the person's own Chrome or Brave: their updater rewrites
 *   the app while we hold it open, and macOS then blames our app ("agentes was
 *   prevented from modifying apps"). A runner outside system mode gets what it
 *   lacks of them as it starts, once the browser is on (`prepareInBackground`).
 * - Ready ahead (`warm`, ADR 0040 §11): the agent's Chrome starts before its
 *   first command, as that command would start it, and each command says what
 *   it waited on before it ran (`setup`).
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
 * - On the agent's desktop (ADR 0058 §7, a request's `desktop`): the same
 *   Chrome runs headed on that display, so people watching the desktop see it;
 *   the desktop starts first. A Chrome in the other mode moves at the next
 *   command that may start one (same profile, same page), never while someone
 *   watches it or a person's turn is open. While it is in use there, its
 *   desktop doesn't stop as idle; while its desktop is watched, it is in use.
 *   In system mode this runs in the agent's worker, as the agent's own user,
 *   on the desktop root starts for it (`WorkerLink.desktop`).
 * - Browser on the agent's desktop (`desktop-browser.ts`, `show`): a person's
 *   click brings that same Chrome there, started, moved or in front, and is
 *   answered once its window shows there.
 * - A page that dies (its renderer crashed or ran out of memory: Chrome's sad
 *   tab) is opened again at once, and the agent's next action is answered
 *   with what happened instead of running on a page that changed under it
 *   (looks and waits run, on the page as it is now). One that dies again
 *   before the agent heard of it shows our own notice there, once, never a
 *   reload loop (`pageCrashed`).
 */

/** A session with no command for this long is closed (its Chrome stops; the profile stays). */
export const BROWSER_IDLE_MS = 15 * 60_000;
/** How often idle browsers are looked for. */
const SWEEP_MS = 60_000;
/** A Chrome that hasn't opened its debugging port by then is given up. */
const CHROME_START_MS = 20_000;
/** A Chrome started for Browser on its desktop whose window hasn't shown by then, once its port opened, is given up. */
const WINDOW_MS = 20_000;
/**
 * How long Chrome takes to draw a window it just showed, at most, on a small computer: Browser's click is answered
 * after it, so the note the launcher shows meanwhile closes under Chrome's window rather than before it.
 */
const WINDOW_DRAW_MS = 500;
/** A Chrome asked to quit that is still there after this is killed. */
const CHROME_KILL_MS = 3000;
/** How long a Chrome gets to close itself (`Browser.close`; it takes a tenth of a second) before it is signaled. */
const CHROME_QUIT_MS = 2000;
/** Memory one live browser takes, roughly (the per-machine cap). */
const SESSION_BYTES = 300 * 1024 * 1024;
/** Frames a second per stream mode. */
export const STREAM_FPS: Record<BrowserStreamMode, number> = { watch: 1, control: 15 };
/** Characters of page output (snapshots, text) one command returns at most. */
const MAX_OUTPUT_CHARS = 50_000;
/** Bytes of stdout read from one command (a full-page screenshot as JSON stays well under). */
const MAX_STDOUT = 8 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** How often a runner waiting on another one's Chrome install looks again. */
const INSTALL_TURN_POLL_MS = 1000;
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
/** After the agent's desktop failed to start, its browser stays headless this long before trying again. */
const DESKTOP_RETRY_MS = 5 * 60_000;
/** A new Chrome's first command waits this long at most for its traffic counter to attach. */
const TRAFFIC_ATTACH_MS = 1000;

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
/**
 * A command that acts on the page: what a page that died since refuses, or what it died under. A look or a wait
 * acts on nothing, and a tolerated command's failure is one the server ignores, as it ignores a look's or a wait's
 * (the settling after an action, the server's own looks): an answer there would be lost.
 */
const actsOnPage = (p: Prepared) => !p.tolerate && !READS.has(p.command) && p.command !== "wait";
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

/** An answer's `setup`, only when something was timed. */
const withSetup = (setup: BrowserSetup) => (Object.keys(setup).length > 0 ? { setup } : {});

/** For the runner's log: `worker 1.2 s, install 28.1 s, launch 1.4 s`. */
export function browserSetupText(setup: BrowserSetup): string {
  return Object.entries(setup)
    .map(([step, ms]) => `${step} ${(ms / 1000).toFixed(1)} s`)
    .join(", ");
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

/** The counters in the agent's `memory.events` that rise when it runs out of memory (`max`: it reached its limit). */
const OUT_OF_MEMORY = ["max", "oom", "oom_kill"];

/** How a tab's page died (`pageCrashed`): `again` before the agent heard of the first time, so it wasn't reloaded. */
export interface PageCrash {
  memory: boolean;
  again: boolean;
}

/**
 * What the agent is told about its page dying, as the answer to the command it died under (`ran`) or to the next
 * one, which didn't run.
 */
export function crashNotice({ memory, again }: PageCrash, ran: boolean): string {
  const what = memory ? "ran out of memory" : "crashed";
  if (again) return `The page ${what} again, so it wasn't reloaded a second time. Open it again only if you need it.`;
  return ran
    ? `The page ${what} while this ran, and was reloaded. Read it again before you go on.`
    : `The page ${what} and was reloaded, so this wasn't done. Read it again before you go on.`;
}

/** Our look (the app's tokens), in place of Chrome's sad tab. */
const CRASH_STYLE = [
  "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfbfa;color:#151514;",
  'font:15px/1.45 Onest,"Segoe UI",system-ui,sans-serif}',
  "main{max-width:400px;margin:16px;padding:24px;background:#fff;border-radius:14px;",
  "box-shadow:0 1px 1px rgba(23,23,22,.04),0 6px 16px -4px rgba(23,23,22,.1),0 0 0 1px rgba(23,23,22,.07)}",
  "h1{margin:0;font-size:17px;font-weight:600}p{margin:4px 0 0;color:#5c5c58}p+h1{margin-top:16px}",
].join("");

/** The page a tab that died again shows to the people watching: both languages, since the runner can't tell whose. */
export function crashPage(memory: boolean): string {
  const [pt, en] = memory
    ? ["A página ficou sem memória", "The page ran out of memory"]
    : ["A página parou de funcionar", "The page stopped working"];
  const html =
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${pt}</title><style>${CRASH_STYLE}</style>` +
    `</head><body><main><h1>${pt}</h1><p>O agente será avisado.</p>` +
    `<h1 lang="en">${en}</h1><p lang="en">The agent will be told.</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
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
 * The newest Chrome for Testing in the shared install (`shared`) and where
 * `agent-browser install` puts it under the home, by version, as its
 * executable; the shared one when both have that version; null when there is
 * none. The person's own Chrome is never used (see the top of this file).
 */
export function findChrome(
  home: string = os.homedir(),
  platform: string = process.platform,
  shared: string | null = null,
): string | null {
  const found: { version: string; exe: string }[] = [];
  for (const root of [...(shared ? [shared] : []), testingChromeDir(home)]) {
    let entries: string[];
    try {
      entries = readdirSync(root).filter((e) => e.startsWith("chrome-"));
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = path.join(root, e);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const exe = testingChromeBinaries(dir, platform).find((b) => existsSync(b));
      if (exe) found.push({ version: e.slice("chrome-".length), exe });
    }
  }
  // Stable: of two with one version, the shared one (listed first) stays first.
  found.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
  return found[0]?.exe ?? null;
}

/**
 * Chrome flags on every launch: no first-run screens, nothing updating
 * Chrome's files in the background, and none of the automation markers a
 * launched-for-automation Chrome carries (no `--enable-automation`). Pages
 * see `prefers-reduced-motion: reduce`, so an animated page holds still: one
 * kept two of a 4-core computer's cores busy whether anyone watched or not,
 * and sent its desktop's viewers a stream of changes. The chip asking to sign
 * in to the browser, a feature of Chrome 147 (at least) to 155, stays off;
 * later versions read the profile's own switch (`prepareProfile`). The sites'
 * sessions outlive Chrome stopping (idle, or moving to or from the agent's
 * desktop), as with Chrome's "Continue where you left off": a site that keeps
 * you signed in only until the browser closes (no "remember me") still has
 * its cookies when Chrome starts again. Measured 2026-10-31 on Chrome for
 * Testing 155: without `--restore-last-session` those cookies were dropped at
 * the next start; with it they stayed, and so did the last session's tabs,
 * which `forgetTabs` removes before each start.
 */
export const CHROME_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-component-update",
  "--force-prefers-reduced-motion",
  "--disable-features=SigninPromoOnAvatarPill",
  "--restore-last-session",
];
const HEADLESS_ARGS = ["--headless=new", "--window-size=1280,800"];
/**
 * On the agent's desktop: maximized; X11 even when the runner itself runs in a
 * Wayland session. A headed Chrome shows a bar about the automation flag above
 * and, Chrome for Testing, one saying it is only for automated testing: each
 * takes the page's height and people see it. `--test-type` hides the first;
 * its value `gpu` is what hides the second. Its windows' class is the dock's
 * Browser's (`StartupWMClass`), so the dock shows them there.
 */
const HEADED_ARGS = ["--start-maximized", "--test-type=gpu", "--ozone-platform=x11", `--class=${BROWSER_WM_CLASS}`];

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
 * The whole command line for the agent's Chrome: our flags, headless or headed
 * (on its desktop), its own port (0: Chrome picks), its profile, the page it opens.
 */
export function chromeLaunchArgs(
  exe: string,
  profile: string,
  platform: string = process.platform,
  lang: string | null = osLang(),
  headed = false,
  page = "about:blank",
  debuggingPort = 0,
): string[] {
  const ua = chromeUserAgent(exe, platform);
  return [
    ...CHROME_ARGS,
    ...(headed ? HEADED_ARGS : HEADLESS_ARGS),
    ...secretStoreArgs(platform),
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`,
    ...(ua ? [`--user-agent=${ua}`] : []),
    ...(lang ? [`--lang=${lang}`] : []),
    page,
  ];
}

/** Where a headed Chrome draws: the agent's desktop. */
export interface ChromeDisplay {
  display: number;
  xauthority: string;
}

/**
 * A headed Chrome's environment: the runner's, on the agent's display. Without
 * the runner's own Wayland display and session bus, so nothing Chrome opens
 * (a file picker, a mail link, a notification) lands on the screen of the
 * person who runs the runner.
 */
export function chromeEnv(on: ChromeDisplay, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && k !== "WAYLAND_DISPLAY" && k !== "DBUS_SESSION_BUS_ADDRESS") env[k] = v;
  }
  return { ...env, DISPLAY: `:${on.display}`, XAUTHORITY: on.xauthority };
}

/**
 * Before a headed start, in the agent's profile:
 * - Chrome draws its own frame. By itself it does only when a window manager
 *   already runs as it starts, and a desktop that just started gets its window
 *   manager a moment later: Chrome would then take that one's title bar, and a
 *   shorter page.
 * - Signing in to Chrome itself is off (its "Allow Chrome sign-in", which it
 *   reads as it starts): no chip or bubble asks a person to sign in to the
 *   browser. Signing in to sites stays as it is: people sign the agent in to
 *   them on purpose.
 * A Preferences file that isn't JSON is Chrome's to deal with, and neither is
 * worth failing a start for.
 */
export function prepareProfile(profile: string) {
  const file = path.join(profile, "Default", "Preferences");
  try {
    const prefs = existsSync(file) ? readJson<unknown>(file) : {};
    if (!isRecord(prefs)) return;
    const browser = isRecord(prefs.browser) ? prefs.browser : {};
    const signin = isRecord(prefs.signin) ? prefs.signin : {};
    if (browser.custom_chrome_frame === true && signin.allowed_on_next_startup === false) return;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJson(file, {
      ...prefs,
      browser: { ...browser, custom_chrome_frame: true },
      signin: { ...signin, allowed_on_next_startup: false },
    });
  } catch {
    // Chrome starts with the settings it has.
  }
}

/**
 * Before every start: the tabs Chrome saved go (`--restore-last-session` would open them again beside the page it
 * starts on, more of them at each restart), so the agent's browser starts on one page, as it always did. Its
 * cookies stay.
 */
export function forgetTabs(profile: string) {
  return rm(path.join(profile, "Default", "Sessions"), { recursive: true, force: true }).catch(() => undefined);
}

/** A Chrome the runner started for one agent. */
export interface OwnChrome {
  pid: number;
  /** Its debugging port (`agent-browser --cdp`). */
  port: number;
  /** Its browser endpoint on that port (`/devtools/browser/<id>`), which its traffic is counted on. */
  wsPath?: string;
  /** Asks it to quit, then kills it if it lingers. */
  kill(): void;
  /** Settles when the process is gone. */
  exited: Promise<void>;
  /** Headed: the agent's display it draws on. */
  display?: number;
}

/**
 * Chrome didn't start. The message is for people; `detail` (what Chrome
 * printed meanwhile) is for the logs; `missing` lists the libraries this
 * computer lacks, when that is why.
 */
export class ChromeStartError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "ChromeStartError";
  }
}

/**
 * When Chrome's output says it exited for a library the dynamic loader
 * couldn't find: every library `ldd` finds missing (the loader stops at the
 * first), else the ones the loader named. Empty for any other exit.
 */
function missingLibraries(exe: string, output: string): string[] {
  const named = [...output.matchAll(/error while loading shared libraries: ([^:\s]+)/g)].map((m) => m[1] as string);
  if (named.length === 0) return [];
  const ldd = spawnSync("ldd", [exe], { encoding: "utf8", timeout: 5000 });
  const all = [...(ldd.stdout ?? "").matchAll(/^\s*(\S+) => not found$/gm)].map((m) => m[1] as string);
  return all.length > 0 ? all : named;
}

/** For people: the missing libraries, the first few by name when there are many. */
export function missingLibrariesText(missing: string[]): string {
  const names =
    missing.length > 6 ? `${missing.slice(0, 5).join(", ")} and ${missing.length - 5} more` : missing.join(", ");
  return `the agent's computer is missing system libraries Chrome needs (${names}). Install them on it, then try again.`;
}

/**
 * Starts Chrome and waits for its debugging port (Chrome writes it to
 * `<profile>/DevToolsActivePort` with `--remote-debugging-port=0`, its
 * browser endpoint on the next line).
 */
export async function launchChrome(
  exe: string,
  args: string[],
  profile: string,
  env?: Record<string, string>,
  start: Spawn = spawn,
  ownsPort: (port: number) => boolean = (port) => {
    const uid = process.getuid?.();
    if (uid === undefined) return false;
    const result = spawnSync("ss", ["-Htln", "-e"], { encoding: "utf8", timeout: 1000 });
    if (result.status !== 0) return false;
    const rows = (result.stdout ?? "").split("\n").filter((line) => {
      const cols = line.trim().split(/\s+/);
      const local = cols[3] ?? "";
      return (
        cols[0] === "LISTEN" &&
        (local.startsWith("127.0.0.1:") || local.startsWith("0.0.0.0:")) &&
        Number(local.slice(local.lastIndexOf(":") + 1)) === port
      );
    });
    return rows.length > 0 && rows.every((line) => Number(/\buid:(\d+)\b/.exec(line)?.[1]) === uid);
  },
): Promise<OwnChrome> {
  const portFile = path.join(profile, "DevToolsActivePort");
  const fixedPort = Number(args.find((arg) => arg.startsWith("--remote-debugging-port="))?.split("=")[1] ?? 0);
  if (!Number.isInteger(fixedPort) || fixedPort < 0 || fixedPort > 65_535) {
    throw new ChromeStartError("Invalid Chrome debugging port", "");
  }
  await rm(portFile, { force: true });
  const child = start(exe, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, ...(env ? { env } : {}) });
  let output = "";
  let started = false;
  // Read for as long as Chrome runs, since a full pipe would stall it; only what it says while starting is kept.
  child.stderr?.on("data", (chunk: Buffer) => {
    if (!started) output = (output + chunk.toString()).slice(-4000);
  });
  const outputClosed = new Promise<void>((resolve) => {
    if (child.stderr) child.stderr.once("close", () => resolve());
    else resolve();
  });
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
    if (gone) {
      // Its last words can arrive after its exit; a process it started may hold the pipe open, so not for long.
      await Promise.race([outputClosed, new Promise((r) => setTimeout(r, 500))]);
      const detail = output.trim();
      const missing = missingLibraries(exe, output);
      if (missing.length > 0) {
        throw new ChromeStartError(missingLibrariesText(missing), `missing ${missing.join(", ")}: ${detail}`, missing);
      }
      // 21 is Chrome's exit code for a profile another Chrome holds (RESULT_CODE_PROFILE_IN_USE).
      const inUse = child.exitCode === 21;
      throw new ChromeStartError(
        inUse ? "Chrome closed while starting (another Chrome is using this profile)" : "Chrome closed while starting",
        detail,
      );
    }
    // Chromium writes DevToolsActivePort only for port 0. For a fixed, preguarded
    // port, wait for its HTTP endpoint and retain the browser websocket path.
    let port = fixedPort;
    let wsPath = "";
    if (fixedPort && ownsPort(fixedPort)) {
      try {
        const reply = await fetch(`http://127.0.0.1:${fixedPort}/json/version`, {
          signal: AbortSignal.timeout(300),
        });
        if (reply.ok) {
          const version = (await reply.json()) as { webSocketDebuggerUrl?: unknown };
          if (typeof version.webSocketDebuggerUrl === "string") {
            const url = new URL(version.webSocketDebuggerUrl);
            if (url.hostname === "127.0.0.1" && Number(url.port) === fixedPort) wsPath = url.pathname;
          }
        }
      } catch {
        // Chrome has not opened the endpoint yet.
      }
    } else if (!fixedPort) {
      const text = await readFile(portFile, "utf8").catch(() => "");
      const [first = "", second = ""] = text.split("\n");
      port = Number(first);
      wsPath = second.trim();
    }
    const validPath = /^\/devtools\/browser\/[\w-]+$/.test(wsPath);
    if (
      Number.isInteger(port) &&
      port > 0 &&
      port < 65536 &&
      (!fixedPort || (port === fixedPort && validPath && ownsPort(fixedPort)))
    ) {
      if (!child.pid) break;
      started = true;
      return {
        pid: child.pid,
        port,
        kill,
        exited,
        ...(validPath ? { wsPath } : {}),
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  kill();
  // Gone before anyone starts another Chrome on this profile (the headless retry of a headed start that hung):
  // one still running would hold the profile.
  await exited;
  throw new ChromeStartError("Chrome didn't open its debugging port in time", output.trim());
}

/** "Google Chrome", "Chrome for Testing"… for `hello.browser` (`shared`: the shared install's folder). */
export function chromeLabel(found: string, home: string = os.homedir(), shared: string | null = null): string {
  for (const testing of [testingChromeDir(home), ...(shared ? [shared] : [])]) {
    if (found === testing || isInside(testing, found)) return "Chrome for Testing";
  }
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
/** CDP's bit for each mouse button in `buttons`. */
const BUTTON_BITS = { none: 0, left: 1, right: 2, middle: 4 } as const;
/** CDP's modifier bits, as `press` spells a chord (`Control+a`). */
const CHORD = [
  [1, "Alt"],
  [2, "Control"],
  [4, "Meta"],
  [8, "Shift"],
] as const;

/** Where a person's pointer is, and which mouse buttons and modifier keys they hold, per stream. */
export interface InputState {
  pointer?: { x: number; y: number };
  /** The mouse buttons down, as CDP's mask (left 1, right 2, middle 4). */
  buttons?: number;
  held: Set<string>;
  /** While the person drags: when they made its last event (`at`, their clock) and when it went to the page. */
  drag?: { at: number; sent: number };
}

/** The longest gap a drag keeps between two of its events: a pause longer than this plays shorter. */
export const DRAG_GAP_MAX_MS = 100;
/** The furthest a drag's gaps may put an event behind the time its batch reached the computer. */
export const DRAG_LAG_MAX_MS = 1000;

/**
 * How long to wait before `e` goes to the page so a drag keeps the gaps the person made between its
 * events: the server sends input in batches and a slow link bunches them, and a slider handed a whole
 * drag at once jumps to its end. Never past `until`: the sender writes `at`, and 100 ms gaps alone would
 * let one batch hold the queue for seconds. Notes `e` as sent once that wait is over. Clicks and anything
 * else go at once.
 */
export function dragDelay(
  e: BrowserInputEvent,
  state: InputState,
  now: number,
  until = Number.POSITIVE_INFINITY,
): number {
  if (e.kind !== "mouse" || e.type === "mouseWheel") return 0;
  const drag = state.drag;
  const wait = Math.min(
    drag && e.at !== undefined && e.type !== "mousePressed"
      ? Math.max(0, drag.sent + Math.min(Math.max(e.at - drag.at, 0), DRAG_GAP_MAX_MS) - now)
      : 0,
    Math.max(0, until - now),
  );
  // A press starts a drag and a release ends it; a move with no press before it is the pointer hovering.
  state.drag =
    e.at === undefined || e.type === "mouseReleased" || (e.type === "mouseMoved" && !drag)
      ? undefined
      : { at: e.at, sent: now + wait };
  return wait;
}

/**
 * One person's input event as commands for `agent-browser`'s relay
 * (`POST /api/command` on the stream port). The daemon runs each on the
 * active tab and answers once Chrome has it, unlike the stream socket, whose
 * input goes to the tab it attached to and is never confirmed. Keys go
 * through `press` (it fills in codes and text); a modifier held on its own is
 * a raw key-down/up pair; a tap from the phone is a left click. Every mouse
 * command says which buttons are down (`buttons`, which the daemon passes to
 * Chrome as given), so a move after a press reaches the page as a drag.
 */
export function relayCommands(e: BrowserInputEvent, state: InputState): Record<string, unknown>[] {
  switch (e.kind) {
    case "mouse": {
      const button = e.button ?? (e.type === "mouseMoved" || e.type === "mouseWheel" ? "none" : "left");
      // A release that never came (dropped on the way, or control that ended mid-press) is sent first, where the
      // pointer was: before a new press of that button, or a move that says no button is down.
      const lost =
        (state.buttons ?? 0) &
        (e.type === "mousePressed" ? BUTTON_BITS[button] : e.type === "mouseMoved" && e.button === "none" ? ~0 : 0);
      if (lost) return [...releaseHeld(state, lost), ...relayCommands(e, state)];
      state.pointer = { x: e.x, y: e.y };
      if (e.type === "mousePressed") state.buttons = (state.buttons ?? 0) | BUTTON_BITS[button];
      else if (e.type === "mouseReleased") state.buttons = (state.buttons ?? 0) & ~BUTTON_BITS[button];
      return [
        {
          action: "input_mouse",
          type: e.type,
          x: e.x,
          y: e.y,
          button,
          buttons: state.buttons ?? 0,
          clickCount: e.clickCount ?? (e.type === "mousePressed" || e.type === "mouseReleased" ? 1 : 0),
          deltaX: e.deltaX ?? 0,
          deltaY: e.deltaY ?? 0,
          modifiers: e.modifiers ?? 0,
        },
      ];
    }
    case "touch": {
      const at = e.touchPoints[0] ?? state.pointer;
      if (!at) return [];
      const mouse = (
        type: "mouseMoved" | "mousePressed" | "mouseReleased",
        button: "none" | "left",
        clickCount: number,
      ) =>
        relayCommands(
          {
            kind: "mouse",
            type,
            x: at.x,
            y: at.y,
            button,
            clickCount,
            ...(e.modifiers ? { modifiers: e.modifiers } : {}),
          },
          state,
        );
      if (e.type === "touchStart") return [...mouse("mouseMoved", "none", 0), ...mouse("mousePressed", "left", 1)];
      if (e.type === "touchMove") return mouse("mouseMoved", "left", 0);
      return mouse("mouseReleased", "left", 1);
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

/** The mouse buttons in `mask` that `state` still holds, let go where the pointer is. */
function releaseHeld(state: InputState, mask = ~0): Record<string, unknown>[] {
  const at = state.pointer;
  if (!at) return [];
  return (["left", "right", "middle"] as const)
    .filter((b) => (state.buttons ?? 0) & mask & BUTTON_BITS[b])
    .flatMap((button) => relayCommands({ kind: "mouse", type: "mouseReleased", x: at.x, y: at.y, button }, state));
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
  /** A secret delivered to the agent (ADR 0027), by name, with the one site it was sealed to, or null. */
  secret: (agent: AgentScope, name: string) => Promise<{ value: string; site: string | null } | null>;
  /** System mode: root preguards this UID's fixed CDP and stream listener ports. */
  fixedPorts?: BrowserPorts;
  /** Tests: how to start `agent-browser` (default: the sidecar or the downloaded binary). */
  command?: string[];
  /** The runner's executable (the sidecar sits next to it). */
  execPath?: string;
  fetch?: typeof fetch;
  /** Tests: the Chrome lookup. */
  chrome?: () => string | null;
  /** Tests: the computer's home (Chrome for Testing lives under it). */
  userHome?: string;
  /** Tests: the shared install's folder (default `SYSTEM_BROWSER_DIR`). */
  sharedDir?: string;
  maxSessions?: number;
  idleMs?: number;
  now?: () => number;
  /** Tests: opens the session's stream socket. */
  connectStream?: (url: string) => StreamSocket;
  /** Tests: opens a Chrome's browser endpoint (its traffic and its pages that die). */
  connectDevtools?: (url: string) => StreamSocket;
  /** The agent's slice's `memory.events` (system mode): whether a page that died ran out of memory. */
  memoryEvents?: string;
  /** Tests: how long a new stream waits for Chrome's first frame (`FIRST_FRAME_MS`). */
  firstFrameMs?: number;
  /** Tests: starts the agent's Chrome (default: `launchChrome`). */
  startChrome?: (exe: string, args: string[], profile: string, env?: Record<string, string>) => Promise<OwnChrome>;
  /** Tests: how long a Chrome started for Browser may take to show its window (`WINDOW_MS`), and to draw it. */
  windowMs?: number;
  windowDrawMs?: number;
  /** The agents' desktops (ADR 0058 §7; a worker's are root's): without them every Chrome is headless. */
  desktops?: Pick<DesktopSessions, "ensure" | "status"> & { session(agentId: string): ChromeDisplay | null };
  /** Tests: whether a pid left in `chromes.json` is still that Chrome (default: asks the system). */
  isOurChrome?: (pid: number, profile: string) => Promise<boolean>;
  /** What `states()` returns may have changed (the desktop app's tray shows it). */
  onChange?: () => void;
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
  /** For the desktop app: the page's host, what the agent did last, and the conversation it was for. */
  host?: string;
  doing?: ControlBrowserDoing;
  /** When the agent's last command ran (not a person's input or a viewer). */
  actedAt?: number;
  link?: string;
  /** When its desktop last failed to start for it (`desktopFor`). */
  desktopFailedAt?: number;
  /** How its page died since the agent last heard (`pageCrashed`), for its next action's answer. */
  crash?: PageCrash;
  /** How many times each tab's page died since the agent last heard of it. */
  crashes: Map<string, number>;
  /** Its `memory.events` when Chrome started or a page last died. */
  memory?: Record<string, number> | null;
}

/** One Chrome in `chromes.json`. */
interface ChromeEntry {
  pid: number;
  profile: string;
  /** Headed: the display of the agent's desktop it is on. */
  display?: number;
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

/** A browser profile's session key (`profile:<id>`, ADR 0110) rather than an agent's id. */
export const isProfileKey = (key: string) => key.startsWith("profile:");

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
  private chromeInstall: Promise<void> | null = null;
  /** Each agent's session while it opens: commands that come meanwhile get the same one (one queue, one Chrome). */
  private readonly opening = new Map<string, Promise<Session>>();
  private failure: { reason: string; at: number } | null = null;
  private closed = false;
  /** Every `closeAll` still running; a new session starts only after them. */
  private closing: Promise<void> = Promise.resolve();
  /** `<runner home>/browser/chromes.json`: the Chromes this runner home started (pid and profile). */
  private readonly pidFile: string;
  /** What each running Chrome sends and receives (protocol 23). */
  private readonly counters = new Map<OwnChrome, TrafficCounter>();
  /** What the counters of Chromes that are gone counted, not taken yet. */
  private trafficLeft = { up: 0, down: 0 };
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
    const chrome = this.chrome();
    const recent = this.recentFailure();
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
      ...(chrome ? { chrome: chromeLabel(chrome, this.userHome, this.shared()) } : {}),
    };
  }

  /** The desktop app's sidecar next to the runner, if there is one. */
  private bundled(): string | null {
    const file = path.join(path.dirname(this.opts.execPath ?? process.execPath), exeName());
    return existsSync(file) ? file : null;
  }

  /** The shared install's folder, when only root (or this user) could have filled it. */
  private shared(): string | null {
    const dir = this.opts.sharedDir ?? SYSTEM_BROWSER_DIR;
    return ownedSafely(dir) ? dir : null;
  }

  /** The shared install's `agent-browser`: checked by the installer, so not hashed again here. */
  private sharedBinary(): string | null {
    const dir = this.shared();
    if (!dir) return null;
    const file = path.join(dir, `agent-browser-${AGENT_BROWSER_VERSION}`);
    return ownedSafely(file) && lstatSync(file).isFile() ? file : null;
  }

  /** The Chrome for Testing to start: the newest of the shared install's and the user's own (tests: `opts.chrome`). */
  private chrome(): string | null {
    return this.opts.chrome ? this.opts.chrome() : findChrome(this.userHome, process.platform, this.shared());
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
    const here = this.bundled() ?? this.sharedBinary();
    if (here) return [here];
    const downloaded = this.downloadedPath();
    return existsSync(downloaded) ? [downloaded] : null;
  }

  /** The binary (downloaded and checked if needed) and a Chrome; throws `browser_unavailable` with the reason. */
  private ensureReady(): Promise<string[]> {
    if (this.opts.command) return this.ensureChrome(this.opts.command).then(() => this.opts.command as string[]);
    const recent = this.recentFailure();
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
    const here = this.bundled() ?? this.sharedBinary();
    if (here) {
      this.binary = here;
      return here;
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
    const url = agentBrowserUrl(target);
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
    if (got !== want) throw this.fail("The agent browser download didn't match its checksum, so it was not used");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o755 });
    await chmod(tmp, 0o755).catch(() => undefined);
    await rename(tmp, file);
  }

  /**
   * Chrome for Testing to drive: found, or installed once (`agent-browser install`). Commands that find none at
   * the same time share one install, and the user's other runners (one per organization) take turns with this
   * one (`installTurn`): two would write the same folder, and one would start `chrome` while the other still
   * writes it (ETXTBSY).
   */
  private ensureChrome(command: string[]): Promise<void> {
    this.chromeInstall ??= this.findOrInstallChrome(command).finally(() => {
      this.chromeInstall = null;
    });
    return this.chromeInstall;
  }

  private async findOrInstallChrome(command: string[]) {
    this.chromePath = this.chrome();
    if (this.chromePath) return;
    const release = await this.installTurn();
    try {
      this.chromePath = this.chrome();
      if (this.chromePath) return;
      this.opts.log("installing Chrome for Testing for the agent browser");
      const out = await this.spawn(command, ["install"], { timeoutMs: INSTALL_TIMEOUT_MS, cwd: this.opts.home });
      this.chromePath = this.chrome();
      if (this.chromePath) return;
      const why = firstLine(out.stderr || out.stdout);
      const hint =
        process.platform === "linux"
          ? ` Chrome's libraries may be missing: run ${command.join(" ")} install --with-deps.`
          : "";
      throw this.fail(`Couldn't install a browser for the agent${why ? ` (${why})` : ""}.${hint}`);
    } finally {
      release();
    }
  }

  /**
   * `install.lock` next to the user's Chrome for Testing, held across processes (`acquireLock`): while another live
   * runner holds it, this one waits, at most an install's time; one whose runner is gone is taken over.
   */
  private async installTurn(): Promise<() => void> {
    const dir = path.dirname(testingChromeDir(this.userHome));
    for (let waited = 0; waited < INSTALL_TIMEOUT_MS; waited += INSTALL_TURN_POLL_MS) {
      try {
        const lock = acquireLock(dir, "install", { file: "install.lock" });
        if (lock.ok) return lock.release;
      } catch {
        // A home it can't write to: `agent-browser install` fails there too, and says why.
        break;
      }
      await new Promise((r) => setTimeout(r, INSTALL_TURN_POLL_MS));
    }
    return () => {};
  }

  /**
   * Gets `agent-browser` and Chrome for Testing ready now, as the first command would (a runner outside system mode
   * with the browser on, as it starts): that command then finds them, or waits on this. A failure here leaves that
   * command to try again at once. Never rejects.
   */
  prepareInBackground(): Promise<void> {
    return this.ensureReady().then(
      () => undefined,
      () => {
        this.failure = null;
      },
    );
  }

  private fail(reason: string) {
    this.failure = { reason: reason.slice(0, BROWSER_LIMITS.message), at: this.now() };
    return new RunnerError("browser_unavailable", this.failure.reason);
  }

  /** The last download or install that failed, while it is recent enough to answer for (`RETRY_FAILURE_MS`). */
  private recentFailure() {
    return this.failure && this.now() - this.failure.at < RETRY_FAILURE_MS ? this.failure : null;
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  /** `browser.act`: one command in the agent's session, after the checks, and what it waited on (protocol 27). */
  async act(
    agent: AgentScope,
    folder: string,
    req: ActRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAnswer & { setup?: BrowserSetup }> {
    const allowed = allowedDomainsOf(req.allowedDomains);
    const prepared = this.checkCommand(req.command, req.args, req.timeoutSeconds, folder, allowed);
    const setup: BrowserSetup = {};
    const session = await this.timedSession(agent, folder, setup);
    const desktop = req.desktop === true;
    const queuedAt = this.now();
    const acts = actsOnPage(prepared);
    const answer = await this.enqueue(session, async () => {
      this.mark(setup, "queued", queuedAt);
      // A page that died since the agent last heard, or while this ran, is an action's answer: it changed under it.
      const before = acts ? this.takeCrash(session, false) : null;
      if (before) return before;
      const done = await this.perform(agent, session, prepared, allowed, req.link, desktop, signal, setup);
      return (acts ? this.takeCrash(session, true) : null) ?? done;
    });
    return { ...answer, ...withSetup(setup) };
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
    const setup: BrowserSetup = {};
    const session = await this.timedSession(agent, folder, setup);
    const desktop = req.desktop === true;
    const queuedAt = this.now();
    return this.enqueue(session, async (): Promise<MachineReplies["browser.batch"]> => {
      this.mark(setup, "queued", queuedAt);
      const answers: BrowserAnswer[] = [];
      /** Where this batch's last action answered. */
      let acted = -1;
      /**
       * A page that died since the agent last heard stops the batch with an action's answer: after an action of
       * this batch, it died under that one (the settling after a click, say), whose answer says so in place of
       * its own and of what followed; before any, the action about to run says so instead of running. Without an
       * action to tell, it waits for the agent's next one.
       */
      const died = () => {
        const notice = this.takeCrash(session, acted >= 0);
        if (!notice) return false;
        if (acted >= 0) answers.length = acted;
        answers.push(notice);
        return true;
      };
      for (const p of prepared) {
        if (signal?.aborted) break;
        const acts = actsOnPage(p);
        if (acts && died()) break;
        if (acts) acted = answers.length;
        let answer: BrowserAnswer;
        try {
          answer = await this.perform(agent, session, p, allowed, req.link, desktop, signal, setup);
        } catch (err) {
          // Nothing ran yet: refused as a whole (its error code reaches the server).
          if (answers.length === 0) throw err;
          // Something already ran: its answers are kept; this command failed and the batch stops.
          answers.push({
            success: false,
            data: null,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
          });
          if (acted >= 0) died();
          break;
        }
        answers.push(answer);
        if ((acted >= 0 && died()) || (!answer.success && !p.tolerate)) break;
      }
      return { answers, ...withSetup(setup) };
    });
  }

  /**
   * `browser.warm` (protocol 27, ADR 0040 §11): the agent's Chrome started before its first command, as that command
   * would start it (`desktop`: on the agent's desktop), on a blank page, with no stream and no `agent-browser`. It
   * takes its place in the agent's queue like a command, so what comes meanwhile runs after it, and the idle stop
   * counts from it. Nothing starts (`started: false`) while a person has the agent's browser or is asked to take it,
   * while its Chrome runs or starts (a command moves it, as ever), or when its session would take the computer's
   * last free browser.
   */
  async warm(agent: AgentScope, folder: string, desktop: boolean): Promise<MachineReplies["browser.warm"]> {
    const agentId = String(agent.id ?? "");
    const busy = (s?: Session) => !!s?.chrome || !!s?.chromeStarting || this.handoffs.has(agentId);
    const open = this.sessions.get(agentId);
    if (busy(open)) return { started: false };
    if (!open && !this.opening.has(agentId) && this.liveSessions().length >= this.maxSessions - 1) {
      return { started: false };
    }
    const setup: BrowserSetup = {};
    const session = await this.timedSession(agent, folder, setup);
    const queuedAt = this.now();
    return this.enqueue(session, async () => {
      this.mark(setup, "queued", queuedAt);
      if (busy(session)) return { started: false, ...withSetup(setup) };
      await this.ensureOwnChrome(agent, session, desktop, [], false, setup);
      return { started: true, ...withSetup(setup) };
    });
  }

  /** `setup[step]`: the time since `since`, when it took 10 ms or more. */
  private mark(setup: BrowserSetup | undefined, step: keyof BrowserSetup, since: number) {
    const ms = Math.round(this.now() - since);
    if (setup && ms >= 10) setup[step] = ms;
  }

  /** The agent's session; when it wasn't open, the time getting it ready took (or waiting on that) is `install`. */
  private async timedSession(agent: AgentScope, folder: string, setup: BrowserSetup): Promise<Session> {
    const open = this.sessions.has(String(agent.id ?? ""));
    const since = this.now();
    const session = await this.session(agent, folder);
    if (!open) this.mark(setup, "install", since);
    return session;
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

  /**
   * Runs one prepared command in the session's queue (the caller holds it). `desktop`: where its Chrome belongs;
   * `setup`: where starting its desktop and its Chrome go.
   */
  private async perform(
    agent: AgentScope,
    session: Session,
    p: Prepared,
    allowed: string[],
    link: unknown,
    desktop: boolean,
    signal?: AbortSignal,
    setup?: BrowserSetup,
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
    if (!READS.has(command)) await this.ensureOwnChrome(agent, session, desktop, allowed, false, setup);
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
    // A runner or worker that just started closes what an earlier run left: its `close --all` would let go of a
    // session opened meanwhile, and a leftover Chrome still holds the profile until it is killed.
    await this.closing;
    if (this.closed) throw new RunnerError("browser_unavailable", "The runner is stopping");
    const agentId = String(agent.id ?? "");
    const existing = this.sessions.get(agentId);
    if (existing) {
      existing.lastUsed = this.now();
      return existing;
    }
    let opening = this.opening.get(agentId);
    if (!opening) {
      opening = this.openSession(agentId, agent, folder).finally(() => this.opening.delete(agentId));
      this.opening.set(agentId, opening);
    }
    return opening;
  }

  /** Sessions used within the idle time: what counts against `maxSessions`. */
  private liveSessions() {
    return [...this.sessions.values()].filter((s) => this.now() - s.lastUsed < this.idleMs);
  }

  private async openSession(agentId: string, agent: AgentScope, folder: string): Promise<Session> {
    const live = this.liveSessions();
    if (live.length >= this.maxSessions) {
      throw new RunnerError(
        "browser_unavailable",
        `This computer already has ${live.length} browsers open (its limit). Try again in a few minutes.`,
      );
    }
    for (const [id, s] of this.sessions) {
      if (live.includes(s)) continue;
      this.sessions.delete(id);
      void this.stopChrome(s);
    }
    await this.ensureReady();
    await mkdir(path.join(folder, AGENT_BROWSER_PROFILE), { recursive: true });
    // Where screenshots and downloads land: there before the first one (the browser doesn't make them).
    await mkdir(path.join(folder, "screenshots"), { recursive: true });
    await mkdir(path.join(folder, "downloads"), { recursive: true });
    await mkdir(path.dirname(this.configFile), { recursive: true, mode: 0o700 });
    if (!existsSync(this.configFile)) await writeFile(this.configFile, "{}\n", { mode: 0o600 });
    const session: Session = {
      agentId,
      name: isProfileKey(agentId)
        ? `profile-${agentId.slice(8, 16)}`
        : `agent-${agentFolderName(agent).suffix.slice(1)}`,
      folder,
      queue: Promise.resolve(),
      lastUsed: this.now(),
      aliveAt: null,
      crashes: new Map(),
    };
    this.sessions.set(agentId, session);
    this.sweepTimer ??= setInterval(() => void this.sweep(), SWEEP_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
    return session;
  }

  /**
   * The agent's Chrome, started when it isn't running: Chrome for Testing with
   * our flags and the agent's profile, headed on the agent's desktop when it
   * belongs there and the desktop runs (started first), else headless; its pid
   * and display go in `chromes.json`. One running in the other mode starts
   * again in this one on the page it showed, unless someone may be looking
   * (`asked`: a person's own click, `show`, moves it anyway, and never runs it
   * headless: the desktop's own refusal, or Chrome's, is the answer). Starting
   * the desktop and Chrome are timed into `setup`.
   */
  private async ensureOwnChrome(
    agent: AgentScope,
    session: Session,
    onDesktop: boolean,
    allowed: string[],
    asked = false,
    setup?: BrowserSetup,
  ): Promise<OwnChrome> {
    // A profile's Chrome never goes on a desktop: there the acting agent's own tools could read the shared account.
    const profileSession = isProfileKey(session.agentId);
    if (profileSession && asked) throw new RunnerError("not_allowed", "A browser profile only runs in the background");
    const desktop = onDesktop && !profileSession;
    const running = session.chrome;
    if (!running && session.chromeStarting) return session.chromeStarting;
    if (running && ((running.display !== undefined) === desktop || (!asked && this.inView(session)))) return running;
    const where = desktop ? await this.desktopFor(agent, session, asked, setup) : null;
    if (asked && !where) throw new RunnerError("desktop_unavailable", "The agent's desktop isn't running");
    const startedAt = this.now();
    let page: string | undefined;
    if (running) {
      if ((running.display !== undefined) === (where !== null)) return running;
      const url = await this.pageUrl(session).catch(() => null);
      if (url && isWebPage(url) && domainAllowed(url, allowed)) page = new URL(url).href;
      this.opts.log(`the browser of ${agent.handle} moves ${where ? "to its desktop" : "off its desktop"}`);
      await this.run(session, ["close"], { timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
      await this.stopChrome(session);
    }
    const profile = path.join(session.folder, AGENT_BROWSER_PROFILE);
    const starting = (async () => {
      const exe = this.chromePath ?? this.chrome();
      if (!exe) throw new RunnerError("browser_unavailable", "No browser is installed for the agent yet");
      const start = this.opts.startChrome ?? launchChrome;
      await this.clearStaleLock(profile);
      const launch = async (on: ChromeDisplay | null) => {
        if (on) prepareProfile(profile);
        await forgetTabs(profile);
        const args = chromeLaunchArgs(
          exe,
          profile,
          process.platform,
          osLang(),
          on !== null,
          page,
          this.opts.fixedPorts?.cdp ?? 0,
        );
        try {
          const started = await start(exe, args, profile, on ? chromeEnv(on) : undefined);
          if (on) started.display = on.display;
          return started;
        } catch (err) {
          if (err instanceof ChromeStartError && err.detail) {
            this.opts.log(`the browser of ${agent.handle} didn't start: ${err.detail}`);
          }
          throw err;
        }
      };
      let chrome: OwnChrome;
      try {
        chrome = await launch(where).catch((err: unknown) => {
          // Libraries Chrome can't load fail a headless start just the same, and aren't the desktop's doing.
          if (!where || asked || (err instanceof ChromeStartError && err.missing.length > 0)) throw err;
          // A headed start failed (its desktop went away or hung under it): headless for now, like a desktop that
          // can't start.
          session.desktopFailedAt = this.now();
          this.opts.log(
            `the browser of ${agent.handle} runs headless: ${err instanceof Error ? err.message : String(err)}`,
          );
          return launch(null);
        });
      } catch (err) {
        throw new RunnerError(
          "internal",
          `Couldn't start the agent's browser: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
        );
      }
      session.chrome = chrome;
      session.aliveAt = null;
      session.memory = this.memoryCounters();
      await this.rememberChrome(chrome.pid, profile, chrome.display);
      void chrome.exited.then(() => {
        void this.forgetChrome(chrome.pid);
        if (session.chrome !== chrome) return;
        // It closed under us (a crash, the person quit it): the next command starts it again.
        session.chrome = undefined;
        session.aliveAt = null;
        this.changed();
      });
      await this.countTraffic(session, chrome);
      this.mark(setup, "launch", startedAt);
      return chrome;
    })();
    session.chromeStarting = starting;
    try {
      return await starting;
    } finally {
      if (session.chromeStarting === starting) session.chromeStarting = undefined;
    }
  }

  /** A new Chrome's traffic is counted from its first command on: the counter attaches first (1 s at most). */
  private async countTraffic(session: Session, chrome: OwnChrome) {
    if (!chrome.wsPath) return;
    const counter = countChromeTraffic(
      `ws://127.0.0.1:${chrome.port}${chrome.wsPath}`,
      this.opts.connectDevtools,
      (page) => this.pageCrashed(session, chrome, page),
    );
    this.counters.set(chrome, counter);
    void chrome.exited.then(() => {
      const last = counter.take();
      this.trafficLeft.up += last.up;
      this.trafficLeft.down += last.down;
      counter.close();
      this.counters.delete(chrome);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([counter.attached, new Promise((r) => (timer = setTimeout(r, TRAFFIC_ATTACH_MS)))]);
    clearTimeout(timer);
  }

  /**
   * A tab's page died: opened again once, and the agent's next action is told. One that dies again before the
   * agent heard of it shows our notice instead, once: a page that can't even start there (the slice's last task
   * taken, or its memory held by another process) would die again at once, and from then on it stays on Chrome's
   * own page, so nothing starts again and again while the agent isn't there. It ran out of memory when the agent's
   * slice reached its limit since its Chrome started or a page last died.
   */
  private pageCrashed(session: Session, chrome: OwnChrome, page: CrashedPage) {
    if (session.chrome !== chrome) return;
    const before = session.memory;
    const now = this.memoryCounters();
    session.memory = now;
    const memory = !!before && !!now && OUT_OF_MEMORY.some((k) => (now[k] ?? 0) > (before[k] ?? 0));
    const times = (session.crashes.get(page.targetId) ?? 0) + 1;
    session.crashes.set(page.targetId, times);
    if (times === 1) page.reopen();
    else if (times === 2) page.show(crashPage(memory));
    session.crash = { memory, again: times > 1 };
    const left = times === 1 ? "reloaded" : times === 2 ? "left on our notice" : "left on Chrome's page";
    this.opts.log(`the browser of ${session.name}: a page ${memory ? "ran out of memory" : "crashed"}, ${left}`);
  }

  private memoryCounters() {
    return this.opts.memoryEvents ? cgroupCounters(this.opts.memoryEvents) : null;
  }

  /**
   * How the agent's page died since it last heard, said once: after it, a page that dies is reloaded again. Not
   * while a person has its browser or is asked to take it: what comes then is theirs or the server's (a person
   * opening a site), and the agent hears it at its first action after their turn.
   */
  private takeCrash(session: Session, ran: boolean): BrowserAnswer | null {
    const crash = session.crash;
    if (!crash || this.handoffs.has(session.agentId)) return null;
    session.crash = undefined;
    session.crashes.clear();
    return { success: false, data: null, error: crashNotice(crash, ran) };
  }

  /** What the agents' Chromes sent and received since the last call, those that are gone included (protocol 23). */
  takeTraffic(): { up: number; down: number } {
    const total = this.trafficLeft;
    this.trafficLeft = { up: 0, down: 0 };
    for (const counter of this.counters.values()) {
      const t = counter.take();
      total.up += t.up;
      total.down += t.down;
    }
    return total;
  }

  /**
   * The agent's Chrome stops (the profile, and so its logins, stay). It is asked to close itself first, as a person
   * quits it, so what it holds reaches the profile: measured 2026-10-31 on Chrome for Testing 155, cookies set a
   * second and a half before a SIGTERM were gone at the next start, the "remember me" one too in three runs of four
   * (a sign-in just before the browser moved to or from the agent's desktop); 35 s before it, or with
   * `Browser.close`, they stayed. One that doesn't close in time is signaled, then killed.
   */
  private async stopChrome(session: Session) {
    const chrome = session.chrome ?? (await session.chromeStarting?.catch(() => undefined));
    session.chrome = undefined;
    session.aliveAt = null;
    if (!chrome) return;
    const counter = this.counters.get(chrome);
    if (counter) {
      counter.quit();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([chrome.exited, new Promise((r) => (timer = setTimeout(r, CHROME_QUIT_MS)))]);
      clearTimeout(timer);
    }
    chrome.kill();
    await chrome.exited;
    await this.forgetChrome(chrome.pid);
  }

  /**
   * The agent's desktop for a headed Chrome, started when it isn't running.
   * Null when it can't be there now: Chrome runs headless meanwhile, and a
   * desktop that failed to start isn't tried again for a while (each try can
   * take seconds). A person who `asked` from that desktop gets it tried at once,
   * and its refusal. A desktop that had to start is timed into `setup`.
   */
  private async desktopFor(
    agent: AgentScope,
    session: Session,
    asked = false,
    setup?: BrowserSetup,
  ): Promise<ChromeDisplay | null> {
    const desktops = this.opts.desktops;
    if (!desktops) return null;
    const failedAt = session.desktopFailedAt;
    if (!asked && failedAt !== undefined && this.now() - failedAt < DESKTOP_RETRY_MS) return null;
    const since = this.now();
    try {
      const ensured = await desktops.ensure(agent, { chrome: true });
      if (ensured?.started) this.mark(setup, "desktop", since);
    } catch (err) {
      session.desktopFailedAt = this.now();
      if (asked) throw err;
      this.opts.log(
        `the browser of ${agent.handle} runs headless: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    session.desktopFailedAt = undefined;
    const on = desktops.session(agent.id);
    return on ? { display: on.display, xauthority: on.xauthority } : null;
  }

  /** Someone may be looking at the agent's Chrome, or working in it: its live view, a person's turn, its desktop's viewers. */
  private inView(session: Session) {
    return (
      !!session.stream || !!session.streamOpening || this.handoffs.has(session.agentId) || this.desktopWatched(session)
    );
  }

  /** The agent's Chrome is on its desktop, and someone watches or controls that desktop. */
  private desktopWatched(session: Session) {
    if (session.chrome?.display === undefined) return false;
    return (this.opts.desktops?.status({ id: session.agentId }).streams ?? 0) > 0;
  }

  /**
   * Whether the agent's Chrome is on its desktop and in use (a command within
   * the idle time, its live view, a person's turn): its desktop doesn't stop
   * as idle under it.
   */
  onDesktopInUse(agentId: string): boolean {
    const s = this.sessions.get(agentId);
    if (!s || s.chrome?.display === undefined) return false;
    return !!s.stream || !!s.streamOpening || this.handoffs.has(agentId) || this.now() - s.lastUsed < this.idleMs;
  }

  /**
   * Idle browsers close: no command (or frame) for the idle time, nobody
   * watching, and no help request open for that agent.
   */
  async sweep() {
    for (const [agentId, s] of this.sessions) {
      // A person on its desktop may be working in it without a command: that counts as use.
      if (this.desktopWatched(s)) s.lastUsed = this.now();
      if (s.stream || s.streamOpening || this.handoffs.has(agentId)) continue;
      if (this.now() - s.lastUsed < this.idleMs) continue;
      this.sessions.delete(agentId);
      this.changed();
      await this.enqueue(s, async () => {
        if (s.chrome) await this.run(s, ["close"], { timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
        await this.stopChrome(s);
      }).catch(() => undefined);
    }
  }

  private readPids(): Promise<ChromeEntry[]> {
    return readFile(this.pidFile, "utf8")
      .then((text) => {
        const v = JSON.parse(text) as unknown;
        return Array.isArray(v)
          ? v.filter((e): e is ChromeEntry => isRecord(e) && Number.isInteger(e.pid) && typeof e.profile === "string")
          : [];
      })
      .catch(() => []);
  }

  private writePids(change: (list: ChromeEntry[]) => ChromeEntry[]) {
    const write = this.pidWrites.then(async () => {
      const next = change(await this.readPids());
      await mkdir(path.dirname(this.pidFile), { recursive: true, mode: 0o700 });
      await writeFile(this.pidFile, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    });
    this.pidWrites = write.catch(() => undefined);
    return write.catch(() => undefined);
  }

  private rememberChrome(pid: number, profile: string, display?: number) {
    return this.writePids((list) => [
      ...list.filter((e) => e.pid !== pid),
      { pid, profile, ...(display !== undefined ? { display } : {}) },
    ]);
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

  /**
   * Chrome's `Singleton*` files name the host and pid that holds a profile. Restored onto another computer they make
   * Chrome exit with 21 (in use elsewhere), so before a launch they go when no Chrome this runner recorded for the
   * folder still runs.
   */
  private async clearStaleLock(profile: string) {
    for (const { pid, profile: held } of await this.readPids()) {
      if (held === profile && (await this.isOurChrome(pid, profile).catch(() => false))) return;
    }
    await Promise.all(
      ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((f) => rm(path.join(profile, f), { force: true })),
    );
  }

  /** A browser profile's folder: under the runner's home, outside every agent's folder. */
  profileFolder(profileId: string) {
    return path.join(this.opts.home, "browser-profiles", profileId);
  }

  /** `browser.profile.delete`: its Chrome stops and its folder goes (logins with it). */
  async deleteProfile(agent: AgentScope, folder: string): Promise<{ deleted: boolean }> {
    await this.stop(agent);
    await rm(folder, { recursive: true, force: true });
    return { deleted: true };
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
    const held = await this.opts.secret(agent, name);
    if (held === null) {
      return {
        success: false,
        data: null,
        error: `No secret named ${name} was delivered to this agent; ask for it with request_secret first`,
      };
    }
    // The site the person sealed it to, on this computer, wins over the one the request names.
    if (held.site && held.site !== site) {
      return {
        success: false,
        data: null,
        error: `${name} is only for ${new URL(held.site).host}, not ${new URL(site).host}; it wasn't typed`,
      };
    }
    const { value } = held;
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

  /**
   * Browser on the agent's desktop (`desktop-browser.ts`): its own Chrome there, in front, for the person who
   * clicked it, answered once its window is on the desktop (`windowShown`). Chrome for Testing is installed first
   * when it isn't here yet (`installing` says so). A Chrome running headless moves there even while someone
   * watches it or a person's turn is open: a person asked, from that desktop. A desktop that can't take it fails
   * the click with its own reason: a click never starts one headless. The click carries no address and no flag, so
   * the browser reaches nothing new. Each click's outcome goes in the log (a failure in the caller's).
   *
   * A Chrome already there comes to the front only for a click that reaches the runner: the apps menu's Browser, a
   * middle or Shift click on docklike's, or the panel's own launcher where docklike isn't installed. A plain click
   * on docklike's Browser while Chrome has a window there never comes here: docklike raises that window itself (or
   * hides it, when it is the active one), and nothing is logged.
   */
  async show(agent: AgentScope, folder: string, installing: () => void): Promise<void> {
    const clickedAt = this.now();
    const chrome = this.chromePath ?? this.chrome();
    if (!this.recentFailure() && (!this.presentCommand() || !chrome)) installing();
    const session = await this.session(agent, folder);
    const outcome = await this.enqueue(session, async () => {
      const before = session.chrome;
      const shown = await this.ensureOwnChrome(agent, session, true, [], true);
      session.lastUsed = this.now();
      if (shown === before) {
        return (await this.activate(shown))
          ? "already open: brought to the front"
          : "already open; it didn't come to the front";
      }
      await this.windowShown(session, shown);
      return `opened in ${((this.now() - clickedAt) / 1000).toFixed(1)} s`;
    });
    this.opts.log(`Browser on the desktop of ${agent.handle}: ${outcome}`);
    this.changed();
  }

  /**
   * Waits for the window of a Chrome just started for Browser: Chrome answers its debugging endpoint's list only
   * once it is done starting, which shows its first window, and lists that window's page; then the time it takes
   * to draw it. One that shows none in time is stopped, and one that closes meanwhile is gone: the click failed.
   */
  private async windowShown(session: Session, chrome: OwnChrome) {
    const until = Date.now() + (this.opts.windowMs ?? WINDOW_MS);
    let gone = false;
    void chrome.exited.then(() => {
      gone = true;
    });
    while (!gone && Date.now() < until) {
      const listed = await (this.opts.fetch ?? fetch)(`http://127.0.0.1:${chrome.port}/json/list`, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, until - Date.now())),
      })
        .then((res) => res.json() as Promise<unknown>)
        .then((targets) => Array.isArray(targets) && targets.some((t) => isRecord(t) && t.type === "page"))
        .catch(() => false);
      if (listed) {
        await new Promise((r) => setTimeout(r, this.opts.windowDrawMs ?? WINDOW_DRAW_MS));
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (gone) throw new RunnerError("internal", "Chrome closed before its window showed");
    await this.stopChrome(session);
    throw new RunnerError("internal", "Chrome's window didn't show in time");
  }

  /**
   * Chrome's window in front, on its most recent tab, through Chrome's own debugging endpoint; a Chrome with no
   * tab left gets a blank one, in a window of its own. False when Chrome didn't take it.
   */
  private async activate(chrome: OwnChrome): Promise<boolean> {
    const at = `http://127.0.0.1:${chrome.port}/json`;
    const call = (p: string, method = "GET") =>
      (this.opts.fetch ?? fetch)(`${at}/${p}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
      });
    try {
      const targets = (await (await call("list")).json()) as unknown;
      const page = Array.isArray(targets)
        ? targets.find((t): t is { id: string } => isRecord(t) && t.type === "page" && typeof t.id === "string")
        : undefined;
      // Chrome takes a new tab only by PUT.
      return (await (page ? call(`activate/${encodeURIComponent(page.id)}`) : call("new?about:blank", "PUT"))).ok;
    } catch {
      // It stays where it is: on the desktop, behind whatever is in front.
      return false;
    }
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

  /** The agent's Chrome process while it runs: its window on the agent's desktop is the browser's, not the desktop's. */
  chromePid(agentId: string): number | null {
    return this.sessions.get(agentId)?.chrome?.pid ?? null;
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
      // The tray lists agents (Ver, Parar): a profile is the workspace's, watched from its page.
      if (isProfileKey(agentId)) continue;
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
    const run = (async () => {
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
    })();
    this.closing = Promise.all([this.closing, run.catch(() => undefined)]).then(() => undefined);
    await run;
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
        if (mode === "watch") this.letGo(session.stream);
        session.stream.mode = mode;
        session.stream.socket.send(JSON.stringify({ type: "config", maxFps: STREAM_FPS[mode] }));
        this.changed();
      }
      // The server asks again when it lost the page (a new process, a stop that failed): an idle page sends it again.
      session.stream.framed = false;
      void this.firstFrame(session, session.stream);
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
      const reported = isRecord(status.data) && typeof status.data.port === "number" ? status.data.port : null;
      if (this.opts.fixedPorts && reported !== this.opts.fixedPorts.stream) {
        throw new RunnerError("browser_unavailable", "The browser's live view is outside its isolated port");
      }
      return reported;
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
        stream.framed = true;
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
    this.letGo(session.stream);
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
   * next), a drag with the gaps the person made (`dragDelay`), never more
   * than `DRAG_LAG_MAX_MS` behind. The stream socket only carries frames.
   */
  async input(agent: AgentScope, events: unknown[]): Promise<MachineReplies["browser.input"]> {
    const session = this.sessions.get(String(agent.id ?? ""));
    const stream = session?.stream;
    if (!session || !stream) throw new RunnerError("bad_request", "Nobody is viewing this agent's browser");
    if (!Array.isArray(events) || events.length > BROWSER_LIMITS.inputEvents) {
      throw new RunnerError("bad_request", `At most ${BROWSER_LIMITS.inputEvents} events at once`);
    }
    session.lastUsed = this.now();
    const until = this.now() + DRAG_LAG_MAX_MS;
    const parsed = events.map((raw) => parseBrowserInputEvent(raw)).filter((e) => e !== null);
    // Nothing queued reaches the page once the stream ended (the browser closed under it) or is back to watching:
    // the person's control ended, and the server checks control only as it forwards a batch.
    const driving = () => session.stream === stream && stream.mode === "control";
    const run = stream.inputQueue.then(async () => {
      let accepted = 0;
      let failed = 0;
      for (const e of parsed) {
        const wait = driving() ? dragDelay(e, stream.input, this.now(), until) : 0;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (!driving()) {
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

  /**
   * The person's control ended (back to watching, or nobody watches): a button they still hold lets go where their
   * pointer was, after the input queued before, so the agent doesn't go on with it held.
   */
  private letGo(stream: Stream) {
    stream.inputQueue = stream.inputQueue.then(async () => {
      for (const command of releaseHeld(stream.input)) await this.relay(stream.port, command);
    });
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
    if (this.opts.fixedPorts) env.AGENT_BROWSER_STREAM_PORT = String(this.opts.fixedPorts.stream);
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
