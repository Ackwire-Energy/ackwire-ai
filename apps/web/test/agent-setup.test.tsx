import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** A new agent's setup checklist (ADR 0155 §2): the top of its DM, in its voice, for whoever sets it up. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const withSetup = (state: FakeState, done: ("ai" | "apps" | "where" | "who" | "how")[] = []) => {
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.setup = { role: "dev", done };
  return state;
};
const openDm = async (state: FakeState) => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
  await settle(8);
};
const card = () => document.body.querySelector<HTMLElement>(".setup-cl");
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("the setup checklist in a new agent's DM", () => {
  test("its greeting and the five steps; a step its data already says is done shows done", async () => {
    const state = withSetup(seedState());
    await openDm(state);
    const c = card();
    expect(c).toBeTruthy();
    expect(document.body.textContent).toContain("Pra eu começar, me ajuda com estas coisas rápidas:");
    expect(c?.querySelectorAll(".setup-row")).toHaveLength(5);
    // It thinks already (the AI status says ready) and it is in #eng: two done.
    expect(c?.querySelectorAll(".setup-row[data-done]")).toHaveLength(2);
    expect(c?.textContent).toContain("Já tenho uma IA para pensar");
    expect(c?.textContent).toContain("2 de 5");
  });

  test("a step's button opens its dialog; saving confirms the step", async () => {
    const state = withSetup(seedState());
    await openDm(state);
    const who = [...(card()?.querySelectorAll<HTMLElement>(".setup-row") ?? [])].find((r) =>
      r.textContent?.includes("Falar com todos da Acme"),
    );
    expect(who).toBeTruthy();
    await click(within(who as HTMLElement).getByRole("button", { name: "Escolher" }));
    const dialog = screen().getByRole("dialog");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(state.calls).toContainEqual({ method: "agents.confirmSetup", args: [ORG_ID, ADA_ID, "who"] });
    // The workspace with the article the app gives it everywhere ("da Acme", as "o time da Acme").
    expect(card()?.textContent).toContain("Falo com todos da Acme");
  });

  test("with nothing left, its greeting asks for no help over a card that is all done", async () => {
    const state = withSetup(seedState(), ["apps", "who", "how"]);
    await openDm(state);
    expect(card()?.textContent).toContain("5 de 5");
    expect(document.body.textContent).not.toContain("Pra eu começar");
  });

  test("an agent made before the checklist shows none: its empty conversation as before", async () => {
    const state = seedState();
    await openDm(state);
    expect(card()).toBeNull();
  });
});

describe("a template agent's greeting", () => {
  test("in its own role, never 'Você me pediu', and never a doubled period", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.setup = { role: null, done: [] };
      ada.role = "Atendimento";
      ada.instructions = "Responde os clientes no WhatsApp.";
    }
    await openDm(state);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Você me pediu");
    expect(text).toContain("a nova de atendimento");
  });

  test("an agent with no role says back what it was asked, closing its sentence once", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.setup = { role: null, done: [] };
      ada.role = "";
      ada.instructions = "Responde os clientes no WhatsApp.";
    }
    await openDm(state);
    expect(document.body.textContent).toContain("Você me pediu: “Responde os clientes no WhatsApp”.");
    expect(document.body.textContent).not.toContain(".”.");
  });

  test("apps skipped on the right hand's card stay skipped for the team's agents", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.setup = { role: "dev", done: [] };
    if (ada)
      state.agents.push({
        ...ada,
        id: "lodi-x",
        name: "Lodi",
        handle: "lodi",
        builtin: "right_hand",
        setup: { role: null, done: ["apps"] },
      });
    await openDm(state);
    expect(card()?.textContent).toContain("Sem apps por enquanto");
  });
});
