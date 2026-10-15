import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("route guards", () => {
  test("signed out: / shows the landing page", async () => {
    const { router } = await renderApp("/", { api: createFakeApi(seedState({ me: null })) });
    expect(router.state.location.pathname).toBe("/");
    expect(screen().getByRole("heading", { level: 1, name: /na mesma conversa/ })).toBeTruthy();
  });

  test("signed in without organizations: / goes to onboarding", async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    const { router } = await renderApp("/", { api: createFakeApi(state) });
    expect(router.state.location.pathname).toBe("/onboarding");
    expect(screen().getByRole("heading", { name: "Crie o espaço do seu time" })).toBeTruthy();
  });

  test("signed in: / → the organization → #general", async () => {
    const { router } = await renderApp("/", { api: createFakeApi() });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(screen().getByRole("heading", { name: "# general" })).toBeTruthy();
    expect(screen().getByRole("navigation", { name: "Navegação do workspace" })).toBeTruthy();
  });

  test("/login when already signed in goes to the redirect target", async () => {
    const { router } = await renderApp(`/login?redirect=/org/${ORG_ID}/members`, { api: createFakeApi() });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/members`);
  });

  test("open redirects are dropped", async () => {
    const { router } = await renderApp("/login?redirect=//evil.example", {
      api: createFakeApi(seedState({ me: null })),
    });
    expect(router.state.location.search).toEqual({});
  });

  test("an organization you're not in shows a designed state, not a crash", async () => {
    await renderApp("/org/someone-else/members", { api: createFakeApi() });
    expect(screen().getByRole("heading", { name: "Você não faz parte desta organização" })).toBeTruthy();
  });

  test("linked-only screens render designed empty states", async () => {
    for (const [path, title] of [["threads/x", "Threads"]] as const) {
      await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi() });
      await settle();
      expect(screen().getByRole("heading", { level: 1, name: title })).toBeTruthy();
      expect(screen().getByText("Em breve")).toBeTruthy();
      cleanup();
    }
  });

  test("unknown paths show the not-found page", async () => {
    await renderApp("/nada/aqui", { api: createFakeApi() });
    expect(screen().getByRole("heading", { name: "Página não encontrada" })).toBeTruthy();
  });

  test("the sidebar lists channels, agents, DMs and the pending approvals count", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi() });
    await settle();
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(nav.textContent).toContain("Acme");
    expect(nav.textContent).toContain("2 membros · 2 agentes");
    expect(screen().getByLabelText("2 aprovações pendentes").textContent).toBe("2");
    for (const name of ["eng", "general", "Ada", "Atlas", "João", "Criar agente"]) {
      expect(nav.textContent).toContain(name);
    }
    expect(nav.textContent).toContain("US$ 15,40 este mês");
  });
});
