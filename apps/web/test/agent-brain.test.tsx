import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { type BrainChoice, changedKeys, needsPlanWarning, type Saved, sameBrain, termsPending } from "@/lib/agent-edit";
import { ADA_ID, createFakeApi, fakeAgentBrain, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const saveBar = () => screen().queryByRole("region", { name: "Alterações não salvas" });
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);

async function open(state = seedState(), api = createFakeApi(state)) {
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=brain`, { api });
  await settle(8);
  return { state, api, section: document.getElementById("agp-sec-brain") as HTMLElement };
}
const group = (section: HTMLElement) => within(section).getByRole("radiogroup", { name: "Quem pensa" });
const radio = (section: HTMLElement, name: RegExp) => within(group(section)).getByRole("radio", { name });

describe("Quem pensa (agent settings)", () => {
  test("three cards with their portraits; the API is the default, with its model and key under them", async () => {
    const { section } = await open();
    expect(section.textContent).toContain("Quem pensa");
    const rows = within(group(section)).getAllByRole("radio");
    expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.textContent)).toEqual([
      "Modelo (API)",
      "Claude Code",
      "CodexEm teste",
    ]);
    expect(rows[0]?.getAttribute("aria-checked")).toBe("true");
    // Each card leads with its engine's portrait (the agent alone for the API) and says where it runs.
    expect(rows.map((r) => r.querySelector("canvas.ac-brain")?.getAttribute("data-kind"))).toEqual([
      "agent",
      "claude_code",
      "codex",
    ]);
    expect(rows.map((r) => r.querySelector(".ac-optrow__foot")?.textContent)).toEqual([
      "Pela API",
      "MacBook",
      "MacBook",
    ]);
    expect(rows[0]?.textContent).toContain("Um modelo de IA pela API, com uma chave do workspace.");
    expect(within(section).queryByRole("switch")).toBeNull();
    expect(within(section).queryByRole("combobox", { name: "Modelo" })).toBeNull();
    // "Modelo (API)" carries the model cards and the key, under the cards.
    const more = section.querySelector(".ac-optrow__more") as HTMLElement;
    expect(within(more).getByRole("group", { name: "Modelo" })).toBeTruthy();
    expect(within(more).getByRole("combobox", { name: "Chave" })).toBeTruthy();
    expect(more.textContent).toContain("Conta no orçamento da Ada.");
    expect(more.textContent).toContain("A chave fica cifrada no servidor; ninguém vê.");
    // One section: no "Modelo e chave" in the index.
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(nav.textContent).toContain("Quem pensa");
    expect(nav.textContent).not.toContain("Modelo e chave");
    expect(document.getElementById("agp-sec-model")).toBeNull();
  });

  test("Claude Code asks first: the personal-plan warning; Cancelar keeps the API", async () => {
    const { section } = await open();
    await click(radio(section, /^Claude Code/));
    const dialog = screen().getByRole("dialog", { name: "Usar o seu plano para o agente?" });
    expect(dialog.textContent).toContain(
      "A assinatura do Claude é pessoal. Usar o seu plano para o agente responder a outras pessoas pode contrariar os termos da Anthropic. O risco é seu.",
    );
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen().queryByRole("dialog", { name: "Usar o seu plano para o agente?" })).toBeNull();
    expect(radio(section, /^Modelo \(API\)/).getAttribute("aria-checked")).toBe("true");
    expect(saveBar()).toBeNull();
  });

  test("confirmed: the model select and the fallback switch; Salvar sends the choice with the warning accepted", async () => {
    const { section, state } = await open();
    await click(radio(section, /^Claude Code/));
    await click(
      within(screen().getByRole("dialog", { name: "Usar o seu plano para o agente?" })).getByRole("button", {
        name: "Entendi, usar mesmo assim",
      }),
    );
    expect(radio(section, /^Claude Code/).getAttribute("aria-checked")).toBe("true");
    expect(within(section).getByRole("combobox", { name: "Modelo" }).textContent).toContain("Sonnet");
    // The API's model and key go with the API row.
    expect(within(section).queryByRole("combobox", { name: "Chave" })).toBeNull();
    expect(within(section).queryByRole("group", { name: "Modelo" })).toBeNull();
    const fallback = within(section).getByRole("switch", {
      name: "Se o computador não estiver disponível, responder pela API",
    });
    expect(fallback.getAttribute("aria-checked")).toBe("true");
    expect(section.textContent).toContain("Usa o orçamento da Ada.");
    expect(section.textContent).toContain("Antes: Modelo (API)");
    await click(fallback);
    const trigger = within(section).getByRole("combobox", { name: "Modelo" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    await click(screen().getByRole("option", { name: /^Opus/ }));
    expect(saveBar()?.textContent).toContain("1 alteração");
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(brainCalls(state)).toEqual([
      { brain: "claude_code", model: "opus", fallback: false, acceptPlanTerms: true },
    ]);
    expect(saveBar()).toBeNull();
  });

  test("Codex: the OpenAI warning; a saved plan brain changes its model without asking again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "codex", model: null, effectiveModel: "gpt-6-sol" });
    const { section } = await open(state, api);
    expect(radio(section, /^Codex/).getAttribute("aria-checked")).toBe("true");
    expect(within(section).getByRole("combobox", { name: "Modelo" }).textContent).toContain("GPT-6 Sol");
    await click(radio(section, /^Claude Code/));
    expect(screen().getByRole("dialog", { name: "Usar o seu plano para o agente?" }).textContent).toContain(
      "termos da Anthropic",
    );
    await click(screen().getByRole("button", { name: "Cancelar" }));
    // Back to the API needs no warning.
    await click(radio(section, /^Modelo \(API\)/));
    expect(screen().queryByRole("dialog", { name: "Usar o seu plano para o agente?" })).toBeNull();
    await click(radio(section, /^Codex/));
    expect(screen().queryByRole("dialog", { name: "Usar o seu plano para o agente?" })).toBeNull();
  });

  test("the save never sends acceptPlanTerms without the warning confirmed; choosing again asks again", async () => {
    const { section, state } = await open();
    await click(radio(section, /^Claude Code/));
    await click(
      within(screen().getByRole("dialog", { name: "Usar o seu plano para o agente?" })).getByRole("button", {
        name: "Entendi, usar mesmo assim",
      }),
    );
    // Back to the API and to Claude Code again: the warning again (nothing confirmed for the new pick yet).
    await click(radio(section, /^Modelo \(API\)/));
    await click(radio(section, /^Claude Code/));
    const again = screen().getByRole("dialog", { name: "Usar o seu plano para o agente?" });
    await click(within(again).getByRole("button", { name: "Cancelar" }));
    expect(radio(section, /^Modelo \(API\)/).getAttribute("aria-checked")).toBe("true");
    expect(brainCalls(state)).toEqual([]);
  });

  test("the warning for Codex names OpenAI", async () => {
    const { section } = await open();
    await click(radio(section, /^Codex/));
    expect(screen().getByRole("dialog", { name: "Usar o seu plano para o agente?" }).textContent).toContain(
      "A assinatura do ChatGPT é pessoal. Usar o seu plano para o agente responder a outras pessoas pode contrariar os termos da OpenAI. O risco é seu.",
    );
  });

  test("only what the computer has can be chosen; the rest says why", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const base = fakeAgentBrain(ADA_ID);
    api.agents.brain = async () => ({
      ...base,
      options: base.options.map((o) => (o.kind === "codex" ? { ...o, available: false, reason: "not_installed" } : o)),
    });
    const { section } = await open(state, api);
    const codex = radio(section, /^Codex/);
    expect(codex.hasAttribute("disabled")).toBe(true);
    expect(codex.textContent).toContain("Não está instalado no MacBook.");
    expect(codex.querySelector("canvas.ac-brain")?.getAttribute("data-state")).toBe("off");
    expect(codex.querySelector(".ac-optrow__foot")?.textContent).toBe("Indisponível");
  });

  test("the owner chooses too; a member sees who chooses", async () => {
    const owner = seedState();
    if (owner.me?.organizations[0]) owner.me.organizations[0].role = "member";
    const ada = owner.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const { section } = await open(owner);
    expect(radio(section, /^Modelo \(API\)/).hasAttribute("disabled")).toBe(false);
    cleanup();
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    const seen = await open(member);
    expect(within(seen.section).queryByRole("radiogroup")).toBeNull();
    expect(seen.section.textContent).toContain("escolhe quem pensa");
    // The model it uses, read-only.
    expect(within(seen.section).queryByRole("combobox", { name: "Chave" })).toBeNull();
    expect(seen.section.textContent).toContain("Conta no orçamento da Ada.");
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
