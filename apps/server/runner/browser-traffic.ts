import { isObject } from "@agenteschat/adapters/machine-protocol";
import type { StreamSocket } from "./browser";

/**
 * What one agent's Chrome sends and receives (protocol 23), from its own
 * DevTools network events: one connection to its browser endpoint, attached
 * (flat sessions) to every page, frame and worker it opens, Chrome's own UI
 * left out and nothing paused, with network events on and no bodies kept for
 * us. Never the rest of the computer, never a URL or a header kept or logged.
 *
 * - Received: each finished response's encoded size (headers included); for
 *   one that failed, what had arrived; nothing for a response a service worker
 *   served (the worker's own fetch is counted on its target).
 * - Sent: each request's headers and its `Content-Length`.
 * - WebSocket frames: their payload (UTF-8 text, or binary).
 * - Not seen: a file Chrome saves as a download (only its request: its body
 *   reaches no network event).
 *
 * Measured 2026-10-27 on Chrome for Testing 155 against local servers: within
 * 0.2% of the bytes they sent and received (the headers). Chrome keeps no byte
 * count of its own to read instead: its histograms moved for neither way.
 *
 * The same connection says when a tab's page died (`Inspector.targetCrashed`
 * on its session: Chrome's sad tab) and opens it again or shows another page
 * there (`onCrash`), so each Chrome has one socket of ours.
 */

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "browser_ui", exclude: true }, { type: "tab", exclude: true }, {}],
};
/**
 * Under a page, frame or worker: its frames and dedicated workers. Service and shared workers are the
 * browser's own targets, attached once above: attached again under each page they serve, their bytes would
 * count twice (a service worker's fetch did).
 */
const AUTO_ATTACH_RELATED = {
  ...AUTO_ATTACH,
  filter: [{ type: "service_worker", exclude: true }, { type: "shared_worker", exclude: true }, {}],
};
/** Bodies never cross the socket, and Chrome buffers none of them for this client. */
const NETWORK = { maxPostDataSize: 1, maxResourceBufferSize: 1, maxTotalBufferSize: 1 };

export interface TrafficCounter {
  /** Settles once Chrome answered the first auto-attach, or the socket failed. */
  attached: Promise<void>;
  /** The bytes counted since the last call. */
  take(): { up: number; down: number };
  close(): void;
}

/** A tab whose page died. */
export interface CrashedPage {
  targetId: string;
  /**
   * Goes to the address it was on again: a page that was a form's answer is fetched again, never sent again (a
   * reload would post the form a second time without asking, as Chrome's own Reload asks).
   */
  reopen(): void;
  /** Shows `url` there instead. */
  show(url: string): void;
}

type Params = Record<string, unknown>;
/** Chrome's byte counts: a component extension's worker says -1. */
const bytes = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** A WebSocket frame's payload: text as UTF-8, binary as Chrome hands it (base64). */
function framePayload(response: unknown): number {
  if (!isObject(response) || typeof response.payloadData !== "string") return 0;
  const data = response.payloadData;
  if (response.opcode === 1) return Buffer.byteLength(data);
  if (response.opcode !== 2) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** A request's headers as they go out, `name: value` lines, plus the body its `Content-Length` says. */
function requestBytes(headers: unknown): number {
  if (!isObject(headers)) return 0;
  let n = 0;
  for (const [name, value] of Object.entries(headers)) {
    const text = String(value);
    n += Buffer.byteLength(name) + Buffer.byteLength(text) + 4;
    if (name.toLowerCase() === "content-length") n += bytes(Number(text));
  }
  return n;
}

/** Counts the Chrome whose browser endpoint is `wsUrl` (`ws://127.0.0.1:<port>/devtools/browser/<id>`). */
export function countChromeTraffic(
  wsUrl: string,
  open: (url: string) => StreamSocket = (url) => new WebSocket(url) as unknown as StreamSocket,
  onCrash?: (page: CrashedPage) => void,
): TrafficCounter {
  let up = 0;
  let down = 0;
  let nextId = 1;
  /** Per session (`""`: the browser's own): each unfinished response's bytes so far, and whether a service worker served it. */
  const sessions = new Map<string, Map<string, { bytes: number; fromWorker: boolean }>>([["", new Map()]]);
  /** The tabs' own sessions (pages attached at the browser's level), with their target. */
  const pages = new Map<string, string>();
  /** What waits on an answer, by the id it was asked under. */
  const answers = new Map<number, (result: Params) => void>();
  let settle = () => {};
  const attached = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let socket: StreamSocket | null = null;
  const send = (method: string, params: Params, sessionId?: string, then?: (result: Params) => void) => {
    const id = nextId++;
    if (then) answers.set(id, then);
    try {
      socket?.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch {
      // closing: what was counted stays
    }
    return id;
  };
  const crashed = (sessionId: string, targetId: string): CrashedPage => ({
    targetId,
    reopen: () =>
      send("Page.getNavigationHistory", {}, sessionId, (history) => {
        const entries = Array.isArray(history.entries) ? history.entries : [];
        const current: unknown = entries[typeof history.currentIndex === "number" ? history.currentIndex : -1];
        if (isObject(current) && typeof current.url === "string" && current.url) {
          send("Page.navigate", { url: current.url }, sessionId);
        }
      }),
    show: (url) => send("Page.navigate", { url }, sessionId),
  });
  let first = 0;
  const entry = (sessionId: string, requestId: unknown) => {
    const requests = sessions.get(sessionId);
    if (!requests || typeof requestId !== "string") return null;
    let e = requests.get(requestId);
    if (!e) {
      e = { bytes: 0, fromWorker: false };
      requests.set(requestId, e);
    }
    return e;
  };
  const end = (sessionId: string, requestId: unknown) => {
    const e = entry(sessionId, requestId);
    sessions.get(sessionId)?.delete(String(requestId));
    return e;
  };

  const onMessage = (raw: unknown) => {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    if (msg.id === first) settle();
    if (typeof msg.id === "number") {
      const then = answers.get(msg.id);
      answers.delete(msg.id);
      if (then && isObject(msg.result)) then(msg.result);
      return;
    }
    const p = isObject(msg.params) ? msg.params : {};
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    switch (msg.method) {
      case "Target.attachedToTarget": {
        if (typeof p.sessionId !== "string") return;
        sessions.set(p.sessionId, new Map());
        const target = isObject(p.targetInfo) ? p.targetInfo : {};
        if (!sessionId && target.type === "page" && typeof target.targetId === "string") {
          pages.set(p.sessionId, target.targetId);
        }
        send("Network.enable", NETWORK, p.sessionId);
        send("Target.setAutoAttach", AUTO_ATTACH_RELATED, p.sessionId);
        return;
      }
      case "Target.detachedFromTarget":
        if (typeof p.sessionId === "string") {
          sessions.delete(p.sessionId);
          pages.delete(p.sessionId);
        }
        return;
      case "Inspector.targetCrashed": {
        const targetId = pages.get(sessionId);
        if (targetId) onCrash?.(crashed(sessionId, targetId));
        return;
      }
      case "Network.requestWillBeSentExtraInfo":
        up += requestBytes(p.headers);
        return;
      case "Network.responseReceived": {
        const e = entry(sessionId, p.requestId);
        if (e && isObject(p.response) && p.response.fromServiceWorker === true) e.fromWorker = true;
        return;
      }
      case "Network.dataReceived": {
        const e = entry(sessionId, p.requestId);
        if (e) e.bytes += bytes(p.encodedDataLength);
        return;
      }
      case "Network.loadingFinished": {
        const e = end(sessionId, p.requestId);
        if (e && !e.fromWorker) down += bytes(p.encodedDataLength);
        return;
      }
      case "Network.loadingFailed": {
        const e = end(sessionId, p.requestId);
        if (e && !e.fromWorker) down += e.bytes;
        return;
      }
      case "Network.webSocketFrameSent":
        up += framePayload(p.response);
        return;
      case "Network.webSocketFrameReceived":
        down += framePayload(p.response);
        return;
    }
  };

  try {
    socket = open(wsUrl);
    socket.onopen = () => {
      first = send("Target.setAutoAttach", AUTO_ATTACH);
    };
    socket.onmessage = (event) => onMessage(event.data);
    socket.onerror = () => settle();
    socket.onclose = () => {
      settle();
      sessions.clear();
      pages.clear();
      answers.clear();
    };
  } catch {
    settle();
  }

  return {
    attached,
    take() {
      const out = { up, down };
      up = 0;
      down = 0;
      return out;
    },
    close() {
      try {
        socket?.close();
      } catch {
        // already closed
      }
    },
  };
}
