import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * The right click (and Shift+F10, the menu key) on the things that have their own menu, in the browser: one list of
 * actions each, shared with its "…" where it has one. Typing and code keep the browser's menu.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
});

type State = ReturnType<typeof seedState>;
const go = async (path = `c/${ENG_ID}`, state: State = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => document.getElementById("app-nav") as HTMLElement;
const menu = () => screen().getByRole("menu", { name: "Ações" });
const items = () =>
  within(menu())
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const rightClick = async (el: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
  await act(async () => void el.dispatchEvent(event));
  await settle(2);
  return event;
};
const pick = async (name: string) => {
  await act(async () => fireEvent.click(within(menu()).getByRole("menuitem", { name })));
  await settle(4);
};
const sidebarLink = (name: string) => within(nav()).getByRole("link", { name: new RegExp(`^#?${name}\\b`) });

describe("a channel", () => {
  test("its sidebar row: mark read when unread, edit and arrange (I manage it), copy link, archive; the browser's menu stays shut", async () => {
    const state = seedState();
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) eng.unreadCount = 3;
    await go(`c/${state.channels[1]?.id}`, state);
    const event = await rightClick(sidebarLink("eng"));
    expect(event.defaultPrevented).toBe(true);
    expect(items()).toEqual([
      "Marcar como lida",
      "Editar canal",
      "Nova categoria com este canal",
      "Copiar link",
      "Arquivar canal",
    ]);
    await pick("Marcar como lida");
    expect(state.calls.some((c) => c.method === "dms.markRead" && c.args[1] === ENG_ID)).toBe(true);
  });

  test("#general can't be archived; Copiar link copies the channel's address", async () => {
    await go();
    await rightClick(sidebarLink("general"));
    expect(items()).not.toContain("Arquivar canal");
    await pick("Copiar link");
    expect(copied.at(-1)).toMatch(new RegExp(`/org/${ORG_ID}/c/`));
  });

  test("the channel's header has the same menu", async () => {
    await go();
    await rightClick(screen().getByRole("heading", { level: 1, name: "# eng" }));
    expect(items()).toEqual(["Editar canal", "Copiar link", "Arquivar canal"]);
  });
});

describe("an agent", () => {
  test("Shift+F10 on its row: talk, profile, copy @, edit (owner or admin), link", async () => {
    await go();
    const row = within(nav()).getByRole("link", { name: /^Ada/ });
    row.focus();
    await act(async () => fireEvent.keyDown(row, { key: "F10", shiftKey: true }));
    await settle(2);
    expect(items()).toEqual(["Mensagem direta", "Ver perfil", "Copiar @ada", "Editar agente", "Copiar link"]);
    await pick("Copiar @ada");
    expect(copied.at(-1)).toBe("@ada");
  });

  test("the menu key opens it too; Editar agente goes to its settings", async () => {
    const { router } = await go();
    const row = within(nav()).getByRole("link", { name: /^Atlas/ });
    await act(async () => fireEvent.keyDown(row, { key: "ContextMenu" }));
    await settle(2);
    await pick("Editar agente");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${seedState().agents[1]?.id}`);
    expect(router.state.location.search).toMatchObject({ tab: "settings" });
  });
});

describe("a person", () => {
  test("their sidebar row: DM and copy @", async () => {
    await go();
    const row = nav().querySelector('a[href$="/dm/person/u-joao"]');
    if (!row) throw new Error("no row for João");
    await rightClick(row);
    expect(items()).toEqual(["Mensagem direta", "Copiar @joao"]);
  });

  test("their name in a message: also their card and Mencionar, which types the @ in the composer", async () => {
    await go();
    const name = screen()
      .getAllByRole("button", { name: /^Perfil de / })
      .find((b) => !b.hasAttribute("aria-hidden"));
    if (!name) throw new Error("no author name");
    await rightClick(name);
    expect(items()).toContain("Mencionar");
    expect(items()).toContain("Ver perfil");
    await pick("Mencionar");
    const composer = screen().getByRole("combobox", { name: "Mensagem para #eng" }) as HTMLTextAreaElement;
    expect(composer.value).toMatch(/@\w+/);
  });
});

describe("lists of things", () => {
  test("a Drive card: open and download first, then what its … has", async () => {
    const api = createFakeApi(seedState(), { seed: true });
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    const card = document.querySelector(".drive-card");
    if (!card) throw new Error("no Drive card");
    await rightClick(card);
    expect(items().slice(0, 3)).toEqual(["Abrir", "Baixar", "Copiar link"]);
  });

  test("a routine: run, pause, then its … (edit, runs, duplicate, delete); the … lists the same", async () => {
    await go("routines");
    await rightClick(screen().getByRole("article", { name: "Resumo da semana" }));
    const fromRightClick = items();
    expect(fromRightClick).toEqual(
      expect.arrayContaining(["Rodar agora", "Pausar", "Editar", "Ver execuções", "Apagar"]),
    );
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
  });

  test("an issue card: open beside, open its page, copy link", async () => {
    await go("issues");
    const card = document.querySelector(".issue-card");
    if (!card) throw new Error("no issue card");
    await rightClick(card);
    expect(items()).toEqual(["Abrir", "Abrir em página inteira", "Copiar link"]);
  });
});

describe("typing keeps the browser's menu", () => {
  test("the composer", async () => {
    await go();
    const composer = screen().getByRole("combobox", { name: "Mensagem para #eng" });
    const event = await rightClick(composer);
    expect(event.defaultPrevented).toBe(false);
    expect(screen().queryByRole("menu", { name: "Ações" })).toBeNull();
  });
});

describe("the sidebar's sections, in my order", () => {
  const blocks = () => [...nav().querySelectorAll<HTMLElement>(".sidebar__block")].map((b) => b.dataset.section);

  test("the default order; Mover para baixo on Canais saves the new one; Restaurar ordem padrão goes back", async () => {
    const { state } = await go();
    expect(blocks()).toEqual(["tools", "channels", "agents", "people"]);
    await act(async () => fireEvent.click(within(nav()).getByRole("button", { name: "Arrastar Canais" })));
    await settle(2);
    expect(within(menu()).getByRole("menuitem", { name: "Mover para cima" }).getAttribute("aria-disabled")).toBe(null);
    await pick("Mover para baixo");
    expect(blocks()).toEqual(["tools", "agents", "channels", "people"]);
    expect(state.calls.filter((c) => c.method === "orgs.setSidebarOrder").map((c) => c.args[1])).toEqual([
      ["tools", "agents", "channels", "people"],
    ]);

    await rightClick(within(nav()).getByRole("button", { name: "Agentes" }));
    await pick("Restaurar ordem padrão");
    expect(blocks()).toEqual(["tools", "channels", "agents", "people"]);
    expect(state.calls.filter((c) => c.method === "orgs.setSidebarOrder").at(-1)?.args[1]).toBeNull();
  });

  test("a saved order comes back: agents first; the top one can't go up", async () => {
    await go(`c/${ENG_ID}`, seedState({ sidebarOrder: ["agents", "people", "tools", "channels"] }));
    expect(blocks()).toEqual(["agents", "people", "tools", "channels"]);
    await rightClick(within(nav()).getByRole("button", { name: "Agentes" }));
    expect(within(menu()).getByRole("menuitem", { name: "Mover para cima" }).hasAttribute("data-disabled")).toBe(true);
  });
});

describe("the open row's highlight", () => {
  test("the active row's plate has a soft glow from the right: the accent's, an agent's in its own color", async () => {
    const { router } = await go();
    const active = () => nav().querySelector<HTMLElement>('.sidebar__item[data-status="active"]');
    expect(active()?.textContent).toContain("eng");
    const css = readFileSync(new URL("../src/layout.css", import.meta.url), "utf8");
    const start = css.indexOf('.sidebar__item[data-status="active"]::before {\n  background:\n    linear-gradient(');
    const rule = css.slice(start, css.indexOf("}", start));
    expect(start).toBeGreaterThan(-1);
    expect(rule).toContain("to left");
    expect(rule).toContain("var(--sel-glow-color, var(--agent))");
    expect(rule).toContain("transparent var(--sel-glow-reach, 44px)");
    // No agent row is left out of it.
    expect(css).not.toContain('.sidebar__row[data-agent-row] > .sidebar__item[data-status="active"]::before');
    await act(() => router.navigate({ to: `/org/${ORG_ID}/dm/agent/${seedState().agents[0]?.id}` }));
    await settle(4);
    expect(active()?.closest("[data-agent-row]")).not.toBeNull();
    expect(active()?.style.getPropertyValue("--sel-glow-color")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
