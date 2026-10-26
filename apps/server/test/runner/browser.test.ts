import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AGENT_BROWSER_VERSION,
  BROWSER_LIMITS,
  BROWSER_PROTOCOL,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  parseRunnerFrame,
  parseServerFrame,
  type RunnerAccess,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { reduceAccess, setTool, TOOL_NAMES, widens } from "../../runner/access";
import {
  agentBrowserTarget,
  BrowserManager,
  type BrowserManagerOptions,
  CHROME_ARGS,
  ChromeStartError,
  captureMarks,
  chromeLabel,
  chromeLaunchArgs,
  chromeUserAgent,
  defaultMaxSessions,
  domainAllowed,
  findChrome,
  type InputState,
  isWebPage,
  jpegSize,
  launchChrome,
  type OwnChrome,
  relayCommands,
  type StreamSocket,
} from "../../runner/browser";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-agent-browser.mjs");
const dev = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
const ops = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };

interface Logged {
  args: string[];
  stdin: string;
}

/** A Chrome the fake "starts": records its command line, answers on a port, and quits when killed. */
interface FakeChrome {
  exe: string;
  args: string[];
  profile: string;
  port: number;
  killed: boolean;
}

function fakeChromes() {
  const started: FakeChrome[] = [];
  const start = async (exe: string, args: string[], profile: string): Promise<OwnChrome> => {
    const c: FakeChrome = { exe, args, profile, port: 9300 + started.length, killed: false };
    started.push(c);
    let quit = () => {};
    const exited = new Promise<void>((resolve) => {
      quit = () => resolve();
    });
    return {
      pid: 40_000 + started.length,
      port: c.port,
      kill: () => {
        c.killed = true;
        quit();
      },
      exited,
    };
  };
  return { started, start };
}

function setup(over: Partial<BrowserManagerOptions> = {}, secrets: Record<string, string> = {}) {
  const ws = tempDir();
  const home = tempDir("runner-home-");
  dirs.push(ws, home);
  const log = path.join(home, "ab.log");
  const stateFile = path.join(home, "ab-state.json");
  process.env.FAKE_AB_LOG = log;
  process.env.FAKE_AB_STATE = stateFile;
  const frames: RunnerFrame[] = [];
  const sockets: FakeSocket[] = [];
  const chromes = fakeChromes();
  const manager = new BrowserManager({
    home,
    log: () => {},
    send: (f) => {
      frames.push(f);
      return true;
    },
    secret: async (_agent, name) => secrets[name] ?? null,
    command: [process.execPath, FAKE],
    chrome: () => "/fake/browsers/chrome-155.0.8059.84/chrome-linux64/chrome",
    startChrome: chromes.start,
    isOurChrome: async () => false,
    connectStream: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      queueMicrotask(() => s.onopen?.());
      return s;
    },
    ...over,
  });
  const folder = async (agent = dev) => agentWorkspace(ws, agent);
  const act = async (
    command: string,
    args: string[] = [],
    extra: { allowedDomains?: string[]; agent?: typeof dev } = {},
  ) =>
    manager.act(extra.agent ?? dev, await folder(extra.agent), {
      op: "browser.act",
      command,
      args,
      timeoutSeconds: 30,
      ...(extra.allowedDomains ? { allowedDomains: extra.allowedDomains } : {}),
    });
  const logged = (): Logged[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Logged)
      : [];
  const page = (patch: Record<string, unknown>) => {
    const cur = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
    writeFileSync(stateFile, JSON.stringify({ ...cur, ...patch }));
  };
  return { ws, home, manager, frames, sockets, folder, act, logged, page, chromes: chromes.started };
}

class FakeSocket implements StreamSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  push(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

// ── Pure parts ───────────────────────────────────────────────────────────────

test("the runner speaks the browser's protocol (12) or later, and the browser is a fourth machine switch", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BROWSER_PROTOCOL);
  expect(TOOL_NAMES).toContain("browser");
  const off: RunnerAccess = { folders: [], tools: { claude: true, codex: false, commands: true } };
  const on = setTool(off, "browser", true);
  expect(on.tools.browser).toBe(true);
  // The server can only turn it off, never on.
  expect(reduceAccess(on, { disableTool: "browser" }).tools.browser).toBe(false);
  expect(widens(reduceAccess(off, { disableTool: "browser" }), off)).toBe(false);
  expect(widens(on, off)).toBe(true);
});

test("release target, session cap and Chrome names", () => {
  expect(agentBrowserTarget("darwin", "arm64")).toBe("darwin-arm64");
  expect(agentBrowserTarget("linux", "x64")).toBe("linux-x64");
  expect(agentBrowserTarget("win32", "x64")).toBe("win32-x64");
  expect(agentBrowserTarget("win32", "arm64")).toBeNull();
  expect(agentBrowserTarget("freebsd", "x64")).toBeNull();
  const GB = 1024 ** 3;
  expect(defaultMaxSessions(2 * GB)).toBe(1);
  expect(defaultMaxSessions(8 * GB)).toBe(6);
  expect(defaultMaxSessions(64 * GB)).toBe(8);
  expect(chromeLabel("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe("Google Chrome");
  expect(chromeLabel("/usr/bin/chromium")).toBe("Chromium");
  expect(chromeLabel("/home/x/.agent-browser/browsers", "/home/x")).toBe("Chrome for Testing");
  expect(chromeLabel("/home/x/.agent-browser/browsers/chrome-155.0.1/chrome-linux64/chrome", "/home/x")).toBe(
    "Chrome for Testing",
  );
});

test("only Chrome for Testing is driven: the newest installed one, never the person's own Chrome", () => {
  const home = tempDir("chrome-home-");
  dirs.push(home);
  // Nothing installed: null, even with a system Chrome on the computer.
  expect(findChrome(home, "linux")).toBeNull();
  const browsers = path.join(home, ".agent-browser", "browsers");
  for (const v of ["chrome-150.0.1", "chrome-155.0.1"]) {
    mkdirSync(path.join(browsers, v, "chrome-linux64"), { recursive: true });
    writeFileSync(path.join(browsers, v, "chrome-linux64", "chrome"), "");
  }
  expect(findChrome(home, "linux")).toBe(path.join(browsers, "chrome-155.0.1", "chrome-linux64", "chrome"));
  const mac = path.join(
    browsers,
    "chrome-156.0.1",
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
  );
  mkdirSync(mac, { recursive: true });
  writeFileSync(path.join(mac, "Google Chrome for Testing"), "");
  expect(findChrome(home, "darwin")).toBe(path.join(mac, "Google Chrome for Testing"));
  // On every launch: nothing updating Chrome's files, pages asked to hold still (`prefers-reduced-motion`), and no
  // chip asking to sign in to Chrome itself.
  expect(CHROME_ARGS).toEqual([
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-component-update",
    "--force-prefers-reduced-motion",
    "--disable-features=SigninPromoOnAvatarPill",
  ]);
});

test("site allowlist: exact hosts, *. wildcards with the bare domain, blank pages always", () => {
  expect(domainAllowed("https://evil.com", [])).toBe(true);
  const list = ["shop.example.com", "*.stripe.com"];
  expect(domainAllowed("https://shop.example.com/cart", list)).toBe(true);
  expect(domainAllowed("https://www.shop.example.com", list)).toBe(false);
  expect(domainAllowed("https://stripe.com", list)).toBe(true);
  expect(domainAllowed("https://checkout.stripe.com/pay", list)).toBe(true);
  expect(domainAllowed("https://notstripe.com", list)).toBe(false);
  expect(domainAllowed("about:blank", list)).toBe(true);
  expect(domainAllowed("file:///etc/passwd", list)).toBe(false);
  expect(domainAllowed("not a url", list)).toBe(false);
});

test("only web pages: local files, view-source, browser pages and scripts are refused whatever their case", () => {
  expect(isWebPage("https://shop.example.com")).toBe(true);
  expect(isWebPage("HTTP://shop.example.com")).toBe(true);
  expect(isWebPage("about:blank")).toBe(true);
  for (const url of [
    "file:///etc/passwd",
    "FILE:///etc/passwd",
    " File:///Users/x/.ssh/id_rsa",
    "view-source:file:///etc/passwd",
    "VIEW-SOURCE:https://x.com",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "javascript:alert(1)",
    "data:text/html,hi",
    "about:settings",
  ]) {
    expect(isWebPage(url)).toBe(false);
  }
});

test("relay input: clicks as input_mouse, keys through press (chords), text inserted, taps as clicks", () => {
  const state: InputState = { held: new Set() };
  expect(relayCommands({ kind: "mouse", type: "mousePressed", x: 10, y: 20 }, state)).toEqual([
    {
      action: "input_mouse",
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
      deltaX: 0,
      deltaY: 0,
      modifiers: 0,
    },
  ]);
  expect(relayCommands({ kind: "key", type: "keyDown", key: "Enter" }, state)).toEqual([
    { action: "press", key: "Enter" },
  ]);
  // press already released it.
  expect(relayCommands({ kind: "key", type: "keyUp", key: "Enter" }, state)).toEqual([]);
  expect(relayCommands({ kind: "key", type: "keyDown", key: "a", modifiers: 2 }, state)).toEqual([
    { action: "press", key: "Control+a" },
  ]);
  expect(relayCommands({ kind: "key", type: "keyDown", key: "A", modifiers: 8 }, state)).toEqual([
    { action: "press", key: "A" },
  ]);
  // A modifier on its own is held and released as raw keys; an unmatched release sends nothing.
  expect(relayCommands({ kind: "key", type: "keyDown", key: "Shift", code: "ShiftLeft" }, state)).toEqual([
    { action: "input_keyboard", type: "keyDown", key: "Shift", code: "ShiftLeft" },
  ]);
  expect(relayCommands({ kind: "key", type: "keyUp", key: "Shift" }, state)).toEqual([
    { action: "input_keyboard", type: "keyUp", key: "Shift" },
  ]);
  expect(relayCommands({ kind: "key", type: "keyUp", key: "Shift" }, state)).toEqual([]);
  expect(relayCommands({ kind: "text", text: "olá" }, state)).toEqual([
    { action: "keyboard", subaction: "insertText", text: "olá" },
  ]);
  const tap = relayCommands({ kind: "touch", type: "touchStart", touchPoints: [{ x: 1, y: 2 }] }, state);
  expect(tap.map((c) => [c.type, c.x, c.y, c.button])).toEqual([
    ["mouseMoved", 1, 2, "none"],
    ["mousePressed", 1, 2, "left"],
  ]);
  // The release has no points: it lands where the touch was.
  expect(relayCommands({ kind: "touch", type: "touchEnd", touchPoints: [] }, state)).toMatchObject([
    { action: "input_mouse", type: "mouseReleased", x: 1, y: 2, button: "left" },
  ]);
});

// ── Commands ─────────────────────────────────────────────────────────────────

test.if(posix)("the runner starts the agent's Chrome itself and every command connects to it", async () => {
  const t = setup();
  expect(await t.act("open", ["https://shop.example.com"])).toMatchObject({ success: true });
  // One Chrome for Testing, on the agent's profile, with our flags and none of the automation markers.
  expect(t.chromes).toHaveLength(1);
  const chrome = t.chromes[0] as FakeChrome;
  const profile = path.join(await t.folder(), ".agentes", "browser");
  expect(chrome.exe).toBe("/fake/browsers/chrome-155.0.8059.84/chrome-linux64/chrome");
  expect(chrome.profile).toBe(profile);
  for (const f of CHROME_ARGS) expect(chrome.args).toContain(f);
  expect(chrome.args).toContain("--headless=new");
  expect(chrome.args).toContain("--disable-blink-features=AutomationControlled");
  expect(chrome.args).toContain("--remote-debugging-port=0");
  expect(chrome.args).toContain(`--user-data-dir=${profile}`);
  expect(chrome.args.some((a) => a.includes("enable-automation"))).toBe(false);
  const ua = chrome.args.find((a) => a.startsWith("--user-agent="));
  expect(ua).toContain("Chrome/155.0.0.0");
  expect(ua).not.toContain("Headless");

  const [call] = t.logged();
  const args = call?.args ?? [];
  const flag = (name: string) => args[args.indexOf(name) + 1];
  expect(flag("--cdp")).toBe(String(chrome.port));
  expect(flag("--session")).toBe("agent-01a142cb");
  expect(flag("--config")).toBe(path.join(t.home, "browser", "config.json"));
  expect(flag("--namespace")).toMatch(/^agentes-[0-9a-f]{8}$/);
  expect(args).toContain("--json");
  expect(args).toContain("--content-boundaries");
  expect(args).toContain("--no-webmcp");
  // agent-browser never launches a Chrome of its own.
  expect(args).not.toContain("--executable-path");
  expect(args).not.toContain("--profile");
  expect(args).not.toContain("--args");
  expect(args.slice(-2)).toEqual(["open", "https://shop.example.com"]);
  expect(readFileSync(path.join(t.home, "browser", "config.json"), "utf8").trim()).toBe("{}");
  // The same Chrome for the next command; its pid is remembered for a crash.
  await t.act("click", ["@e1"]);
  expect(t.chromes).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(t.home, "browser", "chromes.json"), "utf8"))).toEqual([
    { pid: 40_001, profile },
  ]);
  // Another agent: its own Chrome, session and profile.
  await t.act("open", ["https://a.example"], { agent: ops });
  const other = t.logged().at(-1)?.args ?? [];
  expect(other[other.indexOf("--session") + 1]).toBe("agent-9f00aa11");
  expect(t.chromes).toHaveLength(2);
  expect(other[other.indexOf("--cdp") + 1]).toBe(String(t.chromes[1]?.port));
});

test("a normal Chrome user agent for the platform, and the whole launch line", () => {
  const exe = "/h/.agent-browser/browsers/chrome-155.0.8059.84/chrome-mac-arm64/Google Chrome for Testing";
  expect(chromeUserAgent(exe, "darwin")).toBe(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  );
  expect(chromeUserAgent(exe, "win32")).toContain("Windows NT 10.0; Win64; x64");
  expect(chromeUserAgent(exe, "linux")).toContain("X11; Linux x86_64");
  expect(chromeUserAgent("/usr/bin/chrome", "linux")).toBeNull();
  const args = chromeLaunchArgs(exe, "/p", "darwin", "pt-BR");
  expect(args).toContain("--lang=pt-BR");
  expect(args).toContain("--user-data-dir=/p");
  // Never the person's keychain (macOS would ask for their password).
  expect(args).toContain("--use-mock-keychain");
  expect(chromeLaunchArgs(exe, "/p", "linux", null)).toContain("--password-store=basic");
  expect(args.at(-1)).toBe("about:blank");
  expect(chromeLaunchArgs("/usr/bin/chrome", "/p", "linux", null).some((a) => a.startsWith("--user-agent"))).toBe(
    false,
  );
});

/** Starts a fake Chrome that runs `body` (sh) and exits; what `launchChrome` threw. */
async function failedStart(body: string): Promise<ChromeStartError> {
  const dir = tempDir("chrome-");
  dirs.push(dir);
  const exe = path.join(dir, "chrome");
  writeFileSync(exe, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const err = await launchChrome(exe, ["--headless=new"], dir).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChromeStartError);
  return err as ChromeStartError;
}

test.if(posix)(
  "a Chrome that can't load its libraries says which, in words for people; a profile in use only when Chrome says so",
  async () => {
    const loader = `echo "$0: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory" >&2; exit 127`;
    let err = await failedStart(loader);
    expect(err.missing).toEqual(["libnspr4.so"]);
    expect(err.message).toBe(
      "the agent's computer is missing system libraries Chrome needs (libnspr4.so); install them on it, then try again",
    );
    expect(err.detail).toMatch(
      /^missing libnspr4\.so: \/.+\/chrome: error while loading shared libraries: libnspr4\.so:/,
    );

    // The loader stops at the first one: ldd lists them all, and people read the first few.
    const bin = tempDir("ldd-");
    dirs.push(bin);
    const libs = ["libglib-2.0.so.0", "libnss3.so", "libnssutil3.so", "libsmime3.so", "libnspr4.so", "libX11.so.6"];
    const all = [...libs, "libasound.so.2"];
    writeFileSync(
      path.join(bin, "ldd"),
      `#!/bin/sh\nprintf '\\tlibc.so.6 => /lib/libc.so.6 (0x7f00)\\n'\nfor l in ${all.join(" ")}; do printf '\\t%s => not found\\n' "$l"; done\n`,
      { mode: 0o755 },
    );
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      err = await failedStart(loader);
    } finally {
      process.env.PATH = PATH;
    }
    expect(err.missing).toEqual(all);
    expect(err.message).toContain(`(${libs.slice(0, 5).join(", ")} and 2 more); install them on it`);
    expect(err.detail).toStartWith(`missing ${all.join(", ")}: `);

    // A profile another Chrome holds, as Chrome for Testing says it and exits.
    const held =
      "Failed to create a ProcessSingleton for your profile directory. Aborting now to avoid profile corruption.";
    err = await failedStart(`echo "${held}" >&2; exit 21`);
    expect(err.missing).toEqual([]);
    expect(err.message).toBe("Chrome closed while starting (another Chrome is using this profile)");
    expect(err.detail).toBe(held);

    // Any other exit, a loader error among them, gets no guess at why; what Chrome said goes to the logs.
    err = await failedStart(`echo "$0: /lib/libc.so.6: version 'GLIBC_2.38' not found (required by $0)" >&2; exit 1`);
    expect(err.missing).toEqual([]);
    expect(err.message).toBe("Chrome closed while starting");
    expect(err.detail).toContain("version 'GLIBC_2.38' not found");
  },
);

test.if(posix)("flags that reach outside the agent's browser, and unknown commands, are refused", async () => {
  const t = setup();
  expect(await errorCode(() => t.act("open", ["https://x.com", "--profile", "Default"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("open", ["https://x.com", "--cdp=9222"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("auth", ["login", "github"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("chat", ["hi"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("plugin", ["add", "x"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("open", ["file:///etc/passwd"]))).toBe("not_allowed");
  expect(await errorCode(() => t.act("open", ["FILE:///etc/passwd"]))).toBe("not_allowed");
  expect(await errorCode(() => t.act("open", ["view-source:file:///etc/passwd"]))).toBe("not_allowed");
  expect(await errorCode(() => t.act("goto", ["chrome://settings"]))).toBe("not_allowed");
  expect(await errorCode(() => t.act("tab", ["new", "File:///Users/x/.ssh/id_rsa"]))).toBe("not_allowed");
  expect(t.logged()).toHaveLength(0);
});

test.if(posix)("reads never start a browser: they say it isn't open", async () => {
  const t = setup();
  expect(await t.act("snapshot")).toMatchObject({ success: false, error: expect.stringContaining("isn't open") });
  // No Chrome started, and agent-browser never asked (it would launch one of its own).
  expect(t.chromes).toHaveLength(0);
  expect(t.logged()).toHaveLength(0);
  await t.act("open", ["https://shop.example.com"]);
  expect(await t.act("snapshot", ["-i"])).toMatchObject({ success: true, data: { snapshot: expect.any(String) } });
});

test.if(posix)(
  "a read right after a command that worked skips the open check; after an error it checks again",
  async () => {
    const t = setup();
    await t.act("open", ["https://shop.example.com"]);
    await t.act("snapshot");
    await t.act("snapshot");
    const commands = () => t.logged().map((c) => c.args.slice(-2).join(" "));
    expect(commands().filter((c) => c === "stream status")).toHaveLength(0);
    // A command that failed: the browser may be gone, so the next read asks first.
    await t.act("press", ["NoSuchKeyForTheFake"]).catch(() => undefined);
    await t.act("frame", ["x"]);
    await t.act("snapshot");
    expect(commands().filter((c) => c === "stream status")).toHaveLength(1);
  },
);

test("jpegSize reads a JPEG's frame header; captureMarks keeps only well-formed marks", () => {
  // SOI, an APP0 segment to skip, then SOF0 with 800 × 1280.
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0, 0, 0,
    0, 0, 0,
  ]);
  expect(jpegSize(jpeg)).toEqual({ width: 1280, height: 800 });
  expect(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  expect(
    captureMarks([
      { ref: "@e2", number: 2, role: "link", box: { x: 1, y: 2, width: 3, height: 4 } },
      { ref: "not-a-ref", box: {} },
      "nope",
    ]),
  ).toEqual([{ ref: "e2", number: 2, role: "link", box: { x: 1, y: 2, width: 3, height: 4 } }]);
});

test.if(posix)(
  "a batch runs back to back in the agent's session and stops at a failure it doesn't tolerate",
  async () => {
    const t = setup();
    const res = await t.manager.batch(dev, await t.folder(), {
      op: "browser.batch",
      commands: [
        { command: "open", args: ["https://shop.example.com"], timeoutSeconds: 30 },
        // The fake knows neither: one tolerated, one not.
        { command: "fill", args: ["@e1", "x"], timeoutSeconds: 30, tolerate: true },
        { command: "snapshot", args: ["-c"], timeoutSeconds: 30 },
        { command: "press", args: ["Enter"], timeoutSeconds: 30 },
        { command: "click", args: ["@e1"], timeoutSeconds: 30 },
      ],
    });
    expect(res.answers.map((a) => a.success)).toEqual([true, false, true, false]);
    expect(res.answers[2]).toMatchObject({ data: { snapshot: '- button "Go" [ref=e1]' } });
    // The command after the failure never ran.
    expect(t.logged().some((c) => c.args.slice(-2).join(" ") === "click @e1")).toBe(false);
  },
);

test.if(posix)("a command that throws mid-batch keeps the answers of what already ran", async () => {
  const t = setup();
  const res = await t.manager.batch(dev, await t.folder(), {
    op: "browser.batch",
    commands: [
      { command: "open", args: ["https://shop.example.com"], timeoutSeconds: 30 },
      // Checked when it runs: a bad ref throws there.
      { command: "agentes:type_secret", args: ["not-a-ref", "X"], timeoutSeconds: 30 },
      { command: "snapshot", args: [], timeoutSeconds: 30 },
    ],
  });
  expect(res.answers.map((a) => a.success)).toEqual([true, false]);
  expect(res.answers[1]?.error).toContain("agentes:type_secret takes a ref");
});

test.if(posix)("a capture of a page outside the agent's sites is refused (like every read)", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  expect(await errorCode(async () => t.manager.capture(dev, await t.folder(), ["other.example"]))).toBe("not_allowed");
  expect(t.logged().some((c) => c.args.includes("--annotate"))).toBe(false);
});

test.if(posix)("a batch with one command that wouldn't pass is refused before anything runs", async () => {
  const t = setup();
  const folder = await t.folder();
  const batch = (commands: { command: string; args: string[] }[], allowedDomains?: string[]) =>
    errorCode(() =>
      t.manager.batch(dev, folder, {
        op: "browser.batch",
        commands: commands.map((c) => ({ ...c, timeoutSeconds: 30 })),
        ...(allowedDomains ? { allowedDomains } : {}),
      }),
    );
  expect(
    await batch(
      [
        { command: "open", args: ["https://shop.example.com"] },
        { command: "open", args: ["https://evil.example"] },
      ],
      ["shop.example.com"],
    ),
  ).toBe("not_allowed");
  expect(await batch([{ command: "open", args: ["https://x.com", "--profile", "Default"] }])).toBe("bad_request");
  expect(await batch([{ command: "chat", args: ["hi"] }])).toBe("bad_request");
  expect(await batch([])).toBe("bad_request");
  expect(t.logged()).toHaveLength(0);
});

test.if(posix)("capture: the page as a JPEG with its numbered elements, and the file gone at once", async () => {
  const t = setup();
  expect(await errorCode(async () => t.manager.capture(dev, await t.folder()))).toBe("bad_request");
  await t.act("open", ["https://shop.example.com"]);
  const shot = await t.manager.capture(dev, await t.folder());
  expect(shot).toMatchObject({
    width: 1280,
    height: 800,
    viewport: { width: 1280, height: 800 },
    url: "https://shop.example.com",
    marks: [{ ref: "e1", number: 1, role: "button", name: "Go", box: { x: 10, y: 20, width: 100, height: 40 } }],
  });
  expect([...Buffer.from(shot.data, "base64").subarray(0, 2)]).toEqual([0xff, 0xd8]);
  expect(readdirSync(path.join(await t.folder(), ".agentes", "captures"))).toEqual([]);
  const call = t.logged().find((c) => c.args.includes("--annotate"));
  expect(call?.args).toContain("jpeg");
});

test.if(posix)("the first screenshot works: its folder is made before", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  const res = await t.act("screenshot", ["screenshots/2026/first.png"]);
  expect(res).toMatchObject({ success: true });
  expect(existsSync(path.join(await t.folder(), "screenshots", "2026", "first.png"))).toBe(true);
  expect(existsSync(path.join(await t.folder(), "downloads"))).toBe(true);
});

test.if(posix)("the allowlist stops navigations before they go and pages that wander off after an action", async () => {
  const t = setup();
  const allowedDomains = ["shop.example.com"];
  expect(await errorCode(() => t.act("open", ["https://evil.com"], { allowedDomains }))).toBe("not_allowed");
  expect(await t.act("open", ["shop.example.com/login"], { allowedDomains })).toMatchObject({ success: true });
  t.page({ clickTo: "https://evil.com/phish" });
  const res = await t.act("click", ["@e1"], { allowedDomains });
  expect(res).toMatchObject({ success: false, error: expect.stringContaining("evil.com") });
  expect(t.logged().some((c) => c.args.at(-1) === "back")).toBe(true);
  expect(JSON.parse(readFileSync(process.env.FAKE_AB_STATE as string, "utf8")).url).toBe(
    "https://shop.example.com/login",
  );
});

test.if(posix)("with an allowlist, an off-list page is never read and never left open", async () => {
  const t = setup();
  const allowedDomains = ["shop.example.com"];
  await t.act("open", ["https://shop.example.com/"], { allowedDomains });
  // A script moved the page by itself: reading it is refused, and with no history to go back to it goes blank.
  t.page({ url: "https://evil.com/x", noHistory: true });
  const read = await t.act("snapshot", ["-c"], { allowedDomains });
  expect(read).toMatchObject({ success: false, error: expect.stringContaining("now blank") });
  expect(t.logged().some((c) => c.args.includes("snapshot"))).toBe(false);
  expect(JSON.parse(readFileSync(process.env.FAKE_AB_STATE as string, "utf8")).url).toBe("about:blank");
  // Switching to a new tab a link opened on another site: checked too, and blanked.
  t.page({ url: "https://shop.example.com/", tabTo: "https://evil.com/phish", noHistory: true });
  expect(await t.act("tab", ["1"], { allowedDomains })).toMatchObject({
    success: false,
    error: expect.stringContaining("evil.com"),
  });
  expect(JSON.parse(readFileSync(process.env.FAKE_AB_STATE as string, "utf8")).url).toBe("about:blank");
});

test.if(posix)("uploads and screenshots stay in the agent's folder", async () => {
  const t = setup();
  const folder = await t.folder();
  writeFileSync(path.join(folder, "logo.png"), "x");
  expect(await t.act("upload", ["@e2", "logo.png"])).toMatchObject({
    success: true,
    data: { files: [path.join(folder, "logo.png")] },
  });
  expect(await errorCode(() => t.act("upload", ["@e2", "../../etc/passwd"]))).toBe("outside_workspace");
  expect(await errorCode(() => t.act("screenshot", ["/tmp/out.png"]))).toBe("outside_workspace");
});

test.if(posix)("the per-machine cap refuses one browser too many", async () => {
  const t = setup({ maxSessions: 1 });
  await t.act("open", ["https://a.example"]);
  expect(await errorCode(() => t.act("open", ["https://b.example"], { agent: ops }))).toBe("browser_unavailable");
  await t.manager.stop(dev);
  expect(await t.act("open", ["https://b.example"], { agent: ops })).toMatchObject({ success: true });
});

test.if(posix)("a secret is typed through stdin into a password field only, and never comes back", async () => {
  const secret = "hunter2-very-secret";
  const t = setup({}, { SHOP_PASSWORD: secret });
  const typeSecret = (ref: string, name: string, site = "https://shop.example.com") =>
    t.act("agentes:type_secret", [ref, name, site]);
  await t.act("open", ["https://shop.example.com/login"]);
  expect(await typeSecret("@e3", "MISSING_ONE")).toMatchObject({
    success: false,
    error: expect.stringContaining("request_secret"),
  });
  t.page({ attrs: { "@e3": { type: "text", autocomplete: "username" }, "@e4": { type: "password" } } });
  expect(await typeSecret("@e3", "SHOP_PASSWORD")).toMatchObject({
    success: false,
    error: expect.stringContaining("isn't a password"),
  });
  const ok = await typeSecret("e4", "SHOP_PASSWORD");
  expect(ok).toEqual({ success: true, data: { typed: "SHOP_PASSWORD", into: "@e4" } });
  expect(JSON.stringify(ok)).not.toContain(secret);
  const calls = t.logged();
  expect(calls.some((c) => c.args.join(" ").includes(secret))).toBe(false);
  const batch = calls.find((c) => c.args.includes("batch"));
  expect(JSON.parse(batch?.stdin ?? "[]")).toEqual([["fill", "@e4", secret]]);
  // One-time codes count too.
  t.page({ attrs: { "@e5": { type: "text", autocomplete: "one-time-code" } } });
  expect(await typeSecret("@e5", "SHOP_PASSWORD")).toMatchObject({ success: true });
  expect(await errorCode(() => typeSecret("#password", "SHOP_PASSWORD"))).toBe("bad_request");
  // Only on the site it was asked for: another site (an injected page) never gets it.
  const typedBefore = t.logged().filter((c) => c.args.includes("batch")).length;
  expect(await typeSecret("e4", "SHOP_PASSWORD", "https://bank.example")).toMatchObject({
    success: false,
    error: expect.stringContaining("only for bank.example"),
  });
  expect(await errorCode(() => t.act("agentes:type_secret", ["e4", "SHOP_PASSWORD"]))).toBe("bad_request");
  expect(t.logged().filter((c) => c.args.includes("batch")).length).toBe(typedBefore);
});

test.if(posix)("stop closes the agent's browser and its Chrome; a second stop finds nothing", async () => {
  const t = setup();
  await t.act("open", ["https://a.example"]);
  expect(await t.manager.stop(dev)).toEqual({ stopped: true });
  expect(t.logged().at(-1)?.args.at(-1)).toBe("close");
  expect(t.chromes[0]?.killed).toBe(true);
  expect(JSON.parse(readFileSync(path.join(t.home, "browser", "chromes.json"), "utf8"))).toEqual([]);
  expect(await t.manager.stop(dev)).toEqual({ stopped: false });
  // The agent's own close stops its Chrome too; the next page starts a new one on the same profile.
  await t.act("open", ["https://a.example"]);
  expect(await t.act("close")).toMatchObject({ success: true });
  expect(t.chromes[1]?.killed).toBe(true);
  await t.act("open", ["https://b.example"]);
  expect(t.chromes).toHaveLength(3);
  expect(t.chromes[2]?.profile).toBe(t.chromes[0]?.profile);
});

test.if(posix)("an idle browser's Chrome stops, but not while someone watches or a help request is open", async () => {
  let now = 1_000_000;
  const t = setup({ now: () => now, idleMs: 60_000 });
  await t.act("open", ["https://a.example"]);
  await t.act("open", ["https://b.example"], { agent: ops });
  t.manager.setHandoff(ops.id, { status: "pending" });
  now += 61_000;
  await t.manager.sweep();
  expect(t.chromes[0]?.killed).toBe(true);
  expect(t.chromes[1]?.killed).toBe(false);
  t.manager.setHandoff(ops.id, null);
  await t.manager.sweep();
  expect(t.chromes[1]?.killed).toBe(true);
});

test.if(posix)(
  "the runner stopping stops its Chromes; one a crashed run left is stopped on the next start",
  async () => {
    const t = setup();
    await t.act("open", ["https://a.example"]);
    await t.manager.close();
    expect(t.chromes[0]?.killed).toBe(true);

    // A leftover in chromes.json: stopped only when it is still that Chrome (a reused pid is left alone).
    const home = tempDir("runner-home-");
    dirs.push(home);
    mkdirSync(path.join(home, "browser"), { recursive: true });
    writeFileSync(
      path.join(home, "browser", "chromes.json"),
      JSON.stringify([
        { pid: 999_999_901, profile: "/x/.agentes/browser" },
        { pid: 999_999_902, profile: "/y/.agentes/browser" },
      ]),
    );
    const asked: number[] = [];
    const manager = new BrowserManager({
      home,
      log: () => {},
      send: () => true,
      secret: async () => null,
      command: [process.execPath, FAKE],
      chrome: () => null,
      isOurChrome: async (pid) => {
        asked.push(pid);
        return false;
      },
    });
    await manager.closeAll();
    expect(asked).toEqual([999_999_901, 999_999_902]);
    expect(JSON.parse(readFileSync(path.join(home, "browser", "chromes.json"), "utf8"))).toEqual([]);
  },
);

test.if(posix)("a command while the browsers close (a runner that just started) starts its Chrome after", async () => {
  const chromes = fakeChromes();
  let closing = true;
  const startedWhileClosing: boolean[] = [];
  const t = setup({
    startChrome: (exe, args, profile) => {
      startedWhileClosing.push(closing);
      return chromes.start(exe, args, profile);
    },
  });
  const closed = t.manager.closeAll().then(() => {
    closing = false;
  });
  expect(await t.act("open", ["https://a.example/"])).toMatchObject({ success: true });
  await closed;
  expect(startedWhileClosing).toEqual([false]);
  expect(t.logged().map((l) => l.args.at(-1))).toEqual(["--all", "https://a.example/"]);
});

/** A computer without Chrome for Testing until the fake's `install` ran. */
function setupWithoutChrome() {
  const box: { t?: ReturnType<typeof setup> } = {};
  const installs = () => box.t?.logged().filter((l) => l.args[0] === "install").length ?? 0;
  box.t = setup({
    chrome: () => (installs() > 0 ? "/fake/browsers/chrome-155.0.8059.84/chrome-linux64/chrome" : null),
  });
  return { t: box.t, installs };
}

test.if(posix)("an agent's first two commands at once share its new session and one Chrome install", async () => {
  const { t, installs } = setupWithoutChrome();
  const folder = await t.folder();
  const act = (command: string, args: string[]) =>
    t.manager.act(dev, folder, { op: "browser.act", command, args, timeoutSeconds: 30 });
  // The person's open and the live view's `get url` right after it, as the app sends them.
  const [opened, url] = await Promise.all([act("open", ["https://a.example/"]), act("get", ["url"])]);
  expect(opened).toMatchObject({ success: true });
  // In the same session's queue, behind the open (a second session has no Chrome: "the browser isn't open").
  expect(url).toMatchObject({ success: true, data: { url: "https://a.example/" } });
  expect(installs()).toBe(1);
  expect(t.chromes).toHaveLength(1);
});

test.if(posix)("two agents' first commands at once install Chrome once", async () => {
  const { t, installs } = setupWithoutChrome();
  const answers = await Promise.all([
    t.act("open", ["https://a.example/"]),
    t.act("open", ["https://b.example/"], { agent: ops }),
  ]);
  expect(answers).toMatchObject([{ success: true }, { success: true }]);
  expect(installs()).toBe(1);
});

// ── Live view ────────────────────────────────────────────────────────────────

test.if(posix)("the stream relays frames with the page's URL, changes mode, and ends with a frame", async () => {
  const t = setup();
  expect(await errorCode(() => t.manager.streamStart(dev, "watch"))).toBe("browser_closed");
  await t.act("open", ["https://shop.example.com"]);
  expect(await t.manager.streamStart(dev, "watch")).toEqual({ mode: "watch" });
  const socket = t.sockets[0] as FakeSocket;
  expect(socket.url).toBe("ws://127.0.0.1:41234/?maxFps=1");
  socket.push({ type: "url", url: "https://shop.example.com/cart" });
  socket.push({
    type: "frame",
    seq: 7,
    data: "/9j/AAA",
    metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1 },
  });
  socket.push({ type: "frame", seq: 8, data: "/9j/AAA", metadata: {} }); // no size: dropped
  expect(t.frames).toEqual([
    {
      type: "browser.frame",
      agentId: dev.id,
      seq: 7,
      data: "/9j/AAA",
      metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, url: "https://shop.example.com/cart" },
    },
  ]);
  expect(await t.manager.streamStart(dev, "control")).toEqual({ mode: "control" });
  expect(t.sockets).toHaveLength(1);
  expect(socket.sent).toEqual([{ type: "config", maxFps: 15 }]);
  expect(await t.manager.streamStop(dev)).toEqual({ stopped: true });
  expect(socket.closed).toBe(true);
  expect(t.frames.at(-1)).toEqual({ type: "browser.stream.ended", agentId: dev.id, reason: "stopped" });
  expect(await t.manager.streamStop(dev)).toEqual({ stopped: false });
});

test.if(posix)("a stream can't start on a closed browser, never opened or closed since: browser_closed", async () => {
  const t = setup();
  expect(await errorCode(() => t.manager.streamStart(dev, "watch"))).toBe("browser_closed");
  await t.act("open", ["https://shop.example.com"]);
  await t.act("close");
  expect(await errorCode(() => t.manager.streamStart(dev, "control"))).toBe("browser_closed");
  expect(t.sockets).toHaveLength(0);
  // Opening a page (the agent, or a person in control) starts it again, and it streams.
  await t.act("open", ["https://shop.example.com"]);
  expect(await t.manager.streamStart(dev, "watch")).toEqual({ mode: "watch" });
  await t.manager.streamStop(dev);
});

test.if(posix)(
  "an idle page shows at once: a stream with no frame sends one screenshot, with the tab's address and title",
  async () => {
    const t = setup({ firstFrameMs: 5 });
    await t.act("open", ["https://shop.example.com"]);
    await t.manager.streamStart(dev, "watch");
    const socket = t.sockets[0] as FakeSocket;
    // What the stream says on connect: the page's size, then the tabs (the active one's title).
    socket.push({ type: "status", connected: true, viewportWidth: 1280, viewportHeight: 720 });
    socket.push({
      type: "tabs",
      tabs: [
        { url: "https://x.example/", title: "X", active: false },
        { url: "https://shop.example.com/", title: "Loja", active: true },
      ],
    });
    await waitFor(() => t.frames.some((f) => f.type === "browser.frame"));
    expect(t.frames[0]).toEqual({
      type: "browser.frame",
      agentId: dev.id,
      seq: 0,
      data: expect.stringMatching(/^\/9j\//), // the JPEG the fake writes for a .jpg
      metadata: { deviceWidth: 1280, deviceHeight: 720, url: "https://shop.example.com/", title: "Loja" },
    });
    const shot = t.logged().find((c) => c.args.includes("screenshot"));
    expect(shot?.args.slice(-6)).toEqual([
      "screenshot",
      path.join(t.home, "browser", "agent-01a142cb-frame.jpg"),
      "--screenshot-format",
      "jpeg",
      "--screenshot-quality",
      "70",
    ]);
    expect(existsSync(path.join(t.home, "browser", "agent-01a142cb-frame.jpg"))).toBe(false);
    // Another page: frames carry its address; its title comes with the next tab list.
    socket.push({ type: "url", url: "https://shop.example.com/cart" });
    socket.push({ type: "frame", seq: 3, data: "/9j/B", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
    expect(t.frames.at(-1)).toEqual({
      type: "browser.frame",
      agentId: dev.id,
      seq: 3,
      data: "/9j/B",
      metadata: { deviceWidth: 1280, deviceHeight: 720, url: "https://shop.example.com/cart" },
    });
    await t.manager.streamStop(dev);
  },
);

test.if(posix)("a page that repaints by itself gets no screenshot", async () => {
  const t = setup({ firstFrameMs: 5 });
  await t.act("open", ["https://shop.example.com"]);
  await t.manager.streamStart(dev, "watch");
  const socket = t.sockets[0] as FakeSocket;
  socket.push({ type: "status", connected: true, viewportWidth: 1280, viewportHeight: 720 });
  socket.push({ type: "frame", seq: 1, data: "/9j/A", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
  await Bun.sleep(40);
  expect(t.logged().some((c) => c.args.includes("screenshot"))).toBe(false);
  expect(t.frames.filter((f) => f.type === "browser.frame")).toHaveLength(1);
  await t.manager.streamStop(dev);
});

test.if(posix)("two starts at once open one socket; a stop sent meanwhile closes it", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  const [a, b] = await Promise.all([t.manager.streamStart(dev, "watch"), t.manager.streamStart(dev, "control")]);
  expect(a).toEqual({ mode: "watch" });
  expect(b).toEqual({ mode: "control" });
  expect(t.sockets).toHaveLength(1);
  expect((t.sockets[0] as FakeSocket).sent).toEqual([{ type: "config", maxFps: 15 }]);
  await t.manager.streamStop(dev);
  const opening = t.manager.streamStart(dev, "watch");
  const stopped = t.manager.streamStop(dev);
  await opening;
  expect(await stopped).toEqual({ stopped: true });
  expect(t.sockets).toHaveLength(2);
  expect((t.sockets[1] as FakeSocket).closed).toBe(true);
});

test.if(posix)("a stream that closes on the machine says so; one dropped with the connection doesn't", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  await t.manager.streamStart(dev, "watch");
  (t.sockets[0] as FakeSocket).close();
  expect(t.frames.at(-1)).toEqual({ type: "browser.stream.ended", agentId: dev.id, reason: "closed" });
  await t.manager.streamStart(dev, "watch");
  const count = t.frames.length;
  t.manager.stopStreams();
  expect((t.sockets[1] as FakeSocket).closed).toBe(true);
  expect(t.frames).toHaveLength(count);
});

/** agent-browser's command relay on the stream port: records each command and answers like the daemon. */
function fakeRelay(answer: (body: Record<string, unknown>) => Record<string, unknown> = () => ({ success: true })) {
  const received: { body: Record<string, unknown>; origin: string | null; type: string | null; path: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      received.push({
        body,
        origin: req.headers.get("origin"),
        type: req.headers.get("content-type"),
        path: new URL(req.url).pathname,
      });
      // A little delay so out-of-order sends would show.
      await Bun.sleep(body.type === "mousePressed" ? 15 : 1);
      return Response.json({ data: { dispatched: body.type ?? body.action }, ...answer(body) });
    },
  });
  return { server, received, port: server.port as number };
}

test.if(posix)("a person's input goes through the daemon's command relay, in order, confirmed", async () => {
  const t = setup();
  const relay = fakeRelay();
  try {
    await t.act("open", ["https://shop.example.com"]);
    t.page({ port: relay.port });
    expect(await errorCode(() => t.manager.input(dev, [{ kind: "text", text: "x" }]))).toBe("bad_request");
    await t.manager.streamStart(dev, "control");
    const socket = t.sockets[0] as FakeSocket;
    const res = await t.manager.input(dev, [
      { kind: "mouse", type: "mouseMoved", x: 5, y: 6 },
      { kind: "mouse", type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 },
      { kind: "mouse", type: "mouseReleased", x: 5, y: 6, button: "left", clickCount: 1 },
      { kind: "key", type: "keyDown", key: "Enter" },
      { kind: "key", type: "keyUp", key: "Enter" },
      { kind: "text", text: "senha-ção" },
      { kind: "nonsense" },
    ]);
    expect(res).toEqual({ accepted: 6 });
    // Nothing goes over the stream socket but the frame rate.
    expect(socket.sent).toEqual([]);
    expect(relay.received.map((r) => r.path)).toEqual(Array(5).fill("/api/command"));
    expect(relay.received.map((r) => r.origin)).toEqual(Array(5).fill(`http://127.0.0.1:${relay.port}`));
    expect(relay.received.every((r) => r.type === "application/json")).toBe(true);
    expect(relay.received.map((r) => r.body.type ?? r.body.action)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
      "press",
      "keyboard",
    ]);
    expect(relay.received[1]?.body).toMatchObject({ action: "input_mouse", x: 5, y: 6, button: "left", clickCount: 1 });
    expect(relay.received[3]?.body).toMatchObject({ action: "press", key: "Enter" });
    expect(relay.received[4]?.body).toMatchObject({ subaction: "insertText", text: "senha-ção" });
    expect(new Set(relay.received.map((r) => r.body.id)).size).toBe(5);
    // Never typed text on a command line.
    expect(t.logged().some((c) => c.args.join(" ").includes("senha") || c.stdin.includes("senha"))).toBe(false);
    // Two batches sent at once still reach the browser in the order they came.
    relay.received.length = 0;
    await Promise.all([
      t.manager.input(dev, [{ kind: "mouse", type: "mousePressed", x: 1, y: 1 }]),
      t.manager.input(dev, [{ kind: "mouse", type: "mouseReleased", x: 1, y: 1 }]),
    ]);
    expect(relay.received.map((r) => r.body.type)).toEqual(["mousePressed", "mouseReleased"]);
  } finally {
    relay.server.stop(true);
  }
});

test.if(posix)("input the browser doesn't confirm is counted as failed", async () => {
  const t = setup();
  const relay = fakeRelay((body) =>
    body.type === "mousePressed" ? { success: false, error: "Browser not launched" } : {},
  );
  try {
    await t.act("open", ["https://shop.example.com"]);
    t.page({ port: relay.port });
    await t.manager.streamStart(dev, "control");
    const res = await t.manager.input(dev, [
      { kind: "mouse", type: "mousePressed", x: 1, y: 1 },
      { kind: "mouse", type: "mouseReleased", x: 1, y: 1 },
    ]);
    expect(res).toEqual({ accepted: 1, failed: 1 });
    // The stream ended: the rest of a batch is not sent to a browser that isn't there.
    (t.sockets[0] as FakeSocket).close();
    relay.received.length = 0;
    expect(await errorCode(() => t.manager.input(dev, [{ kind: "text", text: "x" }]))).toBe("bad_request");
    expect(relay.received).toEqual([]);
  } finally {
    relay.server.stop(true);
  }
});

// ── Readiness ────────────────────────────────────────────────────────────────

test("a download that doesn't match its pinned checksum is never used", async () => {
  const home = tempDir("runner-home-");
  const bin = tempDir("runner-bin-");
  dirs.push(home, bin);
  if (!agentBrowserTarget()) return;
  let fetched = "";
  const manager = new BrowserManager({
    home,
    log: () => {},
    send: () => true,
    secret: async () => null,
    execPath: path.join(bin, "agentes-runner"),
    chrome: () => "/fake/chrome",
    fetch: (async (url: string) => {
      fetched = url;
      return new Response("not the real binary");
    }) as unknown as typeof fetch,
  });
  expect(manager.info()).toMatchObject({ available: true, version: AGENT_BROWSER_VERSION, chrome: "Google Chrome" });
  const ws = tempDir();
  dirs.push(ws);
  const act = () =>
    manager.act(dev, ws, { op: "browser.act", command: "open", args: ["https://a.example"], timeoutSeconds: 5 });
  expect(await errorCode(act)).toBe("browser_unavailable");
  expect(fetched).toContain(`/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-`);
  expect(existsSync(path.join(home, "bin"))).toBe(false);
  expect(manager.info()).toMatchObject({ available: false, reason: expect.stringContaining("checksum") });
  // Not tried again right away.
  fetched = "";
  expect(await errorCode(act)).toBe("browser_unavailable");
  expect(fetched).toBe("");
});

test.if(posix)("the desktop app's sidecar is used as is, and closeAll closes this runner's browsers only", async () => {
  const home = tempDir("runner-home-");
  const bin = tempDir("runner-bin-");
  dirs.push(home, bin);
  const log = path.join(home, "sidecar.log");
  const sidecar = path.join(bin, "agent-browser");
  writeFileSync(sidecar, `#!/bin/sh\necho "$@" >> '${log}'\necho '{"success":true,"data":null}'\n`);
  chmodSync(sidecar, 0o755);
  const manager = new BrowserManager({
    home,
    log: () => {},
    send: () => true,
    secret: async () => null,
    execPath: path.join(bin, "agentes-runner"),
    chrome: () => null,
  });
  expect(manager.info()).toMatchObject({ available: true });
  await manager.closeAll();
  const line = readFileSync(log, "utf8").trim();
  expect(line).toMatch(/^--namespace agentes-[0-9a-f]{8} --json close --all$/);
});

// ── Requests ─────────────────────────────────────────────────────────────────

test.if(posix)("browser ops need the machine's browser switch, except stopping", async () => {
  const t = setup();
  let access: RunnerAccess = { folders: [], tools: { claude: false, codex: false, commands: true } };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", access: () => access, browser: t.manager };
  const call = (req: MachineRequest) => handleRequest(ctx, req, scope);
  const open: MachineRequest = {
    agent: dev,
    op: "browser.act",
    command: "open",
    args: ["https://a.example"],
    timeoutSeconds: 5,
  };
  expect(await errorCode(() => call(open))).toBe("not_allowed");
  access = { ...access, tools: { ...access.tools, browser: true } };
  expect(await call(open)).toMatchObject({ success: true });
  // The agent's own folder was used.
  expect(existsSync(path.join(t.ws, "dev-01a142cb", ".agentes", "browser"))).toBe(true);
  access = { ...access, tools: { ...access.tools, browser: false } };
  expect(await call({ agent: dev, op: "browser.stop" })).toEqual({ stopped: true });
  expect(await errorCode(() => call({ op: "browser.stop" }))).toBe("bad_request");
  expect(await errorCode(() => handleRequest({ ...ctx, browser: undefined }, open, scope))).toBe("browser_unavailable");
});

test.if(posix)("a paused computer starts no browser work", async () => {
  const t = setup();
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const ctx = {
    workspaceReal: t.ws,
    exec: true,
    token: "agm_x",
    paused: () => true,
    access: (): RunnerAccess => ({
      folders: [],
      tools: { claude: false, codex: false, commands: true, browser: true },
    }),
    browser: t.manager,
  };
  const req: MachineRequest = {
    agent: dev,
    op: "browser.act",
    command: "open",
    args: ["https://a.example"],
    timeoutSeconds: 5,
  };
  expect(await errorCode(() => handleRequest(ctx, req, scope))).toBe("paused");
  expect(t.logged()).toHaveLength(0);
});

test("a frame reaches the server with the page's address and title, the title cut to its limit", () => {
  const frame = (metadata: Record<string, unknown>) =>
    parseRunnerFrame(JSON.stringify({ type: "browser.frame", agentId: dev.id, seq: 1, data: "/9j/A", metadata }));
  const size = { deviceWidth: 1280, deviceHeight: 720 };
  expect(frame({ ...size, url: "https://shop.example.com/", title: "Loja" })).toMatchObject({
    metadata: { ...size, url: "https://shop.example.com/", title: "Loja" },
  });
  const long = frame({ ...size, title: "x".repeat(BROWSER_LIMITS.title + 50) });
  expect(long?.type === "browser.frame" && long.metadata.title?.length).toBe(BROWSER_LIMITS.title);
  // An older runner sends none; an empty one isn't kept.
  const none = frame({ ...size, title: "" });
  expect(none?.type === "browser.frame" && "title" in none.metadata).toBe(false);
});

// ── For the desktop app's tray ───────────────────────────────────────────────

test("browser.handoff from the server parses; a malformed one is dropped", () => {
  const ok = parseServerFrame(
    JSON.stringify({ type: "browser.handoff", agentId: dev.id, handoff: { status: "pending", request: "Entrar" } }),
  );
  expect(ok).toEqual({ type: "browser.handoff", agentId: dev.id, handoff: { status: "pending", request: "Entrar" } });
  expect(parseServerFrame(JSON.stringify({ type: "browser.handoff", agentId: dev.id, handoff: null }))).not.toBeNull();
  expect(parseServerFrame(JSON.stringify({ type: "browser.handoff", handoff: null }))).toBeNull();
  expect(parseServerFrame(JSON.stringify({ type: "browser.handoff", agentId: dev.id, handoff: "x" }))).toBeNull();
});

test.skipIf(!posix)(
  "tray state: open with host, what it did and the conversation; a person's turn; closed",
  async () => {
    let changes = 0;
    const now = 1_000_000;
    const t = setup({ onChange: () => changes++, now: () => now });
    expect(t.manager.states()).toEqual([]);
    await t.manager.act(dev, await t.folder(), {
      op: "browser.act",
      command: "open",
      args: ["https://app.acme.example/login"],
      timeoutSeconds: 30,
      link: "/org/o1/c/c1",
    });
    await t.act("click", ["@e3"]);
    expect(t.manager.states()).toEqual([
      {
        agentId: dev.id,
        open: true,
        host: "app.acme.example",
        doing: "clicking",
        actedAt: new Date(now).toISOString(),
        link: "/org/o1/c/c1",
      },
    ]);
    expect(changes).toBeGreaterThan(0);

    // The server says a person was asked; then that one is in control; a link elsewhere is dropped.
    t.manager.setHandoff(dev.id, { status: "pending", request: "Entrar na Acme", link: "https://evil.example/x" });
    expect(t.manager.states()[0]?.handoff).toEqual({ status: "pending", request: "Entrar na Acme" });
    t.manager.setHandoff(dev.id, { status: "active", controller: "Walter", link: "/org/o1/c/c1?m=h1" });
    expect(t.manager.states()[0]?.handoff).toEqual({
      status: "active",
      controller: "Walter",
      link: "/org/o1/c/c1?m=h1",
    });

    // Closed with a request still open: it stays listed (not open) so the tray can say "precisa de você".
    await t.manager.stop(dev);
    expect(t.manager.states()).toEqual([
      { agentId: dev.id, open: false, handoff: { status: "active", controller: "Walter", link: "/org/o1/c/c1?m=h1" } },
    ]);
    t.manager.setHandoff(dev.id, null);
    expect(t.manager.states()).toEqual([]);

    // Offline: what the server told is forgotten (it tells again on reconnect).
    t.manager.setHandoff(ops.id, { status: "pending" });
    t.manager.clearHandoffs();
    expect(t.manager.states()).toEqual([]);
  },
);

test.skipIf(!posix)("tray state: a browser left idle stops counting as open", async () => {
  let now = 1_000_000;
  const t = setup({ now: () => now, idleMs: 60_000 });
  await t.act("open", ["https://a.example"]);
  expect(t.manager.states()[0]?.open).toBe(true);
  now += 61_000;
  expect(t.manager.states()).toEqual([]);
});
