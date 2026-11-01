import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { agentReactionOf } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {}
});

const FACT = "Deploy em produção só depois das 18h, de segunda a quinta.";
const withMark = () => {
  const state = seedState();
  const first = state.messages.find((m) => m.id === "m-1");
  if (first) first.memories = [{ id: "mem-3", agentId: ADA_ID, kind: "fact", text: FACT, createdAt: first.createdAt }];
  return state;
};
const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
const article = (text: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(text)) as HTMLElement;
const MARK = `Ada guardou isso na memória: ${FACT.slice(0, 89).trimEnd()}`;
const mark = () => screen().queryByRole("button", { name: /^Ada guardou isso na memória/ });
const click = async (el: HTMLElement) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};

describe("memory mark", () => {
  test("sits in the reaction row of the message it came from, after a divider", async () => {
    await open(withMark());
    const row = within(article("o login está devolvendo 401")).getByRole("group", { name: "Reações" });
    const button = within(row).getByRole("button", { name: /^Ada guardou isso na memória/ });
    expect(button.getAttribute("aria-label")?.startsWith(MARK.slice(0, 40))).toBe(true);
    expect(button.className).toBe("msg-mem");
    expect(button.querySelector("canvas.ac-book-mark")).not.toBeNull();
    expect(row.querySelector(".msg-mem__sep")).not.toBeNull();
    // No mark on messages nothing was saved from.
    expect(within(article("Achei a causa")).queryByRole("button", { name: /guardou isso/ })).toBeNull();
  });

  test("click: the fact and where it came from; Esquecer hides it, Desfazer brings it back", async () => {
    const { state } = await open(withMark());
    await click(mark() as HTMLElement);
    const pop = screen().getByRole("dialog", { name: "Ada guardou na memória" });
    expect(pop.textContent).toContain(FACT);
    expect(pop.textContent).toContain("Da mensagem de João");
    expect(within(pop).getByRole("link", { name: "Ver na memória" })).toBeTruthy();
    await click(within(pop).getByRole("button", { name: "Esquecer" }));
    expect(state.calls.find((c) => c.method === "memory.patch")?.args).toEqual([ORG_ID, "mem-3", { archived: true }]);
    expect(mark()).toBeNull();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(3);
    expect(state.calls.filter((c) => c.method === "memory.patch").at(-1)?.args).toEqual([
      ORG_ID,
      "mem-3",
      { archived: false },
    ]);
    expect(mark()).not.toBeNull();
  });

  test("Corrigir edits it in place (a new version) and the mark says the new text", async () => {
    const { state } = await open(withMark());
    await click(mark() as HTMLElement);
    await click(within(screen().getByRole("dialog")).getByRole("button", { name: "Corrigir" }));
    const input = screen().getByRole("textbox", { name: "Corrigir o que foi guardado" });
    await act(async () => fireEvent.change(input, { target: { value: "Deploy só depois das 19h." } }));
    await click(screen().getByRole("button", { name: "Salvar" }));
    expect(state.calls.find((c) => c.method === "memory.patch")?.args).toEqual([
      ORG_ID,
      "mem-3",
      { text: "Deploy só depois das 19h." },
    ]);
    expect(mark()?.getAttribute("aria-label")).toBe("Ada guardou isso na memória: Deploy só depois das 19h.");
  });

  test("a resting mouse opens the tip without taking the focus from the box", async () => {
    await open(withMark());
    const box = screen().getByRole("combobox", { name: /Mensagem para/ });
    box.focus();
    await act(async () => fireEvent.pointerEnter(mark() as HTMLElement, { pointerType: "mouse" }));
    await act(() => new Promise((r) => setTimeout(r, 500)));
    await settle(2);
    expect(within(screen().getByRole("dialog")).getByRole("button", { name: "Corrigir" })).toBeTruthy();
    expect(document.activeElement).toBe(box);
  });

  test("live: message.memories adds the mark for everyone in the channel", async () => {
    const { socket } = await open();
    expect(mark()).toBeNull();
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "message.memories",
          channelId: ENG_ID,
          messageId: "m-1",
          memories: [{ id: "mem-3", agentId: ADA_ID, kind: "fact", text: FACT, createdAt: new Date().toISOString() }],
        },
      }),
    );
    await settle(2);
    expect(
      within(article("o login está devolvendo 401")).getByRole("button", { name: /^Ada guardou isso/ }),
    ).toBeTruthy();
  });
});

describe("the agent's face reacts", () => {
  test("my 👍 on Ada's reply plays the happy face on that message; someone's 👎 the surprised one", async () => {
    const { socket } = await open();
    const reply = article("Achei a causa");
    await act(async () => fireEvent.mouseEnter(reply));
    const bar = within(reply).getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    await click(within(bar).getByRole("button", { name: "Útil" }));
    expect(agentReactionOf("m-2")?.kind).toBe("up");

    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "message.reactions",
          channelId: ENG_ID,
          messageId: "m-2",
          reactions: [
            { reaction: "+1", count: 1, userIds: ["u-walter"], agentIds: [] },
            { reaction: "-1", count: 1, userIds: ["u-joao"], agentIds: [] },
          ],
        },
      }),
    );
    await settle(2);
    expect(agentReactionOf("m-2")?.kind).toBe("down");
  });

  test("an agent's own reaction makes no face", async () => {
    const { socket } = await open();
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "message.reactions",
          channelId: ENG_ID,
          messageId: "m-1",
          reactions: [{ reaction: "+1", count: 1, userIds: [], agentIds: [ADA_ID] }],
        },
      }),
    );
    await settle(2);
    expect(agentReactionOf("m-1")).toBeNull();
  });
});
