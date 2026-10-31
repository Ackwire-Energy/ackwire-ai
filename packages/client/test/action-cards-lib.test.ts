import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentProposalCard } from "../src/api/types";
import {
  actionCardOf,
  agentProposalOf,
  draftLevels,
  mayContinueStretch,
  proposalStatus,
  stretchCardOf,
  stretchCardText,
  suggestedAiText,
} from "../src/lib/action-cards";

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

test("a stretch's pause card (ADR 0089): read safely, said with the agents' names, Continuar for the right people", () => {
  const raw = {
    kind: "stretch_paused",
    stretchId: "s1",
    state: "paused",
    reason: "runs",
    limit: 50,
    forUserId: "u-ana",
    agentIds: ["ada", "theo"],
    held: [{ agentId: "ada", messageId: "m9", trigger: "mention" }],
    continuedByUserId: null,
    continuedAt: null,
  };
  const card = stretchCardOf({ actionCard: raw });
  expect(card).toMatchObject({ kind: "stretch_paused", state: "paused", reason: "runs", limit: 50 });
  expect(actionCardOf({ actionCard: raw })?.kind).toBe("stretch_paused");
  expect(stretchCardOf({ actionCard: { kind: "stretch_paused" } })).toBeNull();
  if (!card) throw new Error("no card");
  const t = ((key: string, values?: Record<string, unknown>) =>
    key === "newAgent.and" ? " e " : `${key}:${JSON.stringify(values)}`) as unknown as TFunction;
  expect(stretchCardText(t, card, ["Ada", "Theo"])).toBe(
    'chat.body.stretch_paused_runs:{"agents":"Ada e Theo","count":2,"steps":50}',
  );
  const spend = { ...card, reason: "spend" as const, limit: 20, agentIds: ["ada"] };
  expect(stretchCardText(t, spend, ["Ada"])).toBe(
    'chat.body.stretch_paused_spend:{"agents":"Ada","count":1,"percent":20}',
  );
  expect(stretchCardText(t, spend, ["Ada"], "US$ 10")).toBe(
    'chat.body.stretch_paused_spend:{"agents":"Ada","count":1,"percent":20,"context":"cost","amount":"US$ 10"}',
  );
  const owner = (id: string) => (id === "theo" ? "u-bia" : null);
  expect(mayContinueStretch(card, "u-ana", owner, false)).toBe(true);
  expect(mayContinueStretch(card, "u-bia", owner, false)).toBe(true);
  expect(mayContinueStretch(card, "u-caio", owner, false)).toBe(false);
  expect(mayContinueStretch(card, "u-caio", owner, true)).toBe(true);
  expect(mayContinueStretch(card, null, owner, false)).toBe(false);
});
