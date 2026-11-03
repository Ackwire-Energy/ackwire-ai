import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DirectMessage } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { introCards, presetsLeft, rightHandOf } from "@agenteschat/client/lib/right-hand";
import { agentStarters, buildConversations, homeLayout, rightHandPin } from "../../src/features/chats/logic";
import { SETTINGS_SECTIONS, visibleSections } from "../../src/features/settings/logic";
import { agent, at } from "./fixtures";

const lodi = agent({ id: "a-lodi", name: "Lodi", builtin: "right_hand" });
const theo = agent({ id: "a-theo", name: "Theo" });
const dm = (a: { id: string; name: string; handle: string }, minutesAgo: number, unread = 0): DirectMessage => ({
  channelId: `d-${a.id}`,
  with: { type: "agent", id: a.id, name: a.name, handle: a.handle },
  lastMessage: { id: `m-${a.id}`, body: "Oi", createdAt: at(minutesAgo), authorType: "agent" },
  unread,
});

test("the right hand is pinned on top of Conversas, its DM's unread kept, and never under Agentes", () => {
  const rows = buildConversations({ channels: [], dms: [dm(lodi, 1, 2), dm(theo, 5)], threads: [] });
  const { pin, rows: rest } = rightHandPin(rows, rightHandOf([theo, lodi]));
  expect(pin).toMatchObject({ kind: "dm", channelId: "d-a-lodi", unread: 2 });
  const agents = homeLayout(rest, []).find((s) => s.key === "agents");
  expect(agents?.rows.map((r) => r.key)).toEqual(["d:d-a-theo"]);
});

test("with no DM yet its row starts one, and the Agentes starters leave it out", () => {
  const { pin, rows } = rightHandPin([], lodi);
  expect(pin).toMatchObject({ kind: "dm", channelId: "", with: { id: "a-lodi" } });
  expect(rows).toEqual([]);
  const starters = agentStarters([lodi, theo].filter((a) => a.builtin !== "right_hand"));
  expect(starters.map((r) => r.key)).toEqual(["a:a-theo"]);
});

test("outside its audience there is no pin", () => {
  const hidden = { ...lodi, canTalk: false };
  expect(canTalk(hidden)).toBe(false);
  const rows = buildConversations({ channels: [], dms: [dm(lodi, 1)], threads: [] });
  expect(rightHandPin(rows, canTalk(hidden) ? hidden : undefined)).toEqual({ pin: null, rows });
});

test("its greeting's cards: Connect AI, then how to start, then what next, then none", () => {
  const base = { noAi: false, aiKnown: true, teamHandles: [] as string[], createsAgents: true, alone: true };
  expect(introCards({ ...base, noAi: true })).toEqual(["connect"]);
  expect(introCards(base)).toEqual(["start"]);
  // Not known yet, or someone who can't create agents: no start card.
  expect(introCards({ ...base, aiKnown: false })).toEqual([]);
  expect(introCards({ ...base, createsAgents: false })).toEqual([]);
  // One ready-made agent created: the others still have their Criar, and what next shows under them.
  expect(introCards({ ...base, teamHandles: ["theo"] })).toEqual(["start", "next"]);
  expect(presetsLeft(["theo"])).toEqual(["ada", "lia", "atlas"]);
  // All four, or an agent of their own: they moved on.
  expect(introCards({ ...base, teamHandles: ["theo", "ada", "lia", "atlas"] })).toEqual(["next"]);
  expect(introCards({ ...base, teamHandles: ["theo", "iara"] })).toEqual(["next"]);
  expect(introCards({ ...base, teamHandles: ["iara"], alone: false })).toEqual([]);
  // People here already: nothing left to offer, ready-made agents or not.
  expect(introCards({ ...base, teamHandles: ["ada"], alone: false })).toEqual([]);
});

test("Configurações has its section for who manages agents, at its own screen", () => {
  const ids = (permissions: string[]) =>
    visibleSections({ id: "o", name: "Acme", role: "member", permissions }).map((s) => s.id);
  expect(ids(["read", "manage_agents"])).toContain("right_hand");
  expect(ids(["read"])).not.toContain("right_hand");
  expect(SETTINGS_SECTIONS.find((s) => s.id === "right_hand")?.href).toBe("/settings/right-hand");
});

test("its DM, cards and profile treat it apart through the one shared helper", () => {
  const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");
  // No computer in its DM, its own line and composer hint.
  const chat = src("chat/ChatScreen.tsx");
  expect(chat).toContain("isRightHand(dmAgent)");
  expect(chat).toContain('t("rightHand.composerHint")');
  expect(chat).toMatch(/dmComputer = dmAgentId && !isThread && !rightHand/);
  // Never archived or deleted from the phone.
  expect(src("agents/AgentEditScreen.tsx")).toContain("admin && !rightHand");
  // No coordinator anywhere on the phone (ADR 0093, superseded by 0134).
  for (const f of [
    "agents/AgentEditScreen.tsx",
    "agents/edit.ts",
    "agents/AgentProfileScreen.tsx",
    "chat/ChannelMembers.tsx",
  ])
    expect(src(f)).not.toMatch(/coordinator/i);
});
