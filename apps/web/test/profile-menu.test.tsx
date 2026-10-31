import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/* The account button at the foot of the sidebar: a menu right above it, me on top, my status in a menu beside it. */

/** A phone: only the compact query matches (the rest goes to the real `matchMedia`). */
let restore: (() => void) | null = null;
function onPhone() {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) =>
    query === COMPACT_QUERY
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as unknown as MediaQueryList)
      : real(query)) as typeof window.matchMedia;
  restore = () => {
    window.matchMedia = real;
  };
}

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

const go = async (state = seedState()) => {
  const fake = createFakeAuth();
  // As the server: after signing out, no session, no one.
  const signOut = fake.auth.signOut;
  fake.auth.signOut = async () => {
    await signOut();
    state.me = null;
  };
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state), auth: fake.auth });
  await settle(6);
  return { ...r, state, authCalls: fake.calls };
};
const account = () => screen().getByRole("button", { name: /^Conta: / });
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** Radix menus open from the keyboard here (a pointer press, not a click, opens them with a mouse). */
const press = async (k: string, el = document.activeElement ?? document.body) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(2);
};
const openMenu = async () => {
  account().focus();
  await press("Enter", account());
  return screen().getAllByRole("menu")[0] as HTMLElement;
};
/** "Definir status" → its menu beside (→ from the item). */
const openStatus = async () => {
  const menu = await openMenu();
  within(menu).getByRole("menuitem", { name: "Definir status" }).focus();
  await press("ArrowRight");
  return screen().getAllByRole("menu")[1] as HTMLElement;
};
const names = (els: HTMLElement[]) => els.map((el) => el.textContent);
const statusCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "orgs.setStatus").map((c) => c.args);

describe("the account menu", () => {
  test("Enter opens it: me on top, then five items; focus goes in, Esc closes it and focus is back on the row", async () => {
    await go();
    const row = account();
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    const menu = await openMenu();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    // Not a full-screen sheet: nothing blurs the app behind it.
    expect(document.documentElement.hasAttribute("data-menu-overlay")).toBe(false);
    const head = menu.querySelector(".profile-menu__head");
    expect(head?.textContent).toContain("Walter");
    expect(head?.textContent).toContain("@walter · Online");
    expect(head?.querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("online");
    expect(names(within(menu).getAllByRole("menuitem"))).toEqual([
      "Definir status",
      "Editar perfil",
      "Configurações",
      "Apagar conta",
      "Sair",
    ]);
    expect(document.activeElement?.textContent).toBe("Definir status");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Editar perfil");
    await press("Escape");
    expect(screen().queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  test("Definir status: → opens how I appear (mine checked) and what I'm up to, ← goes back to the item", async () => {
    await go();
    const status = await openStatus();
    const radios = within(status).getAllByRole("menuitemradio");
    expect(names(radios)).toEqual(["Online", "Ausente", "Ocupado", "Oculto"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    // Each choice with its badge, drawn as on my face.
    expect(radios.map((r) => r.querySelector(".ac-presence")?.getAttribute("data-presence"))).toEqual([
      "online",
      "away",
      "busy",
      "hidden",
    ]);
    expect(within(status).getByRole("menuitem", { name: "O que você está fazendo?" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Online");
    await press("ArrowLeft");
    expect(screen().getAllByRole("menu")).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe("Definir status");
  });

  test("picking Ocupado saves it: my row and its badge say so, and how I appear is told; mine again sends nothing", async () => {
    const { state } = await go();
    await click(within(await openStatus()).getByRole("menuitemradio", { name: "Ocupado" }));
    expect(statusCalls(state)).toEqual([[ORG_ID, { availability: "busy" }]]);
    expect(screen().queryByRole("menu")).toBeNull();
    expect(account().querySelector(".sidebar__user-line")?.textContent).toBe("Ocupado");
    expect(account().querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("busy");
    expect(screen().getByText("Você aparece como ocupado")).toBeTruthy();
    await click(within(await openStatus()).getByRole("menuitemradio", { name: "Ocupado" }));
    expect(statusCalls(state)).toHaveLength(1);
  });

  test("with a line: it sits under my name in a well with when it clears, and what I'm up to opens it to change", async () => {
    const state = seedState();
    state.statuses = new Map([
      ["u-walter", { availability: "busy", status: { text: "Em reunião", emoji: "📅", until: null } }],
    ]);
    await go(state);
    const menu = await openMenu();
    expect(menu.querySelector(".profile-menu__head")?.textContent).toContain("@walter · Ocupado");
    expect(menu.querySelector(".profile-menu__line")?.textContent).toBe("📅Em reuniãoAté você mudar");
    await press("ArrowRight");
    const status = screen().getAllByRole("menu")[1] as HTMLElement;
    expect(within(status).getByRole("menuitemradio", { name: "Ocupado" }).getAttribute("aria-checked")).toBe("true");
    await click(within(status).getByRole("menuitem", { name: "O que você está fazendo?" }));
    const dialog = screen().getByRole("dialog", { name: "Definir status" });
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "O que você está fazendo?" }).value).toBe(
      "Em reunião",
    );
  });

  test("Editar perfil opens my profile over the page, on my @; closing it, focus is back on the row", async () => {
    const { router } = await go();
    const row = account();
    await click(within(await openMenu()).getByRole("menuitem", { name: "Editar perfil" }));
    const dialog = screen().getByRole("dialog", { name: "Seu perfil neste workspace" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Seu @"));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  test("Configurações opens Sua conta in the settings", async () => {
    const { router } = await go();
    await click(within(await openMenu()).getByRole("menuitem", { name: "Configurações" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/account`);
    expect(screen().getByRole("heading", { level: 2, name: "Sua conta" })).toBeTruthy();
  });

  test("Sair signs out and goes to sign in", async () => {
    const { router, authCalls } = await go();
    await click(within(await openMenu()).getByRole("menuitem", { name: "Sair" }));
    await settle(4);
    expect(authCalls.map((c) => c.method)).toEqual(["signOut"]);
    expect(router.state.location.pathname).toBe("/login");
  });

  test("on a phone, with no room beside it, how I appear is in the menu itself", async () => {
    onPhone();
    await go();
    await click(screen().getAllByRole("button", { name: "Abrir menu" })[0] as HTMLElement);
    const menu = await openMenu();
    expect(within(menu).queryByRole("menuitem", { name: "Definir status" })).toBeNull();
    expect(names(within(menu).getAllByRole("menuitemradio"))).toEqual(["Online", "Ausente", "Ocupado", "Oculto"]);
    expect(names(within(menu).getAllByRole("menuitem"))).toEqual([
      "O que você está fazendo?",
      "Editar perfil",
      "Configurações",
      "Apagar conta",
      "Sair",
    ]);
  });
});
