import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/*
 * "Responde a todos" (ADR 0059 §5): an agent on its owner's plan replies only to them until they turn it on, with
 * nothing to accept. Under the switch, a line saying the plan's terms are a gray area there, and behind its ⓘ what
 * they say. Someone else sees whom it replies to and who decides; admins narrow it in "Quem pode falar".
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
 * `ownPlan`: the plan of the MacBook's own sign-in, as its row of the AI accounts says it.
 */
async function ada(patch: Partial<AgentBrain>, { mine = true, tab = "", provider = "", ownPlan = "" } = {}) {
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
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}${tab}`, { api });
  await settle(8);
  return state;
}

const brainDialog = async () => {
  await click(screen().getByRole("button", { name: "Mudar quem pensa" }));
  return screen().getByRole("dialog", { name: "Quem pensa" });
};
const replies = (d: HTMLElement) => within(d).getByRole("switch", { name: "Responde a todos" });
const CLAUDE =
  "Os termos do Claude dizem que o seu plano é para uso próprio. Usar o plano para responder outras pessoas pode ir contra eles.";

describe("Responde a todos (Quem pensa)", () => {
  test("off by default; on asks nothing, with Claude's terms a gray area in a line and their words behind its ⓘ", async () => {
    const state = await ada({});
    const d = await brainDialog();
    const off = replies(d);
    expect(off.getAttribute("aria-checked")).toBe("false");
    // Under the switch: a short line, and the details behind its ⓘ, which describe the switch too.
    const row = off.closest(".plan-replies") as HTMLElement;
    expect(shownText(row)).toBe("Responde a todosZona cinzenta nos termos do Claude");
    const hint = hintOf("Zona cinzenta nos termos do Claude", row);
    expect(hint).toMatchObject({ text: CLAUDE, hidden: true });
    expect(off.getAttribute("aria-describedby")).toBe(hint.button.getAttribute("aria-describedby"));
    expect(shownText(d)).not.toMatch(/risco|Manter só comigo|uso próprio/);

    await click(off);
    expect(screen().queryAllByRole("dialog")).toHaveLength(1);
    expect(replies(d).getAttribute("aria-checked")).toBe("true");
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: null, fallback: true, onlyOwner: false }]);
    expect(document.body.textContent).toContain("Agora a Ada responde a todos.");
  });

  test("on already: off brings back only its owner, with nothing asked", async () => {
    const state = await ada({ onlyOwner: false });
    const d = await brainDialog();
    expect(replies(d).getAttribute("aria-checked")).toBe("true");
    await click(replies(d));
    await click(within(d).getByRole("button", { name: "Usar" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: null, fallback: true, onlyOwner: true });
    expect(document.body.textContent).toContain("A Ada agora só responde a você.");
  });

  test("each plan in its own words: ChatGPT's plan, a team seat (an account or the computer's own), a coding plan's maker", async () => {
    const terms = async () => {
      const row = replies(await brainDialog()).closest(".plan-replies") as HTMLElement;
      const line = row.querySelector(".plan-replies__terms > span")?.textContent ?? "";
      return { line, text: hintOf(line, row).text };
    };
    await ada({ brain: "codex", effectiveModel: "gpt-6-sol" });
    expect(await terms()).toEqual({
      line: "Zona cinzenta nos termos do ChatGPT",
      text: "Os termos do ChatGPT dizem que o seu plano é para uso próprio. Usar o plano para responder outras pessoas pode ir contra eles.",
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
    const SEAT =
      "Os termos do Claude dizem que cada assento é de uma pessoa. Usar o seu para responder outras pessoas pode ir contra eles.";
    await ada({ account: "acct_team", accounts: [seat] });
    expect((await terms()).text).toBe(SEAT);
    cleanup();
    // The computer's own sign-in on a Team seat: the seat's words too, as the plan's panel says them.
    await ada({ ownSignIn: true }, { ownPlan: "team" });
    expect((await terms()).text).toBe(SEAT);
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
      line: "Zona cinzenta nos termos do plano",
      text: "Z.ai diz que o plano é só de quem assina. Usar o seu para responder outras pessoas pode ir contra os termos.",
    });
  });

  test("onto a plan it starts off, and Usar asks nothing", async () => {
    const state = await ada({ brain: "model", effectiveModel: null, onlyOwner: false }, { ownPlan: "max" });
    const d = await brainDialog();
    await click(
      within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getByRole("radio", { name: /^Claude Code/ }),
    );
    expect(replies(d).getAttribute("aria-checked")).toBe("false");
    await click(within(d).getByRole("button", { name: "Usar meu plano do Claude" }));
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: null, fallback: true }]);
  });

  test("someone else's agent: whom it replies to and who decides, no switch", async () => {
    await ada({}, { mine: false });
    let d = await brainDialog();
    expect(within(d).queryByRole("switch", { name: /^(Só r|R)esponde a / })).toBeNull();
    const row = d.querySelector(".plan-replies") as HTMLElement;
    expect(shownText(row)).toBe("Só responde a JoãoUsa o plano de João: só João libera para outras pessoas.");
    cleanup();
    await ada({ onlyOwner: false }, { mine: false });
    d = await brainDialog();
    expect(shownText(d.querySelector(".plan-replies") as HTMLElement)).toBe(
      "Responde a todosUsa o plano de João: só João libera para outras pessoas.",
    );
    expect(within(d).queryByRole("switch", { name: /^(Só r|R)esponde a / })).toBeNull();
  });

  test("back on the API it still answers only its owner: the notice lets everyone in with one click", async () => {
    const state = await ada({});
    const d = await brainDialog();
    await click(
      within(within(d).getByRole("radiogroup", { name: "Quem pensa" })).getByRole("radio", {
        name: /^Modelo do workspace/,
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
      audience: { mode: "everyone", userIds: [] },
    });
  });

  test("an admin who doesn't own it can't let more people in: it says whose plan it is", async () => {
    await ada({}, { mine: false, tab: "?tab=settings&sec=audience" });
    await click(within(audience()).getByRole("radio", { name: /^Todos do workspace/ }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(
      within(audience())
        .getByRole("radio", { name: /^Só o responsável/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.body.textContent).toContain("A Ada pensa com o plano de João: só João libera para mais gente.");
  });
});
