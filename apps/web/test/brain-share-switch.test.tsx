import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { chooseBrain } from "./ai-picker";
import { ADA_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/*
 * "Atende outras pessoas" (ADR 0059 §5): an agent on its owner's plan answers only them until they turn it on, with
 * nothing to accept. Under the switch, a line saying whom it answers in that state and on which plan, and behind its ⓘ
 * what the plan's terms say. An admin who doesn't own it gets the same switch, its line naming whose plan it is, and
 * widens or narrows it in "Quem pode falar" too.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);

/**
 * Ada on the MacBook with the given brain view; Walter (me) owns her unless `mine` is false (then João does).
 * `ownPlan`: the plan of the MacBook's own sign-in, as its row of the AI accounts says it. `en`: the page in English.
 */
async function ada(
  patch: Partial<AgentBrain>,
  { mine = true, tab = "", provider = "", ownPlan = "", en = false, people = false } = {},
) {
  const state = seedState();
  const agent = state.agents.find((a) => a.id === ADA_ID);
  if (agent) {
    agent.ownerUserId = mine ? "u-walter" : "u-joao";
    // Its owner's plan thinks for it (`account`): the MacBook's own sign-in.
    agent.brain = {
      kind: patch.brain ?? "claude_code",
      model: "Sonnet",
      account: "Claude Max",
      ...(provider ? { provider } : {}),
    };
    agent.audience = { mode: people ? "people" : patch.onlyOwner === false ? "everyone" : "owner", userIds: [] };
  }
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "darwin",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
    browser: { available: true, version: "1", chrome: null, reason: null },
  });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
  if (ownPlan) {
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [],
      computers: [
        {
          machineId: "machine_1",
          name: "MacBook",
          online: true,
          mine: true,
          canAdd: true,
          keys: true,
          brains: { claude_code: true, codex: true },
          own: { claude_code: { plan: ownPlan } },
        },
      ],
    });
  }
  const view = fakeAgentBrain(ADA_ID, {
    brain: "claude_code",
    effectiveModel: "sonnet",
    onlyOwner: true,
    canUsePlans: mine,
    ...patch,
  });
  api.agents.brain = async () => structuredClone(view);
  const { services } = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}${tab}`, { api });
  await settle(8);
  if (en) {
    await act(async () => {
      await services.i18n.changeLanguage("en");
    });
    await settle(3);
  }
  return state;
}

const brainDialog = async () => {
  await click(screen().getByRole("button", { name: "Mudar quem pensa" }));
  return screen().getByRole("dialog", { name: "Quem pensa" });
};
/** "Configuração avançada" over "Quem pensa", where the switch is (ADR 0086). */
const ADVANCED = /^(Configuração avançada|Advanced settings)/;
const advanced = async (d: HTMLElement) => {
  await click(within(d).getByRole("button", { name: ADVANCED }));
  return screen().getByRole("dialog", { name: ADVANCED });
};
const done = (a: HTMLElement) => click(within(a).getByRole("button", { name: "Pronto" }));
const replies = (d: HTMLElement) => within(d).getByRole("switch", { name: "Atende outras pessoas" });
/** The line under the switch. */
const lineOf = (row: HTMLElement) => row.querySelector(".plan-replies__terms > span") as HTMLElement;
const TERMS = "os termos do plano";
const CLAUDE =
  "Os planos do Claude são para uso pessoal. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do Claude.";

describe("Atende outras pessoas (Quem pensa)", () => {
  test("off by default; on asks nothing; the line under it says whom Ada answers in each state, the terms behind its ⓘ", async () => {
    const state = await ada({});
    const d = await brainDialog();
    const a = await advanced(d);
    const off = replies(a);
    expect(off.getAttribute("aria-checked")).toBe("false");
    // Under the switch: whom she answers now, on which plan, and the plan's terms behind its ⓘ; both describe the
    // switch.
    const row = off.closest(".plan-replies") as HTMLElement;
    expect(shownText(row)).toBe("Atende outras pessoasA Ada só atende você, pelo seu plano do Claude.");
    const hint = hintOf(TERMS, row);
    expect(hint).toMatchObject({ text: CLAUDE, hidden: true });
    expect(off.getAttribute("aria-describedby")).toBe(
      `${lineOf(row).id} ${hint.button.getAttribute("aria-describedby")}`,
    );
    expect(shownText(a)).not.toMatch(/risco|Manter só comigo|uso pessoal|zona cinzenta/);

    await click(off);
    // Nothing asked: the advanced settings are the only dialog on top.
    expect(screen().queryAllByRole("dialog")).toHaveLength(1);
    expect(replies(a).getAttribute("aria-checked")).toBe("true");
    expect(shownText(row)).toBe("Atende outras pessoasA Ada atende quem pode falar com ela, pelo seu plano do Claude.");
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: null, fallback: true, onlyOwner: false }]);
    expect(document.body.textContent).toContain("Agora a Ada atende outras pessoas.");
  });

  test("in English, the same line for each state", async () => {
    await ada({}, { en: true });
    await click(screen().getByRole("button", { name: "Change who thinks" }));
    const a = await advanced(screen().getByRole("dialog"));
    const off = within(a).getByRole("switch", { name: "Answers other people" });
    const row = off.closest(".plan-replies") as HTMLElement;
    expect(shownText(row)).toBe("Answers other peopleAda answers only you, on your Claude plan.");
    expect(within(row).getByRole("button", { name: "About the plan's terms" })).toBeTruthy();
    await click(off);
    expect(shownText(row)).toBe("Answers other peopleAda answers anyone who can talk to her, on your Claude plan.");
  });

  test("on already: off brings back only its owner, with nothing asked", async () => {
    const state = await ada({ onlyOwner: false });
    const d = await brainDialog();
    const a = await advanced(d);
    expect(replies(a).getAttribute("aria-checked")).toBe("true");
    expect(lineOf(replies(a).closest(".plan-replies") as HTMLElement).textContent).toBe(
      "A Ada atende quem pode falar com ela, pelo seu plano do Claude.",
    );
    await click(replies(a));
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: null, fallback: true, onlyOwner: true });
    expect(document.body.textContent).toContain("A Ada agora só atende você.");
  });

  test("each plan in its own words: ChatGPT's plan, a team seat (an account or the computer's own), a coding plan's maker", async () => {
    const terms = async () => {
      const row = replies(await advanced(await brainDialog())).closest(".plan-replies") as HTMLElement;
      return { line: lineOf(row).textContent, text: hintOf(TERMS, row).text };
    };
    await ada({ brain: "codex", effectiveModel: "gpt-6-sol" });
    expect(await terms()).toEqual({
      line: "A Ada só atende você, pelo seu plano do ChatGPT.",
      text: "Os planos do ChatGPT são para uso pessoal. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do ChatGPT.",
    });
    cleanup();
    const seat: MachineAccount = {
      id: "acct_team",
      kind: "claude_code",
      label: "Claude Team",
      email: "walt@acme.com",
      plan: "team",
      status: "active",
      ownerId: "u-walter",
      ownerName: "Walter",
      mine: true,
      usedBy: ["Ada"],
      usage: null,
      provider: null,
      keyHint: null,
    };
    const SEAT = {
      line: "A Ada só atende você, pelo seu assento do Claude.",
      text: "Cada assento do Claude é de uma pessoa só. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do Claude.",
    };
    await ada({ account: "acct_team", accounts: [seat] });
    expect(await terms()).toEqual(SEAT);
    cleanup();
    // The computer's own sign-in on a Team seat: the seat's words too, as the plan's panel says them.
    await ada({ ownSignIn: true }, { ownPlan: "team" });
    expect(await terms()).toEqual(SEAT);
    cleanup();
    const glm: MachineAccount = {
      ...seat,
      id: "acct_glm",
      label: "GLM Coding",
      email: null,
      plan: null,
      provider: "zai",
      keyHint: "a1b2",
    };
    await ada({ account: "acct_glm", accounts: [glm] });
    expect(await terms()).toEqual({
      line: "A Ada só atende você, pelo seu plano GLM Coding.",
      text: "Z.ai diz que o plano é só de quem assina. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do plano.",
    });
  });

  test("onto a plan it starts off, and Usar asks nothing", async () => {
    const state = await ada({ brain: "model", effectiveModel: null, onlyOwner: false }, { ownPlan: "max" });
    const d = await brainDialog();
    await chooseBrain(d, /^Claude/);
    const a = await advanced(d);
    expect(replies(a).getAttribute("aria-checked")).toBe("false");
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: null, fallback: true }]);
  });

  test("an admin moving João's agent onto his plan with the switch on is asked first", async () => {
    const state = await ada(
      { brain: "model", effectiveModel: null, onlyOwner: false, ownSignIn: true },
      { mine: false, ownPlan: "max" },
    );
    const d = await brainDialog();
    await chooseBrain(d, /^Claude/);
    const a = await advanced(d);
    await click(replies(a));
    await done(a);
    const ask = screen().getByRole("dialog", { name: "Usar o plano de João?" });
    await click(within(ask).getByRole("button", { name: "Continuar" }));
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", onlyOwner: false });
  });

  test("an admin who doesn't own it: the same switch, its line naming whose plan it is, asked first", async () => {
    const state = await ada({}, { mine: false });
    const d = await brainDialog();
    const a = await advanced(d);
    const row = a.querySelector(".plan-replies") as HTMLElement;
    expect(shownText(row)).toBe("Atende outras pessoasA Ada só atende João, pelo plano do Claude de João.");
    await click(replies(a));
    expect(shownText(row)).toBe(
      "Atende outras pessoasA Ada atende quem pode falar com ela, pelo plano do Claude de João.",
    );
    await done(a);
    const ask = screen().getByRole("dialog", { name: "Usar o plano de João?" });
    expect(ask.textContent).toContain("João vai receber um email avisando.");
    await click(within(ask).getByRole("button", { name: "Continuar" }));
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ onlyOwner: false });
  });

  test("back on the API it still answers only its owner: the notice lets everyone in with one click", async () => {
    const state = await ada({});
    const d = await brainDialog();
    await chooseBrain(d, /^Chave de API/);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(document.body.textContent).toContain("A Ada voltou a pensar pela API e ainda só atende você.");
    await click(screen().getByRole("button", { name: "Deixar a Ada atender todos" }));
    await settle(4);
    expect(brainCalls(state)).toEqual([{ brain: "model", fallback: true }, { onlyOwner: false }]);
  });
});

describe("Só algumas pessoas with nobody picked yet", () => {
  test("Atende outras pessoas lets nobody in: the switch goes back off and says to pick people", async () => {
    const state = await ada({}, { people: true });
    const d = await brainDialog();
    const a = await advanced(d);
    await click(replies(a));
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ onlyOwner: false });
    expect(document.body.textContent).not.toContain("Agora a Ada atende outras pessoas.");
    expect(document.body.textContent).toContain(
      "A Ada só atende as pessoas escolhidas, e ninguém foi escolhido ainda. Escolha em Quem pode falar.",
    );
    expect(state.agents.find((x) => x.id === ADA_ID)?.audience).toEqual({ mode: "people", userIds: [] });
  });

  test("back on the API: no button that would let everyone in", async () => {
    await ada({}, { people: true });
    const d = await brainDialog();
    await chooseBrain(d, /^Chave de API/);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(document.body.textContent).toContain("A Ada voltou a pensar pela API e ainda só atende você.");
    expect(screen().queryByRole("button", { name: /^Deixar a Ada atender/ })).toBeNull();
  });
});

describe("Quem pode falar, on a plan", () => {
  const audience = () => screen().getByRole("radiogroup", { name: "Quem pode falar com a Ada" });
  const save = () =>
    click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );

  test("its owner widens it with nothing to accept", async () => {
    const state = await ada({}, { tab: "?tab=settings&sec=audience" });
    await click(within(audience()).getByRole("radio", { name: /^Todos do workspace/ }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(
      within(audience())
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await save();
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      audience: { mode: "everyone", userIds: [], roleIds: [], consultable: true },
    });
  });

  test("an admin who doesn't own it lets more people in too, with nothing to accept", async () => {
    await ada({}, { mine: false, tab: "?tab=settings&sec=audience" });
    await click(within(audience()).getByRole("radio", { name: /^Todos do workspace/ }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(
      within(audience())
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.body.textContent).not.toContain("Só João pode deixar outras pessoas falarem com ela.");
  });
});
