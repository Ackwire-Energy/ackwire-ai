import { describe, expect, test } from "bun:test";
import type { AgentAccess, Run } from "@agenteschat/client";
import { activitySections, dayGroupOf, emojisOf, subtitleOf, whoOf } from "../../src/features/activity/logic";
import { busyAgents, canUse, crewOf, spendOf, workingNow } from "../../src/features/agents/logic";
import { fold, isEmpty, matches, searchResults } from "../../src/features/search/logic";
import { agent, mission, notification } from "./fixtures";

const NOW = new Date(2026, 9, 17, 15, 0);
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe("Atividade", () => {
  const items = [
    notification({ id: "approval", kind: "approval", waiting: true, updatedAt: ago(1) }),
    notification({ id: "question", kind: "agent_question", waiting: true, updatedAt: ago(3) }),
    notification({ id: "today", updatedAt: ago(1) }),
    notification({ id: "yesterday", updatedAt: ago(24) }),
    notification({ id: "week", updatedAt: ago(24 * 4) }),
    notification({ id: "old", updatedAt: ago(24 * 30) }),
    notification({ id: "done", updatedAt: ago(1), doneAt: ago(0.5) }),
    notification({ id: "snoozed", updatedAt: ago(1), snoozedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() }),
  ];

  test("waiting on top (a question before an approval), the rest by day; done and snoozed leave", () => {
    const s = activitySections(items, "all", NOW);
    expect(s.waiting.map((n) => n.id)).toEqual(["question", "approval"]);
    expect(s.days.map(([g, list]) => [g, list.map((n) => n.id)])).toEqual([
      ["today", ["today"]],
      ["yesterday", ["yesterday"]],
      ["week", ["week"]],
      ["older", ["old"]],
    ]);
  });

  test("the waiting filter shows only what waits", () => {
    const s = activitySections(items, "waiting", NOW);
    expect(s.waiting).toHaveLength(2);
    expect(s.days).toEqual([]);
  });

  test("day groups in local time", () => {
    expect(dayGroupOf(ago(2), NOW)).toBe("today");
    expect(dayGroupOf(ago(20), NOW)).toBe("yesterday");
  });

  test("who did it: up to two names and how many more", () => {
    const names: Record<string, string> = { u1: "Theo", u2: "Ana", u3: "Luíza", u4: "" };
    const nameOf = (a: { id: string }) => names[a.id] ?? "";
    expect(whoOf([{ type: "agent", id: "u1" }], nameOf)).toEqual({ first: "Theo", second: null, more: 0, total: 1 });
    expect(
      whoOf(
        [
          { type: "agent", id: "u1" },
          { type: "user", id: "u2" },
          { type: "user", id: "u3" },
          { type: "user", id: "u4" },
        ],
        nameOf,
      ),
    ).toEqual({ first: "Theo", second: "Ana", more: 1, total: 3 });
  });

  test("the line under the title", () => {
    expect(
      subtitleOf(
        notification({ id: "r", kind: "reaction", latest: { quote: "a campanha bateu a meta", emojis: ["🎉"] } }),
      ),
    ).toBe("a campanha bateu a meta");
    expect(subtitleOf(notification({ id: "a", kind: "approval", latest: { title: "Publicar o ajuste" } }))).toBe(
      "Publicar o ajuste",
    );
    expect(emojisOf(notification({ id: "r", kind: "reaction", latest: { emojis: ["🎉", "👏"] } }))).toEqual([
      "🎉",
      "👏",
    ]);
  });
});

describe("who is working", () => {
  const run = (id: string, agentId: string, status: string, threadId: string, createdAt = ago(1)) =>
    ({ id, agentId, status, threadId, channelId: "c1", what: "Cruzando as vendas", createdAt }) as Run;

  test("active missions first, then runs in progress (one per agent and thread)", () => {
    const work = workingNow(
      [
        run("r1", "nina", "running", "t9"),
        run("r2", "nina", "queued", "t9", ago(2)),
        run("r3", "dev", "running", "t1"),
        run("r4", "theo", "done", "t5"),
      ],
      [mission({ id: "m1", agentId: "dev", threadId: "t1" }), mission({ id: "m2", status: "paused", agentId: "iris" })],
    );
    expect(work.map((w) => w.key)).toEqual(["m:m1", "r:r1"]);
    expect([...busyAgents(work)]).toEqual(["dev", "nina"]);
  });

  test("the crew: working ones first, then by name", () => {
    const crew = crewOf(
      [agent({ id: "b", name: "Bento" }), agent({ id: "n", name: "Nina" }), agent({ id: "a", name: "Ana" })],
      new Set(["n"]),
      2,
    );
    expect(crew.map((c) => [c.agent.name, c.busy])).toEqual([
      ["Nina", true],
      ["Ana", false],
    ]);
  });

  test("this month: money only when the API shows it, else the share of the budget", () => {
    expect(
      spendOf({
        budgetUsedPercent: 25,
        monthlyBudgetUsd: 50,
        usage: { agentId: "a", handle: "a", calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 12.4 },
      }),
    ).toEqual({
      kind: "money",
      spentUsd: 12.4,
      budgetUsd: 50,
      fraction: 12.4 / 50,
    });
    expect(spendOf({ budgetUsedPercent: 41.6 })).toEqual({ kind: "percent", percent: 42, fraction: 0.416 });
    expect(spendOf({ budgetUsedPercent: 140, usage: null })).toMatchObject({ kind: "percent", fraction: 1 });
  });

  test("what it may use: apps and built-in groups that are on", () => {
    const access = {
      all: false,
      builtins: [
        { scope: "drive", label: "Drive", state: "granted", tools: [] },
        { scope: "issues", label: "Issues", state: "off", tools: [] },
      ],
      connectors: [
        { connectionId: "c1", connector: "github", label: "GitHub", custom: false, state: "inherited", scopes: [] },
        { connectionId: "c2", connector: "stripe", label: "Stripe", custom: false, state: "off", scopes: [] },
      ],
    } as unknown as AgentAccess;
    expect(canUse(access).map((x) => x.label)).toEqual(["GitHub", "Drive"]);
    expect(canUse(null)).toEqual([]);
  });
});

describe("Busca", () => {
  test("accents and case don't matter", () => {
    expect(fold("Ação")).toBe("acao");
    expect(matches("acao", "Nova Ação")).toBe(true);
    expect(matches("", "x")).toBe(true);
  });

  test("actions, agents, conversations and only message hits", () => {
    const r = searchResults("nova", {
      actionLabels: { newConversation: "Nova conversa", newTask: "Pedir uma tarefa", newAgent: "Criar agente" },
      agents: [agent({ id: "n", name: "Nina", role: "Dados" })],
      channels: [{ id: "c", name: "nova-loja", topic: "", visibility: "public", isMember: true, createdAt: "" }],
      dms: [],
      hits: [
        {
          kind: "message",
          sourceId: "m1",
          channelIds: ["c"],
          title: "",
          snippet: "nova versão",
          score: 1,
          createdAt: "",
        },
        { kind: "issue", sourceId: "i1", channelIds: [], title: "Nova issue", snippet: "", score: 1, createdAt: "" },
      ],
    });
    expect(r.actions).toEqual(["newConversation"]);
    expect(r.agents).toEqual([]);
    expect(r.channels.map((c) => c.id)).toEqual(["c"]);
    expect(r.messages.map((h) => h.sourceId)).toEqual(["m1"]);
    expect(isEmpty(r)).toBe(false);
  });
});
