import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { type BrainChoice, changedKeys, needsPlanWarning, type Saved, sameBrain, termsPending } from "@/lib/agent-edit";
import { ADA_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
const callOrder = (state: ReturnType<typeof seedState>) =>
  state.calls.map((c) => c.method).filter((m) => m === "sandbox.setTarget" || m === "agents.setBrain");

async function open(state = seedState(), api = createFakeApi(state)) {
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api };
}
/** "Como trabalha" under the name: where, who thinks, the browser. */
const sentence = () => screen().getByRole("region", { name: "Como trabalha" });
const dialog = async (word: string, title: string) => {
  await click(screen().getByRole("button", { name: word }));
  return screen().getByRole("dialog", { name: title });
};
const brainDialog = () => dialog("Mudar quem pensa", "Quem pensa");
const card = (d: HTMLElement, name: RegExp) =>
  within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getByRole("radio", { name });
/** The opened brain's model, one click away (a segmented control). */
const model = (d: HTMLElement, name: RegExp) => click(within(d).getByRole("radio", { name }));
/** The switch at the opened brain's foot: answer through the API while the computer is off. */
const offSwitch = (d: HTMLElement) =>
  within(d).getByRole("switch", { name: /^Se o MacBook desligar, responder pela API/ });
/** Opens one of the opened brain's dropdowns and picks an option. */
const pick = async (d: HTMLElement, select: string, option: RegExp) => {
  const trigger = within(d).getByRole("combobox", { name: select });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
};
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
    expect(sentence().textContent).toContain("Trabalha naNuvem");
    expect(sentence().textContent).toContain("Pensa com");
    expect(sentence().textContent).toContain("o modelo da organização");
    expect(sentence().textContent).toContain("Navegadornão navega em sites");
    expect(sentence().textContent?.indexOf("Trabalha na")).toBeLessThan(
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
    expect(sentence().textContent).toContain("o modelo da organização");
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
  test("three brains in a list with their portraits and where each runs; the organization's model and key in its card", async () => {
    await open();
    const d = await brainDialog();
    const rows = within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getAllByRole("radio");
    expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.textContent)).toEqual([
      "Modelo da organização",
      "Claude Code",
      "CodexEm teste",
    ]);
    expect(rows[0]?.getAttribute("aria-checked")).toBe("true");
    // The organization's model is the agent itself; the computer brains are their makers' marks.
    expect(rows[0]?.querySelector("canvas.ac-brain")?.getAttribute("data-kind")).toBe("agent");
    expect(rows[1]?.querySelector(".ac-brand[data-mark='claude']")).not.toBeNull();
    expect(rows[2]?.querySelector(".ac-brand[data-mark='openai']")).not.toBeNull();
    // The agent is on the cloud: a plan brain says where it will go, before it is chosen.
    expect(rows.map((r) => r.querySelector(".ac-optrow__side")?.textContent)).toEqual([
      undefined,
      "Vai para o MacBook",
      "Vai para o MacBook",
    ]);
    // The chosen brain and its settings are one card.
    const more = d.querySelector(".ac-optcard .ac-optrow__more") as HTMLElement;
    expect(rows[0]?.textContent).toContain("Pela API. O uso conta no orçamento da Ada.");
    expect(within(more).getByRole("combobox", { name: "Modelo" })).toBeTruthy();
    expect(within(more).getByRole("combobox", { name: "Chave da API" })).toBeTruthy();
    expect((within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("Claude Code: the agent moves to the MacBook first, then thinks there; the plan warning is the button", async () => {
    const { state } = await open();
    const d = await brainDialog();
    await click(card(d, /^Claude Code/));
    expect(d.textContent).toContain("O plano do Claude é seu, pessoal.");
    // The agent moves to the MacBook: its accounts there aren't offered yet.
    expect(within(d).queryByRole("combobox", { name: "Conta do Claude" })).toBeNull();
    await model(d, /^Opus$/);
    expect(offSwitch(d).getAttribute("aria-checked")).toBe("true");
    await click(offSwitch(d));
    expect(d.textContent).toContain("A Ada avisa quem chamou e espera ele voltar.");
    await click(within(d).getByRole("button", { name: "Usar meu plano do Claude" }));
    await settle(6);
    expect(callOrder(state)).toEqual(["sandbox.setTarget", "agents.setBrain"]);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args.slice(1)).toEqual([ADA_ID, "machine_1"]);
    expect(brainCalls(state)).toEqual([
      { brain: "claude_code", model: "opus", fallback: false, acceptPlanTerms: true },
    ]);
    expect(document.body.textContent).toContain("A Ada agora pensa com Claude Code · Opus no MacBook.");
    expect(screen().queryByRole("dialog", { name: "Quem pensa" })).toBeNull();
  });

  test("a saved plan brain changes its model without the warning; back to the organization's model too", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "codex", model: null, effectiveModel: "gpt-6-sol" });
    await open(state, api);
    expect(sentence().textContent).toContain("Codex · GPT-6 Sol · esforço médio");
    const d = await brainDialog();
    expect(card(d, /^Codex/).getAttribute("aria-checked")).toBe("true");
    await model(d, /Luna/);
    expect(d.textContent).not.toContain("é seu, pessoal");
    await click(within(d).getByRole("button", { name: "Usar" }));
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
    const codex = card(await brainDialog(), /^Codex/);
    expect(codex.hasAttribute("disabled")).toBe(true);
    expect(codex.textContent).toContain("Não está instalado no MacBook.");
    expect(codex.querySelector(".ac-brand--off")).not.toBeNull();
    expect(codex.querySelector(".ac-optrow__side")?.textContent).toBe("Nenhum computador tem");
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
    usedBy: ["Theo"],
  };
  /** Ada thinks with Claude Code on the MacBook, which has the given accounts. */
  async function onMac(patch: Partial<AgentBrain> = {}) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", accounts: [work], ...patch });
    await open(state, api);
    return { state, api };
  }

  test("the cell names the account when the computer has more than one; Usar saves the account and the effort", async () => {
    const { state } = await onMac();
    expect(sentence().textContent).toContain("Claude Code · Sonnet");
    expect(sentence().textContent).toContain("Conta deste MacBook");
    const d = await brainDialog();
    const account = within(d).getByRole("combobox", { name: "Conta do Claude" });
    expect(account.textContent).toContain("Conta deste MacBook");
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    const options = screen().getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Conta deste MacBookA que já está no MacBook",
      "Trabalho · Teamwalt@acme.com · também Theo",
      "Adicionar conta",
    ]);
    await click(screen().getByRole("option", { name: /^Trabalho · Team/ }));
    // Effort: the pixel ramp, a slider (Médio → Alto with the arrow key).
    const effort = within(d).getByRole("slider", { name: "Esforço" });
    expect(effort.getAttribute("aria-valuetext")).toBe("Médio");
    await act(async () => fireEvent.keyDown(effort, { key: "ArrowRight" }));
    expect(effort.getAttribute("aria-valuetext")).toBe("Alto");
    expect(d.textContent).toContain("Pensa mais em tarefas difíceis.");
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

  test("only the computer's owner changes the account; an old app on the computer shows nothing about it", async () => {
    await onMac({ canManageAccounts: false });
    let d = await brainDialog();
    expect(within(d).getByRole("combobox", { name: "Conta do Claude" }).hasAttribute("disabled")).toBe(true);
    expect(d.textContent).toContain("Só Walter troca");
    cleanup();
    await onMac({ accountsSupported: false });
    expect(sentence().textContent).not.toContain("Conta deste MacBook");
    d = await brainDialog();
    expect(within(d).queryByRole("combobox", { name: "Conta do Claude" })).toBeNull();
    expect(within(d).getByRole("slider", { name: "Esforço" })).toBeTruthy();
  });

  test("a signed-out account says so and offers to sign in again", async () => {
    await onMac({ account: "acct_work", accounts: [{ ...work, status: "signed_out" }] });
    const d = await brainDialog();
    expect(d.textContent).toContain("Saiu da conta, entre de novo");
    const account = within(d).getByRole("combobox", { name: "Conta do Claude" });
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    expect(screen().getByRole("option", { name: /^Entrar de novo/ })).toBeTruthy();
  });

  test("Adicionar conta: Claude's own page, the code goes to the computer; Voltar stops the sign-in", async () => {
    const { state, api } = await onMac();
    const d = await brainDialog();
    await pick(d, "Conta do Claude", /^Adicionar conta/);
    await settle(6);
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    const login = fakeMachinesOf.get(api)?.lastLogin();
    expect(login?.kind).toBe("claude_code");
    expect(within(block).getByRole("link", { name: "Entrar com Claude" }).getAttribute("href")).toBe(
      "https://claude.ai/oauth/authorize?code=true",
    );
    expect(block.textContent).toContain("O agentes.chat nunca vê a senha nem o acesso.");
    expect((within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement).disabled).toBe(true);
    await click(within(block).getByRole("button", { name: "Voltar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.cancelAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      login?.loginId,
    ]);
    expect(within(d).getByRole("combobox", { name: "Conta do Claude" })).toBeTruthy();
  });

  test("Adicionar conta (Codex): the code to type there; once the computer signs in, the account is chosen", async () => {
    const codex: MachineAccount = { ...work, id: "acct_codex", kind: "codex", label: "Pessoal", plan: "Plus" };
    const { state, api } = await onMac({ brain: "codex", effectiveModel: "gpt-6-sol", accounts: [] });
    // The computer finishes the first sign-in as soon as the page asks.
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: codex });
    const d = await brainDialog();
    await pick(d, "Conta do Codex", /^Adicionar conta/);
    await settle(8);
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "codex",
    ]);
    expect(within(d).queryByRole("region", { name: "Adicionar conta do Codex" })).toBeNull();
    expect(within(d).getByRole("combobox", { name: "Conta do Codex" }).textContent).toContain("Pessoal · Plus");
    expect(d.textContent).toContain("A conta Pessoal entrou no MacBook. Clique em Usar para salvar.");
    expect(state.calls.some((c) => c.method === "machines.cancelAccountLogin")).toBe(false);
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "codex", model: null, fallback: true, account: "acct_codex" });
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
    await click(mac);
    await click(within(d).getByRole("button", { name: "Usar o MacBook" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args.slice(1)).toEqual([ADA_ID, "machine_1"]);
    expect(document.body.textContent).toContain("A Ada agora trabalha no MacBook.");
  });

  test("the browser on the cloud: the agent moves to the MacBook, and the steps there show before it's allowed", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, false);
    await open(state, api);
    const d = await dialog("Mudar o navegador", "A Ada pode navegar em sites?");
    await click(within(d).getByRole("radio", { name: /^Qualquer site/ }));
    expect(d.textContent).toContain("A Ada passa para o MacBook, que tem navegador.");
    expect(d.textContent).toContain("Falta 1 passo, no próprio MacBook");
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args.slice(1)).toEqual([ADA_ID, "machine_1"]);
    expect(state.calls.some((c) => c.method === "access.set")).toBe(true);
    expect(document.body.textContent).toContain("Falta 1 passo no MacBook.");
  });
});

describe("Quem pensa: the draft", () => {
  const saved: Saved = {
    name: "Ada",
    role: "",
    look: { color: "sky", eyes: "round", accessory: "none" },
    instructions: "",
    model: "claude-sonnet-5-5",
    owner: "u-joao",
    audience: { mode: "everyone", userIds: [] },
    brain: { brain: "model", model: null, fallback: true },
  };
  const api: BrainChoice = { brain: "model", model: null, fallback: true };

  test("only real differences count; the warning only for a plan brain not saved yet", () => {
    expect(changedKeys(saved, { brain: { ...api } })).toEqual([]);
    expect(sameBrain(api, { ...api, model: "opus" })).toBe(true);
    expect(changedKeys(saved, { brain: { ...api, fallback: false } }).map((c) => c.key)).toEqual(["brain"]);
    expect(
      changedKeys(saved, { brain: { brain: "claude_code", model: null, fallback: true } }).map((c) => c.key),
    ).toEqual(["brain"]);
    expect(needsPlanWarning("model", "claude_code")).toBe(true);
    expect(needsPlanWarning("claude_code", "claude_code")).toBe(false);
    expect(needsPlanWarning("claude_code", "codex")).toBe(true);
    expect(needsPlanWarning("codex", "model")).toBe(false);
  });

  test("acceptPlanTerms only after the person confirmed: an unconfirmed switch blocks the save", () => {
    const cc: BrainChoice = { brain: "claude_code", model: null, fallback: true };
    expect(termsPending("model", cc)).toBe(true);
    expect(termsPending("model", { ...cc, termsAccepted: false })).toBe(true);
    expect(termsPending("model", { ...cc, termsAccepted: true })).toBe(false);
    // Already saved, or back to the API: nothing to confirm.
    expect(termsPending("claude_code", cc)).toBe(false);
    expect(termsPending("claude_code", api)).toBe(false);
    expect(termsPending("model", undefined)).toBe(false);
    // The confirmation doesn't count as a change.
    expect(sameBrain(cc, { ...cc, termsAccepted: true })).toBe(true);
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
    const models = within(within(d).getByRole("radiogroup", { name: "Modelo" })).getAllByRole("radio");
    expect(models.map((r) => r.textContent)).toEqual(["Automático", "Opus", "Sonnet", "Haiku"]);
    // A fixed model: the effort's four levels, none of them Automático.
    const ramp = within(d).getByRole("slider", { name: "Esforço" });
    expect(ramp.getAttribute("aria-valuemax")).toBe("4");
    expect(ramp.getAttribute("aria-valuetext")).toBe("Médio");
    await model(d, /^Automático$/);
    expect(d.textContent).toContain("Escolhe o modelo e o esforço para cada tarefa");
    // The model picks the effort too: no ramp to set.
    expect(within(d).queryByRole("slider", { name: "Esforço" })).toBeNull();
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: "auto", fallback: true, effort: "auto" });
  });

  test("back to a fixed model: the ramp returns at Médio and the effort is saved", async () => {
    const state = await onClaude({ model: "auto", effectiveModel: "auto", effort: "auto" });
    const d = await brainDialog();
    expect(within(d).queryByRole("slider", { name: "Esforço" })).toBeNull();
    await model(d, /^Opus$/);
    expect(within(d).getByRole("slider", { name: "Esforço" }).getAttribute("aria-valuetext")).toBe("Médio");
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", model: "opus", effort: "medium" });
  });

  test("a new agent (Automático on every brain) switching to Claude Code starts there on Automático", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // New agents are created with the effort on auto too; the API brain doesn't show it.
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { effort: "auto" });
    await open(state, api);
    const d = await brainDialog();
    await click(card(d, /^Claude Code/));
    const models = within(d).getByRole("radiogroup", { name: "Modelo" });
    expect(
      within(models)
        .getByRole("radio", { name: /^Automático$/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(d).queryByRole("slider", { name: "Esforço" })).toBeNull();
    await click(within(d).getByRole("button", { name: "Usar meu plano do Claude" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({
      brain: "claude_code",
      model: "auto",
      fallback: true,
      acceptPlanTerms: true,
    });
  });

  test("a saved Automático reads as such in the cell", async () => {
    await onClaude({ model: "auto", effectiveModel: "auto", effort: "auto" });
    expect(sentence().textContent).toContain("Claude Code · Automático · esforço automático");
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
});
