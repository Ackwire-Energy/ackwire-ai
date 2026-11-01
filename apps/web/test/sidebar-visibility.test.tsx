import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { NEW_CHANNEL_EVENT } from "@/components/Sidebar";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
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
    expect(sections()).toEqual(["Canais", "Engenharia", "Agentes", "Mensagens diretas"]);
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

  test("an empty channel's suggestions and its / commands go to an agent that answers them", async () => {
    const state = acme("member");
    state.channelMembers[GENERAL_ID] = [
      { type: "person", id: "u-walter" },
      { type: "agent", id: ADA_ID },
      { type: "agent", id: ATLAS_ID },
    ];
    await go(state, `c/${GENERAL_ID}`);
    const chips = document.querySelector(".channel__suggestions")?.textContent ?? "";
    expect(chips).toContain("@Atlas");
    expect(chips).not.toContain("@Ada");
    const box = screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
    await typeIn(box, "/");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(box.value).toBe("@atlas monte um relatório sobre ");
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
    expect(sections()).toEqual(["Canais", "Engenharia", "Diretoria", "Agentes", "Integrations", "Mensagens diretas"]);
    expect(agentRows()).toEqual(["Atlas", "Ada"]);
    const ada = within(nav()).getByRole("link", { name: /^Ada/ });
    expect(within(ada).getByRole("img", { name: "Pessoal" })).toBeTruthy();
  });
});

describe("Equipe on the Agentes header", () => {
  const agentsHead = () => {
    const toggle = [...nav().querySelectorAll(".sidebar__section-toggle")].find((b) => b.textContent === "Agentes");
    const head = toggle?.closest(".sidebar__section-head");
    if (!(head instanceof HTMLElement)) throw new Error("no Agentes header");
    return head;
  };

  test("a button beside the +, not a row of its own, marked while the page is open", async () => {
    await go(acme("owner"));
    const team = within(agentsHead()).getByRole("link", { name: "Equipe" });
    expect(team.getAttribute("href")).toBe(`/org/${ORG_ID}/team`);
    expect(team.getAttribute("title")).toBe("Equipe");
    expect(within(agentsHead()).getByRole("button", { name: "Criar agente ou grupo" })).toBeTruthy();
    expect(within(nav()).getAllByRole("link", { name: "Equipe" })).toHaveLength(1);
    expect(team.getAttribute("data-status")).toBeNull();
    cleanup();
    await go(acme("owner"), "team");
    expect(within(agentsHead()).getByRole("link", { name: "Equipe" }).getAttribute("data-status")).toBe("active");
  });

  test("the icon rail, which hides the headers, keeps it as a tile", async () => {
    await go(acme("owner"));
    const teamTiles = () =>
      [...nav().querySelectorAll(".sidebar__section-body > a.sidebar__item")].filter(
        (a) => a.getAttribute("href") === `/org/${ORG_ID}/team`,
      );
    expect(teamTiles()).toHaveLength(0);
    const toggle = () => within(nav()).getByRole("button", { name: /barra lateral$/ });
    await act(async () => fireEvent.click(toggle()));
    try {
      expect(nav().getAttribute("data-rail")).toBe("true");
      expect(teamTiles()).toHaveLength(1);
    } finally {
      // The rail is kept for the whole page, not per render: back to the full sidebar for the other tests.
      await act(async () => fireEvent.click(toggle()));
    }
  });
});

describe("bringing agents from another app, where agents are made", () => {
  const toImport = () => screen().queryByRole("link", { name: "Trazer agentes de outro app" });

  const importButton = () => screen().queryByRole("button", { name: "Trazer agentes de outro app" });

  test("Equipe links to Importar e exportar for who creates agents; Criar agente opens the import in place", async () => {
    await go(as("owner"), "team");
    expect(toImport()?.getAttribute("href")).toBe(`/org/${ORG_ID}/settings/import`);
    cleanup();
    await go(as("owner"), "agents/new");
    expect(importButton()).not.toBeNull();
  });

  test("members, who don't create agents, get neither", async () => {
    await go(as("member"), "team");
    expect(toImport()).toBeNull();
    cleanup();
    await go(as("member"), "agents/new");
    expect(screen().getByText(/Só admins e donos criam agentes/)).toBeTruthy();
    expect(toImport()).toBeNull();
    expect(importButton()).toBeNull();
  });
});

describe("an agent's row", () => {
  test("the role on its own line under the name, and the lock alone at the row's end", async () => {
    const state = acme("owner");
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.role = "Assistente de e-mails e agenda da diretoria";
    await go(state);
    const row = nav().querySelector(`[data-agent-row="${ADA_ID}"] .sidebar__item`);
    const text = row?.querySelector(":scope > .sidebar__item-text");
    expect([...(text?.children ?? [])].map((el) => [el.className, el.textContent])).toEqual([
      ["sidebar__item-label", "Ada"],
      ["sidebar__item-role", "Assistente de e-mails e agenda da diretoria"],
    ]);
    // Nothing at the row's end shares the name's line with the role: only the lock.
    const end = row?.querySelector(":scope > .sidebar__item-meta");
    expect(end?.textContent).toBe("");
    expect(end?.querySelector(".sidebar__lock")).not.toBeNull();
  });
});
