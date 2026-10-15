import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await key(trigger, "Enter");
  return screen().getByRole("menu");
};
const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
};

describe("finding the settings", () => {
  test("the workspace header is a menu: settings sections and members", async () => {
    const { router } = await go("issues");
    const menu = await openMenu(screen().getByRole("button", { name: "Menu do workspace Acme" }));
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual([
      "Configurações do workspace",
      "Conectores",
      "Skills",
      "Agentes e acesso",
      "Membros",
      "Convidar pessoas",
    ]);
    await click(within(menu).getByRole("menuitem", { name: "Conectores" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/connectors`);
    expect(screen().getByRole("heading", { level: 2, name: "Conectores" })).toBeTruthy();
  });

  test("members see only what they can open", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go("issues", state);
    const menu = await openMenu(screen().getByRole("button", { name: "Menu do workspace Acme" }));
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Configurações do workspace", "Conectores", "Membros"]);
  });

  test("a gear next to the account opens the settings", async () => {
    await go("issues");
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(within(nav).getByRole("link", { name: "Configurações" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings`,
    );
  });

  test("every section has its own URL, with the sub-nav marking it", async () => {
    const sections: [string, string][] = [
      ["general", "Geral"],
      ["members", "Membros"],
      ["access", "Agentes e acesso"],
      ["connectors", "Conectores"],
      ["skills", "Skills"],
      ["keys", "Chaves de API"],
      ["storage", "Armazenamento"],
      ["usage", "Orçamento e uso"],
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
    await click(within(menu).getByRole("menuitem", { name: "Perfil" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Seu perfil neste workspace" });
    await type(within(dialog).getByLabelText("Seu @"), "walt");
    await type(within(dialog).getByLabelText("Fuso horário"), "Lua/Base");
    expect(dialog.textContent).toContain("Use um fuso como America/Sao_Paulo.");
    await type(within(dialog).getByLabelText("Fuso horário"), "Europe/Lisbon");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.updateMe")?.args).toEqual([
      ORG_ID,
      { handle: "walt", timezone: "Europe/Lisbon" },
    ]);
    expect(screen().getByText("Perfil salvo.")).toBeTruthy();
  });
});
