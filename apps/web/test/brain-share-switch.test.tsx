import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * "Só responde a você" (ADR 0059 §5): an agent on its owner's personal plan
 * answers only them until they let others in, after the provider's own words
 * about personal use. Admins only narrow it.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);

/** Ada on the MacBook with the given brain view; Walter (me) owns her unless `mine` is false (then João does). */
async function ada(patch: Partial<AgentBrain>, { mine = true, tab = "", provider = "" } = {}) {
  const state = seedState();
  const agent = state.agents.find((a) => a.id === ADA_ID);
  if (agent) {
    agent.ownerUserId = mine ? "u-walter" : "u-joao";
    agent.brain = { kind: patch.brain ?? "claude_code", model: "Sonnet", ...(provider ? { provider } : {}) };
    agent.audience = { mode: patch.onlyOwner === false ? "everyone" : "owner", userIds: [] };
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
  const view = fakeAgentBrain(ADA_ID, {
    brain: "claude_code",
    effectiveModel: "sonnet",
    onlyOwner: true,
    canUsePlans: mine,
    ...patch,
  });
  api.agents.brain = async () => structuredClone(view);
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}${tab}`, { api });
  await settle(8);
  return state;
}

const brainDialog = async () => {
  await click(screen().getByRole("button", { name: "Mudar quem pensa" }));
  return screen().getByRole("dialog", { name: "Quem pensa" });
};
const shareSwitch = (d: HTMLElement, name = /^Só responde a você/) => within(d).getByRole("switch", { name });

describe("Só responde a você (Quem pensa)", () => {
  test("on by default; off shows Anthropic's words, Manter keeps it, Responder a todos saves it with the terms", async () => {
    const state = await ada({});
    const d = await brainDialog();
    const on = shareSwitch(d);
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(d.textContent).toContain("Usa o seu plano. Os outros veem que a Ada só responde a você.");

    await click(on);
    let share = screen().getByRole("dialog", { name: "Agora a Ada responde a todos" });
    expect(share.textContent).toContain(
      "A Anthropic diz que as assinaturas pessoais do Claude são para uso pessoal. Usar a sua para responder outras pessoas pode ir contra os termos dela. Se continuar, o risco é seu.",
    );
    await click(within(share).getByRole("button", { name: "Manter só comigo" }));
    expect(screen().queryByRole("dialog", { name: "Agora a Ada responde a todos" })).toBeNull();
    expect(shareSwitch(d).getAttribute("aria-checked")).toBe("true");
    expect((within(d).getByRole("button", { name: "Usar" }) as HTMLButtonElement).disabled).toBe(true);

    await click(shareSwitch(d));
    share = screen().getByRole("dialog", { name: "Agora a Ada responde a todos" });
    await click(within(share).getByRole("button", { name: "Responder a todos" }));
    expect(shareSwitch(d).getAttribute("aria-checked")).toBe("false");
    expect(d.textContent).toContain("Responde a outras pessoas com o seu plano.");
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state)).toEqual([
      { brain: "claude_code", model: null, fallback: true, onlyOwner: false, acceptPlanTerms: true },
    ]);
    expect(document.body.textContent).toContain("Agora a Ada responde a todos.");
  });

  test("each provider in its own words: ChatGPT's plan, a team seat", async () => {
    await ada({ brain: "codex", effectiveModel: "gpt-6-sol" });
    let d = await brainDialog();
    await click(shareSwitch(d));
    expect(screen().getByRole("dialog", { name: "Agora a Ada responde a todos" }).textContent).toContain(
      "A OpenAI diz que o plano do ChatGPT é para uso pessoal.",
    );
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
    await ada({ account: "acct_team", accounts: [seat] });
    d = await brainDialog();
    await click(shareSwitch(d));
    expect(screen().getByRole("dialog", { name: "Agora a Ada responde a todos" }).textContent).toContain(
      "A Anthropic diz que cada assento do plano é de uma pessoa.",
    );
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
    d = await brainDialog();
    await click(shareSwitch(d));
    expect(screen().getByRole("dialog", { name: "Agora a Ada responde a todos" }).textContent).toContain(
      "Z.ai diz que o plano é só de quem assina.",
    );
  });

  test("onto a plan it starts on, and Usar asks nothing", async () => {
    const state = await ada({ brain: "model", effectiveModel: null, onlyOwner: false });
    const d = await brainDialog();
    await click(
      within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getByRole("radio", { name: /^Claude Code/ }),
    );
    expect(shareSwitch(d).getAttribute("aria-checked")).toBe("true");
    await click(within(d).getByRole("button", { name: "Usar meu plano do Claude" }));
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: null, fallback: true }]);
  });

  test("someone else's agent: whose plan it is, and the switch only narrows", async () => {
    await ada({}, { mine: false });
    let d = await brainDialog();
    const locked = shareSwitch(d, /^Só responde a João/);
    expect(locked.hasAttribute("disabled")).toBe(true);
    expect(d.textContent).toContain("Usa o plano de João: só João libera para outras pessoas.");
    cleanup();
    const state = await ada({ onlyOwner: false }, { mine: false });
    d = await brainDialog();
    await click(shareSwitch(d, /^Só responde a João/));
    expect(screen().queryByRole("dialog", { name: /responde a todos/ })).toBeNull();
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ onlyOwner: true });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("acceptPlanTerms");
  });

  test("back on the API it still answers only its owner: the notice lets everyone in with one click", async () => {
    const state = await ada({});
    const d = await brainDialog();
    await click(
      within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getByRole("radio", {
        name: /^Modelo da organização/,
      }),
    );
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(document.body.textContent).toContain("A Ada voltou a pensar pela API e ainda só responde a você.");
    await click(screen().getByRole("button", { name: "Liberar para todos" }));
    await settle(4);
    expect(brainCalls(state)).toEqual([{ brain: "model", fallback: true }, { onlyOwner: false }]);
  });
});

describe("Quem pode falar, on a plan", () => {
  const audience = () => screen().getByRole("radiogroup", { name: "Quem pode falar com a Ada" });
  const save = () =>
    click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );

  test("its owner widens it after the warning, and the save carries the terms", async () => {
    const state = await ada({}, { tab: "?tab=settings&sec=audience" });
    await click(within(audience()).getByRole("radio", { name: /^Todos do workspace/ }));
    const share = screen().getByRole("dialog", { name: "Agora a Ada responde a todos" });
    await click(within(share).getByRole("button", { name: "Responder a todos" }));
    expect(
      within(audience())
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await save();
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      audience: { mode: "everyone", userIds: [] },
      acceptPlanTerms: true,
    });
  });

  test("on a coding plan the warning is its maker's", async () => {
    await ada({}, { tab: "?tab=settings&sec=audience", provider: "kimi" });
    await click(within(audience()).getByRole("radio", { name: /^Todos do workspace/ }));
    expect(screen().getByRole("dialog", { name: "Agora a Ada responde a todos" }).textContent).toContain(
      "Kimi diz que o plano é só de quem assina.",
    );
  });

  test("an admin who doesn't own it can't let more people in: it says whose plan it is", async () => {
    await ada({}, { mine: false, tab: "?tab=settings&sec=audience" });
    await click(within(audience()).getByRole("radio", { name: /^Todos do workspace/ }));
    expect(screen().queryByRole("dialog", { name: /responde a todos/ })).toBeNull();
    expect(
      within(audience())
        .getByRole("radio", { name: /^Só o responsável/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.body.textContent).toContain("A Ada pensa com o plano de João: só João libera para mais gente.");
  });
});
