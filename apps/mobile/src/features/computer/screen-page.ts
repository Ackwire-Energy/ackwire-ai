import type { DesktopMode, DesktopViewState } from "@agenteschat/client";
import { originOf } from "@agenteschat/client/lib/server";

/*
 * The agent's screen on the phone (ADR 0098): the app's side of the server's `/screen.html`, in a WebView. The page
 * holds the stream and draws it; the app holds every touch and tells it what to do. Pure, so it is unit-tested.
 */

/** What the page says (`apps/web/src/screen/session.ts`). */
export type ScreenEvent =
  | { type: "ready" }
  | { type: "view"; state: DesktopViewState }
  | { type: "size"; width: number; height: number }
  | { type: "changed" }
  | { type: "refused"; why: "tooLong" };

const VIEW_STATES: ReadonlySet<string> = new Set<DesktopViewState>([
  "connecting",
  "live",
  "hidden",
  "offline",
  "busy",
  "noRoom",
  "paused",
  "held",
  "forbidden",
  "outdated",
  "unavailable",
  "ended",
]);

/** The page's address for one agent. */
export const screenPageUrl = (server: string, orgId: string, agentId: string) =>
  `${server}/screen.html?${new URLSearchParams({ o: orgId, a: agentId }).toString()}`;

/** This WebView holds a session, so only the server's own page ever loads in it: never a link, a redirect or a frame. */
export function screenPageStays(server: string, url: string): boolean {
  const page = new URL(`${server}/screen.html`);
  try {
    const to = new URL(url);
    return to.origin === page.origin && to.pathname === page.pathname;
  } catch {
    return false;
  }
}

/** One message from the server's page, or null for anything else. */
export function screenEvent(server: string, from: { url: string; data: string }): ScreenEvent | null {
  if (originOf(from.url) !== new URL(server).origin) return null;
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(from.data);
    if (typeof parsed !== "object" || parsed === null) return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (m.type === "ready" || m.type === "changed") return { type: m.type };
  if (m.type === "view" && typeof m.state === "string" && VIEW_STATES.has(m.state)) {
    return { type: "view", state: m.state as DesktopViewState };
  }
  if (m.type === "size" && Number(m.width) > 0 && Number(m.height) > 0) {
    return { type: "size", width: Number(m.width), height: Number(m.height) };
  }
  if (m.type === "refused" && m.why === "tooLong") return { type: "refused", why: "tooLong" };
  return null;
}

/**
 * The session for the page's socket. A WebView shares neither the app's stored cookie nor its headers, so the cookie is
 * set from the page, before anything else runs there, in a WebView that keeps nothing (`incognito`) and loads nothing
 * else (`screenPageStays`).
 */
export function sessionCookieScript(cookie: string, server: string): string {
  const secure = server.startsWith("https:") ? "; secure" : "";
  const sets = cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes("="))
    .map((pair) => `document.cookie=${JSON.stringify(`${pair}; path=/; samesite=strict${secure}`)};`);
  return `${sets.join("")}true;`;
}

type PageCalls = {
  set: [{ connect: boolean; mode: DesktopMode }];
  retry: [];
  pointer: [x: number, y: number, buttons: number];
  key: [name: string];
  type: [text: string];
};

/** A call on the page, for `injectJavaScript`. JSON keeps whatever a person typed a value, never code. */
export const screenCall = <K extends keyof PageCalls>(method: K, ...args: PageCalls[K]) =>
  `window.agentScreen?.${method}(${args.map((a) => JSON.stringify(a)).join(",")});true;`;

/** RFB's buttons: the left one, and the wheel's two directions (pressed and let go per notch). */
export const BUTTON = { none: 0, left: 1, wheelUp: 8, wheelDown: 16 } as const;

/** How often a moving pointer reaches the page: a touch moves far more often than a stream needs to hear. */
export const POINTER_MS = 33;

type Send = (x: number, y: number, buttons: number) => void;

/**
 * The pointer on its way to the page. Moves wait for the next tick and only the newest goes; a change of buttons goes
 * at once, and after the move before it, so a click lands where the cursor was seen.
 */
export class PointerLine {
  private buttons: number = BUTTON.none;
  private waiting: { x: number; y: number } | null = null;
  private tick: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: Send,
    private readonly schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly unschedule: (id: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  move(x: number, y: number) {
    this.waiting = { x, y };
    this.tick ??= this.schedule(() => {
      this.tick = null;
      this.flush();
    }, POINTER_MS);
  }

  /** Presses or lets go of these buttons where the pointer is. */
  press(x: number, y: number, buttons: number) {
    this.flush();
    this.buttons = buttons;
    this.send(x, y, buttons);
  }

  /** One click, down and up. */
  click(x: number, y: number, button: number = BUTTON.left) {
    this.flush();
    this.send(x, y, this.buttons | button);
    this.send(x, y, this.buttons);
  }

  /** Stops waiting: the view is going. */
  stop() {
    if (this.tick !== null) this.unschedule(this.tick);
    this.tick = null;
    this.waiting = null;
  }

  private flush() {
    if (!this.waiting) return;
    const { x, y } = this.waiting;
    this.waiting = null;
    this.send(x, y, this.buttons);
  }
}
