import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { NEW_CHANNEL_EVENT } from "@/components/Sidebar";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const INTEGRATIONS = "00000000-0000-4000-8000-0000000000e1";
const ENGINEERING = "00000000-0000-4000-8000-0000000000f1";
const BOARD = "00000000-0000-4000-8000-0000000000f2";

type State = ReturnType<typeof seedState>;
const as = (role: "owner" | "member", state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = role;
  return state;
};
/**
 * Acme where Ada answers only João, her owner, and is Integrations' only agent; #eng sits in Engenharia, and
 * Diretoria holds only private channels I'm not in (the server leaves them out of my list). I am Walter.
 */
function acme(role: "owner" | "member") {
  const state = as(role);
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.audience = { mode: "owner", userIds: [] };
  state.agentGroups = [{ id: INTEGRATIONS, name: "Integrations", agentIds: [ADA_ID] }];
  state.channelCategories = [
    { id: ENGINEERING, name: "Engenharia", position: 0 },
    { id: BOARD, name: "Diretoria", position: 1 },
  ];
  for (const c of state.channels) if (c.id === ENG_ID) c.categoryId = ENGINEERING;
  return state;
}
const go = async (state: State, path = `c/${ENG_ID}`) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const sections = () => [...nav().querySelectorAll(".sidebar__section-toggle")].map((b) => b.textContent);
const agentRows = () =>
  [...nav().querySelectorAll("[data-agent-row] .sidebar__item-label")].map((label) => label.textContent);
const typeIn = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  });

describe("what a member's sidebar lists", () => {
  test("only the agents that answer them, and no group left with none of those", async () => {
    await go(acme("member"));
    expect(agentRows()).toEqual(["Atlas"]);
    expect(sections()).not.toContain("Integrations");
    expect(nav().querySelector(".sidebar__lock")).toBeNull();
    // The team's directory stays a click away.
    expect(within(nav()).getByRole("link", { name: "Equipe" })).toBeTruthy();
  });

  test("no category whose channels are all private ones they're not in", async () => {
    await go(acme("member"));
    expect(sections()).toEqual(["Engenharia", "Agentes", "Mensagens diretas"]);
  });

  test("@ offers only the agents that answer them", async () => {
    await go(acme("member"));
    const box = screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
    await typeIn(box, "oi @a");
    const offered = within(screen().getByRole("listbox", { name: "Pessoas e agentes" }))
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(offered.some((n) => n.includes("Atlas"))).toBe(true);
    expect(offered.some((n) => n.includes("Ada"))).toBe(false);
  });

  test("Criar canal offers only the agents that answer them", async () => {
    await go(acme("member"));
    await act(async () => window.dispatchEvent(new Event(NEW_CHANNEL_EVENT)));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    const picker = within(dialog).getByRole("region", { name: "Buscar pessoa ou agente" });
    expect(picker.textContent).toContain("Atlas");
    expect(picker.textContent).not.toContain("Ada");
  });

  test("owners and admins see every agent, locked ones with the lock, and every group and category", async () => {
    await go(acme("owner"));
    expect(sections()).toEqual(["Engenharia", "Diretoria", "Agentes", "Integrations", "Mensagens diretas"]);
    expect(agentRows()).toEqual(["Atlas", "Ada"]);
    const ada = within(nav()).getByRole("link", { name: /^Ada/ });
    expect(within(ada).getByRole("img", { name: "Pessoal" })).toBeTruthy();
  });
});

describe("bringing agents from another app, where agents are made", () => {
  const toImport = () => screen().queryByRole("link", { name: "Trazer agentes de outro app" });

  test("Equipe and Criar agente open Importar e exportar for who creates agents", async () => {
    await go(as("owner"), "team");
    expect(toImport()?.getAttribute("href")).toBe(`/org/${ORG_ID}/settings/import`);
    cleanup();
    await go(as("owner"), "agents/new");
    expect(toImport()?.getAttribute("href")).toBe(`/org/${ORG_ID}/settings/import`);
  });

  test("members, who don't create agents, get neither", async () => {
    await go(as("member"), "team");
    expect(toImport()).toBeNull();
    cleanup();
    await go(as("member"), "agents/new");
    expect(screen().getByText(/Só admins e donos criam agentes/)).toBeTruthy();
    expect(toImport()).toBeNull();
  });
});
