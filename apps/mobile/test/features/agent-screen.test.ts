import { describe, expect, mock, test } from "bun:test";
import { CURSOR_CELLS, cursorCells } from "../../src/features/computer/pixel-cursor";
import {
  BUTTON,
  POINTER_MS,
  PointerLine,
  screenCall,
  screenEvent,
  screenPageStays,
  screenPageUrl,
  sessionCookieScript,
} from "../../src/features/computer/screen-page";
import {
  boundCamera,
  atDesktopEdge,
  controlScale,
  cursorGain,
  DEFAULT_DESKTOP,
  fitScale,
  followCursor,
  lookAt,
  MAX_SCALE,
  toDesktop,
  zoomCamera,
} from "../../src/features/computer/screen-view";

const SERVER = "https://app.example";
const PHONE = { width: 336, height: 320 };

describe("the page behind the agent's screen", () => {
  test("only the server's own page loads in the WebView that holds the session", () => {
    const url = screenPageUrl(SERVER, "org", "ada");
    expect(url).toBe("https://app.example/screen.html?o=org&a=ada");
    expect(screenPageStays(SERVER, url)).toBe(true);
    expect(screenPageStays(SERVER, "https://app.example/")).toBe(false);
    expect(screenPageStays(SERVER, "https://app.example.evil.example/screen.html")).toBe(false);
    expect(screenPageStays(SERVER, "https://app.example@evil.example/screen.html")).toBe(false);
    expect(screenPageStays(SERVER, "not a url")).toBe(false);
  });

  test("a message counts only from the server's page, and only as what it can say", () => {
    const url = screenPageUrl(SERVER, "org", "ada");
    const heard = (data: unknown, from = url) => screenEvent(SERVER, { url: from, data: JSON.stringify(data) });
    expect(heard({ type: "ready" })).toEqual({ type: "ready" });
    expect(heard({ type: "view", state: "live" })).toEqual({ type: "view", state: "live" });
    expect(heard({ type: "size", width: 1280, height: 900 })).toEqual({ type: "size", width: 1280, height: 900 });
    expect(heard({ type: "ready" }, "https://evil.example/screen.html")).toBeNull();
    expect(heard({ type: "view", state: "nonsense" })).toBeNull();
    expect(heard({ type: "size", width: 0, height: 900 })).toBeNull();
    expect(screenEvent(SERVER, { url, data: "{" })).toBeNull();
    expect(screenEvent(SERVER, { url, data: "null" })).toBeNull();
  });

  test("the session cookie is set only on what the server's address allows", () => {
    const script = sessionCookieScript("; a=1; __Secure-b=2%3D", SERVER);
    expect(script).toContain('document.cookie="a=1; path=/; samesite=strict; secure";');
    expect(script).toContain('document.cookie="__Secure-b=2%3D; path=/; samesite=strict; secure";');
    expect(sessionCookieScript("a=1", "http://localhost:3000")).not.toContain("secure");
    expect(sessionCookieScript("", SERVER)).toBe("true;");
  });

  test("what a person typed stays a value, never code", () => {
    const js = screenCall("type", `"); fetch("https://evil.example`);
    expect(js).toBe(`window.agentScreen?.type("\\"); fetch(\\"https://evil.example");true;`);
    expect(screenCall("pointer", 10, 20, BUTTON.left)).toBe("window.agentScreen?.pointer(10,20,1);true;");
    expect(screenCall("set", { connect: true, mode: "control" })).toBe(
      'window.agentScreen?.set({"connect":true,"mode":"control"});true;',
    );
  });
});

describe("the pointer on its way to the page", () => {
  const line = () => {
    const sent: number[][] = [];
    let run: (() => void) | null = null;
    const schedule = mock((fn: () => void, _ms: number) => {
      run = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const l = new PointerLine(
      (x, y, b) => sent.push([x, y, b]),
      schedule,
      () => {
        run = null;
      },
    );
    return { l, sent, schedule, tick: () => run?.() };
  };

  test("the first move goes at once; after it, only the newest goes at each tick", () => {
    const { l, sent, schedule, tick } = line();
    l.move(1, 1);
    l.move(2, 2);
    l.move(3, 3);
    expect(sent).toEqual([[1, 1, 0]]);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[1]).toBe(POINTER_MS);
    tick();
    expect(sent).toEqual([
      [1, 1, 0],
      [3, 3, 0],
    ]);
  });

  test("a move after a quiet tick doesn't wait", () => {
    const { l, sent, tick } = line();
    l.move(1, 1);
    tick();
    l.move(2, 2);
    expect(sent).toEqual([
      [1, 1, 0],
      [2, 2, 0],
    ]);
  });

  test("a click lands after the move before it, down and then up", () => {
    const { l, sent } = line();
    l.move(5, 6);
    l.click(5, 6);
    expect(sent).toEqual([
      [5, 6, 0],
      [5, 6, BUTTON.left],
      [5, 6, 0],
    ]);
  });

  test("a drag keeps the button held on every move until it lets go", () => {
    const { l, sent, tick } = line();
    l.press(1, 1, BUTTON.left);
    l.move(9, 9);
    tick();
    l.press(9, 9, BUTTON.none);
    expect(sent).toEqual([
      [1, 1, 1],
      [9, 9, 1],
      [9, 9, 0],
    ]);
  });

  test("the wheel's notch doesn't let go of a held button", () => {
    const { l, sent } = line();
    l.press(1, 1, BUTTON.left);
    l.click(1, 1, BUTTON.wheelDown);
    expect(sent.at(-2)).toEqual([1, 1, BUTTON.left | BUTTON.wheelDown]);
    expect(sent.at(-1)).toEqual([1, 1, BUTTON.left]);
  });

  test("nothing goes after the view leaves", () => {
    const { l, sent, tick } = line();
    l.move(1, 1);
    l.move(2, 2);
    l.stop();
    tick();
    expect(sent).toEqual([[1, 1, 0]]);
  });
});

describe("the camera over the agent's screen", () => {
  const desk = DEFAULT_DESKTOP;

  test("watching shows it all; control fills the box, never past what stays sharp", () => {
    expect(fitScale(PHONE, desk)).toBeCloseTo(336 / 1280);
    expect(controlScale(PHONE, desk)).toBeCloseTo(Math.max(320 / 900, (336 / 1280) * 1.25));
    expect(controlScale({ width: 2000, height: 4000 }, desk)).toBe(MAX_SCALE);
  });

  test("the camera stays on the desktop, centered on a side the box is larger than it", () => {
    const s = fitScale(PHONE, desk);
    const whole = boundCamera(50, 50, s, PHONE, desk);
    expect(whole.x).toBeCloseTo(0);
    expect(whole.y).toBeLessThan(0);
    expect(boundCamera(-100, -100, 1, PHONE, desk)).toEqual({ x: 0, y: 0 });
    expect(boundCamera(9999, 9999, 1, PHONE, desk)).toEqual({ x: 1280 - 336, y: 900 - 320 });
    expect(lookAt({ x: 640, y: 450 }, 1, PHONE, desk)).toEqual({ x: 640 - 168, y: 450 - 160 });
  });

  test("a pinch keeps the point under the fingers", () => {
    const before = { x: 200, y: 100 };
    const focal = { x: 100, y: 80 };
    const at = toDesktop(focal, before, 1, desk);
    const after = zoomCamera(before, 1, 2, focal, PHONE, desk);
    const still = toDesktop(focal, after, 2, desk);
    expect(still.x).toBeCloseTo(at.x);
    expect(still.y).toBeCloseTo(at.y);
  });

  test("a tap on the screen maps to the desktop, and stays on it", () => {
    expect(toDesktop({ x: 10, y: 20 }, { x: 100, y: 200 }, 0.5, desk)).toEqual({ x: 120, y: 240 });
    expect(toDesktop({ x: 5000, y: 5000 }, { x: 0, y: 0 }, 1, desk)).toEqual({ x: 1280, y: 900 });
  });

  test("the view moves only once the cursor nears its edge, and just enough", () => {
    const camera = { x: 300, y: 200 };
    expect(followCursor(camera, 1, { x: 460, y: 360 }, PHONE, desk)).toEqual(camera);
    const margin = 320 * 0.2;
    const right = followCursor(camera, 1, { x: 300 + 336, y: 360 }, PHONE, desk);
    expect((300 + 336 - right.x) * 1).toBeCloseTo(336 - margin);
    expect(right.y).toBe(200);
  });

  test("slow swipes aim, fast ones travel, and zooming in keeps a swipe's size on the screen", () => {
    expect(cursorGain(1.6, 0.4)).toBeGreaterThan(cursorGain(0.05, 0.4) * 2);
    expect(cursorGain(99, 0.4)).toBe(cursorGain(1.6, 0.4));
    expect(cursorGain(0.5, 0.8)).toBeCloseTo(cursorGain(0.5, 0.4) / 2);
  });

  test("an easy swipe across the trackpad crosses the view", () => {
    const s = controlScale(PHONE, desk);
    expect(300 * cursorGain(0.6, s) * s).toBeGreaterThan(PHONE.width);
  });

  test("the cursor knows when it has reached the desktop's edge", () => {
    expect(atDesktopEdge({ x: 0, y: 300 }, desk)).toBe(true);
    expect(atDesktopEdge({ x: 1280, y: 300 }, desk)).toBe(true);
    expect(atDesktopEdge({ x: 640, y: 900 }, desk)).toBe(true);
    expect(atDesktopEdge({ x: 640, y: 300 }, desk)).toBe(false);
  });
});

describe("the person's cursor", () => {
  test("its tip is the first cell, where a click lands, and it stays inside its box", () => {
    const cells = cursorCells();
    expect(cells[0]).toEqual({ x: 0, y: 0, tone: "rim" });
    for (const c of cells) {
      expect(c.x).toBeLessThan(CURSOR_CELLS.width);
      expect(c.y).toBeLessThan(CURSOR_CELLS.height);
    }
  });

  test("its body is dithered: both tones, and always the same drawing", () => {
    const tones = new Set(cursorCells().map((c) => c.tone));
    expect(tones).toEqual(new Set(["rim", "body", "light"]));
    expect(cursorCells()).toEqual(cursorCells());
  });
});
