import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { BROWSER_STUCK_MS, type BrowserHandoff } from "@agenteschat/client";
import { icons } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { titleKind } from "@/components/browser/BrowserCard";
import { ADA_ID, createFakeApi, ENG_ID, fakeBrowserOf, ORG_ID, seedState } from "./fake-api";
import { onScreen, renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const HANDOFF_ID = "h-card";

/** Ada asked for help in its browser: the request card in #eng (its id is the handoff's). */
function seedRequest(expiresAt = Date.now() + 10 * 60_000) {
  const state = seedState();
  const handoff: BrowserHandoff = {
    id: HANDOFF_ID,
    agentId: ADA_ID,
    runId: "r-ask",
    machineId: "machine-1",
    kind: "ask",
    instructions: "Entrar no painel com a conta de teste",
    status: "pending",
    requestedForUserId: "u-walter",
    controllerUserId: null,
    note: null,
    expiresAt: new Date(expiresAt).toISOString(),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
  state.messages.push({
    id: HANDOFF_ID,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Help needed in the browser: Entrar no painel com a conta de teste",
    mentionedAgentIds: [],
    agentRunId: "r-ask",
    createdAt: new Date().toISOString(),
    meta: { browserHandoff: handoff, bodyCode: "browser_handoff", bodyParams: { instructions: handoff.instructions } },
  } as (typeof state.messages)[number]);
  return { state, handoff };
}

/** The waiting request: a request card (a labelled group with the handoff's id). */
const waitingRequest = () => document.querySelector(`[data-ask-id="${HANDOFF_ID}"]`) as HTMLElement;

describe("a help request opens the agent's browser in its card", () => {
  // Real time passes in it (the request's own timer), so it gets more than the default 5 s.
  test("nobody opens it: at its time it stops waiting for you, even with no event", async () => {
    const expiresAt = Date.now() + 3_000;
    const { state, handoff } = seedRequest(expiresAt);
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    expect(waitingRequest().hasAttribute("data-ask-mine")).toBe(true);
    // Nothing comes from the server: the card's own timer closes it at that moment.
    await act(() => new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 50)));
    await settle(2);
    expect(waitingRequest()).toBeNull();
    expect(document.querySelector(".brw-rq--settled")?.textContent).toContain("pediu ajuda · expirou");
  }, 15_000);

  test("Abrir aqui takes control in place: Pronto in the header, the app's own text field, no page change", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const request = waitingRequest();
    expect(request).toBeTruthy();
    expect(request.getAttribute("role")).toBe("group");
    expect(request.getAttribute("data-ask-kind")).toBe("browser");
    expect(request.textContent).toContain("Precisa de você no navegador");
    expect(request.textContent).toContain("esperando você");
    expect(request.textContent).toContain("Entrar no painel com a conta de teste");
    const openHere = within(request).getByRole("button", { name: "Abrir aqui" });
    expect(openHere.getAttribute("title")).toBe("Abre neste card, sem sair do chat.");

    await act(async () => fireEvent.click(openHere));
    await settle(4);
    expect(state.calls.some((c) => c.method === "browser.takeControl")).toBe(true);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);

    const card = document.querySelector(".brw-ac") as HTMLElement;
    expect(card.classList.contains("is-open")).toBe(true);
    expect(card.classList.contains("is-control")).toBe(true);
    // The request is the frame's title, with Pronto in its top; the request above says who is helping.
    const top = card.querySelector(".brw-mf__top") as HTMLElement;
    expect(top.querySelector("b")?.textContent).toBe("Entrar no painel com a conta de teste");
    expect(within(top).getByRole("button", { name: "Pronto" })).toBeTruthy();
    expect(within(card).getByRole("textbox", { name: "Texto para a página" })).toBeTruthy();
    // Desistir next to Pronto (the old "Não consegui" under the field is gone).
    expect(within(top).getByRole("button", { name: "Desistir" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Não consegui" })).toBeNull();
    expect(document.querySelector(".brw-rq")?.textContent).toContain("Você está ajudando · neste card");

    // The typing bar: one field, Senha as a lock toggle, the keys behind a keyboard button.
    const lock = within(card).getByRole("button", { name: "Esconder o texto (senha)" });
    await act(async () => fireEvent.click(lock));
    expect(within(card).getByRole("button", { name: "Mostrar o texto" }).getAttribute("aria-pressed")).toBe("true");
    expect(card.querySelector(".brw-keycaps")).toBeNull();
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Teclas" })));
    const keys = within(card).getByRole("group", { name: "Teclas" });
    expect(
      within(keys)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Tab", "Enter", "Apagar", "Esc"]);

    // Desistir asks what happened: its note is one line in the middle of its field that grows as it wraps.
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Desistir" })));
    expect(card.textContent).toContain("O que aconteceu?");
    const why = within(card).getByPlaceholderText("Conte com suas palavras") as HTMLTextAreaElement;
    expect([why.getAttribute("rows"), why.className]).toEqual(["1", "ac-input brw-ac__note"]);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Voltar" })));

    // Pronto takes an optional word for Ada (Enter sends), then hands back: the card folds away.
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Pronto" })));
    expect(card.textContent).toContain("Pronto. Algum recado para a Ada?");
    const note = within(card).getByRole("textbox", { name: "Recado para a Ada" }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(note);
    // The same note as on the screen: one line in the middle of its field that grows as it wraps, with no grip.
    expect([note.tagName, note.getAttribute("rows"), note.className]).toEqual([
      "TEXTAREA",
      "1",
      "ac-input brw-ac__note",
    ]);
    await act(async () => fireEvent.change(note, { target: { value: "Entrei com a conta de teste" } }));
    // Shift+Enter adds a line, as in the chat; Enter sends the note, and adds no line to it.
    expect(fireEvent.keyDown(note, { key: "Enter", shiftKey: true })).toBe(true);
    let typed = true;
    await act(async () => {
      typed = fireEvent.keyDown(note, { key: "Enter" });
    });
    expect(typed).toBe(false);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "browser.done").map((c) => c.args)).toEqual([
      [ORG_ID, HANDOFF_ID, "Entrei com a conta de teste"],
    ]);
    expect(document.querySelector(".brw-ac")).toBeNull();
  });
});

/** A JPEG's first bytes (SOI + a start-of-frame for 1280×800): enough for the page's size. */
const FRAME_DATA = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 32, 5, 0, 3, 0, 0, 0));

describe("the card in the message", () => {
  test("always open, its page in a frame of the agent's color: full screen and back, in control too", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    // Taking over from the request: the card is the control.
    await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    await act(async () =>
      socket.push({
        type: "browser.frame",
        agentId: ADA_ID,
        seq: 1,
        data: FRAME_DATA,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      }),
    );
    // The page in its frame, with no small form to fold it into.
    expect(card.classList.contains("brw-mf")).toBe(true);
    expect(card.querySelector(".brw-ac__page img")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Recolher" })).toBeNull();
    // Full screen and back, as in the computer's window: corners pulled apart, then pushed together.
    const glyph = (name: string) => within(card).getByRole("button", { name }).querySelector("path")?.getAttribute("d");
    expect(glyph("Tela cheia")).toBe(icons.expand[0]?.[1].d);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Tela cheia" })));
    expect(glyph("Sair da tela cheia")).toBe(icons.shrink[0]?.[1].d);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Sair da tela cheia" })));
    expect(card.classList.contains("is-full")).toBe(false);
    expect(card.classList.contains("brw-mf")).toBe(true);
  });

  test("the wheel scrolls the conversation until the page is clicked; Esc gives it back", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    await act(async () =>
      socket.push({
        type: "browser.frame",
        agentId: ADA_ID,
        seq: 1,
        data: FRAME_DATA,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      }),
    );
    await settle(2);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const page = card.querySelector(".brw-ac__page") as HTMLElement;
    const img = page.querySelector("img") as HTMLImageElement;
    img.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 640,
        height: 400,
        right: 640,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const wheelOn = async () => {
      const e = new WheelEvent("wheel", { deltaY: 120, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
      await act(async () => page.dispatchEvent(e));
      return e;
    };

    // Not clicked yet: the wheel is the conversation's (not taken by the page).
    expect((await wheelOn()).defaultPrevented).toBe(false);
    expect(card.querySelector(".brw-ac__capture")).toBeNull();

    // A click into the page takes the wheel: the hint shows and the page keeps the wheel.
    await act(async () => fireEvent.click(img, { clientX: 100, clientY: 100 }));
    expect(card.querySelector(".brw-ac__capture")?.textContent).toBe("Rolando a página · Esc para sair");
    expect((await wheelOn()).defaultPrevented).toBe(true);

    // Esc gives the wheel back to the conversation.
    await act(async () => fireEvent.keyDown(page, { key: "Escape" }));
    expect(card.querySelector(".brw-ac__capture")).toBeNull();
  });

  test("its Chrome on the agent's desktop: Ver a tela inteira over the page, and in the frame's top in control", async () => {
    const api = createFakeApi(seedState());
    fakeBrowserOf.get(api)?.desktops.set(ADA_ID, { available: true, running: true });
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const run = { channelId: ENG_ID, threadId: null, runId: "r-desktop", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const over = card.querySelector(".brw-mf__over") as HTMLElement;
    expect(within(over).getByRole("button", { name: "Ver a tela inteira" })).toBeTruthy();

    await act(async () => fireEvent.click(within(over).getByRole("button", { name: "Assumir" })));
    await settle(3);
    const top = card.querySelector(".brw-mf__top") as HTMLElement;
    await act(async () => fireEvent.click(within(top).getByRole("button", { name: "Ver a tela inteira" })));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
  });
});

describe("the card's title", () => {
  test("'opening' only until the first frame; then the site, or the agent's browser when none is known", () => {
    expect(titleKind({ inControl: false, ask: null, host: "", opening: true })).toBe("opening");
    // A frame arrived (no longer opening) without an address yet: never stuck on "Abrindo".
    expect(titleKind({ inControl: false, ask: null, host: "", opening: false })).toBe("agent");
    expect(titleKind({ inControl: false, ask: null, host: "acme.example", opening: false })).toBe("host");
    expect(titleKind({ inControl: true, ask: "Entrar no painel", host: "acme.example", opening: false })).toBe("ask");
    expect(titleKind({ inControl: true, ask: null, host: "acme.example", opening: false })).toBe("host");
  });
});

describe("a card whose page doesn't come never stays on Opening", () => {
  let offScreen = () => {};
  afterEach(() => {
    setSystemTime();
    offScreen();
    offScreen = () => {};
  });

  const page = (seq = 1) => ({
    type: "browser.frame",
    agentId: ADA_ID,
    seq,
    data: FRAME_DATA,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  });
  const watches = (socket: { sent: unknown[] }) =>
    socket.sent.filter((f) => (f as { type: string }).type === "browser.watch").length;
  const later = () => setSystemTime(new Date(Date.now() + BROWSER_STUCK_MS + 1000));

  test("after a server restart the page never comes: in 75 s it says so, and Tentar de novo restarts the browser", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    await act(async () => r.sockets.last().open());
    await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const cover = () => card.querySelector(".brw-dim__box")?.textContent ?? "";
    expect(cover()).toContain("Na primeira vez neste computador pode levar um minuto.");
    // The server restarts: the socket comes back and the card watches again, but its page doesn't come.
    await act(async () => r.sockets.last().drop());
    await act(() => new Promise((done) => setTimeout(done, 650)));
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    expect(watches(socket)).toBe(1);
    const active = { ...handoff, status: "active", controllerUserId: "u-walter", expiresAt: null };
    const status = { type: "browser.status", agentId: ADA_ID, mode: "control", controllerUserId: "u-walter" };
    await act(async () => socket.push({ ...status, handoff: active, hidden: false }));
    expect(cover()).toContain("Abrindo o navegador da Ada…");
    later();
    // The client's retries are answered with the computer's reason, with no page.
    await act(async () =>
      socket.push({
        type: "browser.unavailable",
        agentId: ADA_ID,
        reason: "unavailable",
        message: "the computer VPS did not answer within 120 s",
      }),
    );
    expect(cover()).toContain("Não deu para abrir o navegador da Ada.");
    expect(cover()).toContain("Tentar de novo reinicia o navegador. Os logins continuam salvos.");
    expect(card.querySelector(".brw-mf__top b")?.textContent).toBe("Entrar no painel com a conta de teste");
    const before = watches(socket);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Tentar de novo" })));
    await settle(3);
    expect(state.calls.filter((c) => c.method === "browser.restart").map((c) => c.args)).toEqual([[ORG_ID, ADA_ID]]);
    // And it watches again: its own watch may be what the server refused.
    expect(watches(socket)).toBe(before + 1);
    // It waits again, from the start, and the page shows when it comes.
    expect(cover()).toContain("Abrindo o navegador da Ada…");
    await act(async () => socket.push(page()));
    expect(card.querySelector(".brw-dim")).toBeNull();
    expect(card.querySelector(".brw-ac__page img")).toBeTruthy();
  });

  test("Abrir aqui while the agent's own card watches its browser: the request's card gets the page too", async () => {
    offScreen = onScreen(".brw-ac");
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    /** The server answers each `browser.watch` on the socket: who is in control, and the newest page. */
    let answered = 0;
    const serve = async (status: Record<string, unknown>) => {
      for (; answered < watches(socket); answered++) {
        await act(async () => socket.push({ type: "browser.status", agentId: ADA_ID, hidden: false, ...status }));
        await act(async () => socket.push(page()));
      }
    };
    // Ada works in its browser: its run's card watches it, and shows the page (one that isn't repainting).
    const run = { channelId: ENG_ID, threadId: null, runId: "r-ask", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    await serve({ mode: "watch", controllerUserId: null, handoff: null });
    expect(document.querySelector(".brw-ac .brw-ac__page img")).toBeTruthy();
    // It asked for help; Abrir aqui opens the request's own card, in control.
    await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    const active = { ...handoff, status: "active", controllerUserId: "u-walter", expiresAt: null };
    await serve({ mode: "control", controllerUserId: "u-walter", handoff: active });
    const cards = [...document.querySelectorAll(".brw-ac")] as HTMLElement[];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.classList.contains("is-control")).toBe(true);
    expect(cards[0]?.querySelector(".brw-dim")).toBeNull();
    expect(cards[0]?.querySelector(".brw-ac__page img")).toBeTruthy();
  });

  test("Reconectando… for 75 s says it couldn't open: someone who only watches tries again by watching", async () => {
    offScreen = onScreen(".brw-ac");
    const state = seedState();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.watchOnly.add(ADA_ID);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const run = { channelId: ENG_ID, threadId: null, runId: "r-watch", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const cover = () => card.querySelector(".brw-dim__box")?.textContent ?? "";
    // The agent's computer restarted and doesn't come back.
    await act(async () => socket.push({ type: "browser.unavailable", agentId: ADA_ID, reason: "reconnecting" }));
    expect(cover()).toContain("Reconectando");
    later();
    await act(async () => socket.push({ type: "browser.unavailable", agentId: ADA_ID, reason: "reconnecting" }));
    expect(cover()).toContain("Não deu para abrir o navegador da Ada.");
    // Watching doesn't restart anyone's browser: no word about it.
    expect(cover()).not.toContain("reinicia");
    const before = watches(socket);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Tentar de novo" })));
    await settle(2);
    expect(watches(socket)).toBe(before + 1);
    expect(state.calls.some((c) => c.method === "browser.restart")).toBe(false);
    await act(async () =>
      socket.push({ type: "browser.status", agentId: ADA_ID, mode: "watch", controllerUserId: null, handoff: null }),
    );
    await act(async () => socket.push(page()));
    expect(card.querySelector(".brw-dim")).toBeNull();
  });

  test("off screen the wait doesn't count: shown after 75 s it's still opening; too many browsers says so", async () => {
    // The card's observer, answered by the test: off screen until shown.
    let show = () => {};
    const native = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(readonly answer: IntersectionObserverCallback) {}
      observe(target: Element) {
        if (!target.matches(".brw-ac")) return;
        show = () => this.answer([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    offScreen = () => {
      globalThis.IntersectionObserver = native;
    };
    const state = seedState();
    const api = createFakeApi(state);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const run = { channelId: ENG_ID, threadId: null, runId: "r-off", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const cover = () => card.querySelector(".brw-dim__box")?.textContent ?? "";
    later();
    await act(async () => show());
    await settle(2);
    expect(cover()).toContain("Abrindo o navegador da Ada…");
    // Its watch refused (a fifth browser on this socket): that, not an opening that never ends.
    await act(async () => socket.push({ type: "error", agentId: ADA_ID, code: "too_many_browsers" }));
    expect(cover()).toContain("Muitos navegadores abertos ao mesmo tempo. Este aparece quando outro fechar.");
    later();
    await act(async () => socket.push({ type: "error", agentId: ADA_ID, code: "too_many_browsers" }));
    expect(cover()).not.toContain("Não deu para abrir");
    // Let in (another view left): the page shows.
    await act(async () =>
      socket.push({ type: "browser.status", agentId: ADA_ID, mode: "watch", controllerUserId: null, handoff: null }),
    );
    await act(async () => socket.push(page()));
    expect(card.querySelector(".brw-dim")).toBeNull();
  });
});
