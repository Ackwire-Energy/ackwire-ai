import { describe, expect, test } from "bun:test";
import {
  BROWSER_DRAG_FLUSH_MS,
  BROWSER_HOVER_MS,
  BROWSER_INPUT_BATCH,
  BROWSER_UNWATCH_DELAY_MS,
  browserHandoffOf,
  browserSteps,
  clickEvents,
  createBrowserLiveConnection,
  createBrowserWatches,
  fitFrame,
  framePoint,
  handoffFuse,
  handoffMinutesLeft,
  keyboardEvents,
  keyEvents,
  modifiersOf,
  pagePoint,
  parseBrowserLiveMessage,
  usesBrowser,
  wheelEvent,
} from "../src/browser";
import { toolActivity } from "../src/lib/activity";

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
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
  });

  test("a click on a letterboxed frame lands on the page; the bands around it don't", () => {
    // A 1280×720 page shown in a 1000×1000 box: drawn 1000×562.5, 218.75 px of band above and below.
    const meta = { deviceWidth: 1280, deviceHeight: 720 };
    const box = { left: 100, top: 50, width: 1000, height: 1000 };
    expect(pagePoint({ x: 100 + 500, y: 50 + 218.75 + 281.25 }, box, meta)).toEqual({ x: 640, y: 360 });
    expect(pagePoint({ x: 100, y: 50 + 218.75 }, box, meta)).toEqual({ x: 0, y: 0 });
    // In the band above the image: not on the page.
    expect(pagePoint({ x: 600, y: 60 }, box, meta)).toBeNull();
    // An element exactly the image's size (fill) maps straight.
    expect(pagePoint({ x: 420, y: 230 }, { left: 100, top: 50, width: 640, height: 360 }, meta, "fill")).toEqual({
      x: 640,
      y: 360,
    });
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
    const sent: { type: string; agentId?: string }[] = [];
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
    const sent: { type: string; agentId?: string }[] = [];
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

describe("one watch per agent on a socket (no stream flapping)", () => {
  const live = (watcher: ReturnType<typeof createBrowserWatches>, sent: unknown[]) =>
    createBrowserLiveConnection({
      send: (f) => sent.push(f),
      watcher,
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
    });

  test("views of the same agent share one watch; it ends a moment after the last leaves", () => {
    const sent: { type: string; agentId?: string }[] = [];
    const t = fakeTimers();
    const watches = createBrowserWatches({ send: (f) => sent.push(f), timers: t.timers });
    const card = live(watches, sent);
    const full = live(watches, sent);
    card.start();
    full.start();
    expect(sent).toEqual([{ type: "browser.watch", agentId: AGENT }]);
    card.close();
    full.close();
    // Not yet: a view coming back meanwhile keeps the stream.
    expect(sent.filter((f) => f.type === "browser.unwatch")).toHaveLength(0);
    expect(t.pending[0]?.ms).toBe(BROWSER_UNWATCH_DELAY_MS);
    t.run();
    expect(sent.at(-1)).toEqual({ type: "browser.unwatch", agentId: AGENT });
    expect(watches.watching()).toEqual([]);
  });

  test("a remount (StrictMode, a re-render) neither unwatches nor watches again", () => {
    const sent: { type: string; agentId?: string }[] = [];
    const t = fakeTimers();
    const watches = createBrowserWatches({ send: (f) => sent.push(f), timers: t.timers });
    const first = live(watches, sent);
    first.start();
    first.close();
    const again = live(watches, sent);
    again.start();
    t.run();
    expect(sent).toEqual([{ type: "browser.watch", agentId: AGENT }]);
    expect(watches.watching()).toEqual([AGENT]);
    // After the socket comes back, every agent someone looks at is watched again, once.
    watches.resumeAll();
    expect(sent.filter((f) => f.type === "browser.watch")).toHaveLength(2);
    again.close();
  });
});

describe("input in bursts, not one message per event", () => {
  type Sent = { type: string; events?: { kind: string; type?: string; deltaY?: number; x?: number }[] };
  const make = (t: ReturnType<typeof fakeTimers>, clock: { now: number }) => {
    const sent: Sent[] = [];
    const conn = createBrowserLiveConnection({
      send: (f) => sent.push(f as Sent),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
      now: () => clock.now,
    });
    return { sent, conn };
  };
  const at = (x: number) => ({ x, y: 1 });

  test("wheel ticks add up into one event per frame", () => {
    const t = fakeTimers();
    const { sent, conn } = make(t, { now: 0 });
    for (let i = 0; i < 10; i++) conn.sendInput([wheelEvent(at(i), 0, 10)]);
    expect(sent).toHaveLength(0);
    expect(t.pending[0]?.ms).toBe(BROWSER_DRAG_FLUSH_MS);
    t.run();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events?.[0]?.deltaY).toBe(100);
    expect(sent[0]?.events?.[0]?.x).toBe(9);
  });

  test("a drag's moves merge; the click after them goes at once, in order", () => {
    const t = fakeTimers();
    const { sent, conn } = make(t, { now: 0 });
    const move = (x: number) => ({
      kind: "mouse" as const,
      type: "mouseMoved" as const,
      button: "left" as const,
      ...at(x),
    });
    conn.sendInput([move(1)]);
    conn.sendInput([move(2)]);
    conn.sendInput([move(3)]);
    conn.sendInput(clickEvents(at(4)));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events?.map((e) => `${e.type}:${e.x}`)).toEqual([
      "mouseMoved:3",
      "mouseMoved:4",
      "mousePressed:4",
      "mouseReleased:4",
    ]);
  });

  test("a click's hover move is sent with it, before the press, even right after another hover", () => {
    const t = fakeTimers();
    const clock = { now: 1000 };
    const { sent, conn } = make(t, clock);
    conn.sendInput([{ kind: "mouse", type: "mouseMoved", ...at(1) }]);
    clock.now += 5;
    conn.sendInput(clickEvents(at(7)));
    const types = sent.flatMap((s) => s.events?.map((e) => `${e.type}:${e.x}`) ?? []);
    expect(types.slice(-3)).toEqual(["mouseMoved:7", "mousePressed:7", "mouseReleased:7"]);
  });

  test("hovering sends the latest position at most every 66 ms", () => {
    const t = fakeTimers();
    const clock = { now: 1000 };
    const { sent, conn } = make(t, clock);
    const hover = (x: number) => ({ kind: "mouse" as const, type: "mouseMoved" as const, ...at(x) });
    conn.sendInput([hover(1)]);
    expect(sent).toHaveLength(1);
    clock.now += 10;
    conn.sendInput([hover(2)]);
    conn.sendInput([hover(3)]);
    expect(sent).toHaveLength(1);
    expect(t.pending[0]?.ms).toBe(BROWSER_HOVER_MS - 10);
    t.run();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.events?.[0]?.x).toBe(3);
  });

  test("closing drops what was still waiting", () => {
    const t = fakeTimers();
    const { sent, conn } = make(t, { now: 0 });
    conn.sendInput([wheelEvent(at(1), 0, 5)]);
    conn.close();
    t.run();
    expect(sent.filter((f) => f.type === "browser.input")).toHaveLength(0);
  });
});

describe("the agent is in its browser", () => {
  test("its current tool, or its latest call, is a browser tool (also through the computer's bridge)", () => {
    expect(usesBrowser({ tool: "browser_click" })).toBe(true);
    expect(usesBrowser({ tool: "mcp__agentes__browser_read" })).toBe(true);
    const call = (id: string, tool: string) => ({ kind: "call", id, tool, detail: null, running: false });
    expect(
      usesBrowser({ tool: null, work: [call("1", "browser_open"), { kind: "say", text: "Abri." }] as never }),
    ).toBe(true);
    expect(usesBrowser({ work: [call("1", "browser_open"), call("2", "run_code")] as never })).toBe(false);
    expect(usesBrowser({})).toBe(false);
  });

  test("the bar says 'usando o navegador', not 'consultando o browser'", () => {
    expect(toolActivity("browser_open")).toEqual({ kind: "browsing" });
    expect(toolActivity("mcp__agentes__browser_click")).toEqual({ kind: "browsing" });
  });
});
