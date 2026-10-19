import { describe, expect, test } from "bun:test";
import type { AppNotification } from "@agenteschat/client";
import { sortWaiting, waitingCardOf } from "../../src/features/activity/logic";
import {
  cardStateOf,
  clickAt,
  handoffOf,
  hostOf,
  keyPress,
  liveBackoff,
  pagePoint,
  textInput,
} from "../../src/features/browser/logic";
import { hrefForPush, hrefFromUrl, notificationHref } from "../../src/features/links/logic";
import { readPushData } from "../../src/lib/push-payload";
import { notification } from "./fixtures";

const card = {
  id: "h1",
  agentId: "a1",
  kind: "ask",
  instructions: "Entrar no painel com a conta de teste",
  status: "pending",
  requestedForUserId: "u1",
  controllerUserId: null,
  note: null,
  expiresAt: "2026-10-19T12:10:00.000Z",
  createdAt: "2026-10-19T12:00:00.000Z",
};

describe("the help request card", () => {
  test("reads the handoff from the message, and nothing malformed", () => {
    expect(handoffOf({ browserHandoff: card })?.instructions).toBe(card.instructions);
    expect(handoffOf({ browserHandoff: { ...card, status: "weird" } })).toBeNull();
    expect(handoffOf({ browserHandoff: { status: "pending" } })).toBeNull();
    expect(handoffOf({})).toBeNull();
    expect(handoffOf(undefined)).toBeNull();
  });

  test("its state: waiting, me in control, someone else, or how it ended", () => {
    expect(cardStateOf({ status: "pending", controllerUserId: null }, "u1")).toBe("waiting");
    expect(cardStateOf({ status: "active", controllerUserId: "u1" }, "u1")).toBe("mine");
    expect(cardStateOf({ status: "active", controllerUserId: "u2" }, "u1")).toBe("helping");
    expect(cardStateOf({ status: "active", controllerUserId: "u2" }, null)).toBe("helping");
    expect(cardStateOf({ status: "done", controllerUserId: "u1" }, "u1")).toBe("done");
    expect(cardStateOf({ status: "expired", controllerUserId: null }, "u1")).toBe("expired");
  });

  test("the site's host", () => {
    expect(hostOf("https://Dashboard.Stripe.com/login?x=1")).toBe("dashboard.stripe.com");
    expect(hostOf("about:blank")).toBe("");
    expect(hostOf(undefined)).toBe("");
  });
});

describe("the live view", () => {
  const page = { width: 1280, height: 800 };

  test("a tap lands on the page point under it (contain fit, letterbox ignored)", () => {
    // 390×400 view: scale = min(390/1280, 400/800) = 0.3047; picture 390×243.75, centered vertically.
    const view = { width: 390, height: 400 };
    const top = (400 - 800 * (390 / 1280)) / 2;
    expect(pagePoint({ x: 195, y: 200 }, view, page)).toEqual({ x: 640, y: 400 });
    expect(pagePoint({ x: 0, y: top }, view, page)).toEqual({ x: 0, y: 0 });
    expect(pagePoint({ x: 195, y: 10 }, view, page)).toBeNull();
    expect(pagePoint({ x: 10, y: 10 }, { width: 0, height: 0 }, page)).toBeNull();
  });

  test("a click is move, press, release at the point", () => {
    const events = clickAt({ x: 10, y: 20 });
    expect(events.map((e) => (e.kind === "mouse" ? e.type : e.kind))).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(events[1]).toMatchObject({ x: 10, y: 20, button: "left", clickCount: 1 });
  });

  test("keys and the whole text of the app's field", () => {
    expect(keyPress("Enter")).toEqual([
      { kind: "key", type: "keyDown", key: "Enter" },
      { kind: "key", type: "keyUp", key: "Enter" },
    ]);
    expect(textInput("ação@teste")).toEqual([{ kind: "text", text: "ação@teste" }]);
    expect(textInput("")).toEqual([]);
  });

  test("reconnects with backoff, the last delay repeats", () => {
    expect(liveBackoff(0)).toBe(500);
    expect(liveBackoff(3)).toBe(4000);
    expect(liveBackoff(99)).toBe(8000);
    expect(liveBackoff(-1)).toBe(500);
  });
});

describe("where a browser request opens", () => {
  test("the push opens the live view", () => {
    const data = readPushData({ orgId: "o1", kind: "browser_handoff", channelId: "c1", handoffId: "h1" });
    expect(data.handoffId).toBe("h1");
    expect(hrefForPush(data)).toBe("/handoff/h1");
    // Another kind with a stray handoffId still opens its conversation.
    expect(hrefForPush({ kind: "mention", channelId: "c1", handoffId: "h1" })).toBe("/chat/c1");
  });

  test("the deep link and the inbox item", () => {
    expect(hrefFromUrl("agenteschat://handoff/h1")).toBe("/handoff/h1");
    const n = notification({
      id: "n1",
      kind: "browser_handoff" as AppNotification["kind"],
      waiting: true,
      source: { channelId: "c1", handoffId: "h1" } as AppNotification["source"],
    });
    expect(notificationHref(n)).toBe("/handoff/h1");
  });

  test("it is a waiting card that opens, and it comes first", () => {
    const n = notification({
      id: "n1",
      kind: "browser_handoff" as AppNotification["kind"],
      waiting: true,
      latest: { text: "Entrar no painel", expiresAt: "2026-10-19T12:10:00.000Z" },
    });
    expect(waitingCardOf(n)).toEqual({
      kind: "browser",
      title: "Entrar no painel",
      expiresAt: "2026-10-19T12:10:00.000Z",
      action: "open",
    });
    const q = notification({ id: "n2", kind: "agent_question", waiting: true });
    expect(sortWaiting([q, n]).map((x) => x.id)).toEqual(["n1", "n2"]);
  });
});
