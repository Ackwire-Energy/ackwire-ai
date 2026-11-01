import { expect, test } from "bun:test";
import type { StreamSocket } from "../../runner/browser";
import { type CrashedPage, countChromeTraffic } from "../../runner/browser-traffic";

/** Chrome's end of the counter's DevTools socket: what the counter sent, and events pushed to it. */
class FakeCdp implements StreamSocket {
  readonly sent: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  event(method: string, params: Record<string, unknown>, sessionId?: string) {
    this.onmessage?.({ data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
  }
  reply(id: number, result: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }
  attach(sessionId: string, type = "page") {
    this.event("Target.attachedToTarget", {
      sessionId,
      targetInfo: { targetId: `t-${sessionId}`, type, url: "" },
      waitingForDebugger: false,
    });
  }
}

function counter(onCrash?: (page: CrashedPage) => void) {
  let cdp: FakeCdp | undefined;
  const c = countChromeTraffic(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    (url) => {
      cdp = new FakeCdp(url);
      return cdp;
    },
    onCrash,
  );
  if (!cdp) throw new Error("no socket");
  return { c, cdp };
}

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "browser_ui", exclude: true }, { type: "tab", exclude: true }, {}],
};
/** Under a target: never the service and shared workers the browser level already attached (counted once). */
const RELATED = {
  ...AUTO_ATTACH,
  filter: [{ type: "service_worker", exclude: true }, { type: "shared_worker", exclude: true }, {}],
};

test("one socket to the browser endpoint: auto-attach without pausing, then network events with no bodies on every session", async () => {
  const { c, cdp } = counter();
  expect(cdp.url).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
  let attached = false;
  void c.attached.then(() => {
    attached = true;
  });
  cdp.onopen?.();
  expect(cdp.sent).toEqual([{ id: 1, method: "Target.setAutoAttach", params: AUTO_ATTACH }]);
  await Bun.sleep(5);
  expect(attached).toBe(false);
  cdp.reply(1);
  await c.attached;
  // A page, then a frame and a worker inside it: each gets the same, on its own session.
  cdp.attach("page-1");
  cdp.event(
    "Target.attachedToTarget",
    { sessionId: "frame-1", targetInfo: { type: "iframe" }, waitingForDebugger: false },
    "page-1",
  );
  cdp.attach("worker-1", "worker");
  const network = { maxPostDataSize: 1, maxResourceBufferSize: 1, maxTotalBufferSize: 1 };
  expect(cdp.sent.slice(1).map(({ method, params, sessionId }) => ({ method, params, sessionId }))).toEqual([
    { method: "Network.enable", params: network, sessionId: "page-1" },
    { method: "Target.setAutoAttach", params: RELATED, sessionId: "page-1" },
    { method: "Network.enable", params: network, sessionId: "frame-1" },
    { method: "Target.setAutoAttach", params: RELATED, sessionId: "frame-1" },
    { method: "Network.enable", params: network, sessionId: "worker-1" },
    { method: "Target.setAutoAttach", params: RELATED, sessionId: "worker-1" },
  ]);
  // It never resumes or pauses a target, and asks for nothing else.
  expect(new Set(cdp.sent.map((m) => m.method))).toEqual(new Set(["Target.setAutoAttach", "Network.enable"]));
  expect(cdp.sent.every((m) => m.method !== "Network.enable" || m.sessionId)).toBe(true);
});

test("received: each finished response's encoded size; a failed one, what had arrived; never below zero", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  cdp.event("Network.responseReceived", { requestId: "r1", response: { status: 200 } }, "p");
  cdp.event("Network.dataReceived", { requestId: "r1", dataLength: 9000, encodedDataLength: 4000 }, "p");
  cdp.event("Network.loadingFinished", { requestId: "r1", encodedDataLength: 4321 }, "p");
  cdp.event("Network.dataReceived", { requestId: "r2", encodedDataLength: 700 }, "p");
  cdp.event("Network.dataReceived", { requestId: "r2", encodedDataLength: 300 }, "p");
  cdp.event("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_ABORTED" }, "p");
  // A component extension's worker says -1.
  cdp.event("Network.loadingFinished", { requestId: "r3", encodedDataLength: -1 }, "p");
  cdp.event("Network.dataReceived", { requestId: "r4", encodedDataLength: -50 }, "p");
  cdp.event("Network.loadingFailed", { requestId: "r4" }, "p");
  expect(c.take()).toEqual({ up: 0, down: 5321 });
  // Taken: the next take starts from zero.
  expect(c.take()).toEqual({ up: 0, down: 0 });
});

test("sent: each request's headers as lines, plus the body its Content-Length says", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  cdp.event(
    "Network.requestWillBeSentExtraInfo",
    {
      requestId: "r1",
      headers: { ":method": "POST", "content-type": "application/octet-stream", "Content-Length": "2000000" },
    },
    "p",
  );
  cdp.event("Network.requestWillBeSentExtraInfo", { requestId: "r2", headers: { accept: "*/*" } }, "p");
  const lines = (h: Record<string, string>) =>
    Object.entries(h).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 4, 0);
  expect(c.take()).toEqual({
    up:
      lines({ ":method": "POST", "content-type": "application/octet-stream", "Content-Length": "2000000" }) +
      2_000_000 +
      lines({ accept: "*/*" }),
    down: 0,
  });
});

test("a response a service worker served counts nothing: the worker's own fetch is counted on its target", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("page");
  cdp.attach("sw", "service_worker");
  // The worker fetches from the network…
  cdp.event("Network.responseReceived", { requestId: "w1", response: { fromServiceWorker: false } }, "sw");
  cdp.event("Network.loadingFinished", { requestId: "w1", encodedDataLength: 10_000 }, "sw");
  // …and answers the page from it.
  cdp.event("Network.responseReceived", { requestId: "p1", response: { fromServiceWorker: true } }, "page");
  cdp.event("Network.dataReceived", { requestId: "p1", encodedDataLength: 10_000 }, "page");
  cdp.event("Network.loadingFinished", { requestId: "p1", encodedDataLength: 10_200 }, "page");
  cdp.event("Network.responseReceived", { requestId: "p2", response: { fromServiceWorker: true } }, "page");
  cdp.event("Network.dataReceived", { requestId: "p2", encodedDataLength: 800 }, "page");
  cdp.event("Network.loadingFailed", { requestId: "p2" }, "page");
  expect(c.take()).toEqual({ up: 0, down: 10_000 });
});

test("WebSocket frames: their payload, text as UTF-8 and binary as decoded bytes", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  const frame = (opcode: number, payloadData: string) => ({
    requestId: "ws",
    response: { opcode, mask: false, payloadData },
  });
  cdp.event("Network.webSocketFrameSent", frame(1, "olá"), "p");
  cdp.event("Network.webSocketFrameReceived", frame(1, "ação ✓"), "p");
  cdp.event("Network.webSocketFrameReceived", frame(2, Buffer.alloc(10, 7).toString("base64")), "p");
  cdp.event("Network.webSocketFrameSent", frame(2, Buffer.alloc(3).toString("base64")), "p");
  // A close or a ping isn't payload.
  cdp.event("Network.webSocketFrameReceived", frame(8, "AAA="), "p");
  expect(c.take()).toEqual({ up: Buffer.byteLength("olá") + 3, down: Buffer.byteLength("ação ✓") + 10 });
});

test("a detached session drops what it had in flight; garbage and unknown events are ignored", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  cdp.event("Network.dataReceived", { requestId: "r1", encodedDataLength: 500 }, "p");
  cdp.event("Target.detachedFromTarget", { sessionId: "p", targetId: "t-p" });
  // Whatever still came for it finds nothing kept.
  cdp.event("Network.loadingFailed", { requestId: "r1" }, "p");
  for (const data of ["not json", "[1,2]", "null", JSON.stringify({ method: "Network.loadingFinished" }), 42]) {
    cdp.onmessage?.({ data });
  }
  cdp.event("Network.loadingFinished", { requestId: 5, encodedDataLength: "lots" }, "p");
  cdp.event("Network.requestWillBeSentExtraInfo", { requestId: "x", headers: "accept: */*" }, "p");
  cdp.event("Page.frameNavigated", { frame: { url: "https://example.com" } }, "p");
  expect(c.take()).toEqual({ up: 0, down: 0 });
});

test("a tab whose page died: said once per crash, opened again at its address by a fresh visit, or shown another page", () => {
  const crashes: CrashedPage[] = [];
  const { cdp } = counter((page) => crashes.push(page));
  cdp.onopen?.();
  cdp.reply(1);
  cdp.attach("tab");
  // A frame inside it, and a worker: their renderers dying isn't the tab's page dying.
  cdp.event("Target.attachedToTarget", { sessionId: "frame", targetInfo: { targetId: "f", type: "iframe" } }, "tab");
  cdp.attach("worker", "worker");
  cdp.event("Inspector.targetCrashed", {}, "frame");
  cdp.event("Inspector.targetCrashed", {}, "worker");
  cdp.event("Inspector.targetCrashed", {});
  expect(crashes).toEqual([]);
  cdp.event("Inspector.targetCrashed", {}, "tab");
  expect(crashes.map((p) => p.targetId)).toEqual(["t-tab"]);
  const asked = () => cdp.sent.filter((m) => m.method.startsWith("Page."));

  // Opened again at the address it was on, found in its history: a form's answer is fetched, never posted again.
  crashes[0]?.reopen();
  const history = asked().at(-1);
  expect(history).toMatchObject({ method: "Page.getNavigationHistory", params: {}, sessionId: "tab" });
  const entries = [
    { id: 1, url: "https://shop.example/cart", title: "Cart" },
    { id: 2, url: "https://shop.example/order", title: "Order" },
  ];
  cdp.reply(history?.id ?? 0, { currentIndex: 1, entries });
  expect(asked().at(-1)).toMatchObject({
    method: "Page.navigate",
    params: { url: "https://shop.example/order" },
    sessionId: "tab",
  });
  // A history it can't read opens nothing.
  crashes[0]?.reopen();
  cdp.reply(asked().at(-1)?.id ?? 0, { currentIndex: 5, entries });
  expect(asked().at(-1)?.method).toBe("Page.getNavigationHistory");

  crashes[0]?.show("data:text/html,notice");
  expect(asked().at(-1)).toMatchObject({
    method: "Page.navigate",
    params: { url: "data:text/html,notice" },
    sessionId: "tab",
  });
  // Gone: its crash isn't anyone's anymore.
  cdp.event("Target.detachedFromTarget", { sessionId: "tab", targetId: "t-tab" });
  cdp.event("Inspector.targetCrashed", {}, "tab");
  expect(crashes).toHaveLength(1);
});

test("a socket that fails or closes settles the attach and keeps what was counted", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  cdp.event("Network.loadingFinished", { requestId: "r", encodedDataLength: 77 }, "p");
  cdp.onerror?.();
  await c.attached;
  c.close();
  expect(cdp.closed).toBe(true);
  expect(c.take()).toEqual({ up: 0, down: 77 });
  // A socket that can't even be made counts nothing and doesn't hold anyone up.
  const broken = countChromeTraffic("ws://127.0.0.1:1/devtools/browser/x", () => {
    throw new Error("no sockets here");
  });
  await broken.attached;
  expect(broken.take()).toEqual({ up: 0, down: 0 });
  broken.close();
});
