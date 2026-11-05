import type { ChannelEvent, UserEvent } from "../api/types";
import { type BrowserWatcher, createBrowserWatches } from "../browser/watches";
import { steerStore } from "./steer";

/**
 * WebSocket client for `/api/ws?orgId=` (apps/server/src/realtime/ws.ts,
 * docs/adr/0010-realtime.md). One connection per organization:
 * - subscribes per channel (ref-counted) and re-subscribes after reconnects;
 * - says when the server confirms a channel's subscription (`onSubscribed`): its
 *   events arrive only from then on, so what a page read before may be behind;
 * - reconnects with backoff; tells listeners so they catch up over HTTP
 *   (real-time is best effort, the database is the source of truth);
 * - pings to keep the connection alive through proxies, and drops a socket whose pong doesn't come back
 *   (`pongTimeoutMs`): after a network change or a sleep the browser can keep a dead socket "open" for
 *   minutes while HTTP still works, so messages send and nothing arrives live;
 * - asks again, with backoff, for a channel someone still listens to when the server drops or refuses its
 *   subscription (`unsubscribed`, an error about the channel, `rate_limited`): the socket stays up and keeps
 *   bringing the person's own events (the reply sound) while that channel would stay silent until a refresh;
 * - when a notification names a message in a channel listened to here whose `message.created` never came
 *   (`MISSED_MESSAGE_GRACE_MS` later), subscribes that channel anew: the server's `subscribed` has every screen
 *   catch up (`onSubscribed`), and a subscription the server lost without a word is made again.
 * - watches agents' browsers with `acks` and answers each `browser.frame` once it could be drawn (`browser.ack`,
 *   after the next animation frame): the server keeps only a couple of frames on their way to this socket, so a slow
 *   link or a busy page shows the newest picture instead of a backlog (ADR 0040 §7.1).
 */

export type ServerFrame =
  | { type: "ready"; orgId: string; userId: string }
  | { type: "subscribed" | "unsubscribed"; channelId: string }
  /** `agentId`: about an agent's browser (ADR 0040), for the live view. */
  | { type: "error"; code: string; channelId?: string; agentId?: string }
  | { type: "pong" }
  | { type: "event"; channelId: string; event: ChannelEvent }
  /** `user`: for me only; `org`: broadcasts to the whole organization. */
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
/** How long after a notification its message's own `message.created` may still come (it is normally first). */
export const MISSED_MESSAGE_GRACE_MS = 3000;
/** How many `message.created` ids are remembered for that check. */
const HEARD_LIMIT = 500;
const OPEN = 1;

/** Where the server is: the page's location (web) or the server's origin, e.g. "https://app.agentes.chat" (phone app). */
export type SocketBase = string | { protocol: string; host: string };

/** A WebSocket address on the server: `path` with `params` as its query. */
export function socketUrl(base: SocketBase, path: string, params: Record<string, string | number>) {
  const origin = typeof base === "string" ? originOf(base) : base;
  const protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${protocol}//${origin.host}${path}?${query}`;
}

/** The socket URL for an organization. */
export function realtimeUrl(base: SocketBase, orgId: string) {
  return socketUrl(base, "/api/ws", { orgId });
}

/** "https://app.agentes.chat/x" → { protocol: "https:", host: "app.agentes.chat" } (no `URL`: React Native's is partial). */
function originOf(base: string): { protocol: string; host: string } {
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]+)/i.exec(base.trim());
  if (!m) throw new Error(`socketUrl: not an absolute URL: ${base}`);
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
  private readonly subscribedListeners = new Set<(channelId: string) => void>();
  private readonly errorListeners = new Set<(code: string, channelId?: string) => void>();
  private readonly userListeners = new Set<(event: UserEvent) => void>();
  private readonly browserListeners = new Set<(frame: Record<string, unknown>) => void>();
  private readonly browserWatches = createBrowserWatches({
    send: (frame) => this.sendBrowserFrame(frame),
    timers: {
      setTimeout: (fn, ms) => this.timers.setTimeout(fn, ms),
      clearTimeout: (id) => this.timers.clearTimeout(id),
    },
  });
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  /** Channels the server confirmed on this socket. */
  private readonly confirmed = new Set<string>();
  private readonly retries = new Map<string, { timer: unknown; attempt: number }>();
  /** Recent `message.created` ids, oldest first. */
  private readonly heard = new Set<string>();
  private everOpened = false;
  private stopped = true;
  status: ConnectionStatus = "idle";

  constructor(
    private readonly options: {
      url: string;
      createSocket: SocketFactory;
      timers?: Timers;
      pingMs?: number;
      /** How long after a ping with nothing heard back the socket counts as dead and is replaced. */
      pongTimeoutMs?: number;
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
    if (first) {
      this.clearRetry(channelId);
      this.send({ type: "subscribe", channelId });
    }
    return () => {
      const current = this.listeners.get(channelId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channelId);
        this.confirmed.delete(channelId);
        this.send({ type: "unsubscribe", channelId });
      }
    };
  }

  /** Tells the channel we're typing, in one of its threads or not (call it throttled: see `typingThrottle`). */
  sendTyping(channelId: string, threadId?: string | null) {
    this.send(threadId ? { type: "typing", channelId, threadId } : { type: "typing", channelId });
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

  /**
   * The server confirmed a channel's subscription (its first, and again after every reconnect): the channel's
   * events reach us from now on. Whatever happened there before, after a page read it, is only over HTTP.
   */
  onSubscribed(listener: (channelId: string) => void) {
    this.subscribedListeners.add(listener);
    return () => {
      this.subscribedListeners.delete(listener);
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
    // Every watch from this socket says it answers frames: `handle` does, for every view of that agent at once.
    this.send(frame.type === "browser.watch" ? { ...frame, acks: true } : frame);
  }

  /** A frame went to the views: answered once they could draw it (a hidden tab draws nothing, so it answers late). */
  private ackBrowserFrame(agentId: string, seq: unknown) {
    const ack = () => this.send({ type: "browser.ack", agentId, ...(typeof seq === "number" ? { seq } : {}) });
    const nextFrame = (globalThis as { requestAnimationFrame?: (fn: () => void) => unknown }).requestAnimationFrame;
    if (typeof nextFrame === "function") nextFrame(ack);
    else ack();
  }

  /**
   * Pings now and replaces the socket if nothing comes back in time (`pongTimeoutMs`). Runs on the ping interval;
   * call it too when the page may have slept or changed networks (visible again, back online).
   */
  checkAlive() {
    if (!this.isOpen || this.pongTimer !== null) return;
    this.send({ type: "ping" });
    const socket = this.socket;
    this.pongTimer = this.timers.setTimeout(() => {
      this.pongTimer = null;
      if (this.socket !== socket || !socket) return;
      // Its close event may never come (or come late, after the new socket opened): detach it first.
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      try {
        socket.close(4000, "no pong");
      } catch {}
      this.lost();
    }, this.options.pongTimeoutMs ?? 10_000);
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
      this.confirmed.clear();
      for (const channelId of this.listeners.keys()) this.send({ type: "subscribe", channelId });
      // The agents' browsers someone is looking at (a watch sent before the socket opened was dropped).
      this.browserWatches.resumeAll();
      this.startPing();
      if (reconnected) for (const l of this.reconnectListeners) l();
    };
    socket.onmessage = (ev) => {
      // Anything heard proves the socket alive.
      if (this.pongTimer !== null) this.timers.clearTimeout(this.pongTimer);
      this.pongTimer = null;
      this.handle(parseServerFrame(ev.data));
    };
    socket.onerror = () => {
      // `onclose` follows and schedules the retry.
    };
    socket.onclose = () => this.lost();
  }

  private lost() {
    this.socket = null;
    this.clearTimers();
    if (!this.stopped) this.scheduleReconnect();
  }

  private handle(frame: ServerFrame | null) {
    if (!frame) return;
    if (frame.type.startsWith("browser.") || (frame.type === "error" && typeof frame.agentId === "string")) {
      for (const l of this.browserListeners) l(frame as Record<string, unknown>);
      if (frame.type === "browser.frame" && typeof frame.agentId === "string") {
        this.ackBrowserFrame(frame.agentId, (frame as { seq?: unknown }).seq);
      }
      return;
    }
    if (frame.type === "event" && "scope" in frame) {
      this.checkHeard(frame.event);
      for (const l of this.userListeners) l(frame.event);
    } else if (frame.type === "event") {
      if (frame.event.type === "message.created") {
        this.heard.add(frame.event.messageId);
        if (this.heard.size > HEARD_LIMIT) this.heard.delete(this.heard.values().next().value as string);
      }
      // "lê na próxima pausa" / "leu" under your messages: one store for every screen (`useSteerState`).
      steerStore.apply(frame.event);
      const set = this.listeners.get(frame.channelId);
      if (!set) return;
      for (const l of [...set]) l(frame.event);
    } else if (frame.type === "subscribed") {
      this.confirmed.add(frame.channelId);
      this.clearRetry(frame.channelId);
      for (const l of this.subscribedListeners) l(frame.channelId);
    } else if (frame.type === "unsubscribed") {
      // Dropped by the server (archived, membership recheck), or the answer to an unsubscribe overtaken by a new
      // listener: ask again while someone listens.
      this.confirmed.delete(frame.channelId);
      this.retrySubscribe(frame.channelId);
    } else if (frame.type === "error") {
      if (frame.channelId) this.retrySubscribe(frame.channelId);
      // Refused before the server read which channel: every one not confirmed yet may be the one.
      else if (frame.code === "rate_limited")
        for (const channelId of this.listeners.keys())
          if (!this.confirmed.has(channelId)) this.retrySubscribe(channelId);
      for (const l of this.errorListeners) l(frame.code, frame.channelId);
    }
  }

  /** A notification about a message in a channel open here: if its `message.created` doesn't come, subscribe anew. */
  private checkHeard(event: UserEvent) {
    if (event.type !== "notification.upserted" || !("notification" in event)) return;
    const { source, readAt } = event.notification;
    const { channelId, messageId } = source;
    if (!channelId || !messageId || readAt || !this.listeners.has(channelId) || this.heard.has(messageId)) return;
    this.timers.setTimeout(() => {
      if (this.heard.has(messageId) || !this.listeners.has(channelId)) return;
      this.confirmed.delete(channelId);
      this.send({ type: "unsubscribe", channelId });
      this.send({ type: "subscribe", channelId });
    }, MISSED_MESSAGE_GRACE_MS);
  }

  private clearRetry(channelId: string) {
    const retry = this.retries.get(channelId);
    if (retry && retry.timer !== null) this.timers.clearTimeout(retry.timer);
    this.retries.delete(channelId);
  }

  /** Subscribes again after a backoff; gives up after the last step (a real refusal), until the next reconnect. */
  private retrySubscribe(channelId: string) {
    if (!this.listeners.has(channelId)) return;
    const prev = this.retries.get(channelId);
    if (prev && prev.timer !== null) return;
    const attempt = prev?.attempt ?? 0;
    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    if (attempt >= backoff.length) return;
    const entry = { attempt: attempt + 1, timer: null as unknown };
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = null;
      if (this.listeners.has(channelId)) this.send({ type: "subscribe", channelId });
    }, backoff[attempt] ?? 10_000);
    this.retries.set(channelId, entry);
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
    this.pingTimer = this.timers.setInterval(() => this.checkAlive(), ms);
  }

  private clearTimers() {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    if (this.pongTimer !== null) this.timers.clearTimeout(this.pongTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    for (const retry of this.retries.values()) if (retry.timer !== null) this.timers.clearTimeout(retry.timer);
    this.retries.clear();
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }
}
