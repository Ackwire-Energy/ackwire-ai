import { describe, expect, test } from "bun:test";
// By path: the client doesn't depend on the adapters, so the package isn't linked here.
import {
  DESKTOP_KEYBOARDS as PROTOCOL_KEYBOARDS,
  STREAM_CLOSE,
  STREAM_LIMITS,
} from "../../adapters/src/machine-protocol";
import type { BrowserHandoff, DesktopStatus } from "../src/index";
import {
  DESKTOP_CLOSE,
  DESKTOP_KEYBOARDS,
  desktopCloseState,
  desktopMode,
  desktopRetryMs,
  desktopSocketUrl,
  desktopStatusState,
  desktopWithHandoff,
  isTerminalExit,
  keyboardFor,
  TERMINAL_SIZE,
  terminalCloseState,
  terminalSize,
  terminalSocketUrl,
} from "../src/index";

const handoff = (over: Partial<BrowserHandoff> = {}): BrowserHandoff => ({
  id: "h1",
  agentId: "a1",
  runId: null,
  machineId: "m1",
  screen: "desktop",
  kind: "takeover",
  instructions: "",
  status: "active",
  requestedForUserId: null,
  controllerUserId: "me",
  note: null,
  expiresAt: null,
  createdAt: "2026-10-24T10:00:00.000Z",
  resolvedAt: null,
  ...over,
});

const status = (over: Partial<DesktopStatus> = {}): DesktopStatus => ({
  available: true,
  reason: null,
  detail: null,
  running: true,
  startedAt: null,
  controllerUserId: null,
  handoff: null,
  viewers: 0,
  canControl: true,
  canStart: true,
  terminal: { available: true, reason: null, allowed: true },
  ...over,
});

describe("the desktop panel", () => {
  test("the mirrors match the protocol: close codes and keyboard layouts", () => {
    for (const [name, code] of Object.entries(DESKTOP_CLOSE)) {
      expect(STREAM_CLOSE[name as keyof typeof STREAM_CLOSE]).toBe(code);
    }
    expect<string[]>([...DESKTOP_KEYBOARDS].sort()).toEqual(Object.keys(PROTOCOL_KEYBOARDS).sort());
  });

  test("close codes: what shows and whether it opens again by itself", () => {
    expect(desktopCloseState(4410)).toEqual({ state: "connecting", retry: "now" });
    expect(desktopCloseState(4409)).toEqual({ state: "hidden", retry: "later" });
    expect(desktopCloseState(4403)).toEqual({ state: "forbidden", retry: "never" });
    expect(desktopCloseState(4404, "no_desktop")).toEqual({ state: "unavailable", retry: "never" });
    expect(desktopCloseState(4429)).toEqual({ state: "busy", retry: "later" });
    expect(desktopCloseState(4503, "offline")).toEqual({ state: "offline", retry: "later" });
    expect(desktopCloseState(1000)).toEqual({ state: "ended", retry: "never" });
    expect(desktopCloseState(4502, "desktop_off")).toEqual({ state: "off", retry: "later" });
    expect(desktopCloseState(4502, "machine_paused")).toEqual({ state: "paused", retry: "later" });
    expect(desktopCloseState(4502, "runner_outdated")).toEqual({ state: "outdated", retry: "never" });
    expect(desktopCloseState(4502, "not_allowed")).toEqual({ state: "unavailable", retry: "never" });
    expect(desktopCloseState(4502, "internal")).toEqual({ state: "connecting", retry: "later" });
    for (const code of [1001, 1005, 1006, 1011, 1013, 4400, 4408]) {
      expect(desktopCloseState(code)).toEqual({ state: "connecting", retry: "later" });
    }
    expect([0, 1, 2, 3, 9].map(desktopRetryMs)).toEqual([1000, 2000, 5000, 10_000, 10_000]);
  });

  test("the desktop's state before a socket: off, someone else in control, or why it can't show", () => {
    expect(desktopStatusState(status(), "me")).toBeNull();
    expect(desktopStatusState(status({ running: false }), "me")).toBe("off");
    expect(desktopStatusState(status({ controllerUserId: "ana" }), "me")).toBe("hidden");
    expect(desktopStatusState(status({ controllerUserId: "me" }), "me")).toBeNull();
    expect(desktopStatusState(status({ available: false, reason: "offline" }), "me")).toBe("offline");
    expect(desktopStatusState(status({ available: false, reason: "runner_outdated" }), "me")).toBe("outdated");
    expect(desktopStatusState(status({ available: false, reason: "not_allowed" }), "me")).toBe("unavailable");
  });

  test("control only on the desktop's own handoff, active and mine", () => {
    expect(desktopMode(status({ handoff: handoff() }), "me")).toBe("control");
    expect(desktopMode(status({ handoff: handoff({ controllerUserId: "ana" }) }), "me")).toBe("watch");
    expect(desktopMode(status({ handoff: handoff({ status: "pending", controllerUserId: null }) }), "me")).toBe(
      "watch",
    );
    // The browser's handoff, its Chrome showing on the desktop: the same window, watched from here.
    expect(desktopMode(status({ handoff: handoff({ screen: "browser" }) }), "me")).toBe("watch");
    expect(desktopMode(status(), "me")).toBe("watch");
  });

  test("a handoff that changed: the desktop's own updates its state; another screen's only when it named it", () => {
    const taken = desktopWithHandoff(status(), handoff());
    expect(taken).toMatchObject({ handoff: { id: "h1" }, controllerUserId: "me" });
    expect(desktopWithHandoff(taken, handoff({ status: "done" }))).toMatchObject({
      handoff: null,
      controllerUserId: null,
    });
    const browsers = handoff({ id: "h2", screen: "browser", controllerUserId: "ana" });
    expect(desktopWithHandoff(status(), browsers)).toEqual(status());
    expect(desktopWithHandoff(status({ handoff: browsers }), { ...browsers, status: "done" })).toMatchObject({
      handoff: null,
    });
    expect(desktopWithHandoff(taken, handoff({ id: "other", status: "done" }))).toBe(taken);
  });

  test("socket addresses: ws or wss on the page's host; the keyboard only in control", () => {
    const base = { protocol: "https:", host: "agentes.chat" };
    expect(desktopSocketUrl(base, { orgId: "o1", agentId: "a1", mode: "watch", keyboard: "br" })).toBe(
      "wss://agentes.chat/api/desktop?orgId=o1&agentId=a1&mode=watch",
    );
    expect(
      desktopSocketUrl("http://localhost:5173/x", {
        orgId: "o 1",
        agentId: "a1",
        mode: "control",
        keyboard: "us-intl",
      }),
    ).toBe("ws://localhost:5173/api/desktop?orgId=o%201&agentId=a1&mode=control&keyboard=us-intl");
    expect(terminalSocketUrl(base, { orgId: "o1", agentId: "a1", cols: 80, rows: 24 })).toBe(
      "wss://agentes.chat/api/terminal?orgId=o1&agentId=a1&cols=80&rows=24",
    );
  });

  test("the keyboard: ABNT2 by its ç key, else by the browser's language", () => {
    expect(keyboardFor("en-US", "ç")).toBe("br");
    expect(keyboardFor("pt-BR")).toBe("br");
    expect(keyboardFor("pt-BR", ";")).toBe("us-intl");
    expect(keyboardFor("en-US", ";")).toBe("us");
    expect(keyboardFor("en-GB")).toBe("gb");
    expect(keyboardFor("pt-PT")).toBe("pt");
    expect(keyboardFor("de")).toBe("de");
    expect(keyboardFor("ja-JP")).toBe("us");
  });
});

describe("the terminal panel", () => {
  test("close codes: what shows (it never opens again by itself)", () => {
    expect(terminalCloseState(1000)).toBe("ended");
    expect(terminalCloseState(4403)).toBe("forbidden");
    expect(terminalCloseState(4404, "no_computer")).toBe("unavailable");
    expect(terminalCloseState(4429, "rate_limited")).toBe("busy");
    expect(terminalCloseState(4503, "offline")).toBe("offline");
    expect(terminalCloseState(4502, "machine_paused")).toBe("paused");
    expect(terminalCloseState(4502, "runner_outdated")).toBe("outdated");
    expect(terminalCloseState(4502, "not_allowed")).toBe("unavailable");
    expect(terminalCloseState(4502, "terminal_unavailable")).toBe("unavailable");
    expect(terminalCloseState(4502, "internal")).toBe("dropped");
    for (const code of [1001, 1006, 1011, 1013, 4400, 4408]) expect(terminalCloseState(code)).toBe("dropped");
  });

  test("its size: what fits the panel, within what the server takes", () => {
    expect(TERMINAL_SIZE).toEqual({ cols: [...STREAM_LIMITS.cols], rows: [...STREAM_LIMITS.rows] });
    expect(terminalSize(132.7, 40.2)).toEqual({ cols: 132, rows: 40 });
    expect(terminalSize(3, 1)).toEqual({ cols: 20, rows: 5 });
    expect(terminalSize(900, 900)).toEqual({ cols: 400, rows: 200 });
  });

  test("the shell's end comes as a text frame; anything else is not it", () => {
    expect(isTerminalExit('{"type":"exit","code":0}')).toBe(true);
    expect(isTerminalExit('{"type":"exit","code":null}')).toBe(true);
    expect(isTerminalExit('{"type":"resize","cols":80,"rows":24}')).toBe(false);
    expect(isTerminalExit("null")).toBe(false);
    expect(isTerminalExit("not json")).toBe(false);
  });
});
