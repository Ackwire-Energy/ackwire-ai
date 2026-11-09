import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * The right hand's first run (ADR 0155 §6): one checklist card under its greeting, for the workspace's owners, each
 * row from the workspace's data, none needing a model.
 */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const click = async (el: Element, rounds = 8) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
/** A new workspace: nobody else, no agent besides Lodi, nothing connected, Lodi with its checklist and an AI. */
const fresh = () => {
  const state = withRightHand(seedState({ agents: [] }), { setup: { role: null, done: [] } });
  state.members = state.members.slice(0, 1);
  state.connections = [];
  state.aiStatus = { any: true, agents: [{ agentId: LODI_ID, state: "ready" }] };
  return state;
};
const openDm = async (state: FakeState) => {
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(12);
  return r;
};
const card = () => document.querySelector(".setup-cl") as HTMLElement;
const rows = () => [...card().querySelectorAll(".setup-row")] as HTMLElement[];
const row = (text: string) => rows().find((r) => r.textContent?.includes(text)) as HTMLElement;

describe("the first-run checklist", () => {
  test("five rows in one order, the next one's button the only primary, nothing posted", async () => {
    const state = fresh();
    await openDm(state);
    expect(card().getAttribute("aria-label")).toBe("Para o time da Acme começar a trabalhar");
    // Each row's name line (a MediaRow's head): the step, and a done one's way to change it after it.
    expect(rows().map((r) => r.querySelector(".ac-mediarow__head")?.textContent)).toEqual([
      "Me conte o que a Acme faz.",
      "Monte o time.",
      "Penso com AutomáticoTrocar",
      "Conecte os apps do trabalho.",
      "Chame quem trabalha com você.",
    ]);
    expect(card().querySelector(".setup-cl__head small")?.textContent).toBe("1 de 5");
    const primary = [...card().querySelectorAll(".setup-row__act button")].filter((b) =>
      b.className.includes("primary"),
    );
    expect(primary.map((b) => b.textContent)).toEqual(["Contar"]);
    // The rows hold the setup: no Connect card, no style question, nothing stored in the chat.
    expect(screen().queryByText("Conectar uma IA para o time")).toBeNull();
    expect(calls(state, "chat.post")).toEqual([]);
  });

  test("what they typed first fills row 1's sentence, and typing resets nothing", async () => {
    const state = fresh();
    const dm = seedDm(state, { type: "agent", id: LODI_ID }, { body: "Vendo pão na padaria do bairro" });
    // Typed by the person, not Lodi.
    for (const m of state.messages) if (m.channelId === dm) m.author = { type: "person", id: "u-walter" };
    await openDm(state);
    expect(card().querySelector(".setup-cl__head small")?.textContent).toBe("1 de 5");
    await click(within(row("Me conte o que a Acme faz.")).getByRole("button", { name: "Contar" }));
    const dialog = screen().getByRole("dialog", { name: "O que a Acme faz?" });
    expect((within(dialog).getByRole("textbox") as HTMLInputElement).value).toBe("Vendo pão na padaria do bairro");
    // Outra coisa asks for the sentence.
    await act(async () => fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "" } }));
    await click(within(dialog).getByRole("button", { name: "Outra coisa" }));
    expect((within(dialog).getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("Agora não on apps is kept, and the row reads done", async () => {
    const state = fresh();
    await openDm(state);
    await click(within(row("Conecte os apps do trabalho.")).getByRole("button", { name: "Agora não" }));
    expect(calls(state, "agents.confirmSetup").map((c) => c.args.slice(1))).toEqual([[LODI_ID, "apps"]]);
    expect(row("Sem apps por enquanto")).toBeTruthy();
  });

  test("row 4 lists the apps to connect with one way out: Fechar, no Cancelar beside it", async () => {
    await openDm(fresh());
    await click(within(row("Conecte os apps do trabalho.")).getByRole("button", { name: "Escolher" }));
    const dialog = screen().getByRole("dialog", { name: "Os apps do trabalho" });
    expect(within(dialog).getAllByRole("button", { name: "Conectar" }).length).toBeGreaterThan(0);
    // The corner X and the footer's Fechar.
    expect(within(dialog).getAllByRole("button", { name: "Fechar" }).length).toBe(2);
    expect(within(dialog).queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  test("complete: Tudo pronto, then how agents talk, and the asks that go to Lodi", async () => {
    const state = withRightHand(seedState(), { setup: { role: null, done: ["apps"] } });
    state.context = "Uma agência de design em Lisboa.";
    state.aiStatus = { any: true, agents: [{ agentId: LODI_ID, state: "ready" }] };
    if (state.me?.organizations[0]) state.me.organizations[0].agentStyle = null;
    await openDm(state);
    expect(card().getAttribute("aria-label")).toBe("Tudo pronto.");
    expect(screen().getByText("Como prefere que eu fale com você?")).toBeTruthy();
    expect(card().textContent).toContain("Agora me peça algo:");
    await click(within(card()).getByRole("button", { name: "Quem do time cuida do quê?" }), 10);
    expect(calls(state, "chat.post").map((c) => (c.args[2] as { body: string }).body)).toEqual([
      "Quem do time cuida do quê?",
    ]);
  });

  test("an invited person sees none of it", async () => {
    const state = fresh();
    const org = state.me?.organizations[0];
    if (org) org.role = "member";
    await openDm(state);
    expect(card()).toBeNull();
  });
});

describe("in a personal workspace (ADR 0158)", () => {
  const personal = () => {
    const state = fresh();
    const org = state.me?.organizations[0];
    if (org) org.mode = "personal";
    return state;
  };

  test("four rows in its words, no people row", async () => {
    await openDm(personal());
    expect(card().getAttribute("aria-label")).toBe("Para os seus agentes começarem");
    expect(rows().map((r) => r.querySelector(".ac-mediarow__head")?.textContent)).toEqual([
      "Me conte um pouco sobre você.",
      "Escolha os seus agentes.",
      "Penso com AutomáticoTrocar",
      "Conecte os seus apps.",
    ]);
    expect(card().querySelector(".setup-cl__head small")?.textContent).toBe("1 de 4");
    expect(screen().getByText("Oi, eu sou o Lodi. Monto os seus agentes com você.")).toBeTruthy();
  });

  test("row 1 asks the areas of life and one sentence, saved as the context; then the agents for them", async () => {
    const state = personal();
    await openDm(state);
    await click(within(row("Me conte um pouco sobre você.")).getByRole("button", { name: "Contar" }));
    const dialog = screen().getByRole("dialog", { name: "Com o que você quer ajuda?" });
    expect((within(dialog).getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
    await click(within(dialog).getByRole("button", { name: "Finanças" }));
    await click(within(dialog).getByRole("button", { name: "Agenda e rotina" }));
    await act(async () =>
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Corro duas vezes por semana." } }),
    );
    await click(within(dialog).getByRole("button", { name: "Salvar" }), 12);
    expect(calls(state, "orgs.updateSettings").map((c) => c.args[1])).toEqual([
      { context: "Quero ajuda com: Agenda e rotina, Finanças. Corro duas vezes por semana." },
    ]);
    expect(screen().getByRole("dialog", { name: "Os seus agentes" })).toBeTruthy();
  });
});
