import { afterEach, describe, expect, test } from "bun:test";
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
const sentence = () => document.querySelector(".agp-work__sentence") as HTMLElement;
const dialog = async (word: string, title: string) => {
  await click(screen().getByRole("button", { name: word }));
  return screen().getByRole("dialog", { name: title });
};
const brainDialog = () => dialog("Mudar quem pensa", "Quem pensa");
const card = (d: HTMLElement, name: RegExp) =>
  within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getByRole("radio", { name });
/** A connected MacBook with Claude Code and Codex; its browser as given. */
const pairMac = (api: ReturnType<typeof createFakeApi>, browser: boolean) =>
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "darwin",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser } },
    browser: { available: browser, version: browser ? "1" : null, chrome: null, reason: null },
  });

describe("the sentence under the name", () => {
  test("who thinks, where and the browser, in one sentence; each word opens its dialog", async () => {
    await open();
    expect(sentence().textContent).toContain("Pensa com o modelo da organização");
    expect(sentence().textContent).toContain("na Nuvem e não navega em sites.");
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
    expect(sentence().textContent).toContain("Pensa com o modelo da organização");
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
  test("three cards with their portraits and where each runs; the organization's model and key under it", async () => {
    await open();
    const d = await brainDialog();
    const rows = within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getAllByRole("radio");
    expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.textContent)).toEqual([
      "Modelo da organização",
      "Claude Code",
      "CodexEm teste",
    ]);
    expect(rows[0]?.getAttribute("aria-checked")).toBe("true");
    expect(rows.map((r) => r.querySelector("canvas.ac-brain")?.getAttribute("data-kind"))).toEqual([
      "agent",
      "claude_code",
      "codex",
    ]);
    // The agent is on the cloud: a plan brain says where it will go, before it is chosen.
    expect(rows.map((r) => r.querySelector(".ac-optrow__foot")?.textContent)).toEqual([
      "Pago pela organização",
      "Vai para o MacBook",
      "Vai para o MacBook",
    ]);
    const more = d.querySelector(".ac-optrow__more") as HTMLElement;
    expect(within(more).getByRole("group", { name: "Modelo" })).toBeTruthy();
    expect(within(more).getByRole("combobox", { name: "Chave" })).toBeTruthy();
    expect((within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("Claude Code: the agent moves to the MacBook first, then thinks there; the plan warning is the button", async () => {
    const { state } = await open();
    const d = await brainDialog();
    await click(card(d, /^Claude Code/));
    expect(d.textContent).toContain("O plano do Claude é seu, pessoal.");
    await click(within(within(d).getByRole("radiogroup", { name: "Modelo" })).getByRole("radio", { name: /^Opus/ }));
    const off = within(d).getByRole("radiogroup", { name: "Se o MacBook estiver desligado" });
    await click(within(off).getByRole("radio", { name: /^Espera o MacBook ligar/ }));
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
    expect(sentence().textContent).toContain("Pensa com Codex · GPT-6 Sol");
    const d = await brainDialog();
    expect(card(d, /^Codex/).getAttribute("aria-checked")).toBe("true");
    await click(within(within(d).getByRole("radiogroup", { name: "Modelo" })).getByRole("radio", { name: /Luna/ }));
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
    expect(codex.querySelector("canvas.ac-brain")?.getAttribute("data-state")).toBe("off");
    expect(codex.querySelector(".ac-optrow__foot")?.textContent).toBe("Nenhum computador tem");
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
