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

const go = async (state = seedState()) => {
  await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
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
