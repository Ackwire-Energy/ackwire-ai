import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, createEvent, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const sheet of document.querySelectorAll("style[data-layout]")) sheet.remove();
});

/** Acme on a channel (#general unless `channel` says), on `api` (the fake one on `state` unless given). */
const go = async (state = seedState(), { api = createFakeApi(state), channel = GENERAL_ID } = {}) => {
  await renderApp(`/org/${ORG_ID}/c/${channel}`, { api });
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
    await go(state, { api });
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

const ENGINEERING = "00000000-0000-4000-8000-0000000000f1";
/** Acme with the category Engenharia: #eng, #design and #alerts (2 unread) in it; #general in none. */
function withCategory() {
  const state = seedState();
  state.channelCategories = [{ id: ENGINEERING, name: "Engenharia", position: 0 }];
  const eng = state.channels.find((c) => c.id === ENG_ID);
  if (!eng) throw new Error("no #eng");
  eng.categoryId = ENGINEERING;
  state.channels.push(
    { ...eng, id: "00000000-0000-4000-8000-0000000000c3", name: "design" },
    { ...eng, id: "00000000-0000-4000-8000-0000000000c4", name: "alerts", unreadCount: 2 },
  );
  return state;
}
/** The app's layout stylesheet in the page: what a closed category hides, and how far in its rows sit. */
const withLayout = async () => {
  const sheet = document.createElement("style");
  sheet.dataset.layout = "";
  sheet.textContent = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
  document.head.append(sheet);
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const category = (name: string) => {
  const toggle = within(nav()).getByRole("button", { name });
  const root = toggle.closest(".sidebar__section") as HTMLElement;
  return { toggle, root, body: root.querySelector(".sidebar__section-body") as HTMLElement };
};
/** A channel's row, in sight or not (a hidden one has no accessible name to find it by). */
const channel = (name: string) => {
  const row = nav().querySelector(`a.sidebar__item[title="#${name}"]`);
  if (!row) throw new Error(`no #${name} in the sidebar`);
  return row;
};
const shown = (el: Element) => window.getComputedStyle(el).display !== "none";

describe("a category in the sidebar (ADR 0080)", () => {
  test("its channels sit a step in under its header; a channel in none stays where it was", async () => {
    await withLayout();
    await go(withCategory());
    const { body } = category("Engenharia");
    expect(body.contains(channel("eng"))).toBe(true);
    expect(window.getComputedStyle(body).paddingLeft).toBe("19px");
    const loose = channel("general").parentElement as HTMLElement;
    expect(loose.closest(".sidebar__section")).toBeNull();
    expect(window.getComputedStyle(loose).paddingLeft).not.toBe("19px");
  });

  test("closed, it hides its channels but the unread ones, and its header says it is closed", async () => {
    await withLayout();
    await go(withCategory());
    const { toggle, body } = category("Engenharia");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(body.id);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(shown(channel("eng"))).toBe(false);
    expect(shown(channel("design"))).toBe(false);
    expect(shown(channel("alerts"))).toBe(true);
    expect(shown(channel("general"))).toBe(true);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(shown(channel("eng"))).toBe(true);
    expect(shown(channel("design"))).toBe(true);
  });

  test("closed, it keeps the channel you are in", async () => {
    await withLayout();
    await go(withCategory(), { channel: ENG_ID });
    await click(category("Engenharia").toggle);
    expect(shown(channel("eng"))).toBe(true);
    expect(shown(channel("design"))).toBe(false);
  });

  test("it stays closed after a reload, for this person in this workspace", async () => {
    await go(withCategory());
    await click(category("Engenharia").toggle);
    expect(JSON.parse(localStorage.getItem(`agentes.sidebar.sections.u-walter.${ORG_ID}`) ?? "[]")).toEqual([
      `category:${ENGINEERING}`,
    ]);
    cleanup();
    await go(withCategory());
    expect(category("Engenharia").toggle.getAttribute("aria-expanded")).toBe("false");
    // João, signed in on the same browser, has his own.
    cleanup();
    const joao = withCategory();
    if (joao.me) joao.me.user = { ...joao.me.user, id: "u-joao", name: "João" };
    await go(joao);
    expect(category("Engenharia").toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
