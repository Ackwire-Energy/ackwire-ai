import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { type BrainChoice, changedKeys, needsPlanWarning, type Saved, sameBrain } from "@/lib/agent-edit";
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
  test("three rows with their marks; the API is the default; no model or fallback for it", async () => {
    const { section } = await open();
    expect(section.textContent).toContain("Quem pensa");
    const rows = within(group(section)).getAllByRole("radio");
    expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.textContent)).toEqual([
      "Modelo (API)",
      "Claude Code no MacBook",
      "Codex no MacBookEm teste",
    ]);
    expect(rows[0]?.getAttribute("aria-checked")).toBe("true");
    expect(rows.map((r) => r.querySelector(".ac-icon") !== null)).toEqual([true, true, true]);
    expect(rows[0]?.textContent).toContain("Conta no orçamento.");
    expect(within(section).queryByRole("switch")).toBeNull();
    expect(within(section).queryByRole("combobox", { name: "Modelo" })).toBeNull();
    // Nav entry for the section.
    expect(screen().getByRole("navigation", { name: "Seções das configurações" }).textContent).toContain("Quem pensa");
  });

  test("Claude Code asks first: the personal-plan warning; Cancelar keeps the API", async () => {
    const { section } = await open();
    await click(radio(section, /^Claude Code no MacBook/));
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
    await click(radio(section, /^Claude Code no MacBook/));
    await click(
      within(screen().getByRole("dialog", { name: "Usar o seu plano para o agente?" })).getByRole("button", {
        name: "Entendi, usar mesmo assim",
      }),
    );
    expect(radio(section, /^Claude Code no MacBook/).getAttribute("aria-checked")).toBe("true");
    expect(within(section).getByRole("combobox", { name: "Modelo" }).textContent).toContain("Sonnet");
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
    expect(radio(section, /^Codex no MacBook/).getAttribute("aria-checked")).toBe("true");
    expect(within(section).getByRole("combobox", { name: "Modelo" }).textContent).toContain("GPT-6 Sol");
    await click(radio(section, /^Claude Code no MacBook/));
    expect(screen().getByRole("dialog", { name: "Usar o seu plano para o agente?" }).textContent).toContain(
      "termos da Anthropic",
    );
    await click(screen().getByRole("button", { name: "Cancelar" }));
    // Back to the API needs no warning.
    await click(radio(section, /^Modelo \(API\)/));
    expect(screen().queryByRole("dialog", { name: "Usar o seu plano para o agente?" })).toBeNull();
    await click(radio(section, /^Codex no MacBook/));
    expect(screen().queryByRole("dialog", { name: "Usar o seu plano para o agente?" })).toBeNull();
  });

  test("the warning for Codex names OpenAI", async () => {
    const { section } = await open();
    await click(radio(section, /^Codex no MacBook/));
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
    const codex = radio(section, /^Codex no MacBook/);
    expect(codex.hasAttribute("disabled")).toBe(true);
    expect(codex.textContent).toContain("Não está instalado no MacBook.");
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
});
