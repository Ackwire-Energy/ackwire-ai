import { describe, expect, test } from "bun:test";
import { type BrowserHandoff, browserHandoffOf, controlledBy, heldTakeoversHere } from "@agenteschat/client";
import { sortWaiting, waitingCardOf } from "../../src/features/activity/logic";
import {
  browserGranted,
  cardStateOf,
  hostOf,
  type PageGap,
  pageNoteOf,
  siteLetter,
  siteOf,
  skyBehind,
  waitsForPage,
} from "../../src/features/browser/logic";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
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

  test("a request on the agent's desktop opens on a computer: never the browser card, never taken here", () => {
    const desktop = { screen: "desktop" as const, controllerUserId: null };
    expect(cardStateOf({ ...desktop, status: "pending" }, "u1")).toBe("computer");
    expect(cardStateOf({ ...desktop, status: "active", controllerUserId: "u1" }, "u1")).toBe("computer");
    // How it ended reads as any request's.
    expect(cardStateOf({ ...desktop, status: "done" }, "u1")).toBe("done");
    expect(cardStateOf({ screen: "browser", status: "pending", controllerUserId: null }, "u1")).toBe("waiting");
    for (const keys of [featureKeysPtBR, featureKeysEn]) expect(keys.browser.card.computer).toContain("{{title}}");
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

describe("the page box with no page to show", () => {
  test("a closed browser says so, without a spinner, and that it opens again by itself", () => {
    expect(pageNoteOf("closed", false, false)).toEqual({ say: "closed", spin: false, help: "closedHelp" });
    expect(pageNoteOf("closed", false, true)).toEqual({ say: "closed", spin: false, help: "closedHelp" });
  });

  test("someone else in control: the screen stays theirs", () => {
    expect(pageNoteOf(null, true, false)).toEqual({ say: "hidden", spin: false, help: null });
    // A reason to show nothing at all wins over who holds it.
    expect(pageNoteOf("offline", true, false)).toEqual({ say: "offline", spin: false, help: null });
    // A closed browser is held until a frame, and no frame reaches a hidden view: who holds it is what it says.
    expect(pageNoteOf("closed", true, false)).toEqual({ say: "hidden", spin: false, help: null });
    expect(pageNoteOf("ended", true, false)).toEqual({ say: "hidden", spin: false, help: null });
  });

  test("opening and reconnecting spin; the person in control hears the 2-minute grace", () => {
    expect(pageNoteOf(null, false, false)).toEqual({ say: "starting", spin: true, help: null });
    expect(pageNoteOf("reconnecting", false, true)).toEqual({ say: "reconnecting", spin: true, help: "grace" });
    expect(pageNoteOf("reconnecting", false, false)).toEqual({ say: "reconnecting", spin: true, help: null });
    for (const gap of ["offline", "no_computer", "unavailable", "forbidden", "ended"] as const)
      expect(pageNoteOf(gap, false, false)).toEqual({ say: gap, spin: false, help: null });
  });

  test("a closed, ended or offline browser shows the agent's sky behind its words; a page on its way doesn't", () => {
    for (const gap of ["closed", "ended", "offline"] as const)
      expect(skyBehind(pageNoteOf(gap, false, false))).toBe(true);
    for (const gap of [null, "reconnecting", "no_computer", "unavailable", "forbidden"] as const)
      expect(skyBehind(pageNoteOf(gap, false, false))).toBe(false);
    // Someone else in control: their screen stays theirs, no sky.
    expect(skyBehind(pageNoteOf("closed", true, false))).toBe(false);
  });

  test("opening, reconnecting or not available for too long says it couldn't open, with Try again; nothing else does", () => {
    for (const gap of [null, "reconnecting", "unavailable"] as const) {
      expect(pageNoteOf(gap, false, true, true)).toEqual({ say: "stuck", spin: false, help: "stuckHelp" });
      expect(waitsForPage(gap)).toBe(true);
    }
    // What waiting can't change keeps its own words, and a page someone else holds stays theirs.
    for (const gap of ["closed", "offline", "no_computer", "forbidden", "ended"] as const) {
      expect(pageNoteOf(gap, false, false, true).say).toBe(gap);
      expect(waitsForPage(gap)).toBe(false);
    }
    expect(pageNoteOf(null, true, false, true).say).toBe("hidden");
    expect(skyBehind(pageNoteOf(null, false, false, true))).toBe(false);
  });

  test("every reason has its words in both languages (the key is built from the reason)", () => {
    const reasons: (PageGap | "stuck")[] = [
      "reconnecting",
      "offline",
      "no_computer",
      "closed",
      "unavailable",
      "forbidden",
      "ended",
      "stuck",
    ];
    for (const keys of [featureKeysPtBR, featureKeysEn]) {
      const words = keys.browser.live.unavailable as Record<string, string>;
      for (const r of reasons) for (const g of ["F", "M"]) expect(words[`${r}${g}`]).toBeTruthy();
      const live = keys.browser.live as Record<string, unknown>;
      for (const g of ["F", "M"]) expect(live[`stuckHelp${g}`]).toBeTruthy();
    }
    expect(featureKeysPtBR.browser.live.unavailable.stuckF).toBe("Não deu para abrir o navegador da {{name}}.");
    expect(featureKeysEn.browser.live.stuckHelpM).toBe("Try again restarts the browser. Its sign-ins stay saved.");
  });
});

describe("whether the agent may use its browser", () => {
  test("only for an agent granted its browser (all tools doesn't cover it)", () => {
    const access = (state: "granted" | "inherited" | "denied" | "off") => ({
      builtins: [{ scope: "browser:use", label: "Navegador", state, tools: [] }],
    });
    expect(browserGranted(access("granted"))).toBe(true);
    expect(browserGranted(access("inherited"))).toBe(false);
    expect(browserGranted(access("off"))).toBe(false);
    expect(browserGranted({ builtins: [] })).toBe(false);
    expect(browserGranted(undefined)).toBe(false);
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
