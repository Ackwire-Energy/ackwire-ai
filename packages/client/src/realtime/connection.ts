import type { ChannelEvent, UserEvent } from "../api/types";
import { type BrowserWatcher, createBrowserWatches } from "../browser/watches";
import { steerStore } from "./steer";

/**
 * WebSocket client for `/api/ws?orgId=` (apps/server/src/realtime/ws.ts,
 * docs/adr/0010-realtime.md). One connection per organization:
 * - subscribes per channel (ref-counted) and re-subscribes after reconnects;
 * - reconnects with backoff; tells listeners so they catch up over HTTP
 *   (real-time is best effort, the database is the source of truth);
 * - pings to keep the connection alive through proxies.
 */

export type ServerFrame =
  | { type: "ready"; orgId: string; userId: string }
  | { type: "subscribed" | "unsubscribed"; channelId: string }
  /** `agentId`: about an agent's browser (ADR 0040), for the live view. */
  | { type: "error"; code: string; channelId?: string; agentId?: string }
  | { type: "pong" }
  | { type: "event"; channelId: string; event: ChannelEvent }
  /** `user`: for me only; `org`: broadcasts to the whole organization (the forum). */
  | { type: "event"; scope: "user" | "org"; event: UserEvent }
  /** The agent browser's live view (ADR 0040): `browser.frame`, `browser.status`, … (see `browser/live.ts`). */
  | { type: `browser.${string}`; agentId: string; [key: string]: unknown };

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The part of the browser WebSocket we use (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000];
const OPEN = 1;

/**
 * The socket URL for an organization. `base` is the page's location (web) or
 * the server's origin, e.g. "https://agentes.chat" (phone app).
 */
export function realtimeUrl(base: string | { protocol: string; host: string }, orgId: string) {
  const origin = typeof base === "string" ? originOf(base) : base;
  const protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${origin.host}/api/ws?orgId=${encodeURIComponent(orgId)}`;
}

/** "https://agentes.chat/x" → { protocol: "https:", host: "agentes.chat" } (no `URL`: React Native's is partial). */
function originOf(base: string): { protocol: string; host: string } {
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]+)/i.exec(base.trim());
  if (!m) throw new Error(`realtimeUrl: not an absolute URL: ${base}`);
  return { protocol: (m[1] as string).toLowerCase(), host: m[2] as string };
}

/** Parses a server frame; `null` for anything we don't understand (ignored). */
export function parseServerFrame(data: unknown): ServerFrame | null {
  if (typeof data !== "string") return null;
  try {
    const frame = JSON.parse(data) as { type?: unknown };
    if (typeof frame?.type !== "string") return null;
    return frame as ServerFrame;
  } catch {
    return null;
  }
}

type EventListener = (event: ChannelEvent) => void;

export class RealtimeConnection {
  private socket: SocketLike | null = null;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(code: string, channelId?: string) => void>();
  private readonly userListeners = new Set<(event: UserEvent) => void>();
  private readonly browserListeners = new Set<(frame: Record<string, unknown>) => void>();
  private readonly browserWatches = createBrowserWatches({
    send: (frame) => this.send(frame),
    timers: {
      setTimeout: (fn, ms) => this.timers.setTimeout(fn, ms),
      clearTimeout: (id) => this.timers.clearTimeout(id),
    },
  });
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private everOpened = false;
  private stopped = true;
  status: ConnectionStatus = "idle";

  constructor(
    private readonly options: {
      url: string;
      createSocket: SocketFactory;
      timers?: Timers;
      pingMs?: number;
      backoffMs?: number[];
    },
  ) {}

  private get timers() {
    return this.options.timers ?? defaultTimers;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, "bye");
    }
    this.setStatus("closed");
  }

  /** Listen to a channel's events. Returns the unsubscribe function. */
  subscribe(channelId: string, listener: EventListener): () => void {
    let set = this.listeners.get(channelId);
    const first = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(channelId, set);
    }
    set.add(listener);
    if (first) this.send({ type: "subscribe", channelId });
    return () => {
      const current = this.listeners.get(channelId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channelId);
        this.send({ type: "unsubscribe", channelId });
      }
    };
  }

  /** Tells the channel we're typing (call it throttled: see `typingThrottle`). */
  sendTyping(channelId: string) {
    this.send({ type: "typing", channelId });
  }

  onStatus(listener: (status: ConnectionStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Called after a reconnect (not the first connect): refetch what may have been missed. */
  onReconnect(listener: () => void) {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /** Events for the signed-in person (e.g. an approval they can decide), whatever channel they're in. */
  onUserEvent(listener: (event: UserEvent) => void) {
    this.userListeners.add(listener);
    return () => {
      this.userListeners.delete(listener);
    };
  }

  /**
   * The agent browser's live view frames (ADR 0040: `browser.*`, and errors about
   * an agent's browser), as they arrive. Feed them to `createBrowserLiveConnection`.
   */
  onBrowserFrame(listener: (frame: Record<string, unknown>) => void) {
    this.browserListeners.add(listener);
    return () => {
      this.browserListeners.delete(listener);
    };
  }

  /**
   * Who watches which agent's browser on this socket: views of one agent share one
   * `browser.watch` and unwatch a moment after the last leaves (pass it to
   * `createBrowserLiveConnection`). Watched again after every (re)connect.
   */
  get browserWatcher(): BrowserWatcher {
    return this.browserWatches;
  }

  /** Sends a live-view frame (`browser.watch`, `browser.unwatch`, `browser.input`); dropped while not connected. */
  sendBrowserFrame(frame: { type: `browser.${string}`; agentId: string; [key: string]: unknown }) {
    this.send(frame);
  }

  /** Whether frames can go out now. */
  get isOpen() {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  onError(listener: (code: string, channelId?: string) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private open() {
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.setStatus("open");
      for (const channelId of this.listeners.keys()) this.send({ type: "subscribe", channelId });
      // The agents' browsers someone is looking at (a watch sent before the socket opened was dropped).
      this.browserWatches.resumeAll();
      this.startPing();
      if (reconnected) for (const l of this.reconnectListeners) l();
    };
    socket.onmessage = (ev) => this.handle(parseServerFrame(ev.data));
    socket.onerror = () => {
      // `onclose` follows and schedules the retry.
    };
    socket.onclose = () => {
      this.socket = null;
      this.clearTimers();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private handle(frame: ServerFrame | null) {
    if (!frame) return;
    if (frame.type.startsWith("browser.") || (frame.type === "error" && typeof frame.agentId === "string")) {
      for (const l of this.browserListeners) l(frame as Record<string, unknown>);
      return;
    }
    if (frame.type === "event" && "scope" in frame) {
      for (const l of this.userListeners) l(frame.event);
    } else if (frame.type === "event") {
      // "lê na próxima pausa" / "leu" under your messages: one store for every screen (`useSteerState`).
      steerStore.apply(frame.event);
      const set = this.listeners.get(frame.channelId);
      if (!set) return;
      for (const l of [...set]) l(frame.event);
    } else if (frame.type === "error") {
      for (const l of this.errorListeners) l(frame.code, frame.channelId);
    }
  }

  private send(frame: unknown) {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(frame));
  }

  private scheduleReconnect() {
    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 10_000;
    this.attempt++;
    this.setStatus("reconnecting");
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private startPing() {
    const ms = this.options.pingMs ?? 30_000;
    if (ms <= 0) return;
    this.pingTimer = this.timers.setInterval(() => this.send({ type: "ping" }), ms);
  }

  private clearTimers() {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }
}
