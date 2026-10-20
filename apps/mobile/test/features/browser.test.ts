import { describe, expect, test } from "bun:test";
import { type BrowserHandoff, browserHandoffOf, controlledBy, heldTakeoversHere } from "@agenteschat/client";
import { sortWaiting, waitingCardOf } from "../../src/features/activity/logic";
import { cardStateOf, hostOf, siteLetter, siteOf } from "../../src/features/browser/logic";
import { handoffHref, hrefForPush, hrefFromUrl, notificationHref } from "../../src/features/links/logic";
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
    expect(browserHandoffOf({ browserHandoff: card })?.instructions).toBe(card.instructions);
    expect(browserHandoffOf({ browserHandoff: { status: "pending" } })).toBeNull();
    expect(browserHandoffOf({})).toBeNull();
    expect(browserHandoffOf(undefined)).toBeNull();
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

describe("the browser card", () => {
  test("names the live page's site, else the last page the agent opened", () => {
    const steps = [
      { tool: "browser_open", detail: "https://www.loja.exemplo/checkout" },
      { tool: "mcp__agentes__browser_click", detail: null },
    ];
    expect(siteOf("https://Dashboard.Stripe.com/login", steps)).toBe("dashboard.stripe.com");
    expect(siteOf(null, steps)).toBe("www.loja.exemplo");
    expect(siteOf(null, [{ tool: "mcp__agentes__browser_open", detail: "loja.exemplo" }])).toBe("loja.exemplo");
    expect(siteOf(undefined, [])).toBe("");
  });

  test("its letter tile", () => {
    expect(siteLetter("www.loja.exemplo")).toBe("L");
    expect(siteLetter("dashboard.stripe.com")).toBe("D");
    expect(siteLetter("")).toBe("");
  });
});

describe("where a browser request opens", () => {
  test("the push opens its conversation with the card in control", () => {
    const data = readPushData({ orgId: "o1", kind: "browser_handoff", channelId: "c1", handoffId: "h1" });
    expect(data.handoffId).toBe("h1");
    expect(hrefForPush(data)).toBe("/chat/c1?handoff=h1");
    expect(hrefForPush({ kind: "browser_handoff", channelId: "c1", threadId: "t1", handoffId: "h1" })).toBe(
      "/chat/c1?thread=t1&handoff=h1",
    );
    // Without the conversation, the bare route finds it.
    expect(hrefForPush({ kind: "browser_handoff", handoffId: "h1" })).toBe("/handoff/h1");
    // Another kind with a stray handoffId still opens its conversation.
    expect(hrefForPush({ kind: "mention", channelId: "c1", handoffId: "h1" })).toBe("/chat/c1");
  });

  test("the deep links and the inbox item", () => {
    expect(hrefFromUrl("agenteschat://handoff/h1")).toBe("/handoff/h1");
    expect(hrefFromUrl("agenteschat://chat/c1?handoff=h1")).toBe("/chat/c1?handoff=h1");
    expect(handoffHref("h1", "c1", "c1")).toBe("/chat/c1?handoff=h1");
    const n = notification({
      id: "n1",
      kind: "browser_handoff",
      waiting: true,
      source: { channelId: "c1", handoffId: "h1" },
    });
    expect(notificationHref(n)).toBe("/chat/c1?handoff=h1");
  });

  test("it is a waiting card that opens, and it comes first", () => {
    const n = notification({
      id: "n1",
      kind: "browser_handoff",
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

describe("a take over held in the conversation (the card outlives the run's live row)", () => {
  const takeover: BrowserHandoff = {
    id: "t1",
    agentId: "a1",
    runId: "r1",
    machineId: "m1",
    kind: "takeover",
    instructions: "",
    status: "active",
    requestedForUserId: null,
    controllerUserId: "u1",
    note: null,
    expiresAt: null,
    createdAt: "2026-10-19T12:00:00.000Z",
    resolvedAt: null,
  };
  const here = { runIds: new Set(["r1"]), drawnAgents: new Set<string>() };

  test("an open take over of a run of this conversation gets its row; others don't", () => {
    expect(heldTakeoversHere([takeover, null, undefined], here)).toEqual([takeover]);
    // Another conversation's run, an ended one, or the agent's own request (its message is its card).
    expect(heldTakeoversHere([{ ...takeover, runId: "r9" }], here)).toEqual([]);
    expect(heldTakeoversHere([{ ...takeover, status: "done" }], here)).toEqual([]);
    expect(heldTakeoversHere([{ ...takeover, kind: "ask" }], here)).toEqual([]);
    expect(heldTakeoversHere([{ ...takeover, runId: null }], here)).toEqual([]);
  });

  test("not while the run's live browser row still draws it, and one per agent", () => {
    expect(heldTakeoversHere([takeover], { ...here, drawnAgents: new Set(["a1"]) })).toEqual([]);
    expect(heldTakeoversHere([takeover, { ...takeover, id: "t2" }], here)).toHaveLength(1);
  });

  test("in control: only the person holding it", () => {
    expect(controlledBy(takeover, "u1")).toBe(true);
    expect(controlledBy(takeover, "u2")).toBe(false);
    expect(controlledBy({ ...takeover, status: "pending" }, "u1")).toBe(false);
  });
});
