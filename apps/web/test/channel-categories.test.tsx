import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, createEvent, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const go = async (state = seedState(), api = createFakeApi(state)) => {
  await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api });
  await settle(8);
  return state;
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
/** "Canais", the only channel section of a workspace with no categories. */
const canais = () => within(nav()).getByRole("button", { name: "Canais" }).closest(".sidebar__section") as HTMLElement;
const names = () =>
  [...canais().querySelectorAll(".sidebar__section-body > a .sidebar__item-label")].map((l) => l.textContent);
const row = (name: string) => within(canais()).getByRole("link", { name });
const dataTransfer = { setData: () => {}, getData: () => "" };
/** Drags `from` over the top or bottom half of `to` (a 0-tall box here) and drops it there. */
const dragOnto = async (from: Element, to: Element, half: "top" | "bottom") => {
  await act(async () => fireEvent.dragStart(from, { dataTransfer }));
  // happy-dom's DragEvent is a plain Event: no clientY from the init.
  const over = createEvent.dragOver(to, { dataTransfer });
  Object.defineProperty(over, "clientY", { value: half === "top" ? 0 : 1 });
  await act(async () => fireEvent(to, over));
  const mark = to.getAttribute("data-drop");
  await act(async () => fireEvent.drop(to, { dataTransfer }));
  await settle(3);
  return mark;
};
const places = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "chat.place").map((c) => c.args.slice(1));

describe("the channels' order in the sidebar (ADR 0080)", () => {
  test("with no categories, a channel drags above or below another one in Canais", async () => {
    const state = await go();
    expect(names()).toEqual(["eng", "general"]);
    expect(row("general").getAttribute("draggable")).toBe("true");

    expect(await dragOnto(row("general"), row("eng"), "top")).toBe("before");
    expect(places(state)).toEqual([[GENERAL_ID, { categoryId: null, beforeChannelId: ENG_ID }]]);
    expect(names()).toEqual(["general", "eng"]);
    expect(row("eng").getAttribute("data-drop")).toBeNull();

    // Below the last one: to the end.
    expect(await dragOnto(row("general"), row("eng"), "bottom")).toBe("after");
    expect(places(state).at(-1)).toEqual([GENERAL_ID, { categoryId: null, beforeChannelId: null }]);
    expect(names()).toEqual(["eng", "general"]);
  });

  test("a drop where the channel already is sends nothing", async () => {
    const state = await go();
    expect(await dragOnto(row("eng"), row("general"), "top")).toBe("before");
    expect(await dragOnto(row("general"), row("eng"), "bottom")).toBe("after");
    expect(places(state)).toEqual([]);
  });

  test("nothing drags until the categories load", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.chat.categories = () => new Promise(() => {});
    await go(state, api);
    expect(row("general").getAttribute("draggable")).toBe("false");
  });

  test("a member drags only the channels they created", async () => {
    const state = seedState();
    const me = state.me;
    if (me?.organizations[0]) me.organizations[0].role = "member";
    for (const c of state.channels) c.createdByUserId = c.id === GENERAL_ID ? me?.user.id : "u-joao";
    await go(state);
    expect(row("general").getAttribute("draggable")).toBe("true");
    expect(row("eng").getAttribute("draggable")).toBe("false");
  });
});

describe("Criar canal in a category made there (ADR 0080)", () => {
  const click = (el: Element) => act(async () => fireEvent.click(el));
  const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
  const pick = async (combobox: HTMLElement, option: string) => {
    combobox.focus();
    await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
    await act(async () => fireEvent.click(screen().getByRole("option", { name: option })));
    await settle();
  };
  const created = (state: ReturnType<typeof seedState>) =>
    state.calls.filter((c) => c.method === "chat.createChannel").map((c) => c.args[1]);

  test("the new channel lands in the category made from its picker, not before it exists", async () => {
    const state = await go();
    await click(within(nav()).getByRole("button", { name: "Criar canal" }));
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    await type(within(dialog).getByLabelText("Nome"), "vendas");
    await pick(within(dialog).getByRole("combobox", { name: "Categoria" }), "Nova categoria…");

    const inner = screen().getByRole("dialog", { name: "Nova categoria" });
    await type(within(inner).getByLabelText("Nome"), "Produto");
    await click(within(inner).getByRole("button", { name: "Criar categoria" }));
    await settle(6);

    // Making the category only picks it: the channel waits for its own Criar.
    expect(created(state)).toEqual([]);
    const category = state.channelCategories?.find((c) => c.name === "Produto");
    expect(category).toBeDefined();
    const still = screen().getByRole("dialog", { name: "Criar canal" });
    expect(within(still).getByRole("combobox", { name: "Categoria" }).textContent).toContain("Produto");

    await click(within(still).getByRole("button", { name: "Criar #vendas" }));
    await settle(6);
    expect(created(state)).toEqual([{ name: "vendas", visibility: "public", categoryId: category?.id }]);
    expect(state.channels.find((c) => c.name === "vendas")?.categoryId).toBe(category?.id ?? "");
  });

  test("from a category's '+', it starts chosen and the channel lands there", async () => {
    const seeded = seedState();
    seeded.channelCategories = [{ id: "cat-produto", name: "Produto", position: 0 }];
    for (const c of seeded.channels) if (c.id === ENG_ID) c.categoryId = "cat-produto";
    const state = await go(seeded);
    await click(within(nav()).getByRole("button", { name: "Novo canal em Produto" }));
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    expect(within(dialog).getByRole("combobox", { name: "Categoria" }).textContent).toContain("Produto");
    await type(within(dialog).getByLabelText("Nome"), "roadmap");
    await click(within(dialog).getByRole("button", { name: "Criar #roadmap" }));
    await settle(6);
    expect(created(state)).toEqual([{ name: "roadmap", visibility: "public", categoryId: "cat-produto" }]);
  });
});
