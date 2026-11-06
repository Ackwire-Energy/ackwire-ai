import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** Acme with its right hand and nothing else made yet; `permissions`: mine, as a plain member. */
function fresh(permissions?: string[]) {
  const state = seedState();
  withRightHand(state, { ownerUserId: "u-walter" });
  state.connections = [];
  if (permissions) Object.assign(state.me?.organizations[0] ?? {}, { role: "member", permissions });
  return state;
}
const go = async (state: FakeState, path: string) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state, { seed: false }) });
  await settle(8);
  return r;
};
const empty = () => document.querySelector(".ac-empty") as HTMLElement;
const title = () => empty().querySelector(".ac-empty__title")?.textContent;
const buttons = () => within(empty()).queryAllByRole("button");

describe("first use: what the place gives, and the one next step", () => {
  test("Tarefas: the agent, one Nova tarefa, and Lodi with the ask already written", async () => {
    const { router } = await go(fresh(), "issues");
    expect(empty().querySelector(".ac-empty__agent canvas")).not.toBeNull();
    expect(title()).toBe("Dê dono e prazo ao trabalho");
    expect(screen().getAllByRole("button", { name: "Nova tarefa" })).toHaveLength(1);
    await click(within(empty()).getByRole("button", { name: "Peça ao Lodi" }));
    expect(router.state.location.pathname).toContain("/dm/agent/");
    expect(document.body.textContent).toContain("Me ajuda a criar as primeiras tarefas do time.");
  });
});

describe("who can't act gets an honest line and no button that fails", () => {
  test("Tarefas without post", async () => {
    await go(fresh(["read", "talk_to_agents"]), "issues");
    expect(title()).toBe("Veja quem faz o quê");
    expect(buttons()).toEqual([]);
    expect(screen().queryByRole("button", { name: "Nova tarefa" })).toBeNull();
  });

  test("Peça ao Lodi goes with talk_to_agents, the task stays", async () => {
    await go(fresh(["read", "post"]), "issues");
    expect(buttons().map((b) => b.textContent)).toEqual(["Nova tarefa"]);
  });

  test("Rotinas: an agent's owner may, who has no agent and no manage_routines may not", async () => {
    const owner = fresh(["read"]);
    for (const a of owner.agents) a.ownerUserId = owner.me?.user.id ?? null;
    await go(owner, "routines");
    expect(title()).toBe("Deixe o trabalho repetido com os agentes");
    cleanup();
    const other = fresh(["read"]);
    for (const a of other.agents) a.ownerUserId = "u-joao";
    await go(other, "routines");
    expect(title()).toBe("Veja o que roda sozinho");
    expect(screen().queryByRole("button", { name: "Nova rotina" })).toBeNull();
  });

  test("Drive without upload_files", async () => {
    await go(fresh(["read"]), "drive");
    expect(empty().textContent).toContain("O que agentes e pessoas fazem nas conversas fica guardado aqui.");
    expect(screen().queryByRole("button", { name: "Enviar arquivo" })).toBeNull();
  });

  test("Conectores without manage_connectors", async () => {
    await go(fresh(["read"]), "settings/connectors");
    expect(title()).toBe("Veja o que os agentes podem usar");
    expect(buttons()).toEqual([]);
  });

  test("an agent that doesn't answer me: its files say what they are, with nothing to ask", async () => {
    const state = fresh(["read", "talk_to_agents", "manage_agents"]);
    for (const a of state.agents) if (a.id === ADA_ID) a.audience = { mode: "owner", userIds: [], roleIds: [] };
    await go(state, `agents/${ADA_ID}?tab=files`);
    expect(title()).toBeUndefined();
    expect(empty().textContent).toContain("Tudo o que Ada entregar numa conversa fica guardado aqui.");
    expect(buttons()).toEqual([]);
  });
});

describe("no results: no agent, a line and the way out", () => {
  test("Tarefas with a filter that hides every task", async () => {
    const api = createFakeApi(fresh(), { seed: false });
    await api.issues.create(ORG_ID, { title: "Fechar o mês" });
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    const search = screen().getByRole("searchbox", { name: /Buscar/ });
    await act(async () => fireEvent.change(search, { target: { value: "xyzzy" } }));
    await settle(6);
    expect(empty().querySelector(".ac-empty__agent")).toBeNull();
    await click(within(empty()).getByRole("button", { name: "Limpar filtros" }));
    expect((search as HTMLInputElement).value).toBe("");
  });
});

describe("all clear: a calm win, nothing to do", () => {
  test("Aprovações with nothing waiting", async () => {
    const state = fresh();
    state.approvals = [];
    await go(state, "approvals");
    expect(title()).toBe("Tudo decidido");
    expect(empty().querySelector(".ac-empty__agent canvas")).not.toBeNull();
    expect(buttons()).toEqual([]);
  });
});
