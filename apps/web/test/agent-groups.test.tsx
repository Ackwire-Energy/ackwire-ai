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
/** A sidebar category by its title: its header button, and the agents listed in it. */
const category = (title: string) => {
  const toggle = within(nav()).getByRole("button", { name: title });
  const root = toggle.closest(".sidebar__section") as HTMLElement;
  const agents = () =>
    [...root.querySelectorAll("[data-agent-row] .sidebar__item-label")].map((label) => label.textContent);
  return { toggle, root, agents };
};
const categories = () => [...nav().querySelectorAll(".sidebar__section-toggle")].map((b) => b.textContent);
/** Opens a "…" menu (Radix: keyboard) and gives the menu. */
const openMenu = async (name: string) => {
  const button = within(nav()).getByRole("button", { name });
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

describe("groups of agents in the sidebar (ADR 0080)", () => {
  test("no groups: the sidebar is as it was, one Agentes with everyone and nothing else to read", async () => {
    await go();
    expect(categories()).toEqual(["Canais", "Agentes", "Mensagens diretas"]);
    expect(category("Agentes").agents()).toEqual(["Ada", "Atlas"]);
    expect(nav().textContent).not.toContain("Arraste agentes para cá");
  });

  test("each group is a category with its title; the agents in none stay under Agentes", async () => {
    await go(
      withGroups([
        { id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID] },
        { id: "00000000-0000-4000-8000-0000000000e2", name: "Florim | Gestão e Financeiro", agentIds: [] },
      ]),
    );
    expect(categories()).toEqual([
      "Canais",
      "Agentes",
      "Integrations",
      "Florim | Gestão e Financeiro",
      "Mensagens diretas",
    ]);
    expect(category("Agentes").agents()).toEqual(["Ada"]);
    expect(category("Integrations").agents()).toEqual(["Atlas"]);
    // An empty group says where its agents go, to whoever organizes them.
    expect(category("Florim | Gestão e Financeiro").root.textContent).toContain("Arraste agentes para cá");
  });

  test("a group collapses and stays so in this browser", async () => {
    await go(withGroups());
    const { toggle, root } = category("Integrations");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.getAttribute("data-open")).toBe("false");
    expect(JSON.parse(localStorage.getItem("agentes.sidebar.sections") ?? "[]")).toEqual([`group:${INTEGRATIONS}`]);
    cleanup();
    await go(withGroups());
    expect(category("Integrations").toggle.getAttribute("aria-expanded")).toBe("false");
    expect(category("Agentes").toggle.getAttribute("aria-expanded")).toBe("true");
  });

  test("owners and admins create, rename, reorder and delete groups; deleting puts its agents back", async () => {
    const { state } = await go(withGroups());
    await click(within(category("Agentes").root).getByRole("button", { name: "Novo grupo" }));
    const dialog = screen().getByRole("dialog", { name: "Novo grupo" });
    await type(within(dialog).getByLabelText("Nome"), "  Produto ");
    await click(within(dialog).getByRole("button", { name: "Criar grupo" }));
    expect(calls(state, "agentGroups.create")).toEqual([[{ name: "Produto" }]]);
    expect(categories()).toEqual(["Canais", "Agentes", "Integrations", "Produto", "Mensagens diretas"]);

    await click(within(await openMenu("Opções de Produto")).getByRole("menuitem", { name: "Mover para cima" }));
    expect(categories()).toEqual(["Canais", "Agentes", "Produto", "Integrations", "Mensagens diretas"]);

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
    expect(categories()).toEqual(["Canais", "Agentes", "Produto", "Mensagens diretas"]);
    expect(category("Agentes").agents()).toEqual(["Ada", "Atlas"]);
  });

  test("an agent moves from its row's menu, into a new group from there, and by dragging", async () => {
    const { state } = await go(withGroups());
    const menu = await openMenu("Opções de Ada");
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((o) => o.textContent),
    ).toEqual(["Sem grupo", "Integrations"]);
    await click(within(menu).getByRole("menuitemradio", { name: "Integrations" }));
    expect(calls(state, "agentGroups.move")).toEqual([[ADA_ID, { groupId: INTEGRATIONS }]]);
    expect(category("Integrations").agents()).toEqual(["Atlas", "Ada"]);

    // Inside its group: up one place.
    await click(within(await openMenu("Opções de Ada")).getByRole("menuitem", { name: "Mover para cima" }));
    expect(calls(state, "agentGroups.move").at(-1)).toEqual([ADA_ID, { groupId: INTEGRATIONS, index: 0 }]);
    expect(category("Integrations").agents()).toEqual(["Ada", "Atlas"]);

    // Dragged onto Agentes: out of any group.
    const atlas = within(category("Integrations").root).getByRole("link", { name: /Atlas/ });
    expect(atlas.getAttribute("draggable")).toBe("true");
    const dataTransfer = { setData: () => {}, getData: () => "" };
    await act(async () => fireEvent.dragStart(atlas, { dataTransfer }));
    const agents = category("Agentes").root;
    await act(async () => fireEvent.dragOver(agents, { dataTransfer }));
    expect(agents.getAttribute("data-drop")).toBe("true");
    await act(async () => fireEvent.drop(agents, { dataTransfer }));
    await settle(3);
    expect(calls(state, "agentGroups.move").at(-1)).toEqual([ATLAS_ID, { groupId: null }]);
    expect(category("Agentes").agents()).toEqual(["Atlas"]);

    // A new group made from a row takes that agent.
    await click(within(await openMenu("Opções de Atlas")).getByRole("menuitem", { name: "Novo grupo…" }));
    const dialog = screen().getByRole("dialog", { name: "Novo grupo" });
    await type(within(dialog).getByLabelText("Nome"), "Ops");
    await click(within(dialog).getByRole("button", { name: "Criar grupo" }));
    expect(calls(state, "agentGroups.create")).toEqual([[{ name: "Ops", agentIds: [ATLAS_ID] }]]);
    expect(category("Ops").agents()).toEqual(["Atlas"]);
  });

  test("members see the groups and nothing to change them", async () => {
    await go(asMember(withGroups()));
    expect(category("Integrations").agents()).toEqual(["Atlas"]);
    expect(within(nav()).queryByRole("button", { name: "Novo grupo" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Opções de Integrations" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Opções de Ada" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: /Ada/ }).getAttribute("draggable")).toBeNull();
  });

  test("a change made elsewhere shows at once (the workspace's realtime)", async () => {
    const { sockets } = await go(withGroups());
    const socket = sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        scope: "org",
        event: {
          type: "agent.groups",
          groups: [{ id: INTEGRATIONS, name: "Integrations", agentIds: [ADA_ID, ATLAS_ID] }],
        },
      }),
    );
    await settle(3);
    expect(category("Integrations").agents()).toEqual(["Ada", "Atlas"]);
    expect(category("Agentes").agents()).toEqual([]);
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
