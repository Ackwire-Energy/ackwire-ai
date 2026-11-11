import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { connectRequest } from "@/pages/onboarding/AiStep";
import { createFakeApi, type FakeState, GENERAL_ID, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * The onboarding's last step, Connect an AI (ADR 0162): on the rail once the team is made, answered by the data
 * (every agent thinking), left with Connect later, and never after a plan left for later. Wherever it ends, the
 * workspace opens on the beta notice alone (`?arrival=beta`, ADR 0160).
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
});

const CONNECT = "Conecte uma IA para o seu time pensar";
const BETA = "Você chegou cedo. Que bom.";

const button = (name: string | RegExp) => screen().getByRole("button", { name });
const click = async (el: Element, rounds = 10) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
const heading = () => document.querySelector(".onb__title")?.textContent;
const eyebrow = () => document.querySelector(".onb__eyebrow")?.textContent;
const body = () => document.querySelector(".onb__body") as HTMLElement;

type Router = Awaited<ReturnType<typeof renderApp>>["router"];
/** The `arrival` asked for by each navigation from now on (the arrival drops it from the address as it opens). */
const arrivals = (router: Router) => {
  const seen: unknown[] = [];
  router.subscribe("onBeforeNavigate", (e) => {
    seen.push((e.toLocation.search as { arrival?: unknown }).arrival);
  });
  return seen;
};

/**
 * Acme being set up, its name and what it does saved and its team made, none of its agents with an AI yet;
 * `held`: agentes.chat Cloud, waiting for its first plan.
 */
const madeTeam = (opts: { held?: boolean } = {}) => {
  const state = withRightHand(seedState());
  if (state.me)
    state.me.organizations = [
      {
        id: ORG_ID,
        name: "Acme",
        role: "owner",
        onboarding: { step: "context", generalChannelId: GENERAL_ID },
        ...(opts.held ? { standing: { state: "hold" as const, reason: "payment" } } : {}),
      },
    ];
  state.context = "Loja online";
  state.aiStatus = {
    any: false,
    agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai", reason: "no_key" })),
  };
  if (opts.held) state.authConfig = { billingUrl: "https://billing.example.com" };
  return state;
};
/** Every agent thinks now (a key or a plan connected, here or in another tab), and the page reads it again. */
const allThink = async (state: FakeState, services: Awaited<ReturnType<typeof renderApp>>["services"]) => {
  state.aiStatus = { any: true, agents: state.agents.map((a) => ({ agentId: a.id, state: "ready" })) };
  await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
  await settle(10);
};
/** Wide enough for the column beside the step. */
const wide = () => {
  const native = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(min-width: 1200px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = native;
  };
};

describe("Connect an AI, the rail's last step", () => {
  test("the team made with no AI: the step, its choices as cards, and what leaving it means", async () => {
    const state = madeTeam();
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    expect(eyebrow()).toBe("Passo 4 de 4");
    expect(heading()).toBe(CONNECT);
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Conectar uma IA");
    for (const name of ["Claude", "ChatGPT", "Outro plano", "Chave de API", "Começar grátis"])
      expect(within(body()).getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    expect(body().textContent).toContain("Sem uma IA, os agentes não respondem.");
    // Nothing is finished while the step waits.
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
  });

  test("a pick opens the Connect dialog over the step, the step still under it", async () => {
    const state = madeTeam();
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    await click(within(body()).getByRole("button", { name: /^Chave de API/ }), 12);
    expect(screen().getByRole("dialog", { name: /^Conectar uma IA/ })).toBeTruthy();
    expect(heading()).toBe(CONNECT);
  });

  test("Connect later finishes it and opens #general on the beta notice alone", async () => {
    const state = madeTeam();
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    const asked = arrivals(router);
    await click(button("Conectar depois"), 16);
    await settle(8);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { finished: true }]]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(asked).toContain("beta");
    const beta = screen().getByRole("dialog", { name: BETA });
    await click(within(beta).getByRole("button", { name: /Continuar/ }), 8);
    expect(screen().queryByRole("dialog", { name: BETA })).toBeNull();
    expect(screen().queryByRole("dialog", { name: CONNECT })).toBeNull();
    expect(screen().queryByRole("dialog", { name: /^Conectar uma IA/ })).toBeNull();
  });

  test("once every agent thinks: the connected screen, the team awake, then Go to the workspace", async () => {
    const restore = wide();
    try {
      const state = madeTeam();
      const { router, services } = await renderApp("/onboarding", { api: createFakeApi(state) });
      await settle(16);
      const stage = () => document.querySelector(".onb-stage") as HTMLElement;
      expect(stage().textContent).toContain("O seu time está pronto");
      await allThink(state, services);
      // It stays on the step to say so, rather than opening the workspace by itself.
      expect(router.state.location.pathname).toBe("/onboarding");
      expect(heading()).toBe("Pronto. O time da Acme já pensa.");
      expect(document.querySelector(".onb__progress-text")?.textContent).toContain("Tudo certo");
      expect(stage().textContent).toContain("O seu time acordou");
      expect(stage().textContent).toContain("já respondem");
      expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
      const asked = arrivals(router);
      await click(button("Entrar no workspace"), 16);
      expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { finished: true }]]);
      expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
      expect(asked).toContain("beta");
    } finally {
      restore();
    }
  });

  test("the AI picked is named once the team thinks, unless a key connected some other way meanwhile", async () => {
    const lead = () => document.querySelector(".onb__lead")?.textContent;
    for (const keyCame of [false, true]) {
      const state = madeTeam();
      const { services } = await renderApp("/onboarding", { api: createFakeApi(state) });
      await settle(16);
      await click(within(body()).getByRole("button", { name: /^Claude/ }), 12);
      // The plan signed in from that dialog; or the dialog was closed, and a key connected in another tab.
      state.aiStatus = {
        any: true,
        ...(keyCame ? { apiKey: true } : {}),
        agents: state.agents.map((a) => ({ agentId: a.id, state: "ready" })),
      };
      await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
      await settle(10);
      expect(lead()).toBe(
        keyCame
          ? "A IA que você conectou responde por todos os agentes. Dá para trocar depois, um por um."
          : "O seu Claude responde por todos os agentes. Dá para trocar depois, um por um.",
      );
      cleanup();
    }
  });

  test("on agentes.chat Cloud, a plan left for later skips the step: Lodi's DM, the beta notice alone", async () => {
    const state = madeTeam({ held: true });
    // The billing service's plan list can't be read: the plan step names a plan generically.
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    expect(heading()).toBe("Ligue o time");
    expect(eyebrow()).toBe("Passo 4 de 5");
    const asked = arrivals(router);
    await click(button(/^Ligar depois/), 16);
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
    expect(asked).toContain("beta");
    await click(within(screen().getByRole("dialog", { name: BETA })).getByRole("button", { name: /Continuar/ }), 8);
    expect(screen().queryByRole("dialog", { name: CONNECT })).toBeNull();
  });
});

describe("a personal workspace (ADR 0159)", () => {
  test("its own words, never a team's: its agents beside the question, its right hand by name on the sky", async () => {
    const restore = wide();
    try {
      // Being set up, the team's question next, its right hand alone and with no AI yet.
      const state = withRightHand(seedState({ agents: [] }));
      if (state.me)
        state.me.organizations = [
          {
            id: ORG_ID,
            name: "Pessoal",
            role: "owner",
            mode: "personal",
            onboarding: { step: "context", generalChannelId: GENERAL_ID },
          },
        ];
      state.aiStatus = {
        any: false,
        agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai", reason: "no_key" })),
      };
      const { services } = await renderApp("/onboarding", { api: createFakeApi(state) });
      await settle(16);
      expect(document.querySelector(".onb-preview__ghost")?.textContent).toBe("Os seus agentes aparecem aqui");
      await click(screen().getByRole("radio", { name: /Ainda não uso nenhum/ }), 4);
      await click(button("Seguir sem agentes"), 16);
      expect(heading()).toBe("Conecte uma IA para os seus agentes pensarem");
      const stage = () => document.querySelector(".onb-stage")?.textContent ?? "";
      expect(stage()).toContain("O Lodi está pronto");
      expect(stage()).toContain("Só falta uma IA para acordar.");
      expect(stage()).not.toContain("time");
      await allThink(state, services);
      expect(stage()).toContain("O Lodi acordou");
      expect(stage()).not.toContain("time");
    } finally {
      restore();
    }
  });
});

describe("what a pick opens", () => {
  test("for the team, Connect for the whole team on the card picked; for the right hand alone, its own dialog", () => {
    const team = [LODI_ID, "ada", "atlas"];
    for (const start of ["claude", "chatgpt", "key", "cursor"] as const)
      expect(connectRequest(start, team)).toEqual({ agentIds: team, start });
    expect(connectRequest("claude", [LODI_ID])).toEqual({ agentId: LODI_ID, intent: "claude" });
    expect(connectRequest("key", [LODI_ID])).toEqual({ agentId: LODI_ID, intent: "api_key" });
    expect(connectRequest("zen", [LODI_ID])).toEqual({ agentId: LODI_ID, plan: "zen" });
  });
});

/** The narrow dialog under the sky: Connect for the whole team (ADR 0160, addendum). */
const inBand = (dialog: HTMLElement) => dialog.querySelector(".arrival-hero") !== null;

/** `madeTeam`, its team the person's own (a plan signs in only for its owner's agents, ADR 0059 §3). */
const ownTeam = () => {
  const state = madeTeam();
  for (const a of state.agents) a.ownerUserId = "u-walter";
  return state;
};

describe("each card opens Connect for the whole team on its own steps (ADR 0162)", () => {
  for (const [card, title] of [
    ["Claude", "Seu plano do Claude"],
    ["ChatGPT", "Seu plano do ChatGPT"],
    ["Cursor", "Seu plano do Cursor"],
    ["Chave de API", "Adicionar uma chave de API"],
  ] as const) {
    test(`${card}: straight to its steps in the team's dialog, never the plain one nor the team's first screen`, async () => {
      const state = ownTeam();
      await renderApp("/onboarding", { api: createFakeApi(state) });
      await settle(16);
      const cardOf = () => within(body()).queryByRole("button", { name: new RegExp(`^${card}`) });
      if (!cardOf()) await click(within(body()).getByRole("button", { name: /^Outro plano/ }), 4);
      await click(cardOf() as HTMLElement, 12);
      const dialog = screen().getByRole("dialog", { name: title });
      expect(inBand(dialog)).toBe(true);
      // On the steps: the way back to the choices, and no list of whom it is for.
      expect(within(dialog).getByRole("button", { name: "Voltar" })).toBeTruthy();
      expect(dialog.querySelector(".arrival-forline")).toBeNull();
      expect(dialog.querySelector(".ai-picker")).toBeNull();
      if (card !== "Chave de API") expect(within(dialog).getByRole("region", { name: title })).toBeTruthy();
    });
  }

  test("the right hand alone: its own plain dialog", async () => {
    // Every other agent someone else's: only the right hand is the person's to wake.
    const state = madeTeam();
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    await click(within(body()).getByRole("button", { name: /^Claude/ }), 12);
    const dialog = screen().getByRole("dialog");
    expect(inBand(dialog)).toBe(false);
    expect(dialog.querySelector(".ai-picker")).toBeTruthy();
  });

  test("connected while the dialog is open: the step moves on by the data", async () => {
    const state = ownTeam();
    const { services } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    await click(within(body()).getByRole("button", { name: /^Claude/ }), 12);
    expect(screen().getByRole("dialog", { name: "Seu plano do Claude" })).toBeTruthy();
    await allThink(state, services);
    expect(heading()).toBe("Pronto. O time da Acme já pensa.");
  });
});
