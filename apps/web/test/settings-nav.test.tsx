import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
// The workspace and account cards open a full-screen menu (MenuOverlay): a dialog with our menu items.
const openMenu = async (trigger: HTMLElement) => {
  await act(async () => fireEvent.click(trigger));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return screen().getAllByRole("menu")[0] as HTMLElement;
};
/** An item's name without its count chip, shortcut or description. */
const itemName = (el: Element) => el.querySelector(".ac-mo__name")?.firstChild?.textContent ?? "";
const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
};

describe("finding the settings", () => {
  test("the workspace header opens its full-screen menu: invite, members, settings sections", async () => {
    const { router } = await go("issues");
    const menu = await openMenu(screen().getByRole("button", { name: "Menu do workspace Acme" }));
    expect(within(menu).getAllByRole("menuitem").map(itemName)).toEqual([
      "Convidar pessoas",
      "Membros",
      "Conectores",
      "Agentes e acesso",
      "Skills",
      "Configurações do workspace",
    ]);
    await click(within(menu).getByRole("menuitem", { name: /^Conectores/ }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/connectors`);
    // The section's own title (the connectors card has a "Conectores" heading too).
    expect(document.querySelector(".settings__body > .page__header h2")?.textContent).toBe("Conectores");
  });

  test("the workspace menu lists my workspaces (this one marked) and a digit opens an option", async () => {
    const { router } = await go("issues");
    await openMenu(screen().getByRole("button", { name: "Menu do workspace Acme" }));
    const dialog = screen().getByRole("dialog", { name: "Acme" });
    const mine = within(dialog).getByRole("menu", { name: "Seus workspaces" });
    const current = within(mine)
      .getAllByRole("menuitem")
      .find((i) => i.getAttribute("aria-current"));
    expect(current?.textContent).toContain("Você está aqui");
    await act(async () => fireEvent.keyDown(dialog, { key: "3" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/connectors`);
    expect(document.documentElement.hasAttribute("data-menu-overlay")).toBe(false);
  });

  test("members see only what they can open", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go("issues", state);
    const menu = await openMenu(screen().getByRole("button", { name: "Menu do workspace Acme" }));
    expect(within(menu).getAllByRole("menuitem").map(itemName)).toEqual([
      "Membros",
      "Conectores",
      "Configurações do workspace",
    ]);
  });

  test("the account card is one button, no gear beside it (settings live in the workspace menu)", async () => {
    await go("issues");
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(within(nav).queryByRole("link", { name: "Configurações" })).toBeNull();
  });

  test("every section has its own URL, with the sub-nav marking it", async () => {
    const sections: [string, string][] = [
      ["general", "Geral"],
      ["members", "Membros"],
      ["access", "Agentes e acesso"],
      ["connectors", "Conectores"],
      ["skills", "Skills"],
      ["keys", "Contas de IA"],
      ["storage", "Armazenamento"],
      ["computers", "Computadores"],
      ["usage", "Orçamento e uso"],
      ["import", "Importar e exportar"],
    ];
    for (const [id, heading] of sections) {
      await go(`settings/${id}`);
      expect(screen().getAllByRole("heading", { level: 2, name: heading }).length).toBeGreaterThan(0);
      const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
      const current = within(nav)
        .getAllByRole("link")
        .find((l) => l.getAttribute("aria-current") === "page");
      expect(current?.getAttribute("href")).toBe(`/org/${ORG_ID}/settings/${id}`);
      cleanup();
    }
  });

  test("an unknown section goes back to Geral", async () => {
    const { router } = await go("settings/nada");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings`);
  });

  test("Perfil and Fuso in the account menu edit my handle and time zone", async () => {
    const { state } = await go("issues");
    const menu = await openMenu(screen().getByRole("button", { name: /^Conta: / }));
    await click(within(menu).getByRole("menuitem", { name: /^Perfil/ }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Seu perfil neste workspace" });
    await type(within(dialog).getByLabelText("Seu @"), "walt");
    // Our zone selector: search by city, Enter picks.
    const zoneBox = within(dialog).getByRole("combobox", { name: "Fuso horário" });
    expect(zoneBox.textContent).toContain("UTC");
    await click(zoneBox);
    await settle(2);
    const search = screen().getByRole("combobox", { name: "Buscar fuso" });
    await type(search, "lisboa");
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    await settle(2);
    expect(within(dialog).getByRole("combobox", { name: "Fuso horário" }).textContent).toContain("Lisboa");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.updateMe")?.args).toEqual([
      ORG_ID,
      { handle: "walt", timezone: "Europe/Lisbon" },
    ]);
    expect(screen().getByText("Perfil salvo.")).toBeTruthy();
  });
});
