import { describe, expect, test } from "bun:test";
import type { AgentAccess, AgentForYouItem, Memory, PlanUsage } from "@agenteschat/client";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { planLine } from "@agenteschat/ui/plan-state";
import {
  canEditMemories,
  dayWord,
  didLines,
  knownAboutMe,
  memoryOrigin,
  plainRole,
  teamLines,
  usesOf,
  type WorkItem,
} from "../../src/features/agents/logic";
import { agent, translator } from "./fixtures";

const NOW = new Date(2026, 9, 17, 15, 0);
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const work = (agentId: string, since: string): WorkItem => ({
  key: `r:${agentId}`,
  agentId,
  kind: "run",
  what: "pesquisando os preços",
  channelId: "c1",
  threadId: null,
  where: { kind: "channel", name: "produto" },
  missionId: null,
  plan: null,
  since,
  waiting: false,
});

describe("Agentes: esperando você, trabalhando, livres", () => {
  const agents = [
    agent({ id: "theo", name: "Theo" }),
    agent({ id: "nina", name: "Nina" }),
    agent({ id: "iris", name: "Iris" }),
  ];

  test("an agent waiting on you goes first with the exact request, once, and leaves the other sections", () => {
    const { waiting, working, free } = teamLines(
      agents,
      [work("theo", ago(0.5)), work("nina", ago(0.4))],
      [],
      [
        { id: "a1", agentId: "theo", title: "Merge PR #128", createdAt: ago(0.1) },
        { id: "a2", agentId: "theo", title: "Deploy", createdAt: ago(0.2) },
        { id: "a3", agentId: "ghost", title: "x", createdAt: ago(0.2) },
      ],
    );
    expect(waiting.map((l) => [l.agent.id, l.approval?.title, l.waitingCount, l.at])).toEqual([
      ["theo", "Merge PR #128", 2, ago(0.1)],
    ]);
    expect(working.map((l) => l.agent.id)).toEqual(["nina"]);
    expect(free.map((l) => l.agent.id)).toEqual(["iris"]);
  });

  test("without requests it is the old split (nothing waiting)", () => {
    const { waiting, working, free } = teamLines(agents, [work("nina", ago(1))], []);
    expect(waiting).toEqual([]);
    expect(working.map((l) => l.agent.id)).toEqual(["nina"]);
    expect(free.map((l) => l.agent.id).sort()).toEqual(["iris", "theo"]);
  });
});

describe("Perfil: o papel numa frase", () => {
  test("skips the prompt's self-introduction and keeps what follows the comma", () => {
    expect(plainRole("Você é o Theo, desenvolvedor do Time Lumen. Cuida do repositório.")).toBe(
      "Desenvolvedor do Time Lumen",
    );
    expect(plainRole("Você é a Nina.\nPesquisa mercado e concorrentes. Responda em português.")).toBe(
      "Pesquisa mercado e concorrentes",
    );
    expect(plainRole("You are Iris")).toBeNull();
  });

  test("what someone typed when creating it, plain, upper case first, short", () => {
    expect(plainRole("responder clientes no **e-mail** e me avisar quando algo for urgente")).toBe(
      "Responder clientes no e-mail e me avisar quando algo for urgente",
    );
    const long = plainRole(`cuida ${"de muitas coisas diferentes ".repeat(10)}`) ?? "";
    expect(long.length).toBeLessThanOrEqual(91);
    expect(long.endsWith("…")).toBe(true);
    expect(plainRole("")).toBeNull();
    expect(plainRole(undefined)).toBeNull();
  });
});

describe("Perfil: memórias", () => {
  const mem = (over: Partial<Memory> & { id: string }): Memory => ({
    agentId: "theo",
    kind: "preference",
    text: "Prefere publicar correções depois das 18h",
    source: "",
    uses: 0,
    lastUsedAt: null,
    pinned: false,
    archived: false,
    lowTrust: false,
    verified: true,
    supersedes: null,
    editedByUserId: null,
    updatedAt: ago(1),
    ...over,
  });

  test("only the owner or an admin may change them", () => {
    const theo = { ownerUserId: "u1" };
    expect(canEditMemories(theo, { id: "u1", role: "member" })).toBe(true);
    expect(canEditMemories(theo, { id: "u2", role: "admin" })).toBe(true);
    expect(canEditMemories(theo, { id: "u2", role: "owner" })).toBe(true);
    expect(canEditMemories(theo, { id: "u2", role: "member" })).toBe(false);
    expect(canEditMemories({ ownerUserId: null }, { id: "u2", role: "member" })).toBe(false);
    expect(canEditMemories(theo, { id: null, role: "admin" })).toBe(false);
  });

  test("where it came from: said in your DM, in a channel, written by you, or learned", () => {
    const at = ago(2);
    expect(
      memoryOrigin(mem({ id: "1", from: { messageId: "m", channelId: "d", threadId: null, dm: true, at } }), "u1"),
    ).toEqual({ kind: "saidDm", at });
    expect(
      memoryOrigin(
        mem({
          id: "2",
          origin: { by: "agent", name: null, channel: "produto", at: ago(30) },
          from: { messageId: "m", channelId: "c", threadId: null, dm: false, at },
        }),
        "u1",
      ),
    ).toEqual({ kind: "saidChannel", channel: "produto", at });
    expect(
      memoryOrigin(
        mem({ id: "3", editedByUserId: "u1", origin: { by: "person", name: "W", channel: null, at } }),
        "u1",
      ),
    ).toEqual({ kind: "wrote", at });
    expect(memoryOrigin(mem({ id: "4", origin: { by: "agent", name: null, channel: null, at } }), "u1")).toEqual({
      kind: "learned",
      at,
    });
  });

  test("active ones, pinned first, then the newest", () => {
    const list = knownAboutMe([
      mem({ id: "old", updatedAt: ago(30) }),
      mem({ id: "gone", archived: true }),
      mem({ id: "new", updatedAt: ago(1) }),
      mem({ id: "pin", pinned: true, updatedAt: ago(90) }),
    ]);
    expect(list.map((m) => m.id)).toEqual(["pin", "new", "old"]);
    expect(knownAboutMe(undefined)).toEqual([]);
  });

  test("today, yesterday or the date", () => {
    expect(dayWord(ago(1), NOW)).toEqual({ kind: "today" });
    expect(dayWord(ago(24), NOW)).toEqual({ kind: "yesterday" });
    expect(dayWord(ago(24 * 5), NOW)).toEqual({ kind: "date", iso: ago(24 * 5) });
  });
});

describe("Perfil: o que fez por você", () => {
  const action = (kind: string, target: Record<string, unknown>, params: Record<string, unknown> = {}) =>
    ({
      type: "action",
      at: ago(1),
      channelId: "c1",
      action: {
        id: `x-${kind}`,
        kind,
        agentId: "theo",
        messageId: "m1",
        requestedByUserId: "u1",
        target,
        params,
        createdAt: ago(1),
        undoableUntil: ago(0.9),
        undoneAt: null,
        undoneByUserId: null,
        redoneAt: null,
      },
    }) as AgentForYouItem;

  test("receipts in the third person, files and approvals, each opening its place", () => {
    const lines = didLines([
      action("issue.created", { type: "issue", id: "i1", number: 131, title: "Login no Safari 15" }),
      action("memory.saved", { type: "memory", id: "k1" }, { text: "x" }),
      action("thread.closed", { type: "thread", id: "t1", title: "Erro" }),
      {
        type: "file",
        at: ago(2),
        file: { id: "f1", kind: "document", title: "Erros da semana", channelId: "c1", threadId: null },
      },
      {
        type: "approval",
        at: ago(0.1),
        approval: {
          id: "a1",
          title: "Merge PR #128",
          status: "pending",
          channelId: "c1",
          threadId: "t1",
          waitingOnYou: true,
        },
      },
      {
        type: "approval",
        at: ago(3),
        approval: {
          id: "a2",
          title: "Deploy",
          status: "refused",
          channelId: "c1",
          threadId: "t1",
          waitingOnYou: false,
        },
      },
    ]);
    expect(lines.map((l) => [l.title.key, l.title.values, l.sub, l.href, l.waiting])).toEqual([
      ["action.issueCreated", { number: "131" }, { text: "Login no Safari 15" }, { kind: "issue", number: 131 }, false],
      ["action.threadClosed", { title: "Erro" }, null, { kind: "chat", channelId: "c1", threadId: "t1" }, false],
      ["file", { title: "Erros da semana" }, { key: "fileKind.document" }, { kind: "file", id: "f1" }, false],
      ["approval", { title: "Merge PR #128" }, { key: "waitingOnYou" }, { kind: "approval", id: "a1" }, true],
      ["approval", { title: "Deploy" }, { key: "youRefused" }, { kind: "approval", id: "a2" }, false],
    ]);
    expect(didLines(undefined)).toEqual([]);
  });
});

describe("Perfil: o que pode usar", () => {
  const tool = (scope: string, state: string, sensitive = false) => ({
    name: scope,
    label: scope,
    description: "",
    readOnly: scope.endsWith("read"),
    connectionId: "c1",
    scope,
    sensitive,
    state,
  });

  test("apps and areas with their level in plain words; whether an action still asks", () => {
    const access = {
      all: false,
      builtins: [
        { scope: "drive:read", label: "Ler o Drive", state: "granted", tools: [tool("drive:read", "granted")] },
        { scope: "drive:write", label: "Escrever", state: "granted", tools: [tool("drive:write", "granted")] },
        { scope: "issues:read", label: "Ler issues", state: "off", tools: [tool("issues:read", "off")] },
      ],
      connectors: [
        {
          connectionId: "c1",
          connector: "github",
          label: "GitHub",
          custom: false,
          state: "granted",
          scopes: [
            { scope: "github:repo.read", label: "Ler", state: "granted", tools: [tool("github:repo.read", "granted")] },
            {
              scope: "github:pr.merge",
              label: "Merge",
              state: "granted",
              tools: [tool("github:pr.merge", "granted", true)],
            },
          ],
        },
        {
          connectionId: "c2",
          connector: "sentry",
          label: "Sentry",
          custom: false,
          state: "off",
          scopes: [
            {
              scope: "sentry:issues.read",
              label: "Ler",
              state: "granted",
              tools: [tool("sentry:issues.read", "granted")],
            },
            { scope: "sentry:issues.write", label: "Mudar", state: "off", tools: [tool("sentry:issues.write", "off")] },
          ],
        },
      ],
    } as unknown as AgentAccess;
    const { lines, asks } = usesOf(access);
    expect(lines.map((l) => [l.label, l.level])).toEqual([
      [{ text: "GitHub" }, "write"],
      [{ text: "Sentry" }, "read"],
      [{ area: "drive" }, "write"],
    ]);
    expect(asks).toBe(true);
    expect(usesOf(null)).toEqual({ lines: [], asks: false });
  });
});

describe("Perfil: o mês, com os limites do plano (ADR 0063 §5)", () => {
  const usage = (windows: PlanUsage["windows"]): PlanUsage => ({ windows, source: "probe", at: NOW.toISOString() });

  test("the compact line in the plan's words, tightest first; near the limit, when it renews; nothing unknown", async () => {
    const pt = planMeterText(await translator("pt-BR"), "pt-BR", NOW);
    const en = planMeterText(await translator("en"), "en", NOW);
    const both = usage([
      { kind: "five_hour", usedPercent: 12 },
      { kind: "seven_day", usedPercent: 40 },
    ]);
    expect(planLine(both, pt, NOW.getTime())?.line).toBe("semana 40% · 5h 12%");
    expect(planLine(both, en, NOW.getTime())?.line).toBe("week 40% · 5h 12%");
    expect(planLine(both, pt, NOW.getTime())?.alert).toBeNull();
    const soon = new Date(NOW.getTime() + 90 * 60_000).toISOString();
    expect(planLine(usage([{ kind: "five_hour", usedPercent: 92, resetsAt: soon }]), pt, NOW.getTime())?.alert).toBe(
      "Quase no limite · renova às 16:30",
    );
    expect(planLine(usage([]), pt, NOW.getTime())).toBeNull();
  });

  test("the screen: the plan's card with its account's name first, the budget only once it spent through the API", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const read = (file: string) => Bun.file(new URL(`../../src/features/${file}`, import.meta.url).pathname).text();
    const [screen, parts] = await Promise.all([read("agents/AgentProfileScreen.tsx"), read("usage/parts.tsx")]);
    expect(screen).toContain("const shown = usageShown(agent?.brain, detail.data?.budgetUsedPercent ?? 0);");
    const plan = screen.indexOf("<PlanMeter compact usage={shown.plan.usage} label={shown.plan.account} />");
    const budget = screen.indexOf(") : spend && shown.budget ? (");
    expect(plan).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(plan);
    // The phone's meter draws the same line as the web's (`planLine`).
    expect(parts).toContain("const shown = planLine(usage, text, now);");
    // The budget is never called a limit next to a plan's limits.
    const t = await translator("pt-BR");
    expect(t("mobile.agent.ofMonthBudget")).toBe("do orçamento do mês");
    expect(t("mobile.agent.exhaustedF", { name: "Ada" })).toBe("A Ada usou todo o orçamento do mês.");
  });
});
