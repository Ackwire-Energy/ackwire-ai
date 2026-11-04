import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type {
  AgentBrain,
  AiComputer,
  BrowserUnavailableReason,
  Machine,
  MachineAccount,
  PlanUsage,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { type BrainChoice, changedKeys, type Saved, sameBrain } from "@/lib/agent-edit";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  fakeAgentBrain,
  fakeBrowserOf,
  fakeMachinesOf,
  NOW,
  OPENROUTER_KEY,
  OPENROUTER_MODELS,
  ORG_ID,
  seedState,
} from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  setSystemTime();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
const callOrder = (state: ReturnType<typeof seedState>) =>
  state.calls.map((c) => c.method).filter((m) => m === "sandbox.setTarget" || m === "agents.setBrain");

async function open(state = seedState(), api = createFakeApi(state)) {
  const { services } = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api, services };
}
/** "Como trabalha" under the name: where, who thinks, the browser. */
const sentence = () => screen().getByRole("region", { name: "Como trabalha" });
/** The "Pensa com" cell: what thinks (and its effort), and under it what pays. */
const brainCell = () => {
  const cell = within(sentence()).getByRole("button", { name: "Mudar quem pensa" });
  return {
    label: cell.querySelector("small")?.textContent,
    value: cell.querySelector(".agp-cell__value")?.textContent,
    sub: cell.querySelector(".agp-cell__sub")?.textContent,
  };
};
const dialog = async (word: string, title: string) => {
  await click(screen().getByRole("button", { name: word }));
  return screen().getByRole("dialog", { name: title });
};
const brainDialog = () => dialog("Mudar quem pensa", "Quem pensa");
const card = (d: HTMLElement, name: RegExp) =>
  within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getByRole("radio", { name });
/** The opened brain's model, from its dropdown. */
const model = (d: HTMLElement, name: RegExp) => pick(d, "Modelo", name);
/** What the opened brain's model dropdown offers (it stays open). */
const modelNames = async (d: HTMLElement) => {
  const trigger = within(d).getByRole("combobox", { name: "Modelo" });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  return screen()
    .getAllByRole("option")
    .map((o) => o.textContent);
};
/** "Configuração avançada" over "Quem pensa": effort, context window, who it answers, the API (ADR 0086). */
const advanced = async (d: HTMLElement) => {
  await click(within(d).getByRole("button", { name: /^Configuração avançada/ }));
  return screen().getByRole("dialog", { name: "Configuração avançada" });
};
const done = (a: HTMLElement) => click(within(a).getByRole("button", { name: "Pronto" }));
/** In the advanced settings: answer through the API while the computer doesn't answer. */
const offSwitch = (d: HTMLElement) =>
  within(d).getByRole("switch", { name: /^Se o MacBook parar de responder, responder pela API/ });
/** Opens one of the opened brain's dropdowns and picks an option. */
const pick = async (d: HTMLElement, select: string, option: RegExp) => {
  const trigger = within(d).getByRole("combobox", { name: select });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
};
/** The MacBook's row in the AI accounts: the own sign-ins its runner reported there. */
const reportOwn = (api: ReturnType<typeof createFakeApi>, own: AiComputer["own"]) =>
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
        own,
      },
    ],
  });
/** A connected MacBook with Claude Code and Codex; its browser as given. */
const pairMac = (api: ReturnType<typeof createFakeApi>, browser: boolean) =>
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "darwin",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser } },
    browser: { available: browser, version: browser ? "1" : null, chrome: null, reason: null },
  });

describe("Como trabalha under the name", () => {
  test("where, who thinks and the browser, in three cells (where first); each opens its dialog", async () => {
    await open();
    expect(sentence().textContent).toContain("ComputadorNenhum computador");
    expect(sentence().textContent).toContain("Pensa com");
    // On the API: its model, then that it pays per use.
    expect(brainCell()).toEqual({ label: "Pensa com", value: "Claude Sonnet 5.5", sub: "Pela API" });
    expect(sentence().textContent).toContain("Navegadornão navega em sites");
    expect(sentence().textContent?.indexOf("Computador")).toBeLessThan(
      sentence().textContent?.indexOf("Pensa com") ?? 0,
    );
    for (const word of ["Mudar quem pensa", "Mudar onde trabalha", "Mudar o navegador"])
      expect(screen().getByRole("button", { name: word }).getAttribute("aria-haspopup")).toBe("dialog");
    // Configurações no longer has "Quem pensa": it lives in the sentence.
    cleanup();
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(document.getElementById("agp-sec-brain")).toBeNull();
    expect(screen().getByRole("navigation", { name: "Seções das configurações" }).textContent).not.toContain(
      "Quem pensa",
    );
  });

  test("a member reads it, without buttons; the owner may open it", async () => {
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    await open(member);
    expect(sentence().textContent).toContain("Claude Sonnet 5.5Pela API");
    expect(screen().queryByRole("button", { name: "Mudar quem pensa" })).toBeNull();
    cleanup();
    const owner = seedState();
    if (owner.me?.organizations[0]) owner.me.organizations[0].role = "member";
    const ada = owner.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    await open(owner);
    expect(screen().getByRole("button", { name: "Mudar quem pensa" })).toBeTruthy();
  });
});

describe("Quem pensa (its dialog)", () => {
  test("what pays, in a list: the API key and the plans by their makers' marks, where each runs; the key's model and key in its card", async () => {
    await open();
    const d = await brainDialog();
    // Only for this agent, said by its name.
    expect(d.textContent).toContain("Vale só para a Ada, em todas as conversas.");
    const rows = within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getAllByRole("radio");
    expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.textContent)).toEqual([
      "Chave de API",
      "Claude",
      "ChatGPT",
    ]);
    expect(rows.map((r) => r.querySelector(".ac-optrow__desc")?.textContent)).toEqual([
      "Pago por uso. Conta no orçamento da Ada.",
      "Usa o seu plano do Claude",
      "Usa o seu plano do ChatGPT",
    ]);
    expect(rows[0]?.getAttribute("aria-checked")).toBe("true");
    // The API key by its model's maker; the plans by their makers' marks.
    expect(rows[0]?.querySelector(".ac-brand[data-mark='claude']")).not.toBeNull();
    expect(rows[1]?.querySelector(".ac-brand[data-mark='claude']")).not.toBeNull();
    expect(rows[2]?.querySelector(".ac-brand[data-mark='openai']")).not.toBeNull();
    // The agent has no computer: a plan brain says where it will go, before it is chosen.
    expect(rows.map((r) => r.querySelector(".ac-optrow__side")?.textContent)).toEqual([
      undefined,
      "Vai para o MacBook",
      "Vai para o MacBook",
    ]);
    // The chosen brain and its settings are one card.
    const more = d.querySelector(".ac-optcard .ac-optrow__more") as HTMLElement;
    expect(within(more).getByRole("combobox", { name: "Modelo" })).toBeTruthy();
    expect(within(more).getByRole("combobox", { name: "Chave da API" })).toBeTruthy();
    expect((within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("Cursor (ADR 0114): a plan card where the computer runs it, its models the plan's first, said so", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const base = fakeAgentBrain(ADA_ID);
    const cursor = {
      kind: "cursor" as const,
      available: true,
      models: [
        { value: "grok-5-code", label: "Grok 5 Code", inPlan: true },
        { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
      ],
      defaultModel: null,
    };
    const options = [...base.options, cursor];
    const machines = [{ machineId: "machine_1", name: "MacBook", online: true, options }];
    api.agents.brain = async () => ({ ...base, options, machines });
    await open(state, api);
    const d = await brainDialog();
    const rows = within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getAllByRole("radio");
    expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.textContent)).toEqual([
      "Chave de API",
      "Claude",
      "ChatGPT",
      "Cursor",
    ]);
    expect(rows[3]?.querySelector(".ac-brand[data-mark='cursor']")).not.toBeNull();
    await act(async () => fireEvent.click(rows[3] as HTMLElement));
    await settle(4);
    const names = await modelNames(d);
    expect(names.some((n) => n?.includes("Grok 5 Code") && n.includes("No seu plano do Cursor"))).toBe(true);
    expect(names.some((n) => n?.includes("Claude Opus 5.5") && n.includes("O Cursor cobra pelo preço da API"))).toBe(
      true,
    );
  });

  test("on the computer it already works on: no side words on the plans, no line by the buttons", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet" });
    await open(state, api);
    const d = await brainDialog();
    const rows = within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getAllByRole("radio");
    expect(rows.map((r) => r.querySelector(".ac-optrow__side")?.textContent ?? null)).toEqual([null, null, null]);
    expect(d.textContent).not.toContain("No MacBook");
    expect(d.querySelector(".agp-wdlg__note")).toBeNull();
    expect(d.textContent).not.toMatch(/Pensa com\s/);
  });

  test("Claude: the agent moves to the MacBook first, then thinks there; the toast says both, and whom it answers now", async () => {
    const { state } = await open();
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    // The agent moves to the MacBook: its accounts there aren't offered yet.
    expect(within(d).queryByRole("combobox", { name: "Conta" })).toBeNull();
    await model(d, /^Opus/);
    const a = await advanced(d);
    expect(offSwitch(a).getAttribute("aria-checked")).toBe("true");
    // One line, its label and its ⓘ: what it does, the same on or off, describes the switch.
    const fallback = hintOf("Se o MacBook parar de responder, responder pela API", a);
    expect(fallback.text).toBe(
      "Responde pela API e conta no orçamento da Ada. Se não, a Ada avisa quem chamou e espera o computador voltar.",
    );
    expect(offSwitch(a).getAttribute("aria-describedby")).toBe(fallback.button.getAttribute("aria-describedby"));
    await click(offSwitch(a));
    expect(offSwitch(a).getAttribute("aria-checked")).toBe("false");
    expect(hintOf("Se o MacBook parar de responder, responder pela API", a).text).toBe(fallback.text);
    expect(shownText(a)).not.toContain("avisa quem chamou");
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(callOrder(state)).toEqual(["sandbox.setTarget", "agents.setBrain"]);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args.slice(1)).toEqual([ADA_ID, "machine_1"]);
    // Choosing a plan asks nothing: it answers only its owner until they say otherwise.
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: "opus", fallback: false }]);
    expect(document.body.textContent).toContain(
      "A Ada agora trabalha no MacBook, pensa com Opus pelo plano do Claude e só atende você.",
    );
    expect(screen().queryByRole("dialog", { name: "Quem pensa" })).toBeNull();
  });

  test("from the API onto a plan on the computer it works on: it answers only its owner from now on, said in the toast", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    reportOwn(api, { claude_code: { plan: "max" } });
    await open(state, api);
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code" });
    expect(document.body.textContent).toContain("A Ada agora pensa com Sonnet pelo plano do Claude e só atende você.");
  });

  test("an admin who isn't its owner moves it from the API onto a plan: the cards and the toast say whose plan it is and whom it answers", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { canUsePlans: false, canManageAccounts: false });
    await open(state, api);
    const d = await brainDialog();
    const rows = within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getAllByRole("radio");
    expect(rows.map((r) => r.querySelector(".ac-optrow__desc")?.textContent)).toEqual([
      "Pago por uso. Conta no orçamento da Ada.",
      "Usa o plano do Claude de Walter",
      "Usa o plano do ChatGPT de Walter",
    ]);
    await click(card(d, /^Claude/));
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code" });
    expect(document.body.textContent).toContain(
      "A Ada agora pensa com Sonnet pelo plano do Claude e só atende Walter.",
    );
  });

  test("no API key anywhere (the workspace's or the server's): no switch promising an answer through it", async () => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [{ agentId: ADA_ID, state: "ready" }],
        routing: { by: "rules", mine: "rules", model: null, noSmallModel: null },
        apiKey: false,
      },
    });
    await open(state);
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    expect(within(d).queryByRole("switch", { name: /responder pela API/ })).toBeNull();
    expect(d.textContent).not.toContain("responder pela API");
  });

  test("a saved plan brain changes its model without the warning; back to the organization's model too", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "codex", model: null, effectiveModel: "gpt-6-sol" });
    await open(state, api);
    // The plan that pays for it in the label, the model it runs and its effort under it.
    expect(brainCell()).toEqual({ label: "Pensa com ChatGPT", value: "GPT-6 Sol · esforço médio", sub: undefined });
    const d = await brainDialog();
    expect(card(d, /^ChatGPT/).getAttribute("aria-checked")).toBe("true");
    await model(d, /Luna/);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "codex", model: "gpt-6-luna", fallback: true });
  });

  test("a saved plan no computer runs right now still saves its own model (Usar isn't stuck)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const base = fakeAgentBrain(ADA_ID, { brain: "codex", model: null, effectiveModel: "gpt-6-sol" });
    const options = base.options.map((o) =>
      o.kind === "codex" ? { ...o, available: false, reason: "exec_off" as const } : o,
    );
    api.agents.brain = async () => ({
      ...base,
      options,
      machines: [{ machineId: "machine_1", name: "MacBook", online: true, options }],
    });
    await open(state, api);
    const d = await brainDialog();
    const use = () => within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement;
    expect(use().disabled).toBe(true);
    await model(d, /Luna/);
    expect(use().disabled).toBe(false);
    await click(use());
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "codex", model: "gpt-6-luna", fallback: true });
  });

  test("what no computer has can't be chosen, and says why", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const base = fakeAgentBrain(ADA_ID);
    const options = base.options.map((o) =>
      o.kind === "codex" ? { ...o, available: false, reason: "not_installed" as const } : o,
    );
    api.agents.brain = async () => ({
      ...base,
      options,
      machines: [{ machineId: "machine_1", name: "MacBook", online: true, options }],
    });
    await open(state, api);
    const codex = card(await brainDialog(), /^ChatGPT/);
    expect(codex.hasAttribute("disabled")).toBe(true);
    expect(codex.textContent).toContain("O Codex não está instalado no MacBook.");
    expect(codex.querySelector(".ac-brand--off")).not.toBeNull();
    expect(codex.querySelector(".ac-optrow__side")?.textContent).toBe("Nenhum computador tem");
  });

  test("a tool turned off says where it turns on: the app on a Mac, the app or the command on Linux", async () => {
    const reason = async (os: string, name: string) => {
      cleanup();
      const state = seedState();
      const api = createFakeApi(state);
      fakeMachinesOf.get(api)?.pair({ id: "machine_1", name, os, mode: "system" });
      const computer = { machineId: "machine_1", name, online: true };
      const base = fakeAgentBrain(ADA_ID, { computer });
      const options = base.options.map((o) =>
        o.kind === "claude_code" ? { ...o, available: false, reason: "tool_off" as const } : o,
      );
      api.agents.brain = async () => ({ ...base, options, machines: [{ ...computer, options }] });
      await open(state, api);
      return card(await brainDialog(), /^Claude/).textContent;
    };
    // The card names the plan; the line names the program on the computer.
    expect(await reason("darwin", "MacBook")).toContain(
      "O Claude Code está desligado no MacBook. Ligue lá, no app do agentes.chat: Preferências → Ferramentas.",
    );
    expect(await reason("linux", "Servidor")).toContain(
      "O Claude Code está desligado no Servidor. Ligue lá, no app do agentes.chat ou com sudo agentes-runner tools enable claude.",
    );
  });
});

describe("Quem pensa: the account on the computer and the effort (ADR 0041)", () => {
  const work: MachineAccount = {
    id: "acct_work",
    kind: "claude_code",
    label: "Trabalho",
    email: "walt@acme.com",
    plan: "Team",
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy: [],
    usage: null,
    provider: null,
    keyHint: null,
  };
  /**
   * Ada thinks with Claude Code on the MacBook, which has the given accounts; `own`: the MacBook's own sign-ins its
   * runner reported, as its row of the AI accounts says them.
   */
  async function onMac(patch: Partial<AgentBrain> = {}, own?: AiComputer["own"]) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    if (own) reportOwn(api, own);
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", accounts: [work], ...patch });
    return open(state, api);
  }

  test("the cell names the account when the computer has more than one; Usar saves the account and the effort", async () => {
    const { state } = await onMac();
    // The computer's own sign-in by the name the Connect cards give it, never the computer's.
    expect(brainCell()).toEqual({
      label: "Pensa com Claude",
      value: "Sonnet · esforço médio",
      sub: "A conta que os seus agentes dividem",
    });
    expect(sentence().textContent).not.toContain("Conta deste MacBook");
    const d = await brainDialog();
    const account = within(d).getByRole("combobox", { name: "Conta" });
    expect(account.textContent).toContain("A conta que os seus agentes dividem");
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    const options = screen().getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "A conta que os seus agentes dividem",
      "Trabalho · Teamwalt@acme.com",
      "Adicionar conta",
    ]);
    await click(screen().getByRole("option", { name: /^Trabalho · Team/ }));
    // Effort, in the advanced settings: the pixel ramp, a slider (Médio → Alto with the arrow key).
    const a = await advanced(d);
    const effort = within(a).getByRole("slider", { name: "Esforço" });
    expect(effort.getAttribute("aria-valuetext")).toBe("Médio");
    await act(async () => fireEvent.keyDown(effort, { key: "ArrowRight" }));
    expect(effort.getAttribute("aria-valuetext")).toBe("Alto");
    expect(a.textContent).toContain("Pensa mais em tarefas difíceis.");
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({
      brain: "claude_code",
      model: null,
      fallback: true,
      effort: "high",
      account: "acct_work",
    });
  });

  test("an account made for all of the person's agents there: picked as it is, Also used by Theo, no sign-in, no move", async () => {
    const shared: MachineAccount = {
      ...work,
      id: "acct_all",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Max",
      usedBy: ["Theo"],
      shared: true,
    };
    const { state } = await onMac({ accounts: [work, shared] });
    const d = await brainDialog();
    const account = within(d).getByRole("combobox", { name: "Conta" });
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "A conta que os seus agentes dividem",
      "Trabalho · Teamwalt@acme.com",
      "Pessoal · MaxTambém usada por Theo",
      "Adicionar conta",
    ]);
    await click(screen().getByRole("option", { name: /^Pessoal · Max/ }));
    await settle(4);
    expect(within(d).queryByRole("region", { name: "Adicionar conta do Claude" })).toBeNull();
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_all" });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("moveAccount");
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")).toBeUndefined();
  });

  test("each person's own: a Claude account another agent thinks with signs in again for this one; someone else's only shows while it's this one's", async () => {
    const theo: MachineAccount = {
      ...work,
      id: "acct_theo",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Max",
      usedBy: ["Theo"],
    };
    const hers: MachineAccount = {
      ...work,
      id: "acct_ana",
      label: "Claude Team 2",
      email: null,
      ownerId: "u-ana",
      ownerName: "Ana Lima",
      mine: false,
      usedBy: ["Ada"],
    };
    const other: MachineAccount = { ...hers, id: "acct_ana2", label: "Claude Team 3", usedBy: [] };
    const { state, api } = await onMac(
      { account: "acct_ana", accounts: [work, theo, hers, other] },
      { claude_code: { plan: "max" } },
    );
    // Ada's own login of Pessoal, once Claude's page signs her in.
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: { ...theo, id: "acct_ada", usedBy: [] } });
    const d = await brainDialog();
    const account = within(d).getByRole("combobox", { name: "Conta" });
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    const options = screen().getAllByRole("option");
    expect(options.map((o) => [o.textContent, o.getAttribute("aria-disabled") === "true"])).toEqual([
      // The computer's own sign-in says its plan under its name, as "Seus planos" titles it.
      ["A conta que os seus agentes dividemClaude · Max", false],
      ["Trabalho · Teamwalt@acme.com", false],
      ["Pessoal · MaxTambém usada por Theo", false],
      ["Claude Team 2De Ana", true],
      ["Adicionar conta", false],
    ]);
    await click(screen().getByRole("option", { name: /^Pessoal · Max/ }));
    await settle(4);
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(block).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    // A sign-in of Ada's own, Theo's account named to Claude's page unseen; nothing taken from Theo.
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { email: "walt@pessoal.com" },
    ]);
    expect(d.textContent).toContain("A conta Pessoal entrou no MacBook. Clique em Usar para salvar.");
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_ada" });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("moveAccount");
  });

  test("her own login signed out, an account another agent uses: a new login of that account, never hers again", async () => {
    const theo: MachineAccount = {
      ...work,
      id: "acct_theo",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Max",
      usedBy: ["Theo"],
    };
    const { state } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, status: "signed_out", usedBy: ["Ada"] }, theo],
    });
    const d = await brainDialog();
    await pick(d, "Conta", /^Pessoal · Max/);
    await settle(4);
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(block).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { email: "walt@pessoal.com" },
    ]);
  });

  test("ChatGPT like Claude: an account another agent thinks with signs in again for this one, never moved", async () => {
    const theo: MachineAccount = {
      ...work,
      id: "acct_theo",
      kind: "codex",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Plus",
      usedBy: ["Theo"],
    };
    await onMac({ brain: "codex", effectiveModel: "gpt-6-sol", accounts: [theo] });
    const d = await brainDialog();
    const account = within(d).getByRole("combobox", { name: "Conta" });
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    expect(screen().getByRole("option", { name: /^Pessoal · Plus/ }).textContent).toBe(
      "Pessoal · PlusTambém usada por Theo",
    );
    await click(screen().getByRole("option", { name: /^Pessoal · Plus/ }));
    await settle(4);
    expect(within(d).getByRole("region", { name: /^Adicionar conta/ })).toBeTruthy();
  });

  test("plan usage: the chosen account's meter; at the limit, its owner's free accounts, never another agent's", async () => {
    const now = new Date().toISOString();
    const full: PlanUsage = {
      windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }],
      limited: true,
      source: "turn",
      at: now,
    };
    const some = (usedPercent: number): PlanUsage => ({
      windows: [{ kind: "five_hour", usedPercent }],
      source: "probe",
      at: now,
    });
    const roomy: MachineAccount = { ...work, id: "acct_roomy", label: "Claude Team 2", usage: some(12) };
    const busy: MachineAccount = { ...work, id: "acct_busy", label: "Claude Team 3", usedBy: ["Theo"], usage: some(3) };
    const { state } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, usedBy: ["Ada"], usage: full }, roomy, busy],
    });
    // The work cell says it, where the account is.
    expect(sentence().textContent).toContain("Trabalho · No limite até");
    const d = await brainDialog();
    // Opening it looks the plans up again.
    expect(state.calls.some((c) => c.method === "machines.refreshAccountUsage")).toBe(true);
    const meter = d.querySelector(".ac-planmeter") as HTMLElement;
    expect(meter.textContent).toContain("No limite até");
    expect(within(meter).getByRole("meter", { name: "5 horas" }).getAttribute("aria-valuenow")).toBe("100");
    expect(within(d).queryByRole("button", { name: /Claude Team 3/ })).toBeNull();
    expect(within(d).getByRole("button", { name: "Conectar outra conta" })).toBeTruthy();
    await click(within(d).getByRole("button", { name: "Usar Claude Team 2 (12%)" }));
    expect(within(d).getByRole("combobox", { name: "Conta" }).textContent).toContain("Claude Team 2");
    expect(within(d).queryByRole("button", { name: /^Usar Claude/ })).toBeNull();
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", account: "acct_roomy" });
  });

  test("plan usage to someone who isn't the agent's owner: the meter, no offer", async () => {
    const full: PlanUsage = {
      windows: [{ kind: "seven_day", usedPercent: 100 }],
      source: "turn",
      at: new Date().toISOString(),
    };
    const spare: MachineAccount = { ...work, id: "acct_spare", label: "Claude Team 2", usage: null };
    await onMac({
      account: "acct_work",
      accounts: [{ ...work, usedBy: ["Ada"], usage: full }, spare],
      canUsePlans: false,
      canManageAccounts: false,
    });
    const d = await brainDialog();
    expect(d.querySelector(".ac-planmeter")?.textContent).toContain("No limite");
    expect(within(d).queryByRole("button", { name: /^Usar Claude/ })).toBeNull();
    expect(within(d).queryByRole("button", { name: "Conectar outra conta" })).toBeNull();
  });

  test("an admin changes the account among its owner's, told whose they are; an old app on the computer shows nothing about it", async () => {
    await onMac({ canUsePlans: false, canManageAccounts: false });
    let d = await brainDialog();
    const picker = within(d).getByRole("combobox", { name: "Conta" });
    expect(picker.hasAttribute("disabled")).toBe(false);
    // Someone else's agents don't share the viewer's sign-in: to them it is the computer's.
    expect(picker.textContent).toContain("Conta deste MacBook");
    expect(d.textContent).toContain(
      "Só contas de João, responsável pela Ada: um plano só pensa pelos agentes do seu dono.",
    );
    expect(d.textContent).not.toMatch(/Só João troca|Adicionar conta/);
    cleanup();
    await onMac({ accountsSupported: false });
    expect(sentence().textContent).not.toMatch(/Conta deste MacBook|A conta que os seus agentes dividem/);
    d = await brainDialog();
    expect(within(d).queryByRole("combobox", { name: "Conta" })).toBeNull();
    expect(within(await advanced(d)).getByRole("slider", { name: "Esforço" })).toBeTruthy();
  });

  test("who may use other people's plans gives Ada a teammate's, named whose it is; one another agent has stays off", async () => {
    const bia: MachineAccount = {
      ...work,
      id: "acct_bia",
      label: "Max da Bia",
      email: null,
      plan: null,
      ownerId: "u-bia",
      ownerName: "Bia Lima",
      mine: false,
    };
    const busy: MachineAccount = { ...bia, id: "acct_caio", label: "Pro do Caio", ownerName: "Caio", usedBy: ["Theo"] };
    const { state } = await onMac({
      account: null,
      accounts: [bia, busy],
      canUsePlans: false,
      canManageAccounts: false,
      canUseOthersPlans: true,
    });
    const d = await brainDialog();
    expect(d.textContent).toContain(
      "Os planos de outras pessoas mostram de quem são. O dono recebe um e-mail e pode tirar de volta.",
    );
    const trigger = within(d).getByRole("combobox", { name: "Conta" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    expect(screen().getByRole("option", { name: /^Max da Bia/ }).textContent).toBe("Max da BiaDe Bia");
    expect(
      screen()
        .getByRole("option", { name: /^Pro do Caio/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await click(screen().getByRole("option", { name: /^Max da Bia/ }));
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_bia" });
  });

  test("a signed-out account says so and offers to sign in again, its own email going to Claude's sign-in unasked", async () => {
    const { state } = await onMac({ account: "acct_work", accounts: [{ ...work, status: "signed_out" }] });
    const d = await brainDialog();
    expect(d.textContent).toContain("Saiu da conta, entre de novo");
    await pick(d, "Conta", /^Entrar de novo/);
    await settle(6);
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    expect(block.querySelector("input")).toBeNull();
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(block).getByRole("button", { name: "Entrar com Claude" }));
      await settle(6);
    } finally {
      window.open = realOpen;
    }
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { accountId: "acct_work", email: "walt@acme.com" },
    ]);
    expect(shownText(block)).not.toContain("walt@acme.com");
  });

  test("signing in again as another account already connected: both addresses said, and Use picks that one for Ada", async () => {
    const pessoal: MachineAccount = { ...work, id: "acct_pessoal", label: "Pessoal", email: "walt@gmail.com" };
    const { state, api } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, status: "signed_out" }, pessoal],
    });
    fakeMachinesOf.get(api)?.endLogin("login_1", {
      state: "failed",
      signedInAs: "walt@gmail.com",
      duplicate: { label: "Pessoal", account: pessoal },
    });
    const d = await brainDialog();
    await pick(d, "Conta", /^Entrar de novo/);
    await settle(6);
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(block).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    expect(shownText(block)).toContain(
      "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
    );
    await click(within(block).getByRole("button", { name: "Usar walt@gmail.com" }));
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_pessoal" });
  });

  test("the computer's own sign-in, chosen again, is the account the agents share, as the Connect cards name it", async () => {
    const { state } = await onMac({ account: "acct_work" }, { claude_code: { plan: "max" } });
    const d = await brainDialog();
    await pick(d, "Conta", /^A conta que os seus agentes dividem/);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: null });
    expect(document.body.textContent).toContain("Ada agora pensa com a conta que os seus agentes dividem.");
  });

  test("the computer's own sign-in is offered only once its runner says it's signed in there", async () => {
    await onMac({ account: "acct_work" });
    const d = await brainDialog();
    const options = async () => {
      const account = within(d).getByRole("combobox", { name: "Conta" });
      account.focus();
      await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
      const shown = screen()
        .getAllByRole("option")
        .map((o) => o.textContent);
      await act(async () => fireEvent.keyDown(screen().getAllByRole("option")[0] as HTMLElement, { key: "Escape" }));
      return shown;
    };
    // The MacBook said nothing of Claude Code's own sign-in: no account of its to choose.
    expect(await options()).toEqual(["Trabalho · Teamwalt@acme.com", "Adicionar conta"]);
    cleanup();
    await onMac({ account: "acct_work" }, { claude_code: { plan: "max" } });
    const signedIn = await brainDialog();
    const account = within(signedIn).getByRole("combobox", { name: "Conta" });
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["A conta que os seus agentes dividemClaude · Max", "Trabalho · Teamwalt@acme.com", "Adicionar conta"]);
  });

  test("ChatGPT on the workspace's computer, which nobody connected: straight to its sign-in, never that computer's account", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Even with its Codex reported signed in: on a computer nobody connected, no person signs in at its terminal.
    reportOwn(api, { codex: { usage: { windows: [], source: "probe", at: NOW.toISOString() } } });
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { ownSignIn: false });
    await open(state, api);
    const d = await brainDialog();
    await click(card(d, /^ChatGPT/));
    await settle(4);
    const block = within(d).getByRole("region", { name: "Adicionar conta do ChatGPT" });
    expect(within(block).getByRole("button", { name: "Entrar com ChatGPT" })).toBeTruthy();
    // Showing the steps starts nothing.
    expect(state.calls.some((c) => c.method === "machines.beginAccountLogin")).toBe(false);
    const use = () => within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement;
    expect(use().disabled).toBe(true);
    // Back: the account starts at Adicionar conta, and Codex waits for one.
    await click(within(block).getByRole("button", { name: "Voltar" }));
    const account = within(d).getByRole("combobox", { name: "Conta" });
    expect(account.textContent).toBe("Adicionar conta");
    expect(d.textContent).not.toMatch(/Conta deste|quem conectou/);
    expect(use().disabled).toBe(true);
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Adicionar conta"]);
    await click(screen().getByRole("option", { name: "Adicionar conta" }));
    expect(within(d).getByRole("region", { name: "Adicionar conta do ChatGPT" })).toBeTruthy();
  });

  test("a computer someone else connected, with no account of hers there: it says who signs a plan in, no empty list", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.pair({
      id: "machine_1",
      name: "MacBook",
      os: "darwin",
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
      browser: { available: true, version: "1", chrome: null, reason: null },
      pairedBy: { id: "u-theo", name: "Theo Lima" },
    });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Ada is Walter's: her plan would be his, and only Theo adds sign-ins on his MacBook.
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { ownSignIn: false, canManageAccounts: false });
    await open(state, api);
    const d = await brainDialog();
    await click(card(d, /^ChatGPT/));
    expect(within(d).queryByRole("combobox", { name: "Conta" })).toBeNull();
    expect(d.textContent).toContain("Só Theo conecta um plano no MacBook.");
    expect((within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("choosing a plan brain starts on what can think there: the computer's own sign-in, a free account, or the sign-in", async () => {
    const plus: MachineAccount = { ...work, id: "acct_plus", kind: "codex", label: "Pessoal", plan: "Plus" };
    const usage = { windows: [], source: "probe" as const, at: NOW.toISOString() };
    const { state } = await onMac({ brain: "model", effectiveModel: null, accounts: [plus] }, { codex: { usage } });
    let d = await brainDialog();
    // Codex's own sign-in is reported on the MacBook its owner connected: the account the agents share.
    await click(card(d, /^ChatGPT/));
    expect(within(d).getByRole("combobox", { name: "Conta" }).textContent).toBe("A conta que os seus agentes dividem");
    // Claude Code's isn't, and nothing of Claude's is there: its sign-in, right away.
    await click(card(d, /^Claude/));
    expect(within(d).getByRole("region", { name: "Adicionar conta do Claude" })).toBeTruthy();
    await click(screen().getByRole("button", { name: "Cancelar" }));
    cleanup();
    // Without Codex's own sign-in reported, a ChatGPT account of hers that thinks for nobody.
    const second = await onMac({ brain: "model", effectiveModel: null, accounts: [plus] });
    d = await brainDialog();
    await click(card(d, /^ChatGPT/));
    expect(within(d).getByRole("combobox", { name: "Conta" }).textContent).toContain("Pessoal · Plus");
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(second.state).at(-1)).toMatchObject({ brain: "codex", account: "acct_plus" });
    expect(brainCalls(state)).toEqual([]);
  });

  test("Adicionar conta: no address asked, Claude's page opens beside, Colar sends only this sign-in's code; Voltar stops it", async () => {
    const { state, api } = await onMac();
    const opened: string[] = [];
    const popup = { closed: false, opener: {}, location: { href: "" }, close: () => {} };
    const realOpen = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return popup;
    }) as unknown as typeof window.open;
    let clip = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => clip, writeText: async () => {} },
    });
    try {
      const d = await brainDialog();
      await pick(d, "Conta", /^Adicionar conta/);
      await settle(6);
      const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
      // Nothing runs on the computer before the person goes on.
      expect(fakeMachinesOf.get(api)?.lastLogin()).toBeUndefined();
      // Where the account stays is the sign-in step's ⓘ.
      expect(hintOf("A conta com o seu plano", block).text).toBe(
        "Conta errada? Saia de lá e tente de novo. A conta fica só no MacBook. Você digita a senha na\u00a0página\u00a0do\u00a0Claude.",
      );
      expect(shownText(block)).not.toContain("digita a senha");
      // The person already has an account here: still no address to type, Claude's own page picks the account.
      expect(block.querySelector("input")).toBeNull();
      await click(within(block).getByRole("button", { name: "Entrar com Claude" }));
      await settle(6);
      expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
        ORG_ID,
        "machine_1",
        "claude_code",
      ]);
      // The window opened on the click itself went to Claude's page, cut off from the app.
      expect(opened).toEqual(["about:blank"]);
      expect(popup.opener).toBeNull();
      expect(popup.location.href).toBe("https://claude.ai/oauth/authorize?code=true&state=st4te");
      expect(within(block).getByRole("link", { name: "Abrir de novo" }).getAttribute("href")).toBe(
        "https://claude.ai/oauth/authorize?code=true&state=st4te",
      );
      const login = fakeMachinesOf.get(api)?.lastLogin();
      expect(login?.kind).toBe("claude_code");
      // Something else on the clipboard (a password) waits for Send, with a line; Colar goes while the field holds it.
      clip = "hunter2-password";
      await click(within(block).getByRole("button", { name: "Colar" }));
      await settle(4);
      expect(fakeMachinesOf.get(api)?.lastLogin()?.box).toBeNull();
      const field = within(block).getByRole("textbox", { name: "Código do Claude" }) as HTMLInputElement;
      expect(field.value).toBe("hunter2-password");
      expect(shownText(block)).toContain("Isso não parece o código do Claude.");
      expect(within(block).queryByRole("button", { name: "Colar" })).toBeNull();
      // Emptied, Colar is back; this sign-in's code (`…#<state>`) goes at once, sealed: the raw code is in no call.
      await act(async () => fireEvent.change(field, { target: { value: "" } }));
      clip = "c0de-from-claude#st4te";
      await click(within(block).getByRole("button", { name: "Colar" }));
      await settle(6);
      expect(fakeMachinesOf.get(api)?.lastLogin()?.box).not.toBeNull();
      expect(JSON.stringify(state.calls)).not.toContain("c0de-from-claude");
      expect((within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement).disabled).toBe(true);
      await click(within(block).getByRole("button", { name: "Voltar" }));
      await settle(4);
      expect(state.calls.find((c) => c.method === "machines.cancelAccountLogin")?.args).toEqual([
        ORG_ID,
        "machine_1",
        login?.loginId,
      ]);
      expect(within(d).getByRole("combobox", { name: "Conta" })).toBeTruthy();
    } finally {
      window.open = realOpen;
    }
  });

  test("Add account: Copy link begins the sign-in with no window, copies its link and shows the code step", async () => {
    const { state, api } = await onMac();
    const opened: string[] = [];
    const realOpen = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as unknown as typeof window.open;
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => "",
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    try {
      const d = await brainDialog();
      await pick(d, "Conta", /^Adicionar conta/);
      await settle(6);
      const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
      expect(within(block).queryByRole("textbox", { name: "Código do Claude" })).toBeNull();
      await click(within(block).getByRole("button", { name: "Copiar link" }));
      await settle(6);
      expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(1);
      expect(fakeMachinesOf.get(api)?.lastLogin()?.kind).toBe("claude_code");
      expect(opened).toEqual([]);
      expect(written).toEqual(["https://claude.ai/oauth/authorize?code=true&state=st4te"]);
      expect(within(block).getByRole("button", { name: "Copiado" })).toBeTruthy();
      expect(within(block).getByRole("textbox", { name: "Código do Claude" })).toBeTruthy();
      // Copied again, the same sign-in's link: no second one begins.
      await click(within(block).getByRole("button", { name: "Copiado" }));
      await settle(4);
      expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(1);
      expect(written).toHaveLength(2);
    } finally {
      window.open = realOpen;
    }
  });

  /** Claude's sign-in started from Add account, its code field showing; the sign-in window is a stand-in. */
  async function codeField() {
    const { state, api } = await onMac();
    const d = await brainDialog();
    await pick(d, "Conta", /^Adicionar conta/);
    await settle(6);
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(block).getByRole("button", { name: "Entrar com Claude" }));
      await settle(6);
    } finally {
      window.open = realOpen;
    }
    const field = within(block).getByRole("textbox", { name: "Código do Claude" });
    // ⌘V: the paste lands in the field as its new value.
    const paste = async (text: string) => {
      await act(async () => {
        fireEvent.paste(field, { clipboardData: { getData: () => text } });
        fireEvent.change(field, { target: { value: text } });
      });
      await settle(6);
    };
    return { state, api, block, paste, sealed: () => fakeMachinesOf.get(api)?.lastLogin()?.box ?? null };
  }

  test("while the code goes and the computer signs in, a line stands in for the field and its buttons; a failed send brings them back", async () => {
    const { api, block, paste } = await codeField();
    const real = api.machines.sendAccountCode;
    let answer = (_ok: boolean) => {};
    api.machines.sendAccountCode = (...args) =>
      new Promise<void>((resolve, reject) => {
        answer = (ok) => (ok ? resolve(real(...args)) : reject(new Error("offline")));
      });
    const code = () => within(block).getByRole("textbox", { name: "Código do Claude" }) as HTMLInputElement;
    /** The line, alone in the step with the product's spinner: no field, Colar, Enviar or Esperando beside it. */
    const busy = () => {
      const line = within(block).getByRole("status");
      expect(line.querySelector("canvas.ac-pixspin")).not.toBeNull();
      expect(block.querySelector("input")).toBeNull();
      expect(within(block).queryByRole("button", { name: /^(Colar|Enviar ao MacBook)$/ })).toBeNull();
      expect(shownText(block)).not.toContain("Esperando");
      return line;
    };
    code().focus();
    await paste("c0de-from-claude#st4te");
    const going = busy();
    expect(going.textContent).toBe("Enviando o código ao MacBook…");
    // The focus the field had goes to the line, not to the page.
    expect(document.activeElement === going).toBe(true);
    // The send fails: the field is back with the code in it, the error under it, and the focus.
    await act(async () => answer(false));
    await settle(4);
    expect(code().value).toBe("c0de-from-claude#st4te");
    expect(document.activeElement === code()).toBe(true);
    expect(shownText(block)).toContain("Não deu para enviar o código. Confira e tente de novo.");
    expect(shownText(block)).not.toContain("Enviando o código");
    // Sent again: the line says the computer is signing in, until the sign-in ends.
    await click(within(block).getByRole("button", { name: "Enviar ao MacBook" }));
    expect(busy().textContent).toBe("Enviando o código ao MacBook…");
    await act(async () => answer(true));
    await settle(6);
    expect(busy().textContent).toBe("Código enviado. O MacBook está terminando de entrar.");
    expect(shownText(block)).not.toContain("Não deu para enviar o código.");
  });

  test("the computer giving up on the code ends the sign-in with its reason, the focus still in the block", async () => {
    const { api, block, paste } = await codeField();
    const machines = fakeMachinesOf.get(api);
    machines?.endLogin(machines.lastLogin()?.loginId ?? "", { state: "failed" });
    (within(block).getByRole("textbox", { name: "Código do Claude" }) as HTMLInputElement).focus();
    await paste("c0de-from-claude#st4te");
    expect(shownText(block)).toContain("Não deu para entrar nessa conta. Tente de novo.");
    expect(within(block).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    expect(within(block).queryByRole("status")).toBeNull();
    expect(document.activeElement === block).toBe(true);
  });

  test("Claude's code pasted into its field with ⌘V goes to the computer by itself, no click", async () => {
    const { state, block, paste, sealed } = await codeField();
    await paste("c0de-from-claude#st4te");
    expect(sealed()).not.toBeNull();
    expect(JSON.stringify(state.calls)).not.toContain("c0de-from-claude");
    expect(shownText(block)).toContain("Código enviado. O MacBook está terminando de entrar.");
    expect(shownText(block)).not.toContain("Isso não parece o código do Claude.");
  });

  test("Colar refused by the browser, then ⌘V: the code goes, and the refusal's line with it", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => {
          throw new Error("denied");
        },
        writeText: async () => {},
      },
    });
    const { block, paste, sealed } = await codeField();
    await click(within(block).getByRole("button", { name: "Colar" }));
    await settle(4);
    expect(shownText(block)).toContain("O navegador não deixou colar.");
    await paste("c0de-from-claude#st4te");
    expect(sealed()).not.toBeNull();
    expect(shownText(block)).toContain("Código enviado. O MacBook está terminando de entrar.");
    expect(shownText(block)).not.toContain("O navegador não deixou colar.");
  });

  test("a code that isn't this sign-in's waits for Enviar, the one action, with a line under it", async () => {
    const { block, paste, sealed } = await codeField();
    await paste("c0de-from-claude#another-state");
    expect(sealed()).toBeNull();
    expect(shownText(block)).toContain("Isso não parece o código do Claude.");
    expect(within(block).queryByRole("button", { name: "Colar" })).toBeNull();
    const send = within(block).getByRole("button", { name: "Enviar ao MacBook" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await click(send);
    await settle(6);
    expect(sealed()).not.toBeNull();
    expect(shownText(block)).toContain("Código enviado. O MacBook está terminando de entrar.");
  });

  test("Claude's code sent while the server restarts: the computer didn't answer, not a wrong code; Enviar sends it again", async () => {
    const { api, block, paste, sealed } = await codeField();
    const sendCode = api.machines.sendAccountCode;
    api.machines.sendAccountCode = async () => {
      throw new ApiError(502, "http_502", "Bad Gateway");
    };
    await paste("c0de-from-claude#st4te");
    expect(shownText(block)).toContain("O MacBook não respondeu. Tente de novo em instantes.");
    expect(shownText(block)).not.toContain("Confira");
    // The computer refusing it is still about the code.
    api.machines.sendAccountCode = async () => {
      throw new ApiError(400, "account.invalid_code", "The sealed code is malformed");
    };
    // A line stands in for the field and its buttons while the code goes: Enviar is a new button after each send.
    const send = () => within(block).getByRole("button", { name: "Enviar ao MacBook" });
    await click(send());
    await settle(6);
    expect(shownText(block)).toContain("Não deu para enviar o código. Confira e tente de novo.");
    expect(shownText(block)).not.toContain("não respondeu");
    api.machines.sendAccountCode = sendCode;
    await click(send());
    await settle(6);
    expect(sealed()).not.toBeNull();
    expect(shownText(block)).toContain("Código enviado. O MacBook está terminando de entrar.");
  });

  test("Adicionar conta (ChatGPT): its settings first, then the sign-in on its button; the account is chosen", async () => {
    const codex: MachineAccount = { ...work, id: "acct_codex", kind: "codex", label: "Pessoal", plan: "Plus" };
    const { state, api } = await onMac({ brain: "codex", effectiveModel: "gpt-6-sol", accounts: [] });
    // The computer finishes the first sign-in as soon as the page asks.
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: codex });
    const d = await brainDialog();
    await pick(d, "Conta", /^Adicionar conta/);
    await settle(8);
    // Showing the steps starts nothing: device code sign-in has to be allowed in ChatGPT first.
    expect(state.calls.some((c) => c.method === "machines.beginAccountLogin")).toBe(false);
    const block = within(d).getByRole("region", { name: "Adicionar conta do ChatGPT" });
    expect(within(block).getByRole("link", { name: "Abrir as configurações do ChatGPT" })).toBeTruthy();
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(block).getByRole("button", { name: "Entrar com ChatGPT" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "codex",
    ]);
    expect(within(d).queryByRole("region", { name: "Adicionar conta do ChatGPT" })).toBeNull();
    expect(within(d).getByRole("combobox", { name: "Conta" }).textContent).toContain("Pessoal · Plus");
    expect(d.textContent).toContain("A conta Pessoal entrou no MacBook. Clique em Usar para salvar.");
    expect(state.calls.some((c) => c.method === "machines.cancelAccountLogin")).toBe(false);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "codex", model: null, fallback: true, account: "acct_codex" });
  });

  test("Adicionar conta (ChatGPT) while the server restarts: Reconectando, never a failure or an offline computer, then the account, one sign-in", async () => {
    const codex: MachineAccount = { ...work, id: "acct_codex", kind: "codex", label: "Pessoal", plan: "Plus" };
    const start = Date.now();
    setSystemTime(new Date(start));
    const { state, api, services } = await onMac({ brain: "codex", effectiveModel: "gpt-6-sol", accounts: [] });
    let online = true;
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => {
      const view = await viewOf(orgId, agentId);
      const on = <T extends { online: boolean }>(m: T) => ({ ...m, online });
      return { ...view, computer: view.computer && on(view.computer), machines: view.machines.map(on) };
    };
    const d = await brainDialog();
    await pick(d, "Conta", /^Adicionar conta/);
    await settle(8);
    const block = within(d).getByRole("region", { name: "Adicionar conta do ChatGPT" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(block).getByRole("button", { name: "Entrar com ChatGPT" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    const read = api.machines.accountLogin;
    const ask = async (after: number, error?: Error) => {
      setSystemTime(new Date(start + after));
      api.machines.accountLogin = error
        ? async () => {
            throw error;
          }
        : read;
      await act(() => services.queryClient.invalidateQueries());
      await settle(6);
    };
    // The MacBook drops out with its runner: no answer, then only the proxy's, then the computer still
    // reconnecting, for 20 s. The sign-in's block says so; no brain there reads as offline meanwhile.
    online = false;
    for (const [after, error] of [
      [3_000, new TypeError("Failed to fetch")],
      [10_000, new ApiError(502, "http_502", "Bad Gateway")],
      [20_000, new ApiError(409, "machine.offline", "The computer MacBook is offline.")],
    ] as const) {
      await ask(after, error);
      expect(shownText(block)).toContain("Reconectando…");
      expect(d.textContent).not.toMatch(/Não deu para entrar|não respondeu|está offline/);
      expect(d.querySelector(".ac-brand--off")).toBeNull();
    }
    // The sign-in went on there meanwhile.
    online = true;
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: codex });
    await ask(22_000);
    expect(d.textContent).toContain("A conta Pessoal entrou no MacBook. Clique em Usar para salvar.");
    expect(d.textContent).not.toMatch(/Não deu para entrar|não respondeu/);
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(1);
    expect(state.calls.some((c) => c.method === "machines.cancelAccountLogin")).toBe(false);
    // With no sign-in under way, an offline computer says so again.
    online = false;
    await ask(30_000);
    expect(d.textContent).toContain("O MacBook está offline");
  });
});

describe("Quem pensa: a plan with a login per agent, and plans on the Cloud", () => {
  const glm = (id: string, usedBy: string[]): MachineAccount => ({
    id,
    kind: "claude_code",
    label: "GLM Coding",
    email: null,
    plan: null,
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy,
    usage: null,
    provider: "zai",
    keyHint: "4f2a",
  });

  test("a coding plan whose logins think for other agents: one more for this one, its key pasted again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, {
        brain: "claude_code",
        effectiveModel: "sonnet",
        accounts: [glm("acct_theo", ["Theo"]), glm("acct_lia", ["Lia"])],
      });
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: glm("acct_ada", []) });
    await open(state, api);
    const d = await brainDialog();
    // The plan has its own card: Claude's account choice is Claude's alone.
    const options = async () => {
      const account = within(d).getByRole("combobox", { name: "Conta" });
      account.focus();
      await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
      return screen()
        .getAllByRole("option")
        .map((o) => o.textContent);
    };
    expect(await options()).toEqual(["A conta que os seus agentes dividem", "Adicionar conta"]);
    await act(async () => fireEvent.keyDown(screen().getAllByRole("option")[0] as HTMLElement, { key: "Escape" }));
    await click(card(d, /^GLM Coding/));
    // One option for the account, not one per login.
    expect(await options()).toEqual(["GLM CodingTambém usada por Theo e Lia", "Adicionar conta"]);
    await click(screen().getByRole("option", { name: /^GLM Coding/ }));
    const block = within(d).getByRole("region", { name: "Conectar GLM Coding" });
    fireEvent.change(within(block).getByLabelText("Chave do GLM Coding"), {
      target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
    });
    await click(within(block).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { provider: "zai" },
    ]);
    expect(d.textContent).toContain("A conta GLM Coding entrou no MacBook. Clique em Usar para salvar.");
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_ada" });
  });

  test("on the Cloud too, the plan's owner lets it answer other people: the switch, its line and ⓘ", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", onlyOwner: true });
    await open(state, api);
    const d = await brainDialog();
    const a = await advanced(d);
    const replies = within(a).getByRole("switch", { name: "Atende outras pessoas" });
    expect(replies.getAttribute("aria-checked")).toBe("false");
    expect(shownText(a)).toContain("A Ada só atende você, pelo seu plano do Claude.");
    expect(hintOf("os termos do plano", a).text).toContain("Os planos do Claude são para uso pessoal.");
    expect(shownText(a)).not.toContain("Um plano é pessoal");
    await click(replies);
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: null, fallback: true, onlyOwner: false });
  });
});

describe("Quem pensa: a coding plan's models", () => {
  /** One of Walter's key accounts of `provider` on the MacBook. */
  const planKey = (provider: string | null, over: Partial<MachineAccount> = {}): MachineAccount => ({
    id: "acct_plan",
    kind: "claude_code",
    label: "Plano",
    email: null,
    plan: null,
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy: ["Ada"],
    usage: null,
    provider,
    keyHint: "4f2a",
    ...over,
  });
  /** Ada thinks with Claude Code on the MacBook, with Walter's key account of `provider`. */
  async function onPlan(provider: string, patch: Partial<AgentBrain> = {}, over: Partial<MachineAccount> = {}) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, {
        brain: "claude_code",
        effectiveModel: "sonnet",
        account: "acct_plan",
        accounts: [planKey(provider, over)],
        ...patch,
      });
    await open(state, api);
    return { state, api };
  }
  /** What one of the opened card's dropdowns offers (it closes again). */
  const offered = async (d: HTMLElement, select: string) => {
    const trigger = within(d).getByRole("combobox", { name: select });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const shown = screen()
      .getAllByRole("option")
      .map((o) => o.textContent);
    await act(async () => fireEvent.keyDown(screen().getAllByRole("option")[0] as HTMLElement, { key: "Escape" }));
    await settle(2);
    return shown;
  };

  test("every model of the plan in a select, by maker, each with what it's sold as and needs; saved by its id", async () => {
    const { state } = await onPlan("opencode");
    const d = await brainDialog();
    expect(within(d).queryByRole("radiogroup", { name: "Modelo" })).toBeNull();
    const trigger = within(d).getByRole("combobox", { name: "Modelo" });
    expect(trigger.textContent).toBe("MiniMax M3");
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const options = screen()
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toHaveLength(29);
    expect(options.slice(0, 4)).toEqual([
      "AutomáticoEscolhe o modelo e o esforço para cada tarefa",
      "MiniMax M3",
      "MiniMax M3.1 Flash",
      "Claude Haiku 5.5",
    ]);
    expect(options).toContain("Kimi K3.1 ProTopo de linha");
    // Grouped by maker, as the workspace's models are, each beside its logo.
    const list = screen().getByRole("listbox");
    expect([...list.querySelectorAll(".ac-menu__heading")].map((h) => h.textContent)).toEqual([
      "MiniMax",
      "Claude",
      "Z.ai",
      "Kimi",
      "Alibaba",
      "DeepSeek",
      "Xiaomi",
      "OpenAI",
      "Gemini",
      "xAI",
      "Meituan",
      "Tencent",
      "StepFun",
      "Meta",
      "Reflection",
      "OpenCode",
    ]);
    expect(list.querySelectorAll(".ac-menu__leading")).toHaveLength(29);
    // Every maker's own mark, never its initial.
    expect(list.querySelectorAll(".ac-brand__initial")).toHaveLength(0);
    expect(
      within(list).getByRole("group", { name: "Tencent" }).querySelector(".ac-brand")?.getAttribute("data-mark"),
    ).toBe("tencent");
    // DeepSeek's answer only once the OpenCode workspace allows the Global region: said behind the ⓘ at the row's
    // end, the row's description, never a line of the row.
    const deepseek = within(within(list).getByRole("group", { name: "DeepSeek" })).getAllByRole("option");
    expect(deepseek.map((o) => o.querySelector(".ac-menu__desc")?.textContent ?? null)).toEqual([null, "Econômico"]);
    const described = (o: HTMLElement) =>
      document.getElementById(o.getAttribute("aria-describedby") ?? "")?.textContent;
    expect(deepseek.map(described)).toEqual([
      "Precisa da região Global no OpenCode.",
      "Precisa da região Global no OpenCode.",
    ]);
    // A model that trains on what it's sent: its provider does, never agentes.chat.
    const beam = screen().getByRole("option", { name: "Beam Free" });
    expect(described(beam)).toBe(
      "Grátis. O provedor pode usar os pedidos para treinar o modelo. Ligue a permissão no OpenCode.",
    );
    const tip = () => document.querySelector(".ac-menu__tip")?.textContent ?? null;
    const info = beam.querySelector(".ac-menu__hint") as HTMLElement;
    // The pointer resting on the ⓘ shows the note; a click on it shows it too, and never picks the model.
    await act(async () => fireEvent.pointerEnter(info, { pointerType: "mouse" }));
    expect(tip()).toBe(described(beam) ?? "");
    await act(async () => fireEvent.pointerLeave(info, { pointerType: "mouse" }));
    expect(tip()).toBeNull();
    await act(async () => fireEvent.click(info));
    expect(tip()).toBe(described(beam) ?? "");
    expect(screen().queryByRole("listbox")).not.toBeNull();
    await act(async () => fireEvent.pointerLeave(info, { pointerType: "mouse" }));
    // A real mouse enters before it clicks: the click keeps the note the hover showed.
    await act(async () => fireEvent.pointerEnter(info, { pointerType: "mouse" }));
    await act(async () => fireEvent.click(info));
    expect(tip()).toBe(described(beam) ?? "");
    await act(async () => fireEvent.pointerLeave(info, { pointerType: "mouse" }));
    expect(tip()).toBeNull();
    // The keys reaching the option show it as well. The key goes to the page, not the list: on an arrow, Radix
    // moves the focus itself in a timeout, to the option after the one the key was pressed on.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      (deepseek[0] as HTMLElement).focus();
      fireEvent.keyUp(document.body, { key: "ArrowDown" });
    });
    expect(tip()).toBe("Precisa da região Global no OpenCode.");
    await click(screen().getByRole("option", { name: /^DeepSeek V4\.1 Flash/ }));
    // Chosen, what it needs is said once: under it, how to give it, with the plan's page.
    expect(within(d).getByRole("combobox", { name: "Modelo" }).textContent).toBe("DeepSeek V4.1 FlashEconômico");
    expect(d.textContent).toContain(
      "Ligue a região Global no OpenCode, em Settings\u00a0›\u00a0Privacy. Sem ela, este modelo não responde.",
    );
    expect(within(d).getByRole("link", { name: "Abrir opencode.ai" }).getAttribute("href")).toBe(
      "https://opencode.ai/console",
    );
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", model: "deepseek-v4.1-flash" });
    expect(document.body.textContent).toContain("A Ada agora pensa com DeepSeek V4.1 Flash pelo OpenCode Go.");
  });

  test("a coding plan is a card of its own: its keys alone under Conta, its models; another card starts on its own", async () => {
    await onPlan("opencode", {
      model: "deepseek-v4.1-flash",
      effectiveModel: "deepseek-v4.1-flash",
      accounts: [
        planKey("opencode"),
        planKey("opencode", { id: "acct_oc2", label: "Plano 2", usedBy: [], keyHint: "9f3c" }),
        planKey("zai", { id: "acct_theirs", mine: false, usedBy: [], keyHint: "1b2c" }),
        planKey(null, { id: "acct_claude", label: "Pessoal", keyHint: null, plan: "Max", usedBy: [] }),
      ],
    });
    const d = await brainDialog();
    const rows = within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getAllByRole("radio");
    // Only the plans with an account of the viewer's there, or the one the agent thinks with.
    expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.textContent)).toEqual([
      "Chave de API",
      "Claude",
      "ChatGPT",
      "OpenCode Go",
    ]);
    const opencode = card(d, /^OpenCode Go/);
    expect(opencode.getAttribute("aria-checked")).toBe("true");
    expect(opencode.querySelector(".ac-brand[data-mark='opencode']")).not.toBeNull();
    expect(opencode.querySelector(".ac-optrow__desc")?.textContent).toBe("Usa o seu plano do OpenCode Go");
    // It thinks where its key is: nothing beside it on the computer the agent works on.
    expect(opencode.querySelector(".ac-optrow__side")).toBeNull();
    expect(await offered(d, "Conta")).toEqual(["Planochave …4f2a", "Plano 2chave …9f3c", "Adicionar conta"]);
    // Claude: its models from Sonnet, its own accounts.
    await click(card(d, /^Claude/));
    expect(within(d).getByRole("combobox", { name: "Modelo" }).textContent).toBe(
      "SonnetEquilibrado. Bom para quase tudo.",
    );
    expect(await offered(d, "Modelo")).toHaveLength(4);
    expect(await offered(d, "Conta")).toEqual(["Pessoal · Max", "Adicionar conta"]);
    // Back on OpenCode Go: what it had.
    await click(card(d, /^OpenCode Go/));
    expect(within(d).getByRole("combobox", { name: "Modelo" }).textContent).toBe("DeepSeek V4.1 FlashEconômico");
    expect(within(d).getByRole("combobox", { name: "Conta" }).textContent).toContain("Plano");
  });

  test("a plan's card starts on a key made for all of its owner's agents there, though another agent thinks with it", async () => {
    const { state } = await onPlan("opencode", {
      account: null,
      accounts: [planKey("opencode", { id: "acct_oc", usedBy: ["Theo"], shared: true })],
    });
    const d = await brainDialog();
    expect(card(d, /^Claude/).getAttribute("aria-checked")).toBe("true");
    await click(card(d, /^OpenCode Go/));
    expect(within(d).getByRole("combobox", { name: "Conta" }).textContent).toContain("Plano");
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", account: "acct_oc" });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("moveAccount");
  });

  test("a key its plan refused: said so, and its last option asks the same account for a new key", async () => {
    const { state } = await onPlan("opencode", {}, { status: "signed_out" });
    const d = await brainDialog();
    expect(d.textContent).toContain("A chave foi recusada: troque por uma nova.");
    expect(await offered(d, "Conta")).toEqual(["PlanoA chave foi recusada: troque por uma nova.", "Trocar a chave"]);
    await pick(d, "Conta", /^Trocar a chave/);
    const block = within(d).getByRole("region", { name: "Conectar OpenCode Go" });
    fireEvent.change(within(block).getByLabelText("Chave do OpenCode Go"), {
      target: { value: "oc_sk_fake-key-for-tests" },
    });
    await click(within(block).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { accountId: "acct_plan", provider: "opencode" },
    ]);
  });

  test("the cell: the plan that pays in its label, the model and its effort under it, its account among two of that plan", async () => {
    await onPlan("opencode", { model: "deepseek-v4.1-flash", effectiveModel: "deepseek-v4.1-flash", effort: "max" });
    expect(brainCell()).toEqual({
      label: "Pensa com OpenCode Go",
      value: "DeepSeek V4.1 Flash · esforço máximo",
      sub: undefined,
    });
    expect(sentence().querySelector(".ac-brand[data-mark='opencode']")).not.toBeNull();
    cleanup();
    await onPlan("opencode", {
      accounts: [planKey("opencode"), planKey("opencode", { id: "acct_oc2", label: "Plano 2", keyHint: "9f3c" })],
    });
    expect(brainCell().sub).toBe("Plano");
  });

  test("Conectar outro plano, for the agent's owner: Quem pensa closes and Connect an AI opens for this agent", async () => {
    await onPlan("opencode");
    const d = await brainDialog();
    await click(within(d).getByRole("button", { name: "Conectar outro plano" }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: "Quem pensa" })).toBeNull();
    expect(screen().getByRole("dialog", { name: "Conectar uma IA para a Ada" })).toBeTruthy();
    cleanup();
    await onPlan("opencode", { canUsePlans: false, canManageAccounts: false });
    expect(within(await brainDialog()).queryByRole("button", { name: "Conectar outro plano" })).toBeNull();
  });

  test("an admin moves its owner's agent off the owner's coding plan, onto the owner's other plans or the API", async () => {
    await onPlan("opencode", { canUsePlans: false, canManageAccounts: false }, { mine: false });
    const d = await brainDialog();
    const claude = card(d, /^Claude/);
    expect(claude.hasAttribute("disabled")).toBe(false);
    expect(claude.textContent).toContain("Usa o plano do Claude de João");
    expect(d.textContent).not.toContain("Só João troca");
    expect(card(d, /^ChatGPT/).hasAttribute("disabled")).toBe(false);
    expect(card(d, /^Chave de API/).hasAttribute("disabled")).toBe(false);
    expect(card(d, /^OpenCode Go/).textContent).toContain("Usa o plano do OpenCode Go de João");
  });

  test("the cell names the plan's model it runs; models sold with words show them, a plan's only model too", async () => {
    await onPlan("kimi", { model: "k3-256k", effectiveModel: "k3-256k" });
    expect(sentence().textContent).toContain("K3 256K");
    cleanup();
    await onPlan("zai", { model: "opus", effectiveModel: "opus" });
    let d = await brainDialog();
    expect(within(d).queryByRole("radiogroup", { name: "Modelo" })).toBeNull();
    // An alias the plan leaves out runs its main model: shown as that one, with what it's sold as.
    const trigger = within(d).getByRole("combobox", { name: "Modelo" });
    expect(trigger.textContent).toBe("GLM-5.3Topo de linha");
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "AutomáticoEscolhe o modelo e o esforço para cada tarefa",
      "GLM-5.3Topo de linha",
      "GLM-5.3 FlashEconômico",
    ]);
    cleanup();
    await onPlan("minimax");
    d = await brainDialog();
    // The model is a select on every brain, a plan of one model too.
    const one = within(d).getByRole("combobox", { name: "Modelo" });
    expect(one.textContent).toBe("MiniMax M3.1 Flash");
    one.focus();
    await act(async () => fireEvent.keyDown(one, { key: "Enter" }));
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["AutomáticoEscolhe o modelo e o esforço para cada tarefa", "MiniMax M3.1 Flash"]);
  });
});

describe("Onde trabalha and the browser (their dialogs)", () => {
  test("each computer says what it has; choosing one saves at once", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await open(state, api);
    const d = await dialog("Mudar onde trabalha", "Onde a Ada trabalha?");
    const mac = within(d).getByRole("radio", { name: /^MacBook/ });
    expect(mac.textContent).toContain("Ligado · Claude Code · Codex · Navegador");
    // Portraits are as wide as their drawings: each sits in the same column, so the names line up, and the drawing
    // starts at the row's edge like any other lead. "Nenhum computador" leads with a dash in that column.
    const options = within(d).getAllByRole("radio");
    expect(options.length).toBeGreaterThan(1);
    const none = within(d).getByRole("radio", { name: /^Nenhum computador/ });
    expect(none.querySelector(".ac-optrow__lead > .machine-row__pic > svg.ac-icon")).toBeTruthy();
    for (const option of options.filter((o) => !o.textContent?.startsWith("Nenhum computador")))
      expect(option.querySelector(".ac-optrow__lead > .machine-row__pic > canvas.ac-computer")).toBeTruthy();
    const css = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
    const column = css.split("\n.machine-row__pic {")[1]?.split("}")[0] ?? "";
    expect(column).toContain("width: 48px");
    expect(column).not.toContain("center");
    await click(mac);
    await click(within(d).getByRole("button", { name: "Usar o MacBook" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args.slice(1)).toEqual([ADA_ID, "machine_1"]);
    expect(document.body.textContent).toContain("A Ada agora trabalha no MacBook.");
  });

  test("the browser with no computer: the agent moves to the MacBook, and the steps there show before it's allowed", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, false);
    await open(state, api);
    const d = await dialog("Mudar o navegador", "A Ada pode navegar em sites?");
    await click(within(d).getByRole("radio", { name: /^Qualquer site/ }));
    expect(d.textContent).toContain("A Ada passa para o MacBook, que tem navegador.");
    const steps = within(d).getByRole("region", { name: "Falta 1 passo, no próprio MacBook" });
    // The app's icon sits by the clock: at the top on a Mac, at the bottom on a PC.
    expect(steps.textContent).toContain("Clique no ícone do agentes.chat perto do relógio");
    expect(steps.querySelector(".machine-command__code")).toBeNull();
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args.slice(1)).toEqual([ADA_ID, "machine_1"]);
    expect(state.calls.some((c) => c.method === "access.set")).toBe(true);
    expect(document.body.textContent).toContain("Falta 1 passo no MacBook.");
  });

  test("on a Linux computer, maybe a server without the app, the step there is the command too", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.pair({
      id: "machine_1",
      name: "Servidor",
      os: "linux",
      mode: "system",
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: false } },
      browser: { available: false, version: null, chrome: null, reason: null },
    });
    await open(state, api);
    const d = await dialog("Mudar o navegador", "A Ada pode navegar em sites?");
    await click(within(d).getByRole("radio", { name: /^Qualquer site/ }));
    const steps = within(d).getByRole("region", { name: "Falta 1 passo, no próprio Servidor" });
    expect(steps.textContent).toContain(
      "Só quem está no computador liga, no app do agentes.chat: Preferências → Ferramentas.Sem o app? No terminal do computador:",
    );
    expect(steps.querySelector(".machine-command__code")?.textContent).toBe("sudo agentes-runner tools enable browser");
    expect(steps.querySelector(".brw-steps__grid")).toBeNull();
  });

  /**
   * Ada's browser on Servidor, a Linux computer (`machine` over it), and the page open. `reason`: what the server says
   * of her browser there; null: she still has no computer, so turning it on moves her there.
   */
  const onServidor = async (
    machine: Partial<Machine>,
    reason: BrowserUnavailableReason | null,
    { cloud = false, granted = false } = {},
  ) => {
    cleanup();
    const state = seedState();
    if (granted) state.scopes[ADA_ID] = [...(state.scopes[ADA_ID] ?? []), { connectionId: null, scope: "browser:use" }];
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    machines?.pair({ id: "machine_1", name: "Servidor", os: "linux", mode: "system", ...machine });
    if (cloud) machines?.setSetup({ state: "ready", machineId: "machine_1" });
    if (reason) {
      await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
      fakeBrowserOf.get(api)?.settings.set(ADA_ID, {
        allowedDomains: null,
        available: false,
        reason,
        detail: null,
        machine: { id: "machine_1", name: "Servidor" },
      });
    }
    await open(state, api);
  };
  const tools = (browser?: boolean) => ({
    folders: [],
    tools: { claude: true, codex: true, commands: true, ...(browser === undefined ? {} : { browser }) },
  });
  const command = (steps: Element | null) => steps?.querySelector(".machine-command__code")?.textContent;

  test("the step is only for a switch that is off, on a computer someone here reaches", async () => {
    const stepsIn = async (...args: Parameters<typeof onServidor>) => {
      await onServidor(...args);
      const d = await dialog("Mudar o navegador", "A Ada pode navegar em sites?");
      await click(within(d).getByRole("radio", { name: /^Qualquer site/ }));
      return d.querySelector(".brw-steps");
    };
    const missing = {
      available: false,
      version: "1",
      chrome: null,
      reason: "Chrome's libraries are missing: run `agentes-runner browser install --with-deps`",
    };
    expect(command(await stepsIn({ access: tools(false) }, "switched_off"))).toBe(
      "sudo agentes-runner tools enable browser",
    );
    // Switched on, and Chrome's libraries missing there: nothing to turn on, where she is or where she'd move.
    expect(await stepsIn({ access: tools(true), browser: missing }, "not_installed")).toBeNull();
    expect(await stepsIn({ access: tools(true), browser: missing }, null)).toBeNull();
    // A runner from before the browser has no switch for it.
    expect(await stepsIn({ access: tools() }, "outdated")).toBeNull();
    // The workspace's own computer: nobody here reaches it.
    expect(
      await stepsIn({ kind: "managed", os: "other", access: tools(false) }, "switched_off", { cloud: true }),
    ).toBeNull();
  });

  test("under the sentence, the step waits for a switch that is off, not for one that is on", async () => {
    await onServidor({ access: tools(false) }, "switched_off", { granted: true });
    expect(command(screen().getByRole("region", { name: "Falta 1 passo, no próprio Servidor" }))).toBe(
      "sudo agentes-runner tools enable browser",
    );
    // On, and the computer hasn't said yet whether it runs.
    await onServidor({ access: tools(true) }, "not_reported", { granted: true });
    expect(document.querySelector(".brw-steps")).toBeNull();
  });
});

describe("Quem pensa: the draft", () => {
  const saved: Saved = {
    name: "Ada",
    handle: "ada",
    role: "",
    look: { color: "sky", eyes: "round", accessory: "none" },
    instructions: "",
    model: "claude-sonnet-5-5",
    owner: "u-joao",
    audience: { mode: "everyone", userIds: [] },
    brain: { brain: "model", model: null, fallback: true },
  };
  const api: BrainChoice = { brain: "model", model: null, fallback: true };

  test("only real differences count", () => {
    expect(changedKeys(saved, { brain: { ...api } })).toEqual([]);
    expect(sameBrain(api, { ...api, model: "opus" })).toBe(true);
    expect(changedKeys(saved, { brain: { ...api, fallback: false } }).map((c) => c.key)).toEqual(["brain"]);
    expect(
      changedKeys(saved, { brain: { brain: "claude_code", model: null, fallback: true } }).map((c) => c.key),
    ).toEqual(["brain"]);
  });
});

describe("Quem pensa: Automático", () => {
  /** Ada thinks with Claude Code on the MacBook (as given). */
  async function onClaude(patch: Partial<AgentBrain> = {}) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", ...patch });
    await open(state, api);
    return state;
  }

  test("Claude Code: Automático comes first for the model and picks the effort too; Usar saves both", async () => {
    const state = await onClaude();
    const d = await brainDialog();
    // Each with what it is for.
    expect(await modelNames(d)).toEqual([
      "AutomáticoEscolhe o modelo e o esforço para cada tarefa",
      "OpusO mais capaz. Gasta o plano mais rápido.",
      "SonnetEquilibrado. Bom para quase tudo.",
      "HaikuRápido e leve. Para tarefas simples.",
    ]);
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    // A fixed model: the effort's four levels, none of them Automático, in the advanced settings, whose row names
    // what it holds.
    const row = () => within(d).getByRole("button", { name: /^Configuração avançada/ }).textContent;
    expect(row()).toContain("Esforço, janela de contexto e quem atende");
    let a = await advanced(d);
    const ramp = within(a).getByRole("slider", { name: "Esforço" });
    expect(ramp.getAttribute("aria-valuemax")).toBe("4");
    expect(ramp.getAttribute("aria-valuetext")).toBe("Médio");
    await done(a);
    await model(d, /^Automático/);
    expect(d.textContent).toContain("Escolhe o modelo e o esforço para cada tarefa");
    // The model picks the effort too: no ramp to set, and the place says so and how to set it.
    expect(row()).toContain("Janela de contexto e quem atende");
    expect(row()).not.toContain("Esforço");
    a = await advanced(d);
    expect(within(a).queryByRole("slider", { name: "Esforço" })).toBeNull();
    expect(a.textContent).toContain(
      "EsforçoO modelo Automático escolhe o esforço de cada tarefa. Escolha um modelo para fixar o esforço.",
    );
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: "auto", fallback: true, effort: "auto" });
  });

  test("back to a fixed model: the ramp returns at Médio and the effort is saved", async () => {
    const state = await onClaude({ model: "auto", effectiveModel: "auto", effort: "auto" });
    const d = await brainDialog();
    let a = await advanced(d);
    expect(within(a).queryByRole("slider", { name: "Esforço" })).toBeNull();
    await done(a);
    await model(d, /^Opus/);
    a = await advanced(d);
    expect(within(a).getByRole("slider", { name: "Esforço" }).getAttribute("aria-valuetext")).toBe("Médio");
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", model: "opus", effort: "medium" });
  });

  test("a new agent (Automático on every brain) switching to Claude Code starts there on Automático", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Its own Claude Code sign-in is there: Claude Code starts on it, not on a sign-in.
    reportOwn(api, { claude_code: { plan: "max" } });
    // New agents are created with the effort on auto too; the API brain doesn't show it.
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { effort: "auto" });
    await open(state, api);
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    expect(within(d).getByRole("combobox", { name: "Modelo" }).textContent).toStartWith("Automático");
    const a = await advanced(d);
    expect(within(a).queryByRole("slider", { name: "Esforço" })).toBeNull();
    await done(a);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: "auto", fallback: true });
  });

  test("a saved Automático reads as such in the cell", async () => {
    await onClaude({ model: "auto", effectiveModel: "auto", effort: "auto" });
    // The only Claude account there is the computer's own: the plan's name, not the account's. Automático picks the
    // effort too, so no effort follows it.
    expect(brainCell()).toEqual({ label: "Pensa com Claude", value: "Automático", sub: undefined });
  });

  test("the organization's model: Automático is the first choice, and Usar saves the agent's model as auto", async () => {
    const { state } = await open();
    const d = await brainDialog();
    const trigger = within(d).getByRole("combobox", { name: "Modelo" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const first = screen().getAllByRole("option")[0] as HTMLElement;
    expect(first.textContent).toBe("AutomáticoEscolhe o modelo e o esforço para cada tarefa");
    await click(first);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2])).toEqual([{ model: "auto" }]);
    expect(document.body.textContent).toContain("A Ada agora pensa com Automático.");
  });

  test("OpenRouter's models: a search over them, its good picks before the rest, each with its price", async () => {
    const seeded = seedState({ extraModels: OPENROUTER_MODELS });
    seeded.credentials.push(OPENROUTER_KEY);
    const { state } = await open(seeded);
    const d = await brainDialog();
    await click(within(d).getByRole("combobox", { name: "Modelo" }));
    const list = screen().getByRole("listbox", { name: "Modelos" });
    const groups = within(list)
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Claude", "OpenAI", "OpenRouter · Boas escolhas", "OpenRouter"]);
    const search = screen().getByRole("combobox", { name: "Buscar modelos" });
    await act(async () => fireEvent.change(search, { target: { value: "glm" } }));
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Z.ai: GLM LatestUS$ 0,1 / US$ 2,77 por milhão de tokens",
      "Z.ai: GLM 5.3US$ 0,1 / US$ 2,77 por milhão de tokens",
    ]);
    // The maker's name and the id find them too; a free one says so.
    await act(async () => fireEvent.change(search, { target: { value: "nvidia free" } }));
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["NVIDIA: Nemotron 3 Ultra (free)Grátis, com limite diário"]);
    await act(async () => fireEvent.change(search, { target: { value: "glm" } }));
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2])).toEqual([
      { model: "~z-ai/glm-latest" },
    ]);
  });

  test("without an OpenRouter key its good picks show, each saying a key opens it, and not the rest of its list", async () => {
    await open(seedState({ extraModels: OPENROUTER_MODELS }));
    const d = await brainDialog();
    await click(within(d).getByRole("combobox", { name: "Modelo" }));
    const list = screen().getByRole("listbox", { name: "Modelos" });
    const picks = within(within(list).getByRole("group", { name: "OpenRouter · Boas escolhas" })).getAllByRole(
      "option",
    );
    expect(picks.map((o) => [o.textContent, o.getAttribute("aria-disabled")])).toEqual([
      ["Z.ai: GLM LatestPrecisa de uma chave de API OpenRouter", "true"],
      ["DeepSeek: DeepSeek Flash LatestPrecisa de uma chave de API OpenRouter", "true"],
      ["Claude Sonnet LatestPrecisa de uma chave de API OpenRouter", "true"],
    ]);
    expect(within(list).queryByRole("group", { name: "OpenRouter" })).toBeNull();
  });
});

describe("Usar em outros agentes (ADR 0094)", () => {
  const LIA_ID = "00000000-0000-4000-8000-0000000000a9";

  async function withOthers(tweak?: (api: ReturnType<typeof createFakeApi>) => void) {
    const state = seedState();
    const [, atlas] = state.agents;
    if (!atlas) throw new Error("no Atlas");
    state.agents.push({ ...atlas, id: LIA_ID, name: "Lia", handle: "lia" });
    state.setupResults = { [LIA_ID]: { status: "skipped", reason: "other_computer", params: { computer: "PC" } } };
    const api = createFakeApi(state);
    tweak?.(api);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    reportOwn(api, { claude_code: { plan: "max" } });
    await open(state, api);
    return state;
  }
  const copyCalls = (state: ReturnType<typeof seedState>) =>
    state.calls.filter((c) => c.method === "agents.applySetup").map((c) => c.args[1]);

  test("after choosing: the others with what each would do, Todos picks who can, one call saves Ada and them", async () => {
    const state = await withOthers();
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    await model(d, /^Opus/);
    await click(within(d).getByRole("button", { name: /^Usar em outros agentes/ }));
    const c = screen().getByRole("dialog", { name: "Usar em outros agentes" });
    expect(c.textContent).toContain("Eles passam a pensar com Opus pelo plano do Claude.");
    // What each would do, from the server's preview, Ada first as she is saved first: nothing saved yet.
    expect(copyCalls(state)).toEqual([
      {
        setup: expect.objectContaining({ brain: "claude_code", machineId: "machine_1", model: "opus" }),
        agentIds: [ADA_ID, ATLAS_ID, LIA_ID],
        preview: true,
      },
    ]);
    expect(within(c).queryByRole("checkbox", { name: /^Ada/ })).toBeNull();
    expect(brainCalls(state)).toEqual([]);
    const atlas = within(c).getByRole("checkbox", { name: /^Atlas/ });
    expect(atlas.closest("label")?.textContent).toContain("Hoje: Claude Sonnet 5.5");
    const lia = within(c).getByRole("checkbox", { name: /^Lia/ });
    expect(lia.closest("label")?.textContent).toContain("Trabalha no PC");
    expect(lia.hasAttribute("disabled")).toBe(true);
    const use = () => within(c).getByRole("button", { name: /^(Usar em|Escolha)/ }) as HTMLButtonElement;
    expect(use().textContent).toBe("Escolha os agentes");
    expect(use().disabled).toBe(true);
    await click(within(c).getByRole("checkbox", { name: /^Todos/ }));
    expect(atlas.getAttribute("aria-checked")).toBe("true");
    expect(lia.getAttribute("aria-checked")).toBe("false");
    expect(use().textContent).toBe("Usar em 1 agente");
    await click(use());
    await settle(6);
    // Ada's own choice first, then the others in one call.
    expect(brainCalls(state)).toEqual([expect.objectContaining({ brain: "claude_code", model: "opus" })]);
    expect(copyCalls(state).at(-1)).toEqual({
      setup: expect.objectContaining({ brain: "claude_code", model: "opus", effort: "medium" }),
      agentIds: [ATLAS_ID],
    });
    expect(document.body.textContent).toContain("1 agente agora pensa com Opus pelo plano do Claude.");
    expect(screen().queryByRole("dialog", { name: "Quem pensa" })).toBeNull();
    // No agent picked on someone else's plan: nothing asked.
    expect(screen().queryByRole("dialog", { name: /^Usar o plano/ })).toBeNull();
  });

  test("an agent picked on someone else's plan: one question naming its owner first; Cancelar saves nothing, Continuar once", async () => {
    const state = await withOthers();
    state.setupResults = {
      ...state.setupResults,
      [ATLAS_ID]: { status: "applied", opensPlan: true },
    };
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    await model(d, /^Opus/);
    await click(within(d).getByRole("button", { name: /^Usar em outros agentes/ }));
    const c = screen().getByRole("dialog", { name: "Usar em outros agentes" });
    await click(within(c).getByRole("checkbox", { name: /^Atlas/ }));
    const saves = () => copyCalls(state).filter((x) => !(x as { preview?: boolean }).preview);
    await click(within(c).getByRole("button", { name: "Usar em 1 agente" }));
    const q = screen().getByRole("dialog", { name: "Usar o plano de João?" });
    expect(q.textContent).toContain(
      "As conversas com Atlas vão usar o plano do Claude de João e os limites dele. João vai receber um email avisando.",
    );
    await click(within(q).getByRole("button", { name: "Cancelar" }));
    await settle(4);
    expect(screen().queryByRole("dialog", { name: /^Usar o plano/ })).toBeNull();
    expect(brainCalls(state)).toEqual([]);
    expect(saves()).toEqual([]);
    await click(within(c).getByRole("button", { name: "Usar em 1 agente" }));
    await click(
      within(screen().getByRole("dialog", { name: "Usar o plano de João?" })).getByRole("button", {
        name: "Continuar",
      }),
    );
    await settle(6);
    expect(brainCalls(state)).toHaveLength(1);
    expect(saves()).toEqual([
      { setup: expect.objectContaining({ brain: "claude_code", model: "opus" }), agentIds: [ATLAS_ID] },
    ]);
  });

  test("the Autonomia goes too: said with the setup, each agent's change on its line, even where the AI can't", async () => {
    const state = await withOthers((api) => {
      const brain = api.agents.brain;
      api.agents.brain = async (orgId, agentId) => ({
        ...(await brain(orgId, agentId)),
        ...(agentId === ADA_ID ? { autonomy: "never" as const } : {}),
      });
    });
    state.setupResults = {
      [ATLAS_ID]: { status: "same", autonomy: { from: "always", to: "never" } },
      [LIA_ID]: {
        status: "skipped",
        reason: "other_computer",
        params: { computer: "PC" },
        autonomy: { from: "low_risk_auto", to: "never" },
      },
    };
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    await model(d, /^Opus/);
    const row = within(d).getByRole("button", { name: /^Usar em outros agentes/ });
    expect(row.textContent).toContain("A mesma IA, o modelo, o esforço e a autonomia");
    await click(row);
    const c = screen().getByRole("dialog", { name: "Usar em outros agentes" });
    expect(c.textContent).toContain("Eles passam a pensar com Opus pelo plano do Claude · Autonomia: Não pergunta.");
    expect(copyCalls(state)[0]).toMatchObject({ setup: { autonomy: "never" }, preview: true });
    // Atlas already thinks so and Lia works on another computer: only their Autonomia changes, and they can take it.
    const atlas = within(c).getByRole("checkbox", { name: /^Atlas/ });
    expect(atlas.closest("label")?.textContent).toContain("Já pensa assim · Autonomia: Pergunta sempre → Não pergunta");
    expect(atlas.hasAttribute("disabled")).toBe(false);
    const lia = within(c).getByRole("checkbox", { name: /^Lia/ });
    expect(lia.closest("label")?.textContent).toContain(
      "Trabalha no PC · Autonomia: Só o que é arriscado → Não pergunta",
    );
    expect(lia.hasAttribute("disabled")).toBe(false);
    expect(c.textContent).toContain("2 agentes podem usar");
    await click(within(c).getByRole("checkbox", { name: /^Todos/ }));
    await click(within(c).getByRole("button", { name: "Usar em 2 agentes" }));
    await settle(6);
    expect(copyCalls(state).at(-1)).toEqual({
      setup: expect.objectContaining({ brain: "claude_code", model: "opus", autonomy: "never" }),
      agentIds: [ATLAS_ID, LIA_ID],
    });
    const toasts = document.body.textContent;
    expect(toasts).toContain("1 agente agora pensa com Opus pelo plano do Claude · Autonomia: Não pergunta.");
    expect(toasts).toContain("1 agente mudou só a autonomia.");
    expect(toasts).not.toContain("não mudou");
  });

  test("Levar a autonomia off: each agent keeps its own, and one only its Autonomia would change can't be picked", async () => {
    const state = await withOthers((api) => {
      const brain = api.agents.brain;
      api.agents.brain = async (orgId, agentId) => ({
        ...(await brain(orgId, agentId)),
        ...(agentId === ADA_ID ? { autonomy: "never" as const } : {}),
      });
    });
    state.setupResults = {
      [ATLAS_ID]: { status: "applied", autonomy: { from: "always", to: "never" } },
      [LIA_ID]: {
        status: "skipped",
        reason: "other_computer",
        params: { computer: "PC" },
        autonomy: { from: "low_risk_auto", to: "never" },
      },
    };
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    await model(d, /^Opus/);
    await click(within(d).getByRole("button", { name: /^Usar em outros agentes/ }));
    const c = screen().getByRole("dialog", { name: "Usar em outros agentes" });
    const carry = within(c).getByRole("switch", { name: /^Levar a autonomia/ });
    expect(carry.getAttribute("aria-checked")).toBe("true");
    expect(carry.closest("label")?.textContent).toContain(
      "Não pergunta, como neste agente. Desligado, cada um fica com a sua.",
    );
    expect(c.textContent).toContain("2 agentes podem usar");
    await click(carry);
    await settle(4);
    // Asked again without it: the setup in words and each agent's line leave it out.
    const again = copyCalls(state).at(-1);
    expect(again).toMatchObject({ agentIds: [ADA_ID, ATLAS_ID, LIA_ID], preview: true });
    expect(again).not.toHaveProperty(["setup", "autonomy"]);
    expect(c.textContent).toContain("Eles passam a pensar com Opus pelo plano do Claude.");
    expect(c.textContent).not.toContain("Autonomia:");
    expect(within(c).getByRole("checkbox", { name: /^Lia/ }).hasAttribute("disabled")).toBe(true);
    expect(c.textContent).toContain("1 agente pode usar");
    await click(within(c).getByRole("checkbox", { name: /^Todos/ }));
    await click(within(c).getByRole("button", { name: "Usar em 1 agente" }));
    await settle(6);
    const used = copyCalls(state).at(-1);
    expect(used).toEqual({
      setup: expect.objectContaining({ brain: "claude_code", model: "opus" }),
      agentIds: [ATLAS_ID],
    });
    expect(used).not.toHaveProperty(["setup", "autonomy"]);
    expect(document.body.textContent).toContain("1 agente agora pensa com Opus pelo plano do Claude.");
    expect(document.body.textContent).not.toContain("mudou só a autonomia");
  });

  test("Todos says how many can take it only once the preview says so", async () => {
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    await withOthers((api) => {
      const apply = api.agents.applySetup;
      api.agents.applySetup = async (orgId, input) => {
        await arrived;
        return apply(orgId, input);
      };
    });
    const d = await brainDialog();
    await click(card(d, /^Claude/));
    await click(within(d).getByRole("button", { name: /^Usar em outros agentes/ }));
    const c = screen().getByRole("dialog", { name: "Usar em outros agentes" });
    expect(within(c).queryByRole("checkbox", { name: /^Todos/ })).toBeNull();
    expect(c.textContent).not.toContain("0 agente");
    arrive();
    await settle(4);
    expect(c.textContent).toContain("1 agente pode usar");
  });

  test("the API's model and key go too, for an admin; nothing to pick when nobody can take it", async () => {
    const state = seedState();
    state.credentials.push({
      id: "cred-2",
      provider: "anthropic",
      label: "Claude do time",
      keyHint: "9b1c",
      createdAt: NOW.toISOString(),
      revokedAt: null,
    });
    state.setupResults = { [ATLAS_ID]: { status: "same" } };
    await open(state);
    const d = await brainDialog();
    await pick(d, "Chave da API", /^Claude do time/);
    await click(within(d).getByRole("button", { name: /^Usar em outros agentes/ }));
    const c = screen().getByRole("dialog", { name: "Usar em outros agentes" });
    expect(copyCalls(state)[0]).toEqual({
      setup: { brain: "model", model: "claude-sonnet-5-5", key: "cred-2", contextTokens: null },
      agentIds: [ADA_ID, ATLAS_ID],
      preview: true,
    });
    expect(
      within(c)
        .getByRole("checkbox", { name: /^Atlas/ })
        .closest("label")?.textContent,
    ).toContain("Já pensa assim");
    expect(c.textContent).toContain("Nenhum outro agente pode usar agora.");
    expect(c.textContent).not.toContain("0 agente");
    expect(
      within(c)
        .getByRole("checkbox", { name: /^Todos/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
