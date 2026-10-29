import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { BrowserHandoff } from "@agenteschat/client";
import { icons } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { titleKind } from "@/components/browser/BrowserCard";
import { ADA_ID, createFakeApi, ENG_ID, fakeBrowserOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const HANDOFF_ID = "h-card";

/** Ada asked for help in its browser: the request card in #eng (its id is the handoff's). */
function seedRequest() {
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
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
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

describe("a help request opens the agent's browser in its card", () => {
  test("Abrir aqui takes control in place: Pronto in the header, the app's own text field, no page change", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const request = document.querySelector(".brw-rq") as HTMLElement;
    expect(request).toBeTruthy();
    expect(within(request).getByText("Abre neste card, sem sair do chat.")).toBeTruthy();

    await act(async () => fireEvent.click(within(request).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "browser.takeControl")).toBe(true);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);

    const card = document.querySelector(".brw-ac") as HTMLElement;
    expect(card.classList.contains("is-open")).toBe(true);
    expect(card.classList.contains("is-control")).toBe(true);
    // The request is the title; the line under it says who is in control.
    expect(card.querySelector(".brw-ac__tx b")?.textContent).toBe("Entrar no painel com a conta de teste");
    expect(card.querySelector(".brw-ac__tx small")?.textContent).toContain("Você no controle ·");
    expect(card.querySelector(".brw-ac__tx small")?.textContent).not.toContain("Entrar no painel");
    expect(within(card).getByRole("button", { name: "Pronto" })).toBeTruthy();
    expect(within(card).getByRole("textbox", { name: "Texto para a página" })).toBeTruthy();
    // Desistir next to Pronto in the header (the old "Não consegui" under the field is gone).
    expect(within(card).getByRole("button", { name: "Desistir" })).toBeTruthy();
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
  test("closed it's a small live card; a click opens it in place", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    // Taking over from the request opens the card; fold it to see the closed form.
    await act(async () =>
      fireEvent.click(
        within(document.querySelector(".brw-rq") as HTMLElement).getByRole("button", { name: "Abrir aqui" }),
      ),
    );
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
    // Folded, it keeps the last frame as its small picture (it streams only while on screen).
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Recolher" })));
    expect(card.classList.contains("is-open")).toBe(false);
    expect(card.querySelector(".brw-ac__thumb img")).toBeTruthy();
    expect(card.textContent).toContain("Clique para expandir");
    await act(async () => fireEvent.click(card.querySelector(".brw-ac__tt") as HTMLElement));
    expect(card.classList.contains("is-open")).toBe(true);
    // Full screen and back, as in the computer's window: corners pulled apart, then pushed together.
    const glyph = (name: string) => within(card).getByRole("button", { name }).querySelector("path")?.getAttribute("d");
    expect(glyph("Tela cheia")).toBe(icons.expand[0]?.[1].d);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Tela cheia" })));
    expect(glyph("Sair da tela cheia")).toBe(icons.shrink[0]?.[1].d);
  });

  test("the wheel scrolls the conversation until the page is clicked; Esc gives it back", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      fireEvent.click(
        within(document.querySelector(".brw-rq") as HTMLElement).getByRole("button", { name: "Abrir aqui" }),
      ),
    );
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
