import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AGENT_BROWSER_VERSION,
  BROWSER_PROTOCOL,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  type RunnerAccess,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { reduceAccess, setTool, TOOL_NAMES, widens } from "../../runner/access";
import {
  agentBrowserTarget,
  BrowserManager,
  type BrowserManagerOptions,
  chromeLabel,
  defaultMaxSessions,
  domainAllowed,
  type StreamSocket,
  streamMessage,
} from "../../runner/browser";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import { errorCode, removeDirs, tempDir } from "./helpers";

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
  const manager = new BrowserManager({
    home,
    log: () => {},
    send: (f) => {
      frames.push(f);
      return true;
    },
    secret: async (_agent, name) => secrets[name] ?? null,
    command: [process.execPath, FAKE],
    chrome: () => "/fake/chrome",
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
  return { ws, home, manager, frames, sockets, folder, act, logged, page };
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

test("protocol 12 is the runner's protocol, and the browser is a fourth machine switch", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBe(BROWSER_PROTOCOL);
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

test("stream input: keys get the codes and text CDP needs, shortcuts and key-ups type nothing", () => {
  expect(streamMessage({ kind: "key", type: "keyDown", key: "Enter" })).toMatchObject({
    type: "input_keyboard",
    eventType: "keyDown",
    key: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  });
  expect(streamMessage({ kind: "key", type: "keyDown", key: "Tab" })).not.toHaveProperty("text");
  expect(streamMessage({ kind: "key", type: "keyDown", key: "a" })).toMatchObject({
    text: "a",
    windowsVirtualKeyCode: 65,
  });
  expect(streamMessage({ kind: "key", type: "keyDown", key: "a", modifiers: 2 })).not.toHaveProperty("text");
  expect(streamMessage({ kind: "key", type: "keyUp", key: "a" })).not.toHaveProperty("text");
  expect(streamMessage({ kind: "mouse", type: "mousePressed", x: 10, y: 20 })).toEqual({
    type: "input_mouse",
    eventType: "mousePressed",
    x: 10,
    y: 20,
    button: "left",
    clickCount: 1,
    deltaX: 0,
    deltaY: 0,
    modifiers: 0,
  });
  expect(streamMessage({ kind: "touch", type: "touchStart", touchPoints: [{ x: 1, y: 2 }] })).toMatchObject({
    type: "input_touch",
    eventType: "touchStart",
  });
  expect(streamMessage({ kind: "text", text: "olá" })).toBeNull();
});

// ── Commands ─────────────────────────────────────────────────────────────────

test.if(posix)("commands run in the agent's own session and profile, with our flags", async () => {
  const t = setup();
  expect(await t.act("open", ["https://shop.example.com"])).toMatchObject({ success: true });
  const [call] = t.logged();
  const args = call?.args ?? [];
  const flag = (name: string) => args[args.indexOf(name) + 1];
  expect(flag("--session")).toBe("agent-01a142cb");
  expect(flag("--profile")).toBe(path.join(await t.folder(), ".agentes", "browser"));
  expect(flag("--config")).toBe(path.join(t.home, "browser", "config.json"));
  expect(flag("--namespace")).toMatch(/^agentes-[0-9a-f]{8}$/);
  expect(args).toContain("--json");
  expect(args).toContain("--content-boundaries");
  expect(args).toContain("--no-webmcp");
  expect(args.slice(-2)).toEqual(["open", "https://shop.example.com"]);
  expect(readFileSync(path.join(t.home, "browser", "config.json"), "utf8").trim()).toBe("{}");
  // Another agent: another session and profile.
  await t.act("open", ["https://a.example"], { agent: ops });
  const other = t.logged().at(-1)?.args ?? [];
  expect(other[other.indexOf("--session") + 1]).toBe("agent-9f00aa11");
});

test.if(posix)("flags that reach outside the agent's browser, and unknown commands, are refused", async () => {
  const t = setup();
  expect(await errorCode(() => t.act("open", ["https://x.com", "--profile", "Default"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("open", ["https://x.com", "--cdp=9222"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("auth", ["login", "github"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("chat", ["hi"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("plugin", ["add", "x"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("open", ["file:///etc/passwd"]))).toBe("not_allowed");
  expect(t.logged()).toHaveLength(0);
});

test.if(posix)("reads never launch a blank browser: they say it isn't open", async () => {
  const t = setup();
  expect(await t.act("snapshot")).toMatchObject({ success: false, error: expect.stringContaining("isn't open") });
  expect(t.logged().map((c) => c.args.slice(-2).join(" "))).toEqual(["stream status"]);
  await t.act("open", ["https://shop.example.com"]);
  expect(await t.act("snapshot", ["-i"])).toMatchObject({ success: true, data: { snapshot: expect.any(String) } });
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
  const typeSecret = (ref: string, name: string) => t.act("agentes:type_secret", [ref, name]);
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
});

test.if(posix)("stop closes the agent's browser; a second stop finds nothing", async () => {
  const t = setup();
  await t.act("open", ["https://a.example"]);
  expect(await t.manager.stop(dev)).toEqual({ stopped: true });
  expect(t.logged().at(-1)?.args.at(-1)).toBe("close");
  expect(await t.manager.stop(dev)).toEqual({ stopped: false });
});

// ── Live view ────────────────────────────────────────────────────────────────

test.if(posix)("the stream relays frames with the page's URL, changes mode, and ends with a frame", async () => {
  const t = setup();
  expect(await errorCode(() => t.manager.streamStart(dev, "watch"))).toBe("bad_request");
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
  expect(t.manager.streamStop(dev)).toEqual({ stopped: true });
  expect(socket.closed).toBe(true);
  expect(t.frames.at(-1)).toEqual({ type: "browser.stream.ended", agentId: dev.id, reason: "stopped" });
  expect(t.manager.streamStop(dev)).toEqual({ stopped: false });
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

test.if(posix)("a person's input goes over the stream; whole text goes through stdin", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  expect(await errorCode(() => t.manager.input(dev, [{ kind: "text", text: "x" }]))).toBe("bad_request");
  await t.manager.streamStart(dev, "control");
  const socket = t.sockets[0] as FakeSocket;
  const res = await t.manager.input(dev, [
    { kind: "mouse", type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 },
    { kind: "key", type: "keyDown", key: "Enter" },
    { kind: "text", text: "senha-ção" },
    { kind: "nonsense" },
  ]);
  expect(res).toEqual({ accepted: 3 });
  expect(socket.sent.map((m) => m.type)).toEqual(["input_mouse", "input_keyboard"]);
  const typed = t.logged().find((c) => c.args.includes("batch"));
  expect(JSON.parse(typed?.stdin ?? "[]")).toEqual([["keyboard", "inserttext", "senha-ção"]]);
  expect(typed?.args.join(" ")).not.toContain("senha");
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
