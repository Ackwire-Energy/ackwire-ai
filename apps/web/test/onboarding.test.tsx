import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, DirectMessage, TeamTemplate } from "@agenteschat/client";
import { ApiError, keys } from "@agenteschat/client";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import { focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ATLAS_ID,
  createFakeApi,
  type FakeState,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle, showIn } from "./render";

/*
 * The onboarding (ADR 0162): what the workspace is for first (ADR 0159), then, for a company or team, the blue rail
 * with Lodi, its steps read from the workspace's own data, the plan only where the workspace waits for its first one,
 * and where the workspace opens after it.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
  focusManager.setFocused(undefined);
});

const button = (name: string | RegExp) => screen().getByRole("button", { name });
const answer = (name: RegExp) => screen().getByRole("radio", { name });
const click = async (el: Element, rounds = 10) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
/** The first question answered for a company or team: its name comes next. */
const forATeam = async () => {
  await click(answer(/Para minha empresa ou time/), 4);
  await click(button("Continuar"), 4);
};
const type = async (label: string, value: string) => {
  await act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
const heading = () => document.querySelector(".onb__title")?.textContent;
const eyebrow = () => document.querySelector(".onb__eyebrow")?.textContent;
/** The plan step's card: its button shares the rail step's name, "Ligar o time". */
const planCard = () => document.querySelector(".onb__plan") as HTMLElement;
const GREETING = "Oi, eu sou o Lodi. Monto o time com você.";
/** A new workspace's zone and the person's own in it: this browser's, sent with the workspace. */
const zones = () => {
  const zone = browserTimezone();
  return { timezone: zone ?? "UTC", ...(zone ? { memberTimezone: zone } : {}) };
};

const draft = (name: string, handle: string, role: string, channel: string) => ({
  name,
  handle,
  role,
  line: `${name} cuida de ${role.toLowerCase()}.`,
  instructions: role,
  appearance: null,
  channel,
  routines: [],
  firstTask: null,
});
const TEMPLATES: TeamTemplate[] = [
  {
    id: "store",
    name: "Loja online",
    sub: "Pedidos, estoque e redes sociais",
    description: "Para uma loja que vende online.",
    team: {
      lead: "Um time para a loja.",
      agents: [
        draft("Iara", "iara", "Atendimento", "atendimento"),
        draft("Otto", "otto", "Pedidos", "pedidos"),
        draft("Lia", "lia", "Conteúdo", "conteudo"),
      ],
      newChannels: ["atendimento", "pedidos", "conteudo"],
      skills: [],
      weekly: null,
      approvals: "O que sai para os clientes espera a sua aprovação.",
      invite: [],
    },
  },
  {
    id: "clinic",
    name: "Clínica ou consultório",
    sub: "Agenda no WhatsApp",
    description: "Para uma clínica.",
    team: {
      lead: "Um time para a clínica.",
      agents: [draft("Nina", "nina", "Agenda", "agenda")],
      newChannels: ["agenda"],
      skills: [],
      weekly: null,
      approvals: "",
      invite: [],
    },
  },
];

/** Someone signed up with no workspace yet; `cloud`: the server bills, and a new workspace waits for its plan. */
const newcomer = (cloud: boolean) => {
  const state = seedState({ agents: [] });
  if (state.me) state.me.organizations = [];
  state.teamTemplates = TEMPLATES;
  if (cloud) {
    state.authConfig = { billingUrl: "https://billing.example.com" };
    state.newWorkspaceStanding = { state: "hold", reason: "payment" };
  }
  return state;
};
/** One being set up already, at whatever its data says. */
const settingUp = (opts: { held?: boolean; context?: string; team?: boolean } = {}) => {
  const state = withRightHand(seedState(opts.team ? {} : { agents: [] }));
  if (state.me)
    state.me.organizations = [
      {
        id: ORG_ID,
        name: "Ateliê Couto",
        role: "owner",
        onboarding: { step: "context", generalChannelId: GENERAL_ID },
        ...(opts.held ? { standing: { state: "hold" as const, reason: "payment" } } : {}),
      },
    ];
  if (opts.context) state.context = opts.context;
  state.teamTemplates = TEMPLATES;
  if (opts.held) state.authConfig = { billingUrl: "https://billing.example.com" };
  return state;
};
/** The billing service's public plan list; `null`: it can't be read. */
const plans = (list: unknown | null) => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return list === null
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return asked;
};
const PLANS = {
  recommended: "team",
  plans: [
    { key: "personal", name: "Pessoal", price: "$29", period: "month" },
    { key: "team", name: "Equipe", price: "$49", period: "month" },
  ],
};

/** Steps 1 to 3 as a person goes through them: the name, "Loja online", the store's team made. */
async function throughTheTeam(state: FakeState) {
  const r = await renderApp("/onboarding", { api: createFakeApi(state) });
  await settle(10);
  await forATeam();
  await type("Nome", "Ateliê Couto");
  await click(button("Continuar"), 14);
  await click(button("Loja online"), 4);
  await click(button("Continuar"), 14);
  await click(button("Criar o time"), 16);
  return r;
}

describe("the steps", () => {
  test("the name creates the workspace and goes on, nothing finished; what it does is its context", async () => {
    const state = newcomer(false);
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    expect(document.querySelector(".onb__say")?.textContent).toContain("Eu sou o Lodi.");
    await forATeam();
    expect(eyebrow()).toBe("Passo 1 de 3");
    await type("Nome", "Ateliê Couto");
    await click(button("Continuar"), 14);
    expect(calls(state, "orgs.create")[0]?.args[0]).toEqual({ name: "Ateliê Couto", ...zones() });
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
    expect(heading()).toBe("O que a Ateliê Couto faz?");
    expect(eyebrow()).toBe("Passo 2 de 3");
    // A type alone is enough; its words are the context.
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    await click(button("Loja online"), 4);
    await click(button("Continuar"), 14);
    const orgId = state.me?.organizations[0]?.id;
    expect(calls(state, "orgs.updateSettings").at(-1)?.args).toEqual([orgId, { context: "Loja online" }]);
    expect(heading()).toBe("Seu time");
    // The store's team, picked for its business.
    expect(document.querySelector(".tp-agents")?.textContent).toContain("Otto");
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Loja online");
  });

  test("a type and a sentence are saved together: going back, or coming back later, finds both", async () => {
    const state = newcomer(false);
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    await forATeam();
    await type("Nome", "Ateliê Couto");
    await click(button("Continuar"), 14);
    await click(button("Clínica ou consultório"), 4);
    await type("Em uma frase", "Atendemos com hora marcada");
    await click(button("Continuar"), 14);
    const orgId = state.me?.organizations[0]?.id;
    const context = "Clínica ou consultório · Atendemos com hora marcada";
    expect(calls(state, "orgs.updateSettings").at(-1)?.args).toEqual([orgId, { context }]);
    // Back on step 2: the type still picked, the sentence still there, and Continuar keeps both.
    await click(document.querySelectorAll(".onb__step")[1] as HTMLElement, 8);
    expect(button("Clínica ou consultório").getAttribute("aria-pressed")).toBe("true");
    expect((screen().getByLabelText("Em uma frase") as HTMLTextAreaElement).value).toBe("Atendemos com hora marcada");
    await click(button("Continuar"), 14);
    expect(calls(state, "orgs.updateSettings").at(-1)?.args).toEqual([orgId, { context }]);
    cleanup();
    // Another visit (a reload, the phone): the team step starts on the clinic's template, not the first one.
    await renderApp("/onboarding", { api: createFakeApi(settingUp({ context })) });
    await settle(14);
    expect(heading()).toBe("Seu time");
    expect(document.querySelector(".tp-agents")?.textContent).toContain("Nina");
  });

  test("a template picked stays picked, until step 2 names another business: then that business's template", async () => {
    const state = settingUp({ context: "Roupas sob medida para noivas" });
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    const team = () => document.querySelector(".tp-agents")?.textContent;
    expect(team()).toContain("Otto");
    await pick(screen().getByRole("combobox", { name: "Modelos de time" }), "Clínica ou consultório");
    expect(team()).toContain("Nina");
    const backToStep2 = () => click(document.querySelectorAll(".onb__step")[1] as HTMLElement, 8);
    await backToStep2();
    await click(button("Continuar"), 14);
    expect(team()).toContain("Nina");
    await backToStep2();
    await click(button("Loja online"), 4);
    await click(button("Continuar"), 14);
    expect(team()).toContain("Otto");
  });

  test("Outra coisa asks for the sentence", async () => {
    const state = settingUp();
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(12);
    expect(heading()).toBe("O que a Ateliê Couto faz?");
    await click(button("Outra coisa"), 4);
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    await type("Em uma frase", "Roupas sob medida para noivas");
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(false);
  });

  test("self-hosted (no plans): three steps, Criar o time opens #general", async () => {
    const state = newcomer(false);
    const { router } = await throughTheTeam(state);
    const orgId = state.me?.organizations[0]?.id;
    expect(calls(state, "agents.applyTeamTemplate").map((c) => c.args[1])).toEqual(["store"]);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[orgId, { finished: true }]]);
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${orgId}/c/`));
    // Never a price, a plan or a billing call.
    expect(calls(state, "orgs.billingLink")).toEqual([]);
  });

  test("a step of the template that fails says why, and the same button tries again", async () => {
    const state = settingUp({ context: "Loja online" });
    const api = createFakeApi(state);
    api.agents.applyTeamTemplate = async () => ({
      channelId: "dm",
      messageId: "m",
      state: "pending",
      error: { step: "channel", reason: "taken", target: "pedidos" } as never,
    });
    await renderApp("/onboarding", { api });
    await settle(12);
    await click(button("Criar o time"), 12);
    expect(document.querySelector(".onb__actions [role='alert']")).not.toBeNull();
    expect(button("Tentar de novo")).toBeTruthy();
  });

  test("beside the question: a workspace named neutrally until typed, every agent counted, one team order", async () => {
    const native = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(min-width: 1200px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      plans(PLANS);
      await renderApp("/onboarding", { api: createFakeApi(newcomer(true)) });
      await settle(10);
      const preview = () => document.querySelector(".onb-preview") as HTMLElement;
      const name = () => preview().querySelector(".sidebar__org-name")?.textContent;
      const meta = () => preview().querySelector(".sidebar__org-meta")?.textContent;
      const agents = () =>
        [...(preview().querySelectorAll(".sidebar__section")[1]?.querySelectorAll(".sidebar__item-label") ?? [])].map(
          (e) => e.textContent,
        );
      // Never the field's example ("Ex.: Acme"), and Lodi, listed under Agentes, is counted there.
      expect(name()).toBe("Seu workspace");
      expect(meta()).toBe("1 membro · 1 agente");
      await forATeam();
      await type("Nome", "Ateliê Couto");
      expect(name()).toBe("Ateliê Couto");
      await click(button("Continuar"), 14);
      await click(button("Loja online"), 4);
      await click(button("Continuar"), 14);
      // The template's order, the one step 3 lists, before and after the team is made.
      expect(
        [...document.querySelectorAll(".onb__body .tp-agent .ac-mediarow__head b")].map((b) => b.textContent),
      ).toEqual(["Iara", "Otto", "Lia"]);
      expect(agents()).toEqual(["Lodi", "Iara", "Otto", "Lia"]);
      expect(meta()).toBe("1 membro · 4 agentes");
      await click(button("Criar o time"), 16);
      expect(agents()).toEqual(["Lodi", "Iara", "Otto", "Lia"]);
      expect([...planCard().querySelectorAll(".onb__plan-week b")].map((b) => b.textContent)).toEqual([
        "Iara",
        "Otto",
        "Lia",
      ]);
      expect(document.querySelector(".onb__steps")?.textContent).toContain("Iara, Otto e Lia");
    } finally {
      window.matchMedia = native;
    }
  });
});

describe("the plan step (agentes.chat Cloud)", () => {
  test("the team asleep, the plan with its price from the billing service, the link to that plan's Checkout", async () => {
    const state = newcomer(true);
    const asked = plans(PLANS);
    await throughTheTeam(state);
    expect(eyebrow()).toBe("Passo 4 de 4");
    expect(heading()).toBe("Ligue o time");
    const card = document.querySelector(".onb__plan") as HTMLElement;
    expect(card.textContent).toContain("Plano Equipe · $49 por mês");
    expect(card.querySelectorAll(".onb__plan-face")).toHaveLength(3);
    expect(asked[0]).toBe("https://billing.example.com/plans.json?locale=pt-BR");
    // Nothing is finished while it waits for the plan.
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
    const orgId = state.me?.organizations[0]?.id;
    await click(within(planCard()).getByRole("button", { name: "Ligar o time" }), 6);
    expect(calls(state, "orgs.billingLink").map((c) => c.args)).toEqual([[orgId, "onboarding", "team"]]);
    await click(button("Ver todos os planos"), 6);
    expect(calls(state, "orgs.billingLink").at(-1)?.args).toEqual([orgId, "onboarding"]);
  });

  test("back at the plan step from the billing page: it opens whole, its price there from its first frame", async () => {
    const state = settingUp({ context: "Loja online", team: true, held: true });
    let answer: (r: Response) => void = () => {};
    globalThis.fetch = (() =>
      new Promise<Response>((done) => {
        answer = done;
      })) as unknown as typeof fetch;
    await renderApp(`/org/${ORG_ID}/onboarding`, { api: createFakeApi(state) });
    await settle(14);
    // The billing service's plan list still on its way: no step yet, rather than one whose price line would change.
    expect(planCard()).toBeNull();
    const list = new Response(JSON.stringify(PLANS), { status: 200, headers: { "content-type": "application/json" } });
    await act(async () => answer(list));
    await settle(10);
    expect(document.querySelector(".onb__plan-price")?.textContent).toContain("Plano Equipe · $49 por mês");
  });

  test("with no plan data, the plan is named generically and both ways open the billing page", async () => {
    const state = newcomer(true);
    plans(null);
    await throughTheTeam(state);
    expect(document.querySelector(".onb__plan-price")?.textContent).toContain("Um plano do agentes.chat");
    expect(screen().queryByRole("button", { name: "Ver todos os planos" })).toBeNull();
    await click(within(planCard()).getByRole("button", { name: "Ligar o time" }), 6);
    expect(calls(state, "orgs.billingLink").map((c) => c.args.length)).toEqual([2]);
  });

  test("Entrar no workspace sem ligar finishes it and opens Lodi's DM, where the banner keeps the plan", async () => {
    const state = newcomer(true);
    plans(PLANS);
    const { router } = await throughTheTeam(state);
    const orgId = state.me?.organizations[0]?.id;
    await click(button("Entrar no workspace sem ligar"), 16);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[orgId, { finished: true }]]);
    expect(router.state.location.pathname).toBe(`/org/${orgId}/dm/agent/${LODI_ID}`);
  });
});

describe("a workspace being set up resumes from its data", () => {
  test("at what it does, at its team, at its plan; never a second workspace", async () => {
    for (const [opts, title] of [
      [{}, "O que a Ateliê Couto faz?"],
      [{ context: "Loja online" }, "Seu time"],
      [{ context: "Loja online", team: true, held: true }, "Ligue o time"],
    ] as const) {
      const state = settingUp(opts);
      plans(PLANS);
      await renderApp("/onboarding", { api: createFakeApi(state) });
      await settle(14);
      expect(heading()).toBe(title);
      expect(calls(state, "orgs.create")).toEqual([]);
      expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
      cleanup();
    }
  });

  test("a step answered in another tab meanwhile: this one moves on when it comes back, never a second team", async () => {
    const state = settingUp({ context: "Loja online", held: true });
    plans(PLANS);
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    expect(heading()).toBe("Seu time");
    // The other tab made the team.
    state.agents.push(...seedState().agents);
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle(14);
    expect(heading()).toBe("Ligue o time");
    expect(calls(state, "agents.applyTeamTemplate")).toEqual([]);
  });

  test("a read that fails, or a workspace that won't open, says so with a way on, never a sky that waits", async () => {
    const broke = () => new ApiError(500, "internal", "Something broke");
    const state = settingUp({ context: "Loja online" });
    const api = createFakeApi(state);
    const read = api.orgs.settings;
    let fails = 1;
    api.orgs.settings = async (orgId) => {
      if (fails-- > 0) throw broke();
      return read(orgId);
    };
    await renderApp("/onboarding", { api });
    await settle(14);
    await click(button("Tentar de novo"), 14);
    expect(heading()).toBe("Seu time");
    cleanup();

    const ready = settingUp({ context: "Loja online", team: true });
    const opening = createFakeApi(ready);
    const finish = opening.orgs.saveOnboarding;
    let refusals = 1;
    opening.orgs.saveOnboarding = async (orgId, input) => {
      if (refusals-- > 0) throw broke();
      return finish(orgId, input);
    };
    const { router } = await renderApp("/onboarding", { api: opening });
    await settle(16);
    expect(router.state.location.pathname).toBe("/onboarding");
    await click(button("Tentar de novo"), 16);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  });

  test("everything done and no plan to wait for: it opens in #general", async () => {
    const state = settingUp({ context: "Loja online", team: true });
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  });

  test("back from paying: #general, the payment said as being confirmed; back without: the plan step", async () => {
    const paid = settingUp({ context: "Loja online", team: true, held: true });
    const { router } = await renderApp(`/org/${ORG_ID}/onboarding?paid=1`, { api: createFakeApi(paid) });
    await settle(14);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect((router.state.location.search as { paid?: boolean }).paid).toBe(true);
    expect(calls(paid, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { finished: true }]]);
    cleanup();

    const back = settingUp({ context: "Loja online", team: true, held: true });
    plans(PLANS);
    await renderApp(`/org/${ORG_ID}/onboarding`, { api: createFakeApi(back) });
    await settle(14);
    expect(heading()).toBe("Ligue o time");
    expect(calls(back, "orgs.saveOnboarding")).toEqual([]);
    cleanup();

    // Back without paying to one set up meanwhile in another tab: it opens as it is, never a new workspace's step 1.
    const meanwhile = settingUp({ context: "Loja online", team: true, held: true });
    const org = meanwhile.me?.organizations[0];
    if (org) delete org.onboarding;
    const again = await renderApp(`/org/${ORG_ID}/onboarding`, { api: createFakeApi(meanwhile) });
    await settle(14);
    expect(again.router.state.location.pathname.startsWith(`/org/${ORG_ID}/`)).toBe(true);
    expect(document.querySelector(".onb")).toBeNull();
  });

  test("asked to delete the workspace being set up: its dialog, and nothing is finished", async () => {
    const state = settingUp();
    await renderApp("/onboarding?delete=1", { api: createFakeApi(state) });
    await settle(10);
    expect(screen().getByRole("dialog")).toBeTruthy();
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
  });
});

describe("the name step's other cases", () => {
  test("waiting for its plan elsewhere: said in place, with the way to that plan", async () => {
    const state = newcomer(true);
    const api = createFakeApi(state);
    api.orgs.create = async () => {
      throw new ApiError(403, "org.create_unpaid", "Waiting", { orgId: ORG_ID });
    };
    await renderApp("/onboarding", { api });
    await settle(10);
    await forATeam();
    await type("Nome", "Outra loja");
    await click(button("Continuar"), 10);
    expect(document.querySelector(".onb__status")?.textContent).toBeTruthy();
    expect(document.querySelector(".onb__answer .row button")).not.toBeNull();
  });

  test("back on the name after another visit: the workspace's own zone and name, the zone kept unless changed", async () => {
    const state = settingUp({ context: "Loja online" });
    const api = createFakeApi(state);
    const read = api.orgs.settings;
    api.orgs.settings = async (orgId) => ({ ...(await read(orgId)), timezone: "Asia/Tokyo" });
    await renderApp("/onboarding", { api });
    await settle(14);
    await click(document.querySelectorAll(".onb__step")[0] as HTMLElement, 8);
    expect(document.querySelector(".onb__help")?.textContent).toContain("Tóquio");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("Ateliê Couto");
    // The field clears like any other, and an empty name goes nowhere.
    await type("Nome", "");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("");
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    await type("Nome", "Ateliê Couto e Filhas");
    await click(button("Continuar"), 14);
    expect(calls(state, "orgs.updateSettings").at(-1)?.args).toEqual([ORG_ID, { name: "Ateliê Couto e Filhas" }]);
  });

  test("invite-only: the step says so and Continuar stays off", async () => {
    const state = newcomer(false);
    if (state.me) state.me.user = { ...state.me.user, canCreateWorkspace: false };
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    await click(answer(/Para minha empresa ou time/), 4);
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".onb__note")?.textContent).toBeTruthy();
  });
});

describe("for me (ADR 0159)", () => {
  test("no name to ask and no rail: a personal workspace, named in the person's language, opens in Lodi's DM", async () => {
    const state = newcomer(true);
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    expect(heading()).toBe("Para que você vai usar o agentes.chat?");
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    // "For me", not "For my company or team", whose words start the same in Portuguese.
    await click(answer(/^Para mim(?!ha)/), 4);
    expect(screen().queryByLabelText("Nome")).toBeNull();
    await click(button("Continuar"), 16);
    expect(calls(state, "orgs.create")[0]?.args[0]).toEqual({ name: "Pessoal", mode: "personal", ...zones() });
    const orgId = state.me?.organizations.at(-1)?.id;
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[orgId, { finished: true }]]);
    expect(router.state.location.pathname).toBe(`/org/${orgId}/dm/agent/${LODI_ID}`);
    // Never the plan step nor a team template: its card in Lodi's DM holds the rest.
    expect(calls(state, "agents.applyTeamTemplate")).toEqual([]);
  });

  test("back from the name, the question again; the answer can change", async () => {
    const state = newcomer(false);
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    await forATeam();
    expect(screen().getByLabelText("Nome")).toBeTruthy();
    await click(button("Voltar"), 4);
    expect(answer(/Para minha empresa ou time/).getAttribute("aria-checked")).toBe("true");
    expect(calls(state, "orgs.create")).toEqual([]);
  });
});

/** Every call the app makes, reads too, in order, as "orgs.create". */
function recorded(api: ApiClient) {
  const log: string[] = [];
  const wrap = <T extends object>(target: T, path: string): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver);
        const name = path ? `${path}.${String(key)}` : String(key);
        if (typeof value === "function")
          return (...args: unknown[]) => {
            log.push(name);
            return value.apply(obj, args);
          };
        return value && typeof value === "object" ? wrap(value, name) : value;
      },
    });
  return { api: wrap(api, ""), log };
}

/**
 * How long "Abrindo seu workspace" waits is its calls one after another: each is a round trip to the server (#1).
 */
describe("opening a new workspace, in round trips", () => {
  test("For me: one call makes it with both zones, one finishes it and opens Lodi's DM, nobody asked again", async () => {
    const state = newcomer(false);
    const { api, log } = recorded(createFakeApi(state));
    const { router } = await renderApp("/onboarding", { api });
    await settle(10);
    await click(answer(/^Para mim(?!ha)/), 4);
    log.length = 0;
    const off = router.subscribe("onBeforeNavigate", (e) => {
      if (e.pathChanged) log.push(`→ ${e.toLocation.pathname}`);
    });
    await click(button("Continuar"), 16);
    off();
    const orgId = state.me?.organizations.at(-1)?.id;
    const before = log.slice(0, log.findIndex((c) => c.startsWith("→")) + 1);
    expect(before[0]).toBe("orgs.create");
    // Its zones went with it and the answers said who the person is: none of them is asked on its own.
    expect(before.filter((c) => ["account.me", "orgs.updateSettings", "orgs.updateMe"].includes(c))).toEqual([]);
    // One call finishes it, and its answer says where it opens.
    expect(before.slice(-2)).toEqual(["orgs.saveOnboarding", `→ /org/${orgId}/dm/agent/${LODI_ID}`]);
    expect(state.me?.organizations.at(-1)?.onboarding).toBeUndefined();
  });

  test("a logo picked first: the workspace, its logo, then who the person is asked again, for the logo", async () => {
    const state = newcomer(false);
    const { api, log } = recorded(createFakeApi(state));
    await renderApp("/onboarding", { api });
    await settle(10);
    await forATeam();
    await click(button("Escolher o logo"), 4);
    const dialog = screen().getByRole("dialog", { name: "Logo do workspace" });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () =>
      fireEvent.change(input, { target: { files: [new File(["png-bytes"], "logo.png", { type: "image/png" })] } }),
    );
    await settle(3);
    await click(screen().getByRole("button", { name: "Salvar" }), 6);
    await type("Nome", "Ateliê Couto");
    log.length = 0;
    await click(button("Continuar"), 14);
    expect(log.slice(0, 5)).toEqual(["orgs.create", "orgs.setLogo", "orgs.settings", "agents.list", "account.me"]);
    expect(heading()).toBe("O que a Ateliê Couto faz?");
  });

  test("a conversation opened for the first time shows from its own answer, no list read again for it", async () => {
    const state = seedState();
    const { api, log } = recorded(createFakeApi(state));
    const { services } = await renderApp(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`, { api });
    await settle(10);
    expect(screen().getByRole("heading", { level: 1, name: /Atlas/ })).toBeTruthy();
    expect(log.filter((c) => c === "dms.open")).toHaveLength(1);
    expect(log.filter((c) => c === "dms.list")).toHaveLength(1);
    expect(log.filter((c) => c === "chat.channels")).toHaveLength(1);
    // In the DM list all the same, where the header's search finds it.
    const dms = services.queryClient.getQueryData<DirectMessage[]>(keys.dms(ORG_ID)) ?? [];
    expect(dms.some((d) => d.with.id === ATLAS_ID)).toBe(true);
  });
});

describe("the worst case, measured by CI's geometry in German and Russian too", () => {
  test("a long unbroken name, a long first name, a long sentence, a long plan and price, every rail answer filled", async () => {
    const state = settingUp({ held: true, team: true, context: "Vendemos cerâmica feita à mão. ".repeat(16).trim() });
    const org = state.me?.organizations[0];
    if (org) org.name = "Cerâmicas Pneumoultramicroscopicossilicovulcanoconióticas Artesanais Ltda";
    if (state.me) state.me.user = { ...state.me.user, name: "Maximiliana Bartolomeu Constantinopla de Albuquerque" };
    plans({
      recommended: "team",
      plans: [{ key: "team", name: "Equipe Profissional Ilimitada Plus", price: "US$ 49,00 + impostos" }],
    });
    const { services } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    expect(heading()).toBe("Ligue o time");
    expect(document.querySelector(".onb__plan-price")?.textContent).toContain("Equipe Profissional Ilimitada Plus");
    for (const lang of ["de", "ru"] as const) {
      await showIn(services, lang);
      for (const step of [0, 1, 3]) {
        await click(document.querySelectorAll(".onb__step")[step] as HTMLElement, 8);
        (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
      }
    }
  });
});

describe("the top of Lodi's DM without its checklist", () => {
  test("with a team and an AI: the greeting and the way to build the team again, no card", async () => {
    const state = withRightHand(seedState());
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(10);
    expect(document.body.textContent).toContain(GREETING);
    expect(document.querySelector(".setup-cl")).toBeNull();
    expect(button("Montar o time")).toBeTruthy();
  });
});
