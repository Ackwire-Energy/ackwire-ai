import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * AGENTES (ADR 0083 and its 2026-11 addendum): the agents that talk to me, my pinned ones on top, the ones in no group,
 * then each group as a header that opens and closes; my order; Mudar de grupo and dragging for who manages agents, with
 * Desfazer. "Fixar no topo" in every section, five at most, my own agents on day one.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const sheet of document.querySelectorAll("style[data-layout]")) sheet.remove();
});

type State = ReturnType<typeof seedState>;
const INTEGRATIONS = "00000000-0000-4000-8000-0000000000e1";
const BOARD = "00000000-0000-4000-8000-0000000000e2";
const withGroups = (state: State = seedState()) => {
  state.agentGroups = [
    { id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID] },
    { id: BOARD, name: "Diretoria", agentIds: [] },
  ];
  return state;
};
const asMember = (state: State) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
const go = async (state: State = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const head = (name: string) =>
  within(nav()).getByRole("button", { name }).closest(".sidebar__section-head") as HTMLElement;
const section = (name: string) => head(name).closest(".sidebar__section") as HTMLElement;
const rowsIn = (el: HTMLElement) =>
  [...el.querySelectorAll("[data-agent-row] .sidebar__item-label")].map((l) => l.textContent);
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const items = () =>
  within(screen().getByRole("menu", { name: "Ações" }))
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const rightClick = async (el: Element) => {
  await act(async () => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle(2);
};
const pick = (name: string) =>
  click(within(screen().getByRole("menu", { name: "Ações" })).getByRole("menuitem", { name }));
const openMenu = async (label: string) => {
  const button = within(nav()).getByRole("button", { name: label });
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu", { name: label });
};
const views = (state: State) => state.calls.filter((c) => c.method === "orgs.setSidebarView").map((c) => c.args[1]);
const withLayout = async () => {
  const sheet = document.createElement("style");
  sheet.dataset.layout = "";
  sheet.textContent = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
  document.head.append(sheet);
};
const shown = (el: Element) => {
  for (let e: Element | null = el; e; e = e.parentElement)
    if (window.getComputedStyle(e).display === "none") return false;
  return true;
};

describe("Agentes and its groups", () => {
  test("the agents in no group first, with no header; each group a header with its count", async () => {
    await go(withGroups());
    expect(rowsIn(section("Agentes"))).toEqual(["Ada"]);
    expect(rowsIn(section("Integrations"))).toEqual(["Atlas"]);
    expect(head("Integrations").querySelector(".sidebar__section-count")?.textContent).toBe("1");
    // An empty group is for who arranges the agents: it says where they go.
    expect(section("Diretoria").textContent).toContain("Arraste agentes para cá");
    // Every agent is listed: no row under them says so again.
    expect(nav().querySelector(".sidebar__see-all")).toBeNull();
  });

  test("a member never sees an empty group, nor drags agents", async () => {
    await go(asMember(withGroups()));
    expect(within(nav()).queryByRole("button", { name: "Diretoria" })).toBeNull();
    expect(nav().querySelector("[draggable='true'][data-agent-row], [data-agent-row] [draggable='true']")).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Novo agente ou grupo" })).toBeNull();
  });

  test("closed, a group still shows the agent that wrote to me, and the working count while one works", async () => {
    await withLayout();
    const state = withGroups();
    seedDm(state, { type: "agent", id: ATLAS_ID }, { ago: 1, unread: 2 });
    const r = await go(state);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await click(within(nav()).getByRole("button", { name: "Integrations" }));
    const atlas = nav().querySelector(`[data-agent-row="${ATLAS_ID}"]`) as HTMLElement;
    expect(atlas.dataset.live).toBe("true");
    expect(shown(atlas)).toBe(true);
    await act(async () =>
      socket.push({
        type: "event",
        channelId: GENERAL_ID,
        event: {
          channelId: GENERAL_ID,
          type: "agent.run",
          threadId: null,
          runId: "r-1",
          agentId: ATLAS_ID,
          status: "running",
        },
      }),
    );
    await settle(4);
    expect(head("Integrations").querySelector(".sidebar__section-working")?.textContent).toBe("1 trabalhando");
    // The live line under its name says where, in place of the pill.
    expect(atlas.querySelector(".sidebar__item-role")?.textContent).toBe("trabalhando em #general");
    expect(atlas.querySelector(".sidebar__busy")).toBeNull();
  });

  test("Meus primeiro, from Agentes' ⋯: the agents I'm responsible for lead each group, saved for me", async () => {
    const state = seedState();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.ownerUserId = "u-walter";
    // Day one would pin Atlas (mine): a person who already chose their pins.
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [], channels: [], people: [] },
    };
    await go(state);
    expect(rowsIn(section("Agentes"))).toEqual(["Ada", "Atlas"]);
    const menu = await openMenu("Opções de Agentes");
    await click(within(menu).getByRole("menuitemradio", { name: "Meus primeiro" }));
    expect(rowsIn(section("Agentes"))).toEqual(["Atlas", "Ada"]);
    expect(views(state).at(-1)).toMatchObject({ agentSort: "mine" });
  });

  test("an owner shows the agents that don't talk to them from the ⋯; a member has no such choice", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.audience = { mode: "owner", userIds: [] };
    await go(state);
    expect(rowsIn(section("Agentes"))).toEqual(["Atlas"]);
    // The one not listed is in Equipe, and the row under the agents says how many.
    expect(within(nav()).getByRole("link", { name: "Mais 1 agente na Equipe" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/team`,
    );
    const menu = await openMenu("Opções de Agentes");
    await click(within(menu).getByRole("menuitemcheckbox", { name: "Mostrar agentes que não falam comigo" }));
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(rowsIn(section("Agentes"))).toEqual(["Ada", "Atlas"]);
    expect(nav().querySelector(".sidebar__see-all")).toBeNull();
    expect(views(state).at(-1)).toMatchObject({ showAllAgents: true });
    cleanup();
    await go(asMember(seedState()));
    const theirs = await openMenu("Opções de Agentes");
    expect(within(theirs).queryByRole("menuitemcheckbox")).toBeNull();
  });
});

describe("Mudar de grupo", () => {
  test("the row's right click moves the agent, and the toast's Desfazer puts it back", async () => {
    const { state } = await go(withGroups());
    await rightClick(within(nav()).getByRole("link", { name: /^Ada/ }));
    expect(items()).toEqual(expect.arrayContaining(["Sem grupo", "Integrations", "Diretoria", "Novo grupo com Ada"]));
    await pick("Integrations");
    expect(rowsIn(section("Integrations"))).toEqual(["Atlas", "Ada"]);
    const toast = screen()
      .getByText("Ada foi para o grupo Integrations")
      .closest("[role='status'], li, div") as HTMLElement;
    await click(within(toast.parentElement as HTMLElement).getByRole("button", { name: "Desfazer" }));
    expect(rowsIn(section("Agentes"))).toEqual(["Ada"]);
    const moves = state.calls.filter((c) => c.method === "agentGroups.move").map((c) => c.args.slice(1));
    expect(moves.map(([agentId, to]) => [agentId, (to as { groupId: string | null }).groupId])).toEqual([
      [ADA_ID, INTEGRATIONS],
      [ADA_ID, null],
    ]);
  });
});

describe("Fixar no topo", () => {
  test("day one: my own agents on top of Agentes, with a line about pins; its ✕ keeps them and the line goes", async () => {
    const state = seedState();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.ownerUserId = "u-walter";
    await go(state);
    expect(rowsIn(section("Agentes"))).toEqual(["Atlas", "Ada"]);
    const pinned = nav().querySelector(`[data-agent-row="${ATLAS_ID}"]`) as HTMLElement;
    expect(within(pinned).getByRole("img", { name: "Fixado no topo" })).toBeTruthy();
    expect(section("Agentes").querySelector(".sidebar__pins-end")).not.toBeNull();
    const hint = section("Agentes").querySelector(".sidebar__pins-hint") as HTMLElement;
    expect(hint.textContent).toContain("Seus agentes ficam no topo.");
    await click(within(hint).getByRole("button", { name: "Fechar" }));
    expect(section("Agentes").querySelector(".sidebar__pins-hint")).toBeNull();
    expect(views(state).at(-1)).toMatchObject({ pins: { agents: [ATLAS_ID], channels: [], people: [] } });
  });

  test("a channel pinned from its right click goes on top of Canais; Tirar do topo puts it back", async () => {
    const { state } = await go();
    const eng = () => nav().querySelector(`a.sidebar__item[title="#eng"]`) as HTMLElement;
    await rightClick(eng());
    await pick("Fixar no topo");
    const canais = section("Canais");
    expect(canais.querySelector("a.sidebar__item")?.getAttribute("title")).toBe("#eng");
    expect(canais.querySelector(".sidebar__pins-end")).not.toBeNull();
    expect(views(state).at(-1)).toMatchObject({ pins: { channels: [ENG_ID] } });
    await rightClick(eng());
    await pick("Tirar do topo");
    expect(canais.querySelector(".sidebar__pins-end")).toBeNull();
  });

  test("a person pinned stays on top of Mensagens diretas even before a conversation", async () => {
    const state = seedState();
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [], channels: [], people: ["u-joao"] },
    };
    await go(state);
    expect(
      [...section("Mensagens diretas").querySelectorAll("a .sidebar__item-label")].map((l) => l.textContent),
    ).toEqual(["João"]);
  });

  test("five per section: the sixth says so and pins nothing", async () => {
    const state = seedState();
    const five = ["c1", "c2", "c3", "c4", "c5"];
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [], channels: five, people: [] },
    };
    await go(state);
    await rightClick(nav().querySelector(`a.sidebar__item[title="#eng"]`) as HTMLElement);
    await pick("Fixar no topo");
    expect(screen().getByText("Você já fixou 5 canais. Tire um do topo para fixar este.")).toBeTruthy();
    expect(views(state)).toEqual([]);
  });
});
