import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/* A personal workspace's sidebar (ADR 0159): the person on top, the agents with no header and New agent under them,
   group conversations and people only when there are some, one More at the end with Início, Go to… and every tool. */

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
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual([
      "Definir status",
      "Editar perfil",
      "Sua conta",
      "Configurações",
      // A personal workspace of mine is me: my face (its initial here) and my name, never the workspace's.
      "WWalterVocê está aqui",
      "Novo workspace",
      "Sair",
    ]);
    expect(menu.textContent).toContain("Seus workspaces");
  });

  test("no tool in sight while nothing waits; one More at the end with Início, Go to… and every tool", async () => {
    await go(personal());
    expect(nav().querySelector(".sidebar__tools")).toBeNull();
    expect(nav().querySelector(".sidebar__jump")).toBeNull();
    const more = nav().querySelector(".sidebar__end .sidebar__more") as HTMLElement;
    expect(more).not.toBeNull();
    await click(more);
    const menu = screen().getByRole("dialog", { name: "Mais" });
    const names = within(menu)
      .getAllByRole("link")
      .map((l) => l.querySelector(".ac-menu__label")?.firstChild?.textContent);
    expect(names).toEqual([
      "Início",
      "Aprovações",
      "Propostas de melhoria",
      "Rotinas",
      "Drive",
      "Calendário",
      "Tarefas",
      "Threads",
      "Equipe",
      "Wiki",
      "Painéis",
      "Gerenciador de tarefas",
    ]);
    expect(within(menu).getByRole("button", { name: /Ir para…/ })).toBeTruthy();
    const tasks = within(menu).getByRole("link", { name: /Tarefas/ });
    expect(tasks.querySelector(".ac-menu__desc")?.textContent).toBe("Suas tarefas e as dos seus agentes");
  });

  test("Aprovações comes into sight while something waits", async () => {
    const state = personal();
    const first = state.approvals[0];
    if (first) first.status = "pending";
    await go(state);
    const rows = [...nav().querySelectorAll(".sidebar__tools .sidebar__item-label")].map((l) => l.textContent);
    expect(rows).toEqual(["Aprovações"]);
  });

  test("the agents have no header; New agent sits right under them and opens the new agent's card (ADR 0164)", async () => {
    const state = withRightHand(personal());
    await go(state);
    const agents = nav().querySelector('.sidebar__block[data-section="agents"]') as HTMLElement;
    expect(agents.querySelector(".sidebar__section-toggle")).toBeNull();
    const rows = [...agents.querySelectorAll(".sidebar__item")];
    const last = rows.at(-1) as HTMLElement;
    expect(last.classList.contains("sidebar__new-agent")).toBe(true);
    expect(last.textContent).toBe("Novo agente");
    await click(last);
    const dialog = screen().getByRole("dialog", { name: "Novo agente" });
    // From scratch first, then the personal starters; Clara picked, introducing herself on her card.
    const options = within(dialog).getAllByRole("option");
    expect(options[0]?.textContent).toContain("Do zero");
    expect(within(dialog).getByRole("option", { name: /Clara/ }).getAttribute("aria-selected")).toBe("true");
    expect((within(dialog).getByRole("textbox", { name: "Nome" }) as HTMLInputElement).value).toBe("Clara");
    expect(dialog.textContent).toContain("Oi! Eu sou a");
    await click(within(dialog).getByRole("button", { name: /Criar Clara/ }));
    const made = state.calls.find((c) => c.method === "agents.create");
    expect(made).toBeTruthy();
    const input = made?.args[1] as { name: string; setup: { starter?: string; hello?: string; apps?: object } };
    expect(input.name).toBe("Clara");
    expect(input.setup.starter).toBe("clara");
    expect(input.setup.hello).toContain("agenda");
    // Its starter's apps at write, with the ones already connected here (ADR 0159 §3a).
    expect(input.setup.apps).toMatchObject({ "google-calendar": "write", todoist: "write" });
  });

  test("from scratch, the card asks what it will do and offers names that fit it (ADR 0164)", async () => {
    const state = withRightHand(personal());
    await go(state);
    const agents = nav().querySelector('.sidebar__block[data-section="agents"]') as HTMLElement;
    await click([...agents.querySelectorAll(".sidebar__item")].at(-1) as HTMLElement);
    const dialog = screen().getByRole("dialog", { name: "Novo agente" });
    await click(within(dialog).getByRole("option", { name: /Do zero/ }));
    const create = within(dialog).getByRole("button", { name: /Criar agente/ }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const what = within(dialog).getByRole("textbox", { name: "O que faz" });
    await act(async () => fireEvent.change(what, { target: { value: "Cuidar da agenda do consultório" } }));
    await settle(2);
    // An agenda's names; one of them picked becomes its name.
    const idea = within(dialog).getByRole("button", { name: "Lia" });
    await click(idea);
    expect((within(dialog).getByRole("textbox", { name: "Nome" }) as HTMLInputElement).value).toBe("Lia");
    await click(within(dialog).getByRole("button", { name: /Criar Lia/ }));
    const input = state.calls.find((c) => c.method === "agents.create")?.args[1] as {
      instructions: string;
      setup: { role: null; hello?: string };
    };
    expect(input.instructions).toBe("Cuidar da agenda do consultório");
    expect(input.setup).toMatchObject({ role: null, hello: "Cuidar da agenda do consultório" });
  });

  test("the agents come first; channels are Conversas em grupo; with someone else in, people and #general show", async () => {
    await go(personal());
    expect(blocks()).toEqual(["agents", "channels", "people"]);
    const toggles = [...nav().querySelectorAll(".sidebar__section-toggle")].map((b) => b.textContent);
    expect(toggles).toContain("Conversas em grupo");
    expect(toggles).toContain("Mensagens diretas");
    expect(channelRows()).toContain("general");
  });

  test("alone: no people and no #general; the channels show while there is another one", async () => {
    await go(personal({ alone: true }));
    expect(blocks()).toEqual(["agents", "channels"]);
    expect(channelRows()).toEqual(["eng"]);
  });

  test("alone with only #general: no group conversations at all", async () => {
    const state = personal({ alone: true });
    state.channels = state.channels.filter((c) => c.name === "general");
    await go(state, `dm/agent/${ADA_ID}`);
    expect(blocks()).toEqual(["agents"]);
  });

  test("a team's sidebar is as before: the workspace on top, ⌘K under it, me and the bell at the foot", async () => {
    await go(seedState());
    expect(nav().querySelector(".sidebar__end")).toBeNull();
    expect(nav().querySelector(".sidebar__jump")).not.toBeNull();
    expect(nav().querySelector(".sidebar__foot .sidebar__bell")).not.toBeNull();
    expect(blocks()).toEqual(["tools", "channels", "agents", "people"]);
  });
});
