import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, LODI_ID, NOW, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
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
  // Only the plans it can think with: Claude's and the coding plans through Claude Code.
  const picker = within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" });
  expect(within(picker).queryByRole("button", { name: "Claude" })).toBeTruthy();
  expect(within(picker).queryByRole("button", { name: "ChatGPT" })).toBeNull();
  expect(within(picker).queryByRole("button", { name: "Cursor" })).toBeNull();
  expect(within(picker).queryByRole("button", { name: "OpenCode" })).toBeNull();
});

test("someone else's plan: the line says it answers only its owner", async () => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(lodiOnPlan("plan_not_shared")) });
  await settle(8);
  const card = document.querySelector(".waitcard") as HTMLElement;
  expect(card.textContent).toContain("Lodi pensa com um plano que só atende o próprio dono.");
  expect(within(card).getByRole("button", { name: "Usar uma chave de API" })).toBeTruthy();
});
