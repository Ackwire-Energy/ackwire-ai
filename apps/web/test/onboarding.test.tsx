import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, type FakeState, GENERAL_ID, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
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
/** The first-run checklist (ADR 0152 §6): only for an owner whose Lodi has one. */
const checklist = () => document.querySelector(".setup-cl");

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

describe("the top of Lodi's DM without its checklist", () => {
  test("no AI yet: the greeting, then Connect AI only (no banner over the composer)", async () => {
    const state = fresh();
    state.aiStatus = { any: false, agents: [{ agentId: LODI_ID, state: "no_ai" }] };
    await openDm(state);
    expect(document.body.textContent).toContain(GREETING);
    expect(document.body.textContent).toContain(
      "Crio os agentes, conecto os apps e convido as pessoas. Nada muda sem você pedir, e eu faço só o que você pode fazer.",
    );
    expect(screen().getByText("Conectar uma IA para o time")).toBeTruthy();
    expect(button("Conectar")).toBeTruthy();
    expect(checklist()).toBeNull();
    expect(document.querySelector(".noai-banner")).toBeNull();
    // It is no stored message: nothing was posted for it.
    expect(calls(state, "chat.post")).toEqual([]);
  });

  test("with a team and an AI: the greeting and the way to build the team again, no card", async () => {
    await openDm(withRightHand(seedState()));
    expect(document.body.textContent).toContain(GREETING);
    expect(checklist()).toBeNull();
    expect(button("Montar o time")).toBeTruthy();
  });
});
