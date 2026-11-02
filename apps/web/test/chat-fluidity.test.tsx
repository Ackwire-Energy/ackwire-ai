import { afterEach, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MessageBody } from "@/chat/MessageBody";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () =>
      r.sockets.last().push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }),
    );
  return { ...r, ev, state };
};

describe("a streaming answer keeps its spacing", () => {
  const answer = "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro, ainda escrevendo";

  test("settled blocks and the tail share one wrapper: the gap between blocks is the same live and final", () => {
    const view = render(<MessageBody body={answer} live />);
    const wrappers = () => view.container.querySelectorAll(".md");
    expect(wrappers()).toHaveLength(1);
    const wrapper = wrappers()[0] as HTMLElement;
    expect(wrapper.classList.contains("md--message")).toBe(true);
    // Every block is a sibling of the others (the `> * + *` gap applies between the settled ones and the tail).
    expect([...wrapper.children].map((c) => c.tagName)).toEqual(["P", "P", "P"]);
    expect(wrapper.lastElementChild?.querySelector(".ac-word")).not.toBeNull();
    expect(wrapper.firstElementChild?.querySelector(".ac-word")).toBeNull();
    // The final message: the same wrapper element, the same blocks, no fading words.
    view.rerender(<MessageBody body={answer} />);
    expect(wrappers()).toHaveLength(1);
    expect(wrappers()[0]).toBe(wrapper);
    expect(wrapper.children).toHaveLength(3);
    expect(wrapper.querySelector(".ac-word")).toBeNull();
  });
});

describe("a streaming answer's done paragraphs stay put", () => {
  test("a paragraph ending (the text ends on a blank line) doesn't redraw the ones above it or fade them in again", () => {
    const view = render(<MessageBody body={"Um.\n\nDois.\n\nTres"} live />);
    const blocks = () => [...view.container.querySelectorAll(".md--message > p")];
    const [um, dois] = blocks();
    for (const body of ["Um.\n\nDois.\n\nTres.\n\n", "Um.\n\nDois.\n\nTres.\n\nQuatro"]) {
      view.rerender(<MessageBody body={body} live />);
      expect(blocks()[0]).toBe(um as Element);
      expect(blocks()[1]).toBe(dois as Element);
      expect(um?.querySelector(".ac-word")).toBeNull();
      expect(dois?.querySelector(".ac-word")).toBeNull();
    }
  });

  test("the final message keeps every block the live answer drew (not only the wrapper)", () => {
    const body = "Um.\n\nDois.\n\nTres.\n\nQuatro.";
    const view = render(<MessageBody body={body} live />);
    const before = [...view.container.querySelectorAll(".md--message > *")];
    view.rerender(<MessageBody body={body} />);
    const after = [...view.container.querySelectorAll(".md--message > *")];
    expect(after).toHaveLength(4);
    for (const [i, el] of after.entries()) expect(el).toBe(before[i] as Element);
    expect(view.container.querySelector(".ac-word")).toBeNull();
  });
});

describe("live answer → saved message", () => {
  test("the text the person was reading stays the same element when the message takes the block's place", async () => {
    const { ev } = await open();
    const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };
    const body = "O cache do relatório expirou.\n\nVou refazer a consulta";
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: body });
    await settle(3);
    const row = document.querySelector('[data-run-id="r-live"]') as HTMLElement;
    const text = row.querySelector(".ac-msg__text") as HTMLElement;
    expect(text.textContent).toBe("O cache do relatório expirou.Vou refazer a consulta");
    await ev({
      type: "message.created",
      messageId: "m-ada",
      message: {
        id: "m-ada",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body,
        mentionedAgentIds: [],
        agentRunId: "r-live",
        createdAt: new Date().toISOString(),
      },
    });
    await ev({ type: "run.finished", ...ids, status: "done" });
    await settle(3);
    const shown = [...document.querySelectorAll(".ac-msg__text")].filter((t) =>
      t.textContent?.includes("cache do relatório"),
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBe(text);
    expect(text.isConnected).toBe(true);
    expect(text.querySelector(".ac-word")).toBeNull();
    expect(text.closest(".ac-msg")?.classList.contains("ac-msg--streaming")).toBe(false);
  });
});

describe("following the bottom", () => {
  test("what grew while the list glided down (the activity bar opening) is followed once the glide ends", async () => {
    const device = domWindow().happyDOM.settings.device;
    device.prefersReducedMotion = "no-preference";
    const native = globalThis.ResizeObserver;
    const observers: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      await open();
      const log = screen().getByRole("region", { name: "Mensagens" });
      let height = 2000;
      Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => height });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
      // A browser's glide ends where it was told to, even when the end moved on the way.
      log.scrollTo = ((opts: ScrollToOptions) => {
        log.scrollTop = opts.top ?? 0;
      }) as typeof log.scrollTo;
      await act(() => new Promise((r) => setTimeout(r, 1600)));
      const composer = screen().getByRole("combobox", { name: /Mensagem para/ });
      await act(async () => fireEvent.change(composer, { target: { value: "bom dia" } }));
      await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
      await settle(3);
      expect(log.scrollTop).toBe(2000);
      // The bar above the composer opens mid-glide: the end is 32px further.
      height = 2032;
      await act(async () => {
        for (const cb of observers) cb([], {} as ResizeObserver);
      });
      expect(log.scrollTop).toBe(2000);
      await act(() => new Promise((r) => setTimeout(r, 700)));
      expect(log.scrollTop).toBe(2032);
    } finally {
      globalThis.ResizeObserver = native;
      device.prefersReducedMotion = "reduce";
    }
  });
});

describe("an image in a message", () => {
  test("keeps its loading size until it is decoded (one size change, not a collapse first)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const image = await api.artifacts.upload(
      ORG_ID,
      new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], "tela.png", { type: "image/png" }),
    );
    const base = state.messages[0] as (typeof state.messages)[number];
    state.messages.push({
      ...base,
      id: "m-image",
      threadId: null,
      body: "A tela:",
      mentionedAgentIds: [],
      meta: { artifacts: [{ id: image.id, version: 1 }] },
      createdAt: new Date().toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const thumb = document.querySelector(".file-thumb") as HTMLElement;
    const img = thumb.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toStartWith("blob:");
    expect(thumb.dataset.loading).toBe("true");
    await act(async () => fireEvent.load(img));
    expect(thumb.dataset.loading).toBeUndefined();
  });
});
