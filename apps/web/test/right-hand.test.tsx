import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { DESKTOP_QUERY } from "@/components/NavDrawer";
import {
  ADA_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  fakeMachinesOf,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The team's right hand (ADR 0137) on the web: its pinned row, the members column, its profile, its DM, Settings. */

let media: { mockRestore: () => void } | null = null;
afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const go = async (state: FakeState, path = `c/${GENERAL_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const pinRow = () => nav().querySelector<HTMLElement>("a[data-right-hand]");
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("the right hand's row in the sidebar", () => {
  test("first in the list, above the tools, with its label; never under Mensagens diretas", async () => {
    const state = withRightHand(seedState());
    seedDm(state, { type: "agent", id: LODI_ID }, { ago: 2 });
    seedDm(state, { type: "agent", id: ADA_ID }, { ago: 5 });
    await go(state);
    const row = pinRow();
    expect(row).toBeTruthy();
    const scroll = nav().querySelector(".sidebar__scroll") as HTMLElement;
    // Before every section (it isn't one: nothing moves or hides it).
    expect(scroll.firstElementChild?.contains(row)).toBe(true);
    expect(row?.closest("[data-section]")).toBeNull();
    expect(row?.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
    expect(row?.querySelector(".sidebar__item-label")?.textContent).toBe("Lodi");
    const dms = [...nav().querySelectorAll<HTMLElement>("[data-agent-row]")].map((r) => r.dataset.agentRow);
    expect(dms).toContain(ADA_ID);
    expect(dms).not.toContain(LODI_ID);
  });

  test("Novo until it is first opened, then its label; its DM's unread count when it answered", async () => {
    const state = withRightHand(seedState());
    await go(state);
    expect(pinRow()?.textContent).toContain("Novo");
    await click(pinRow() as HTMLElement);
    expect(pinRow()?.textContent).not.toContain("Novo");
    expect(pinRow()?.textContent).toContain("seu braço direito");
    cleanup();
    localStorage.clear();
    // Its DM opened any other way (the onboarding, Mensagem on its card): gone all the same.
    const { router } = await go(withRightHand(seedState()));
    expect(pinRow()?.textContent).toContain("Novo");
    await act(async () => {
      await router.navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: ORG_ID, agentId: LODI_ID } });
    });
    await settle(8);
    expect(pinRow()?.textContent).not.toContain("Novo");
    cleanup();
    // Remembered in this browser.
    const again = withRightHand(seedState());
    seedDm(again, { type: "agent", id: LODI_ID }, { unread: 2 });
    await go(again);
    expect(pinRow()?.querySelector(".sidebar__item-meta")).toBeNull();
    expect(pinRow()?.textContent).toContain("2");
  });

  test("outside its audience, there is no row", async () => {
    await go(
      withRightHand(seedState(), { ownerUserId: "u-joao", audience: { mode: "people", userIds: [], roleIds: ["r"] } }),
    );
    expect(pinRow()).toBeNull();
  });
});

describe("the right hand elsewhere", () => {
  test("the members column lists it first among the agents, with how to call it", async () => {
    media = spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: q === DESKTOP_QUERY,
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    const r = await go(withRightHand(seedState()), `c/${ENG_ID}`);
    await act(async () => r.sockets.last().open());
    const column = screen().getByRole("complementary", { name: "Membros de #eng" });
    const agents = within(column).getByRole("region", { name: "Agentes" });
    const rows = [...agents.querySelectorAll(".members-side__row")];
    expect(rows[0]?.querySelector(".members-side__label")?.textContent).toBe("Lodi");
    expect(rows[0]?.querySelector(".members-side__line")?.textContent).toBe("chame com @lodi");
  });

  test("its DM says what it is and that nothing changes without you", async () => {
    await go(withRightHand(seedState()), `dm/agent/${LODI_ID}`);
    const header = document.querySelector(".channel__header") as HTMLElement;
    // As the language writes it; the line's first letter goes up in CSS (no case change on translated text).
    const topic = header.querySelector(".channel__topic[data-right-hand]");
    expect(topic?.textContent).toContain("seu braço direito · age com as suas permissões");
    expect(header.textContent).not.toContain("Computador");
    expect(screen().getByRole("combobox", { name: "Mensagem para Lodi · nada muda sem você" })).toBeTruthy();
  });

  test("Settings › Lodi: its name and face in the nav, the lock line and its audit link", async () => {
    await go(withRightHand(seedState()), "settings/right_hand");
    const link = within(screen().getByRole("navigation", { name: "Seções das configurações" })).getByRole("link", {
      name: "Lodi",
    });
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen().getByRole("heading", { name: "Lodi" })).toBeTruthy();
    const body = document.querySelector(".settings__body") as HTMLElement;
    expect(body.textContent).toContain("Na barra lateral ele aparece sempre como “seu braço direito”.");
    expect(body.textContent).toContain("O Lodi não pode ser arquivado nem apagado.");
    expect(within(body).getByRole("link", { name: "Ver o que o Lodi fez" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/audit?agent=${LODI_ID}`,
    );
  });

  test("renaming it there saves the name and its @", async () => {
    const { state } = await go(withRightHand(seedState()), "settings/right_hand");
    const name = screen().getByRole("textbox", { name: "Nome e visual" });
    await act(async () => fireEvent.change(name, { target: { value: "Bento" } }));
    await act(async () => fireEvent.blur(name));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args.slice(1)).toEqual([
      LODI_ID,
      { name: "Bento", handle: "bento" },
    ]);
  });

  test("a member has no Lodi section", async () => {
    const state = withRightHand(seedState());
    const org = state.me?.organizations[0];
    if (org) org.role = "member";
    await go(state, "settings/account");
    const settingsNav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(settingsNav).queryByRole("link", { name: "Lodi" })).toBeNull();
  });
});

describe("the right hand's Connect AI", () => {
  test("it thinks on no computer: the dialog opens on the API key, and a plan says why it can't, never a sign-in loading", async () => {
    const state = withRightHand(seedState());
    state.aiStatus = { any: false, agents: [{ agentId: LODI_ID, state: "no_ai", reason: "no_key" }] };
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    // As the server answers for it: the workspace's computer is ready, and none is ever given to it.
    const brain = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await brain(orgId, agentId)),
      ...(agentId === LODI_ID ? { computer: null, accounts: [] } : {}),
    });
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Conectar" }), 10);
    const box = screen().getByRole("dialog", { name: "Conectar uma IA para o Lodi" });
    expect(within(box).getByRole("region", { name: "Chave de API" })).toBeTruthy();
    const group = within(box).getByRole("group", { name: "Qual IA eles vão usar?" });
    await click(within(group).getByRole("button", { name: "Claude" }), 10);
    const panel = within(box).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("O Lodi pensa só com uma chave de API.");
    expect(within(panel).queryByRole("button", { name: "Entrar com Claude" })).toBeNull();
    expect(panel.querySelector("[aria-busy='true']")).toBeNull();
    await click(within(panel).getByRole("button", { name: "Usar uma chave de API agora" }));
    expect(within(box).getByRole("region", { name: "Chave de API" })).toBeTruthy();
  });
});
