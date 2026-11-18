import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { OrgPlanUsage, PlanAccountUsage } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, settle, showIn } from "./render";

/**
 * Settings › AI and usage: under an open account's agents, its use by kind, and when handoffs between agents led the
 * week, a hint to message the agent that took most of that work.
 */

const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function claudeMax(over: Partial<PlanAccountUsage> = {}): PlanAccountUsage {
  return {
    key: "machine_1:claude_code:acct_max",
    machineId: "machine_1",
    machineName: "MacBook",
    kind: "claude_code",
    accountId: "acct_max",
    label: "Claude Max",
    plan: "max",
    provider: null,
    ownerName: "Walter",
    mine: false,
    email: null,
    signedOut: false,
    usage: {
      windows: [
        {
          kind: "five_hour",
          usedPercent: 86,
          resetsAt: soon(2),
          agents: [
            { agentId: LODI_ID, name: "Lodi", percent: 44 },
            { agentId: ADA_ID, name: "Ada", percent: 27 },
            { agentId: ATLAS_ID, name: "Atlas", percent: 15 },
          ],
        },
        {
          kind: "seven_day",
          usedPercent: 71,
          resetsAt: soon(72),
          agents: [
            { agentId: LODI_ID, name: "Lodi", percent: 33 },
            { agentId: ADA_ID, name: "Ada", percent: 24 },
            { agentId: ATLAS_ID, name: "Atlas", percent: 14 },
          ],
        },
      ],
      source: "turn",
      at: new Date().toISOString(),
    },
    agents: [
      { agentId: LODI_ID, name: "Lodi", tokens: 6_200_000, now: true },
      { agentId: ADA_ID, name: "Ada", tokens: 4_500_000, now: true },
      { agentId: ATLAS_ID, name: "Atlas", tokens: 2_600_000, now: true },
    ],
    monthTokens: 13_300_000,
    kinds: [
      { kind: "routines", tokens: 1_400_000, percent: 7 },
      { kind: "handoffs", tokens: 6_900_000, percent: 37 },
      { kind: "people", tokens: 5_000_000, percent: 27 },
    ],
    hint: { kind: "handoffs", agentId: ADA_ID },
    ...over,
  };
}

async function openUsage(account: PlanAccountUsage, lang?: "en") {
  const api = createFakeApi(withRightHand(seedState()));
  api.orgs.planUsage = async (): Promise<OrgPlanUsage> => ({
    month: new Date().toISOString().slice(0, 7),
    money: false,
    api: [],
    accounts: [account],
  });
  const { services } = await renderApp(`/org/${ORG_ID}/settings/usage`, { api });
  await settle(6);
  if (lang) await showIn(services, lang);
  const head = document.querySelector(".plan-row__head");
  // Near its limit the row starts open.
  if (head?.getAttribute("aria-expanded") === "false") {
    await act(async () => fireEvent.click(head));
    await settle(4);
  }
  (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  return document.querySelector(".plan-row__body") as HTMLElement;
}

test("an open account lists its use by kind under the agents, handoffs first, and offers to message Ada", async () => {
  const body = await openUsage(claudeMax(), "en");
  expect(within(body).getByText("By kind")).toBeTruthy();
  const rows = [...body.querySelectorAll(".plan-kinds .plan-shares__row")].map((r) => r.textContent);
  expect(rows).toEqual([
    "Handoffs between agents · week 37% · 6.9M tokens",
    "Conversations with people · week 27% · 5M tokens",
    "Routines · week 7% · 1.4M tokens",
  ]);
  const hint = body.querySelector(".plan-kinds__hint") as HTMLElement;
  expect(hint.getAttribute("role")).toBe("status");
  expect(hint.textContent).toContain("Most of this week's use came from agents handing work to each other.");
  const link = within(hint).getByRole("link", { name: "Message Ada" });
  expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
  cleanup();
});

test("no hint from the server, no hint; no kinds (an older server), no list", async () => {
  let body = await openUsage(claudeMax({ hint: null }));
  expect(body.querySelectorAll(".plan-kinds .plan-shares__row")).toHaveLength(3);
  expect(body.querySelector(".plan-kinds__hint")).toBeNull();
  cleanup();
  const { kinds: _k, hint: _h, ...older } = claudeMax();
  body = await openUsage(older);
  expect(body.querySelector(".plan-kinds")).toBeNull();
  expect(body.querySelector(".plan-kinds__label")).toBeNull();
  cleanup();
});
