import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  createFakeApi,
  type FakeState,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** A new workspace opens in its right hand's DM (ADR 0137): the greeting and the first cards come from the app. */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const button = (name: string | RegExp) => screen().getByRole("button", { name });
const click = async (el: Element, rounds = 8) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
const GREETING = "Oi, eu sou o Lodi. Monto o time com você.";
/** Nobody else here yet, and no agent besides Lodi. */
const fresh = () => {
  const state = withRightHand(seedState({ agents: [] }));
  state.members = state.members.slice(0, 1);
  return state;
};
const openDm = async (state: FakeState) => {
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(10);
  return r;
};
const startCard = () => screen().queryByRole("group", { name: /^O que a .+ faz\?|^Como você quer começar\?$/ });
/** The ready-made agents sit behind the start card's footer button. */
const openPresets = async () => click(button("Agentes prontos"), 4);

describe("after the workspace's name", () => {
  test("the workspace is set up at once and opens in Lodi's DM, its greeting at the top", async () => {
    const state = seedState({ agents: [] });
    if (state.me) state.me.organizations = [];
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await act(async () => fireEvent.change(screen().getByLabelText("Nome"), { target: { value: "Acme Saúde" } }));
    await click(button("Continuar"), 12);
    expect(calls(state, "orgs.create")[0]?.args[0]).toEqual({ name: "Acme Saúde" });
    const orgId = state.me?.organizations.at(-1)?.id;
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[orgId, { finished: true }]]);
    expect(state.me?.organizations.at(-1)?.onboarding).toBeUndefined();
    expect(router.state.location.pathname).toBe(`/org/${orgId}/dm/agent/${LODI_ID}`);
    expect(document.body.textContent).toContain(GREETING);
    // No agent was made for the person: Ada is a preset like the others, not a guide already on the team.
    expect(calls(state, "agents.create")).toEqual([]);
  });

  test("a workspace left at any step of the older onboarding is finished and opens in Lodi's DM", async () => {
    for (const step of ["context", "agents", "team", "done"] as const) {
      const state = withRightHand(seedState({ agents: [] }));
      if (state.me)
        state.me.organizations = [
          { id: ORG_ID, name: "Acme", role: "owner", onboarding: { step, generalChannelId: GENERAL_ID } },
        ];
      const { router } = await renderApp("/", { api: createFakeApi(state) });
      await settle(12);
      expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
      expect(calls(state, "orgs.create")).toEqual([]);
      cleanup();
    }
  });

  test("back from paying from an older onboarding: Lodi's DM, the payment said as being confirmed", async () => {
    const state = withRightHand(seedState({ agents: [] }));
    if (state.me)
      state.me.organizations = [
        { id: ORG_ID, name: "Acme", role: "owner", onboarding: { step: "computer", generalChannelId: GENERAL_ID } },
      ];
    const { router } = await renderApp(`/org/${ORG_ID}/onboarding?paid=1`, { api: createFakeApi(state) });
    await settle(12);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
    expect((router.state.location.search as { paid?: boolean }).paid).toBe(true);
  });

  test("asked to delete the workspace being set up: its dialog, and nothing is finished", async () => {
    const state = withRightHand(seedState({ agents: [] }));
    if (state.me)
      state.me.organizations = [
        { id: ORG_ID, name: "Acme", role: "owner", onboarding: { step: "agents", generalChannelId: GENERAL_ID } },
      ];
    await renderApp("/onboarding?delete=1", { api: createFakeApi(state) });
    await settle(10);
    expect(screen().getByRole("dialog")).toBeTruthy();
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
  });
});

describe("the top of Lodi's DM", () => {
  test("no AI yet: the greeting, then Connect AI only (no banner over the composer)", async () => {
    const state = fresh();
    state.aiStatus = { any: false, agents: [{ agentId: LODI_ID, state: "no_ai" }] };
    await openDm(state);
    expect(document.body.textContent).toContain(GREETING);
    expect(document.body.textContent).toContain(
      "Crio os agentes, conecto os apps e convido as pessoas. Nada muda sem o seu clique, e eu faço só o que você pode fazer.",
    );
    expect(screen().getByText("Conectar uma IA para o time")).toBeTruthy();
    expect(button("Conectar")).toBeTruthy();
    expect(startCard()).toBeNull();
    expect(document.querySelector(".noai-banner")).toBeNull();
    // It is no stored message: nothing was posted for it.
    expect(calls(state, "chat.post")).toEqual([]);
  });

  test("with an AI: what the workspace does, the business types to tap and the other ways in under it", async () => {
    await openDm(fresh());
    const card = startCard();
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("esperando você");
    expect(card?.textContent).toContain("Com isso eu monto um time pronto, e você só confere.");
    for (const name of ["Agência", "Loja online", "Software e apps", "Outra coisa"])
      expect(within(card as HTMLElement).getByRole("button", { name })).toBeTruthy();
    expect(card?.textContent).toContain("Ou escreva do seu jeito aqui embaixo, numa frase.");
    for (const name of ["Ver modelos de time", "Agentes prontos", "Importar meus agentes"])
      expect(within(card as HTMLElement).getByRole("button", { name })).toBeTruthy();
    // The ready-made agents wait behind their button.
    expect(within(card as HTMLElement).queryByRole("button", { name: /^Criar / })).toBeNull();
    await openPresets();
    const tiles = within(startCard() as HTMLElement)
      .getAllByRole("button", { name: /^Criar / })
      .map((b) => b.textContent);
    expect(tiles).toEqual(["TheoPM", "AdaDev", "LiaPesquisa", "AtlasOps"]);
    expect(screen().queryByText("Conectar uma IA para o time")).toBeNull();
  });

  test("a business type is my own message to Lodi, and the card reads answered with it checked", async () => {
    const state = fresh();
    await openDm(state);
    await click(button("Software e apps"), 10);
    expect(calls(state, "chat.post").map((c) => (c.args[2] as { body: string }).body)).toEqual(["Software e apps"]);
    const card = startCard() as HTMLElement;
    expect(card.textContent).toContain("respondida");
    const picked = within(card).getByRole("button", { name: "Software e apps" });
    expect(picked.getAttribute("aria-pressed")).toBe("true");
    expect((picked as HTMLButtonElement).disabled).toBe(true);
  });

  test("a tile's Criar makes that agent alone, in #general; the other tiles stay, the next card comes under", async () => {
    const state = fresh();
    await openDm(state);
    await openPresets();
    await click(button("Criar Lia"), 12);
    const made = calls(state, "agents.create").map((c) => c.args[1] as { name: string; appearance: unknown });
    expect(made.map((a) => a.name)).toEqual(["Lia"]);
    expect(made[0]?.appearance).toEqual({ color: "rose", eyes: "dots", accessory: "flower" });
    const lia = state.agents.find((a) => a.name === "Lia");
    expect(calls(state, "chat.addMember").map((c) => c.args.slice(1))).toEqual([[GENERAL_ID, { agentId: lia?.id }]]);
    expect(within(startCard() as HTMLElement).queryByRole("button", { name: "Criar Lia" })).toBeNull();
    expect(button("Criar Theo")).toBeTruthy();
    expect(screen().getByRole("group", { name: "O time chegou. E agora?" })).toBeTruthy();
    expect(button("Convidar pessoas")).toBeTruthy();
    // The team button makes only the ones left.
    await click(button("Montar um time pra começar"), 16);
    expect(calls(state, "agents.create").map((c) => (c.args[1] as { name: string }).name)).toEqual([
      "Lia",
      "Theo",
      "Ada",
      "Atlas",
    ]);
    expect(startCard()).toBeNull();
  });

  test("Montar um time pra começar makes the four, each with its own look, on Automático", async () => {
    const state = fresh();
    await openDm(state);
    await openPresets();
    await click(button("Montar um time pra começar"), 16);
    const made = calls(state, "agents.create").map(
      (c) => c.args[1] as { name: string; handle: string; model: string; appearance: unknown },
    );
    expect(made.map((a) => [a.name, a.handle, a.model])).toEqual([
      ["Theo", "theo", "auto"],
      ["Ada", "ada", "auto"],
      ["Lia", "lia", "auto"],
      ["Atlas", "atlas", "auto"],
    ]);
    expect(made[1]?.appearance).toEqual({ color: "green", eyes: "wide", accessory: "headphones" });
    expect(calls(state, "chat.addMember")).toHaveLength(4);
  });

  test("the other ways in: the import opens Settings › Importar", async () => {
    const { router } = await openDm(fresh());
    await click(button("Importar meus agentes"));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/import`);
  });

  test("one question at a time: how agents talk waits for the start card; a greeting leaves it asking, with no second offer", async () => {
    const state = fresh();
    if (state.me?.organizations[0]) state.me.organizations[0].agentStyle = null;
    seedDm(state, { type: "agent", id: LODI_ID }, { body: "oi" });
    await openDm(state);
    expect(screen().queryByText("Como prefere que eu fale com você?")).toBeNull();
    const card = startCard() as HTMLElement;
    expect(card.textContent).toContain("esperando você");
    expect((within(card).getByRole("button", { name: "Agência" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen().queryByRole("button", { name: "Montar o time" })).toBeNull();
  });

  test("Outra coisa puts the cursor in Lodi's composer instead of sending", async () => {
    const state = fresh();
    await openDm(state);
    await click(button("Outra coisa"), 4);
    expect(calls(state, "chat.post")).toEqual([]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Mensagem para Lodi · nada muda sem você");
  });

  test("Dar a primeira tarefa opens the first agent's DM with its task written in the composer", async () => {
    const state = fresh();
    const { router } = await openDm(state);
    await openPresets();
    await click(button("Criar Theo"), 12);
    const theo = state.agents.find((a) => a.name === "Theo");
    await click(button("Dar a primeira tarefa para o Theo"), 12);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${theo?.id}`);
    const box = screen().getByRole("combobox", { name: "Mensagem para Theo" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Monte o plano da nossa primeira semana: o que cada um de nós faz primeiro?");
  });

  test("whoever can't create agents gets the greeting alone; with people here already, no next card", async () => {
    const member = fresh();
    const me = member.me?.organizations[0];
    if (me) me.role = "member";
    await openDm(member);
    expect(document.body.textContent).toContain(GREETING);
    expect(startCard()).toBeNull();
    cleanup();
    // A team and other people: nothing left to offer at the top.
    const busy = withRightHand(seedState());
    await openDm(busy);
    expect(document.body.textContent).toContain(GREETING);
    expect(startCard()).toBeNull();
    expect(screen().queryByRole("group", { name: "O time chegou. E agora?" })).toBeNull();
  });
});
