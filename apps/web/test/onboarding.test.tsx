import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ApiClient, type DirectMessage, keys } from "@agenteschat/client";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import { act, cleanup, fireEvent } from "@testing-library/react";
import {
  ATLAS_ID,
  createFakeApi,
  type FakeState,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
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
/** The first-run checklist (ADR 0155 §6): only for an owner whose Lodi has one. */
const checklist = () => document.querySelector(".setup-cl");

describe("after the workspace's name", () => {
  test("the workspace is set up at once and opens in Lodi's DM, its greeting at the top", async () => {
    const state = seedState({ agents: [] });
    if (state.me) state.me.organizations = [];
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await act(async () => fireEvent.change(screen().getByLabelText("Nome"), { target: { value: "Acme Saúde" } }));
    await click(button("Continuar"), 12);
    // Made finished, with its zone and the person's own (this browser's), in the one call.
    const zone = browserTimezone();
    expect(calls(state, "orgs.create")[0]?.args[0]).toEqual({
      name: "Acme Saúde",
      timezone: zone ?? "UTC",
      ...(zone ? { memberTimezone: zone } : {}),
      finished: true,
    });
    const orgId = state.me?.organizations.at(-1)?.id;
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
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

/** Every call the app makes, reads too, in order, as "orgs.create". */
function recorded(api: ApiClient) {
  const log: string[] = [];
  const wrap = <T extends object>(target: T, path: string): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver);
        const name = path ? `${path}.${String(key)}` : String(key);
        if (typeof value === "function")
          return (...args: unknown[]) => {
            log.push(name);
            return value.apply(obj, args);
          };
        return value && typeof value === "object" ? wrap(value, name) : value;
      },
    });
  return { api: wrap(api, ""), log };
}

/**
 * How long "Abrindo seu workspace" waits is its calls one after another: each is a round trip to the server (#1).
 */
describe("opening a new workspace, in round trips", () => {
  test("Continuar makes the workspace in one call that answers where it opens and who the person is now", async () => {
    const state = seedState({ agents: [] });
    if (state.me) state.me.organizations = [];
    const { api, log } = recorded(createFakeApi(state));
    const { router } = await renderApp("/onboarding", { api });
    await act(async () => fireEvent.change(screen().getByLabelText("Nome"), { target: { value: "Acme Saúde" } }));
    log.length = 0;
    const off = router.subscribe("onBeforeNavigate", (e) => {
      if (e.pathChanged) log.push(`→ ${e.toLocation.pathname}`);
    });
    await click(button("Continuar"), 12);
    off();
    const orgId = state.me?.organizations.at(-1)?.id;
    // Everything before the app goes to the workspace waits on the one before it.
    expect(log.slice(0, log.findIndex((c) => c.startsWith("→")) + 1)).toEqual([
      "orgs.create",
      `→ /org/${orgId}/dm/agent/${LODI_ID}`,
    ]);
    // Its zone, the person's own and the finished onboarding went with it.
    expect(calls(state, "orgs.create")[0]?.args[0]).toMatchObject({ name: "Acme Saúde", finished: true });
    expect(state.me?.organizations.at(-1)?.onboarding).toBeUndefined();
    expect(router.state.location.pathname).toBe(`/org/${orgId}/dm/agent/${LODI_ID}`);
    expect(document.body.textContent).toContain(GREETING);
  });

  test("a logo picked first: the workspace, its logo, then the finish, whose answer opens it", async () => {
    const state = seedState({ agents: [] });
    if (state.me) state.me.organizations = [];
    const { api, log } = recorded(createFakeApi(state));
    const { router } = await renderApp("/onboarding", { api });
    await click(button("Escolher o logo"), 4);
    const dialog = screen().getByRole("dialog", { name: "Logo do workspace" });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () =>
      fireEvent.change(input, { target: { files: [new File(["png-bytes"], "logo.png", { type: "image/png" })] } }),
    );
    await settle(3);
    await click(screen().getByRole("button", { name: "Salvar" }), 6);
    await act(async () => fireEvent.change(screen().getByLabelText("Nome"), { target: { value: "Acme Saúde" } }));
    log.length = 0;
    const off = router.subscribe("onBeforeNavigate", (e) => {
      if (e.pathChanged) log.push(`→ ${e.toLocation.pathname}`);
    });
    await click(button("Continuar"), 12);
    off();
    const orgId = state.me?.organizations.at(-1)?.id;
    expect(log.slice(0, log.findIndex((c) => c.startsWith("→")) + 1)).toEqual([
      "orgs.create",
      "orgs.setLogo",
      "orgs.saveOnboarding",
      `→ /org/${orgId}/dm/agent/${LODI_ID}`,
    ]);
    expect(calls(state, "orgs.create")[0]?.args[0]).not.toHaveProperty("finished");
    expect(state.me?.organizations.at(-1)?.onboarding).toBeUndefined();
  });

  test("a conversation opened for the first time shows from its own answer, no list read again for it", async () => {
    const state = seedState();
    const { api, log } = recorded(createFakeApi(state));
    const { services } = await renderApp(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`, { api });
    await settle(10);
    expect(screen().getByRole("heading", { level: 1, name: /Atlas/ })).toBeTruthy();
    expect(log.filter((c) => c === "dms.open")).toHaveLength(1);
    expect(log.filter((c) => c === "dms.list")).toHaveLength(1);
    expect(log.filter((c) => c === "chat.channels")).toHaveLength(1);
    // In the DM list all the same, where the header's search finds it.
    const dms = services.queryClient.getQueryData<DirectMessage[]>(keys.dms(ORG_ID)) ?? [];
    expect(dms.some((d) => d.with.id === ATLAS_ID)).toBe(true);
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
