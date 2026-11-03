import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentGroup } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const INTEGRATIONS = "00000000-0000-4000-8000-0000000000e1";

/** Acme with a group, Integrations, holding Atlas (Ada in none); `role`: mine. */
function withGroups(groups: AgentGroup[] = [{ id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID] }]) {
  const state = seedState();
  state.agentGroups = groups;
  return state;
}
const asMember = (state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
const go = async (state = seedState(), path = `c/${GENERAL_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const card = () => screen().getByText("Grupos de agentes").closest(".team-groups") as HTMLElement;
/** A group on Equipe by its title, and the agents listed in it. */
const group = (title: string) => {
  const root = within(card()).getByRole("region", { name: title });
  const agents = () => [...root.querySelectorAll("[data-agent-row] b")].map((b) => b.textContent);
  return { root, agents };
};
const groupTitles = () => [...card().querySelectorAll(".team-groups__head h3")].map((h) => h.textContent);
/** Opens a "…" menu (Radix: keyboard) and gives the menu. */
const openMenu = async (name: string) => {
  const button = within(card()).getByRole("button", { name });
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu");
};
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args.slice(1));
const team = (state = seedState()) => go(state, "team");

describe("groups of agents on Equipe (ADR 0083)", () => {
  test("the sidebar has no agents' part or groups: they are arranged on Equipe", async () => {
    await go(withGroups());
    const titles = [...nav().querySelectorAll(".sidebar__section-toggle")].map((b) => b.textContent);
    expect(titles).toEqual(["Canais", "Mensagens diretas"]);
    expect(nav().textContent).not.toContain("Integrations");
    expect(nav().querySelector("[draggable='true'][data-agent-row]")).toBeNull();
  });

  test("no groups: Agentes with everyone and nothing else to read", async () => {
    await team();
    expect(groupTitles()).toEqual(["Agentes"]);
    expect(group("Agentes").agents()).toEqual(["Ada", "Atlas"]);
    expect(card().textContent).not.toContain("Arraste agentes para cá");
  });

  test("each group has its title; the agents in none stay under Agentes", async () => {
    await team(
      withGroups([
        { id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID] },
        { id: "00000000-0000-4000-8000-0000000000e2", name: "Lumen | Gestão e Financeiro", agentIds: [] },
      ]),
    );
    expect(groupTitles()).toEqual(["Agentes", "Integrations", "Lumen | Gestão e Financeiro"]);
    expect(group("Agentes").agents()).toEqual(["Ada"]);
    expect(group("Integrations").agents()).toEqual(["Atlas"]);
    // An empty group says where its agents go, to whoever organizes them.
    expect(group("Lumen | Gestão e Financeiro").root.textContent).toContain("Arraste agentes para cá");
  });

  test("owners and admins create, rename, reorder and delete groups; deleting puts its agents back", async () => {
    const { state } = await team(withGroups());
    await click(within(card()).getByRole("button", { name: "Novo grupo" }));
    const dialog = screen().getByRole("dialog", { name: "Novo grupo" });
    await type(within(dialog).getByLabelText("Nome"), "  Produto ");
    await click(within(dialog).getByRole("button", { name: "Criar grupo" }));
    expect(calls(state, "agentGroups.create")).toEqual([[{ name: "Produto" }]]);
    expect(groupTitles()).toEqual(["Agentes", "Integrations", "Produto"]);

    await click(within(await openMenu("Opções de Produto")).getByRole("menuitem", { name: "Mover para cima" }));
    expect(groupTitles()).toEqual(["Agentes", "Produto", "Integrations"]);

    await click(within(await openMenu("Opções de Integrations")).getByRole("menuitem", { name: "Renomear" }));
    const rename = screen().getByRole("dialog", { name: "Renomear grupo" });
    const name = within(rename).getByLabelText("Nome") as HTMLInputElement;
    expect(name.value).toBe("Integrations");
    await type(name, "APIs");
    await click(within(rename).getByRole("button", { name: "Salvar" }));
    expect(calls(state, "agentGroups.update").at(-1)).toEqual([INTEGRATIONS, { name: "APIs" }]);

    await click(within(await openMenu("Opções de APIs")).getByRole("menuitem", { name: "Excluir grupo" }));
    const sure = screen().getByRole("dialog", { name: "Excluir o grupo APIs?" });
    expect(sure.textContent).toContain("Os agentes dele voltam para Agentes.");
    await click(within(sure).getByRole("button", { name: "Excluir grupo" }));
    expect(calls(state, "agentGroups.remove")).toEqual([[INTEGRATIONS]]);
    expect(groupTitles()).toEqual(["Agentes", "Produto"]);
    expect(group("Agentes").agents()).toEqual(["Ada", "Atlas"]);
  });

  test("an agent moves from its row's menu, into a new group from there, and by dragging", async () => {
    const { state } = await team(withGroups());
    const menu = await openMenu("Opções de Ada");
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((o) => o.textContent),
    ).toEqual(["Sem grupo", "Integrations"]);
    await click(within(menu).getByRole("menuitemradio", { name: "Integrations" }));
    expect(calls(state, "agentGroups.move")).toEqual([[ADA_ID, { groupId: INTEGRATIONS }]]);
    expect(group("Integrations").agents()).toEqual(["Atlas", "Ada"]);

    // Inside its group: up one place.
    await click(within(await openMenu("Opções de Ada")).getByRole("menuitem", { name: "Mover para cima" }));
    expect(calls(state, "agentGroups.move").at(-1)).toEqual([ADA_ID, { groupId: INTEGRATIONS, index: 0 }]);
    expect(group("Integrations").agents()).toEqual(["Ada", "Atlas"]);

    // Dragged onto Agentes: out of any group.
    const atlas = within(group("Integrations").root).getByRole("link", { name: /Atlas/ });
    expect(atlas.getAttribute("draggable")).toBe("true");
    const dataTransfer = { setData: () => {}, getData: () => "" };
    await act(async () => fireEvent.dragStart(atlas, { dataTransfer }));
    const agents = group("Agentes").root;
    await act(async () => fireEvent.dragOver(agents, { dataTransfer }));
    expect(agents.getAttribute("data-drop")).toBe("true");
    await act(async () => fireEvent.drop(agents, { dataTransfer }));
    await settle(3);
    expect(calls(state, "agentGroups.move").at(-1)).toEqual([ATLAS_ID, { groupId: null }]);
    expect(group("Agentes").agents()).toEqual(["Atlas"]);

    // A new group made from a row takes that agent.
    await click(within(await openMenu("Opções de Atlas")).getByRole("menuitem", { name: "Novo grupo…" }));
    const dialog = screen().getByRole("dialog", { name: "Novo grupo" });
    await type(within(dialog).getByLabelText("Nome"), "Ops");
    await click(within(dialog).getByRole("button", { name: "Criar grupo" }));
    expect(calls(state, "agentGroups.create")).toEqual([[{ name: "Ops", agentIds: [ATLAS_ID] }]]);
    expect(group("Ops").agents()).toEqual(["Atlas"]);
  });

  test("members see the groups and nothing to change them", async () => {
    await team(asMember(withGroups()));
    expect(groupTitles()).toEqual(["Integrations"]);
    expect(group("Integrations").agents()).toEqual(["Atlas"]);
    expect(within(card()).queryByRole("button", { name: "Novo grupo" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Opções de Integrations" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Opções de Atlas" })).toBeNull();
    expect(within(card()).getByRole("link", { name: /Atlas/ }).getAttribute("draggable")).toBeNull();
  });

  test("members with no group holding an agent they see get no groups card", async () => {
    await team(asMember());
    expect(screen().queryByText("Grupos de agentes")).toBeNull();
  });

  test("a change made elsewhere shows at once (the workspace's realtime)", async () => {
    const { sockets, state } = await team(withGroups());
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(3);
    // Someone else moved Ada into Integrations: the event says the groups changed, Equipe reads them again.
    state.agentGroups = [{ id: INTEGRATIONS, name: "Integrations", agentIds: [ADA_ID, ATLAS_ID] }];
    await act(async () => socket.push({ type: "event", scope: "org", event: { type: "agent.groups" } }));
    await settle(3);
    expect(group("Integrations").agents()).toEqual(["Ada", "Atlas"]);
    expect(group("Agentes").agents()).toEqual([]);
  });
});

describe("the Group field on the agent's page", () => {
  test("owners and admins pick it in Configurações and it saves with the page", async () => {
    const { state } = await go(withGroups(), `agents/${ADA_ID}?tab=settings&sec=identity`);
    const field = screen().getByRole("combobox", { name: "Grupo" });
    expect(field.textContent).toBe("Sem grupo");
    field.focus();
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Integrations" }));
    const bar = screen().getByRole("region", { name: "Alterações não salvas" });
    expect(bar.textContent).toContain("Grupo");
    await click(within(bar).getByRole("button", { name: /^Salvar/ }));
    await settle(4);
    expect(calls(state, "agentGroups.move")).toEqual([[ADA_ID, { groupId: INTEGRATIONS }]]);
    expect(screen().getByRole("combobox", { name: "Grupo" }).textContent).toBe("Integrations");
  });

  test("with no groups there is no field; a member reads the agent's group", async () => {
    await go(seedState(), `agents/${ADA_ID}?tab=settings&sec=identity`);
    expect(screen().queryByRole("combobox", { name: "Grupo" })).toBeNull();
    cleanup();
    await go(asMember(withGroups()), `agents/${ATLAS_ID}?tab=settings&sec=identity`);
    expect(screen().queryByRole("combobox", { name: "Grupo" })).toBeNull();
    expect(document.querySelector(".agp-id")?.textContent).toContain("Integrations");
  });
});
