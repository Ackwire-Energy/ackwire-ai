import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Missões (Threads.html)", () => {
  test("the sidebar item opens the Threads page on the Missões tab; empty: a designed state", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/threads?tab=missions`, { api: createFakeApi() });
    await settle();
    expect(router.state.location.search).toEqual({ tab: "missions" });
    expect(screen().getByRole("heading", { level: 1, name: "Missões" })).toBeTruthy();
    expect(screen().getByText("Nenhuma missão ainda")).toBeTruthy();
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(within(nav).getByRole("link", { name: /Missões/ })).toBeTruthy();
  });

  test("a mission's card: title, agent, state, the plan as items, the computer, Abrir thread", async () => {
    const api = createFakeApi(seedState());
    await api.missions.create(ORG_ID, { agentId: ADA_ID, goal: "Construir o app mobile", channelId: ENG_ID });
    await renderApp(`/org/${ORG_ID}/threads?tab=missions`, { api });
    await settle(6);
    const card = screen().getByRole("article", { name: /Missão Construir o app mobile/ });
    expect(within(card).getByText("Plano proposto")).toBeTruthy();
    // No plan yet (the executor is still exploring): no "0 de 0" count.
    expect(within(card).getByText("Sem itens ainda")).toBeTruthy();
    expect(within(card).getAllByText(/MacBook/).length).toBeGreaterThan(0);
    expect(within(card).getAllByRole("button", { name: /Abrir thread/ }).length).toBeGreaterThan(0);
  });
});
