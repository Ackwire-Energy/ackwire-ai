import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeAgentBrain, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * ADR 0137 §11: "Sua IA" is every person's, the workspace's AI is the admins', and every row of Lodi's settings has the
 * same structure. Its page opens docked beside its conversation, like a thread, with nothing dimmed.
 */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const planOf = (ownerId: string | undefined) =>
  ({
    id: "acc-ana",
    kind: "claude_code",
    label: "Trabalho",
    ownerId,
    mine: true,
    status: "active",
    shared: true,
    usedBy: [],
  }) as never;

test("Lodi's settings: the face opens the look, the plan is its logo and name on its own line, every row a row", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "claude_code", model: "Sonnet" } });
  const api = createFakeApi(state);
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: "claude_code",
      account: "acc-ana",
      accounts: [planOf(state.me?.user.id)],
      onlyOwner: true,
      canUsePlans: true,
      canEdit: true,
    });
  await renderApp(`/org/${ORG_ID}/settings/right_hand`, { api });
  await settle(8);
  const body = document.querySelector(".settings__body") as HTMLElement;
  expect(within(body).queryByRole("button", { name: "Mudar visual" })).toBeNull();
  await act(async () => fireEvent.click(within(body).getByRole("button", { name: "Mudar o visual do Lodi" })));
  await settle(4);
  expect(screen().getByRole("dialog", { name: "Mudar visual" })).toBeTruthy();
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Cancelar" })));
  await settle(2);
  const lines = [...body.querySelectorAll(".rh-set__planline")];
  expect(lines.length).toBe(2);
  for (const line of lines) {
    expect(line.querySelector(".ac-provider-logo, svg, img")).toBeTruthy();
    expect(line.textContent).toContain("Trabalho");
    // Under the row's text, never beside the control.
    expect(line.closest(".settings-row__help")).toBeTruthy();
  }
  const share = within(body).getByRole("switch", { name: "Atende outras pessoas" });
  expect(share.closest(".settings-row")).toBeTruthy();
  expect(share.closest(".settings-row")?.querySelector(".settings-row__icon svg")).toBeTruthy();
});

test("a member's Lodi page has Sua IA: what their DM thinks with without a plan, and Conectar meu plano", async () => {
  const state = withRightHand(seedState());
  const me = state.me?.organizations[0];
  if (me) me.role = "member";
  const api = createFakeApi(state);
  api.agents.brain = async (_org, id) =>
    fakeAgentBrain(id, {
      scope: "mine",
      brain: "model",
      accounts: [],
      canUsePlans: true,
      workspaceAi: { brain: "claude_code", ownerId: "u-ana", servesYou: false },
    });
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  const row = document.querySelector(".settings-row") as HTMLElement;
  expect(row.textContent).toContain("Sua IA");
  expect(row.textContent).toContain("o plano do workspace só atende");
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Conectar meu plano" })));
  await settle(6);
  expect(screen().getByRole("dialog", { name: /Lodi/ })).toBeTruthy();
});

test("after a key is chosen and the page reloads, Lodi's settings name it: Sua IA says it's the workspace's, the workspace's AI shows it", async () => {
  const state = withRightHand(seedState());
  const api = createFakeApi(state);
  const key = { provider: "openai", label: "OpenAI da Acme" };
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: "model",
      accounts: [],
      canUsePlans: true,
      workspaceAi: { brain: "model", ownerId: null, servesYou: true, key },
    });
  await renderApp(`/org/${ORG_ID}/settings/right_hand`, { api });
  await settle(8);
  const rows = [...document.querySelectorAll(".settings-row")].map((r) => r.textContent ?? "");
  expect(rows.find((r) => r.includes("Sua IA"))).toContain("a chave do workspace: OpenAI da Acme");
  expect(rows.find((r) => r.includes("IA do workspace"))).toContain("OpenAI da Acme");
});

describe("the agent's page beside its conversation", () => {
  const openPanel = async () => {
    const state = withRightHand(seedState());
    seedDm(state, { type: "agent", id: LODI_ID });
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const opener = document.querySelector(".dm-who__hit") as HTMLElement;
    opener.focus();
    await act(async () => fireEvent.click(opener));
    await settle(6);
    return opener;
  };
  const panel = () => document.querySelector(".thread-panel--wide") as HTMLElement | null;

  test("floats over a scrim, takes the focus, and gives it back on Esc", async () => {
    const opener = await openPanel();
    const side = panel() as HTMLElement;
    expect(side.previousElementSibling?.classList.contains("thread-panel__scrim")).toBe(true);
    expect(side.contains(document.activeElement)).toBe(true);
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    await act(async () => fireEvent.keyDown(side, { key: "Escape" }));
    await settle(3);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("its × and its opener again close it", async () => {
    const opener = await openPanel();
    await act(async () =>
      fireEvent.click(within(panel() as HTMLElement).getAllByRole("button", { name: "Fechar" })[0] as HTMLElement),
    );
    await settle(3);
    expect(panel()).toBeNull();
    await act(async () => fireEvent.click(opener));
    await settle(4);
    expect(panel()).toBeTruthy();
    await act(async () => fireEvent.click(opener));
    await settle(4);
    expect(panel()).toBeNull();
  });
});
