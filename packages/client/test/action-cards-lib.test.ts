import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentProposalCard } from "../src/api/types";
import { actionCardOf, agentProposalOf, draftLevels, proposalStatus, suggestedAiText } from "../src/lib/action-cards";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const card = (patch: Partial<AgentProposalCard> = {}): AgentProposalCard => ({
  kind: "agent_proposal",
  forUserId: "u1",
  params: {
    draft: {
      name: "Nina",
      handle: "nina",
      role: "Designer",
      instructions: "Desenha.",
      appearance: null,
      channelIds: [],
      access: [
        { connectionId: "c-github", level: "write" },
        { connectionId: "c-linear", level: "read" },
      ],
      ai: { kind: "model" },
    },
    why: "Para o design.",
  },
  state: "pending",
  agentId: null,
  decidedByUserId: null,
  decidedAt: null,
  expiresAt: new Date(NOW + HOUR).toISOString(),
  ...patch,
});

test("a proposal is an action card of its own; a Connect card stays one", () => {
  expect(actionCardOf({ actionCard: card() })?.kind).toBe("agent_proposal");
  expect(agentProposalOf({ actionCard: card() })?.params.draft.handle).toBe("nina");
  const connect = { actionCard: { kind: "connect_ai", forUserId: null, params: { why: "x", agentIds: [] } } };
  expect(actionCardOf(connect)?.kind).toBe("connect_ai");
  expect(agentProposalOf(connect)).toBeNull();
  expect(agentProposalOf({ actionCard: { kind: "agent_proposal" } })).toBeNull();
});

test("where it stands: open until a day passes (also while someone creates it), then what was decided", () => {
  expect(proposalStatus(card(), NOW)).toBe("open");
  expect(proposalStatus(card({ state: "creating" }), NOW)).toBe("open");
  expect(proposalStatus(card(), NOW + 2 * HOUR)).toBe("expired");
  expect(proposalStatus(card({ state: "created", agentId: "a1" }), NOW + 2 * HOUR)).toBe("created");
  expect(proposalStatus(card({ state: "denied" }), NOW)).toBe("denied");
});

test("the draft's levels by connection, and the AI it suggests in words", () => {
  expect(draftLevels(card().params.draft)).toEqual({ "c-github": "write", "c-linear": "read" });
  const t = ((key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key) as unknown as TFunction;
  expect(suggestedAiText(t, { kind: "model" })).toBe("actionCard.agentProposal.aiModel");
  expect(suggestedAiText(t, { kind: "none" })).toBe("actionCard.agentProposal.aiNone");
  expect(
    suggestedAiText(t, { kind: "account", brain: "codex", machineId: "m", accountId: "a", label: "ChatGPT Plus" }),
  ).toBe('actionCard.agentProposal.aiAccount:{"account":"ChatGPT Plus"}');
});
