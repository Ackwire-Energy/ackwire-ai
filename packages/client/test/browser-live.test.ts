import { describe, expect, test } from "bun:test";
import {
  BROWSER_INPUT_BATCH,
  browserHandoffOf,
  browserSteps,
  clickEvents,
  createBrowserLiveConnection,
  fitFrame,
  framePoint,
  handoffFuse,
  handoffMinutesLeft,
  keyboardEvents,
  keyEvents,
  modifiersOf,
  parseBrowserLiveMessage,
} from "../src/browser";

const AGENT = "11111111-1111-4111-8111-111111111111";

function fakeTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  return {
    pending,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++;
        pending.push({ fn, ms, id });
        return id;
      },
      clearTimeout: (id: unknown) => {
        const i = pending.findIndex((p) => p.id === id);
        if (i >= 0) pending.splice(i, 1);
      },
    },
    run() {
      const all = pending.splice(0);
      for (const p of all) p.fn();
    },
  };
}

describe("agent browser input (ADR 0040)", () => {
  test("a click on the shown frame lands on the page, scaled to the viewport", () => {
    const meta = { deviceWidth: 1280, deviceHeight: 720 };
    expect(framePoint({ x: 320, y: 180 }, { width: 640, height: 360 }, meta)).toEqual({ x: 640, y: 360 });
    expect(framePoint({ x: 0, y: 0 }, { width: 640, height: 360 }, meta)).toEqual({ x: 0, y: 0 });
    // Outside the frame, or a frame with no size: nothing.
    expect(framePoint({ x: 700, y: 10 }, { width: 640, height: 360 }, meta)).toBeNull();
    expect(framePoint({ x: 1, y: 1 }, { width: 0, height: 360 }, meta)).toBeNull();
  });

  test("a frame fits a box without distortion, centered", () => {
    expect(fitFrame({ width: 1000, height: 1000 }, { deviceWidth: 1000, deviceHeight: 500 })).toEqual({
      width: 1000,
      height: 500,
      left: 0,
      top: 250,
    });
  });

  test("Command becomes Control unless the agent's computer is a Mac", () => {
    expect(modifiersOf({ metaKey: true }, false)).toBe(2);
    expect(modifiersOf({ metaKey: true }, true)).toBe(4);
    expect(modifiersOf({ shiftKey: true, altKey: true }, false)).toBe(9);
  });

  test("special keys and shortcuts go as keys; characters as text; modifiers alone not at all", () => {
    expect(keyEvents("Enter").map((e) => e.kind === "key" && [e.type, e.code])).toEqual([
      ["keyDown", "Enter"],
      ["keyUp", "Enter"],
    ]);
    expect(keyboardEvents({ key: "a", metaKey: true }, false)).toEqual(keyEvents("a", 2));
    expect(keyboardEvents({ key: "é" }, false)).toEqual([{ kind: "text", text: "é" }]);
    expect(keyboardEvents({ key: "Shift" }, false)).toBeNull();
    expect(clickEvents({ x: 5, y: 6 }).map((e) => e.kind === "mouse" && e.type)).toEqual([
      "mousePressed",
      "mouseReleased",
    ]);
  });
});

describe("agent browser live connection (ADR 0040)", () => {
  test("watches, forwards its own frames and status, ignores other agents", () => {
    const sent: unknown[] = [];
    const frames: number[] = [];
    const statuses: string[] = [];
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      agentId: AGENT,
      onFrame: (f) => frames.push(f.seq),
      onStatus: (s) => statuses.push(s.mode),
    });
    live.start();
    expect(sent).toEqual([{ type: "browser.watch", agentId: AGENT }]);
    live.handleMessage({
      type: "browser.frame",
      agentId: AGENT,
      seq: 3,
      data: "abc",
      metadata: { deviceWidth: 10, deviceHeight: 10 },
    });
    live.handleMessage({
      type: "browser.frame",
      agentId: "other",
      seq: 4,
      data: "abc",
      metadata: { deviceWidth: 10, deviceHeight: 10 },
    });
    live.handleMessage({
      type: "browser.status",
      agentId: AGENT,
      mode: "control",
      controllerUserId: "u1",
      handoff: null,
    });
    expect(frames).toEqual([3]);
    expect(statuses).toEqual(["control"]);
    live.close();
    expect(sent.at(-1)).toEqual({ type: "browser.unwatch", agentId: AGENT });
  });

  test("retries the watch with backoff while the computer is reconnecting; close stops it", () => {
    const sent: { type: string }[] = [];
    const t = fakeTimers();
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
      backoffMs: [100, 200],
    });
    live.start();
    live.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "reconnecting" });
    expect(t.pending[0]?.ms).toBe(100);
    t.run();
    expect(sent.filter((f) => f.type === "browser.watch")).toHaveLength(2);
    live.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "reconnecting" });
    expect(t.pending[0]?.ms).toBe(200);
    live.close();
    expect(t.pending).toHaveLength(0);
    // Forbidden never retries.
    const again = createBrowserLiveConnection({
      send: () => {},
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
    });
    again.start();
    again.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "forbidden" });
    expect(t.pending).toHaveLength(0);
  });

  test("an ended stream (the browser closed) is watched again after a backoff; a stop we asked for isn't", () => {
    const sent: { type: string }[] = [];
    const t = fakeTimers();
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
      backoffMs: [100],
    });
    live.start();
    live.handleMessage({ type: "browser.ended", agentId: AGENT, reason: "stopped" });
    expect(t.pending).toHaveLength(0);
    live.handleMessage({ type: "browser.ended", agentId: AGENT, reason: "closed" });
    expect(t.pending[0]?.ms).toBe(100);
    t.run();
    expect(sent.filter((f) => f.type === "browser.watch")).toHaveLength(2);
    live.close();
  });

  test("input goes in batches the server accepts", () => {
    const sent: { events?: unknown[] }[] = [];
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f as { events?: unknown[] }),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
    });
    const events = Array.from({ length: BROWSER_INPUT_BATCH + 5 }, () => ({ kind: "text" as const, text: "a" }));
    expect(live.sendInput(events)).toBe(true);
    expect(sent.map((f) => f.events?.length)).toEqual([BROWSER_INPUT_BATCH, 5]);
    expect(live.sendInput([])).toBe(false);
  });

  test("messages are checked", () => {
    expect(parseBrowserLiveMessage({ type: "browser.frame", agentId: AGENT, seq: 1 })).toBeNull();
    expect(parseBrowserLiveMessage({ type: "error", agentId: AGENT, code: "forbidden" })).toEqual({
      type: "error",
      agentId: AGENT,
      code: "forbidden",
    });
  });
});

describe("agent browser requests (ADR 0040)", () => {
  const base = {
    id: "h1",
    agentId: AGENT,
    status: "pending",
    createdAt: "2026-10-19T10:00:00.000Z",
    expiresAt: "2026-10-19T10:10:00.000Z",
  };

  test("the card's request is read from the message meta", () => {
    expect(browserHandoffOf({ browserHandoff: base })?.id).toBe("h1");
    expect(browserHandoffOf({ browserHandoff: { id: 1 } })).toBeNull();
    expect(browserHandoffOf(null)).toBeNull();
  });

  test("time left and the fuse", () => {
    const now = new Date("2026-10-19T10:05:00.000Z").getTime();
    expect(handoffMinutesLeft(base, now)).toBe(5);
    expect(handoffFuse(base, now)).toBeCloseTo(0.5);
    expect(handoffMinutesLeft({ expiresAt: null }, now)).toBeNull();
  });

  test("the watching log keeps the browser calls only", () => {
    expect(
      browserSteps([
        { kind: "say", text: "hi" },
        {
          kind: "call",
          id: "c1",
          tool: "browser_open",
          connector: null,
          detail: "shop.example",
          code: null,
          output: [],
          running: false,
        },
        {
          kind: "call",
          id: "c2",
          tool: "read_file",
          connector: null,
          detail: null,
          code: null,
          output: [],
          running: false,
        },
      ]).map((s) => s.tool),
    ).toEqual(["browser_open"]);
  });
});
