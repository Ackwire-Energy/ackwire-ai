import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/* A personal workspace's sidebar (ADR 0158): the person on top, Go to… as a row, no foot, Routines and Drive in
   sight, the agents first, no people or #general while the person is alone. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type State = ReturnType<typeof seedState>;
/** Acme as a personal workspace, nothing waiting for me; `alone`: João isn't a member. */
const personal = ({ alone = false }: { alone?: boolean } = {}) => {
  const state = seedState();
  const org = state.me?.organizations[0];
  if (org) org.mode = "personal";
  for (const a of state.approvals) a.status = "approved";
  for (const p of state.proposals) p.status = "accepted";
  if (alone) state.members = state.members.filter((m) => m.userId === state.me?.user.id);
  return state;
};
const go = async (state: State, path = `c/${ENG_ID}`) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const nav = () => document.getElementById("app-nav") as HTMLElement;
const top = () => nav().querySelector(".sidebar__top") as HTMLElement;
/** The tools' links in the list, under Início. */
const listed = () =>
  [...nav().querySelectorAll(".sidebar__tools > a.sidebar__item .sidebar__item-label")]
    .map((l) => l.textContent)
    .slice(1);
const blocks = () => [...nav().querySelectorAll<HTMLElement>(".sidebar__block")].map((b) => b.dataset.section);
const channelRows = () =>
  [...nav().querySelectorAll('.sidebar__item[data-kind="channel"] .sidebar__item-label')].map((l) => l.textContent);

describe("a personal workspace's sidebar", () => {
  test("me on top with the bell beside me, and no foot", async () => {
    await go(personal());
    const me = within(top()).getByRole("button", { name: /^Conta: / });
    expect(me.textContent).toContain("Walter");
    expect(within(top()).getByRole("link", { name: "Notificações" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/notifications`,
    );
    expect(within(top()).queryByRole("button", { name: /Menu do workspace/ })).toBeNull();
    expect(nav().querySelector(".sidebar__foot")).toBeNull();
    expect(nav().querySelectorAll(".sidebar__bell")).toHaveLength(1);
  });

  test("my menu opens down with my account, the settings and my workspaces in it", async () => {
    await go(personal());
    const me = within(top()).getByRole("button", { name: /^Conta: / });
    me.focus();
    await act(async () => {
      fireEvent.keyDown(me, { key: "Enter" });
      fireEvent.keyUp(me, { key: "Enter" });
    });
    await settle(3);
    const menu = screen().getAllByRole("menu")[0] as HTMLElement;
    expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Definir status",
      "Editar perfil",
      "Sua conta",
      "Configurações",
      "AcmeVocê está aqui",
      "Novo workspace",
      "Sair",
    ]);
    expect(menu.textContent).toContain("Seus workspaces");
  });

  test("Go to… is the list's first row, above Início; no ⌘K field on top", async () => {
    await go(personal());
    const first = nav().querySelector(".sidebar__tools > .sidebar__item");
    expect(first?.classList.contains("sidebar__goto")).toBe(true);
    expect(first?.querySelector(".sidebar__item-label")?.textContent).toBe("Ir para…");
    expect(nav().querySelector(".sidebar__jump")).toBeNull();
  });

  test("Rotinas and Drive in sight; the rest in More, each with its line for one person", async () => {
    await go(personal());
    expect(listed()).toEqual(["Rotinas", "Drive"]);
    await click(within(nav()).getByRole("button", { name: "Mais" }));
    const more = screen().getByRole("dialog", { name: "Mais" });
    const names = within(more)
      .getAllByRole("link")
      .map((l) => l.querySelector(".ac-menu__label")?.firstChild?.textContent);
    expect(names).toEqual([
      "Aprovações",
      "Propostas de melhoria",
      "Calendário",
      "Tarefas",
      "Threads",
      "Equipe",
      "Wiki",
      "Painéis",
      "Gerenciador de tarefas",
    ]);
    const tasks = within(more).getByRole("link", { name: /Tarefas/ });
    expect(tasks.querySelector(".ac-menu__desc")?.textContent).toBe("Suas tarefas e as dos seus agentes");
  });

  test("the agents come first; channels are Conversas em grupo; with someone else in, people and #general show", async () => {
    await go(personal());
    expect(blocks()).toEqual(["tools", "agents", "channels", "people"]);
    const toggles = [...nav().querySelectorAll(".sidebar__section-toggle")].map((b) => b.textContent);
    expect(toggles).toContain("Conversas em grupo");
    expect(toggles).toContain("Mensagens diretas");
    expect(channelRows()).toContain("general");
  });

  test("alone: no people and no #general; the channels show while there is another one", async () => {
    await go(personal({ alone: true }));
    expect(blocks()).toEqual(["tools", "agents", "channels"]);
    expect(channelRows()).toEqual(["eng"]);
  });

  test("alone with only #general: no group conversations at all", async () => {
    const state = personal({ alone: true });
    state.channels = state.channels.filter((c) => c.name === "general");
    await go(state, `dm/agent/${ADA_ID}`);
    expect(blocks()).toEqual(["tools", "agents"]);
  });

  test("a team's sidebar is as before: the workspace on top, ⌘K under it, me and the bell at the foot", async () => {
    await go(seedState());
    expect(nav().querySelector(".sidebar__goto")).toBeNull();
    expect(nav().querySelector(".sidebar__jump")).not.toBeNull();
    expect(nav().querySelector(".sidebar__foot .sidebar__bell")).not.toBeNull();
    expect(blocks()).toEqual(["tools", "channels", "agents", "people"]);
  });
});
