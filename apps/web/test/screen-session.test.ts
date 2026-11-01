import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type RFB from "@novnc/novnc";
import type { RfbChannel } from "@novnc/novnc";
import { type ScreenEvent, ScreenSession } from "@/screen/session";

class FakeSocket extends EventTarget {
  binaryType = "blob";
  readyState = 1;
  sent: unknown[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  serverCloses(code: number, reason = "") {
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
  serverSays(text: string) {
    this.dispatchEvent(new MessageEvent("message", { data: text }));
  }
}

class FakeRfb extends EventTarget {
  viewOnly = false;
  qualityLevel = 0;
  compressionLevel = 0;
  scaleViewport = true;
  resizeSession = true;
  focusOnClick = true;
  background = "";
  keys: [number, string | null, boolean | undefined][] = [];
  pasted: string[] = [];
  gone = false;
  constructor(readonly channel: RfbChannel) {
    super();
  }
  sendKey(keysym: number, code: string | null, down?: boolean) {
    this.keys.push([keysym, code, down]);
  }
  clipboardPasteFrom(text: string) {
    this.pasted.push(text);
  }
  disconnect() {
    this.gone = true;
    this.channel.close();
  }
  connects() {
    this.dispatchEvent(new Event("connect"));
  }
}

const opened: ScreenSession[] = [];

function setup() {
  const target = document.createElement("div");
  const sockets: FakeSocket[] = [];
  const rfbs: FakeRfb[] = [];
  const events: ScreenEvent[] = [];
  const session = new ScreenSession(
    target,
    { orgId: "org", agentId: "ada", base: { protocol: "https:", host: "app.example" } },
    {
      createRfb: (_el, channel) => {
        const rfb = new FakeRfb(channel);
        rfbs.push(rfb);
        return rfb as unknown as RFB;
      },
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      post: (e) => events.push(e),
    },
  );
  opened.push(session);
  return { session, sockets, rfbs, events };
}

afterEach(() => {
  for (const s of opened.splice(0)) s.set({ connect: false, mode: "watch" });
});

describe("the agent's screen on the phone's page", () => {
  test("it opens only when asked, and draws at the desktop's own size: the app moves and zooms it", () => {
    const { session, sockets, rfbs } = setup();
    expect(sockets).toHaveLength(0);
    session.set({ connect: true, mode: "watch" });
    expect(sockets[0]?.url).toContain("/api/desktop?");
    expect(sockets[0]?.url).toContain("switch=1");
    expect(sockets[0]?.url).toContain("mode=watch");
    expect(rfbs[0]?.viewOnly).toBe(true);
    expect(rfbs[0]?.scaleViewport).toBe(false);
    expect(rfbs[0]?.qualityLevel).toBe(3);
  });

  test("the same wish twice does nothing", () => {
    const { session, sockets } = setup();
    session.set({ connect: true, mode: "watch" });
    session.set({ connect: true, mode: "watch" });
    expect(sockets).toHaveLength(1);
  });

  test("a pointer goes as one RFB message, only in control and only once connected", () => {
    const { session, sockets, rfbs } = setup();
    session.set({ connect: true, mode: "control" });
    session.pointer(300, 200, 1);
    expect(sockets[0]?.sent).toEqual([]);
    rfbs[0]?.connects();
    session.pointer(300.4, 200.6, 1);
    const sent = sockets[0]?.sent[0] as Uint8Array;
    expect([...sent]).toEqual([5, 1, 300 >> 8, 300 & 255, 201 >> 8, 201 & 255]);
  });

  test("watching takes no input at all", () => {
    const { session, sockets, rfbs } = setup();
    session.set({ connect: true, mode: "watch" });
    rfbs[0]?.connects();
    session.pointer(10, 10, 1);
    session.key("Enter");
    session.type("oi");
    expect(sockets[0]?.sent).toEqual([]);
    expect(rfbs[0]?.keys).toEqual([]);
    expect(rfbs[0]?.pasted).toEqual([]);
  });

  test("the key row presses X keys; an emoji goes as a paste, with Shift+Insert", () => {
    const { session, rfbs } = setup();
    session.set({ connect: true, mode: "control" });
    rfbs[0]?.connects();
    session.key("Enter");
    expect(rfbs[0]?.keys).toEqual([[0xff0d, "Enter", undefined]]);
    session.type("oi 🙂");
    expect(rfbs[0]?.pasted).toEqual(["oi 🙂"]);
    expect(rfbs[0]?.keys.slice(1).map((k) => k[2])).toEqual([true, true, false, false]);
  });

  test("a paste the desktop would drop is said, never sent", () => {
    const { session, rfbs, events } = setup();
    session.set({ connect: true, mode: "control" });
    rfbs[0]?.connects();
    session.type(`🙂${"a".repeat(300_000)}`);
    expect(rfbs[0]?.pasted).toEqual([]);
    expect(events).toContainEqual({ type: "refused", why: "tooLong" });
  });

  test("a close says why, and one for good stops trying until asked", () => {
    const { session, sockets, events } = setup();
    session.set({ connect: true, mode: "watch" });
    sockets[0]?.serverCloses(4403);
    expect(events).toContainEqual({ type: "view", state: "forbidden" });
    expect(events).toContainEqual({ type: "changed" });
    session.retry();
    expect(sockets).toHaveLength(2);
  });

  test("a close heard after letting go changes nothing", () => {
    const { session, sockets, events } = setup();
    session.set({ connect: true, mode: "watch" });
    session.set({ connect: false, mode: "watch" });
    expect(sockets[0]?.closed).toBe(true);
    const before = events.length;
    sockets[0]?.serverCloses(4403);
    expect(events).toHaveLength(before);
  });

  test("the server switching a stream starts a new session on the same socket", () => {
    const { session, sockets, rfbs, events } = setup();
    session.set({ connect: true, mode: "watch" });
    rfbs[0]?.connects();
    sockets[0]?.serverSays('{"type":"mode","mode":"watch"}');
    session.set({ connect: true, mode: "control" });
    sockets[0]?.serverSays('{"type":"mode","mode":"control"}');
    expect(sockets).toHaveLength(1);
    expect(rfbs[0]?.gone).toBe(true);
    expect(rfbs[1]?.viewOnly).toBe(false);
    expect(rfbs[1]?.qualityLevel).toBe(6);
    expect(events).toContainEqual({ type: "changed" });
  });

  test("a stream that can't switch opens again in the new mode", () => {
    const { session, sockets } = setup();
    session.set({ connect: true, mode: "watch" });
    session.set({ connect: true, mode: "control" });
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.url).toContain("mode=control");
  });
});
