import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeAgentBrain, LODI_ID, NOW, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The team's right hand on a Claude plan (ADR 0137 §1, §7): the line its DM shows, and the plans Connect offers it. */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const line = (reason: string): Message => ({
  id: "m-line",
  channelId: `dm-${LODI_ID}`,
  threadId: null,
  author: { type: "agent", id: LODI_ID },
  body: "I can't answer now: the computer my plan is signed in on is away.",
  mentionedAgentIds: [],
  agentRunId: "r-line",
  meta: {
    bodyCode: "no_ai",
    noAi: { agentId: LODI_ID, forUserId: "u-walter", reason, intent: "task", runId: "r-line" },
  },
  createdAt: NOW.toISOString(),
});

const lodiOnPlan = (reason: string) => {
  const state = withRightHand(
    seedState({ aiStatus: { any: true, agents: [{ agentId: LODI_ID, state: "waiting" }] } }),
    { brain: { kind: "claude_code", model: "Sonnet" } },
  );
  seedDm(state, { type: "agent", id: LODI_ID });
  state.messages.push(line(reason));
  return state;
};

test("its plan's computer away: one plain line in its DM, and Usar uma chave de API opens Connect on the key", async () => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(lodiOnPlan("computer_away")) });
  await settle(8);
  const card = document.querySelector(".waitcard") as HTMLElement;
  expect(card.textContent).toContain("Lodi não consegue responder agora: o computador do plano está fora do ar.");
  // Never a spinner, never "Conectar" as if it had no AI.
  expect(card.querySelector(".ac-spinner")).toBeNull();
  expect(within(card).queryByRole("button", { name: "Conectar" })).toBeNull();
  await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Usar uma chave de API" })));
  await settle(6);
  const dialog = screen().getByRole("dialog", { name: /Lodi/ });
  // Every plan, as for any agent: Codex's and Cursor's too (ADR 0137 §4, the owner's accepted risk).
  const picker = within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" });
  for (const name of ["Claude", "ChatGPT", "Cursor"]) {
    expect(within(picker).queryByRole("button", { name })).toBeTruthy();
  }
  expect(within(picker).queryAllByRole("button", { name: /OpenCode/ }).length).toBeGreaterThan(0);
});

test("someone else's plan: the line says it answers only its owner", async () => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(lodiOnPlan("plan_not_shared")) });
  await settle(8);
  const card = document.querySelector(".waitcard") as HTMLElement;
  expect(card.textContent).toContain("Lodi pensa com um plano que só atende o próprio dono.");
  expect(within(card).getByRole("button", { name: "Usar uma chave de API" })).toBeTruthy();
});

test("its computer's runner too old: the line says to update it, never that it has no AI", async () => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(lodiOnPlan("runner_outdated")) });
  await settle(8);
  const card = document.querySelector(".waitcard") as HTMLElement;
  expect(card.textContent).toContain(
    "Lodi não consegue responder agora: o programa no computador do plano precisa ser atualizado.",
  );
  expect(card.textContent).not.toContain("nenhuma IA");
  expect(within(card).getByRole("button", { name: "Usar uma chave de API" })).toBeTruthy();
});

test("Settings › Lodi on someone else's OpenCode plan: an admin may still let other people's DMs use it", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "opencode", model: "opencode/glm-5.3" } });
  const api = createFakeApi(state);
  api.agents.brain = async () =>
    fakeAgentBrain(LODI_ID, {
      brain: "opencode",
      account: "acc-ana",
      accounts: [
        {
          id: "acc-ana",
          kind: "opencode",
          label: "Zen da Ana",
          ownerId: "u-ana",
          status: "active",
          shared: true,
          usedBy: [],
        } as never,
      ],
      onlyOwner: true,
      canUsePlans: false,
      canEdit: true,
    });
  await renderApp(`/org/${ORG_ID}/settings/right_hand`, { api });
  await settle(8);
  const body = document.querySelector(".settings__body") as HTMLElement;
  expect(body.textContent).toContain("OpenCode · Zen da Ana");
  const share = within(body).getByRole("switch", { name: "Atende outras pessoas" });
  expect(share.hasAttribute("disabled")).toBe(false);
  await act(async () => fireEvent.click(share));
  await settle(4);
  expect(state.calls.find((c) => c.method === "agents.setBrain")?.args.slice(1)).toEqual([
    LODI_ID,
    { onlyOwner: false },
  ]);
});
