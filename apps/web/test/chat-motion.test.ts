import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Message } from "@/api/types";
import { buildTimeline, groupsWith, messageKey } from "@/chat/timeline";
import { createI18n } from "@/i18n";
import { type ActivityEntry, activityText, barEntries, toolActivity } from "@/lib/activity";
import {
  entersWithMotion,
  greetingSuggestions,
  messageUsage,
  nearBottom,
  suggestionTopic,
  usageLine,
} from "@/lib/chat";
import { dayLabel } from "@/lib/format";
import { initialReveal, REVEAL_MAX_LAG_MS, rebaseReveal, revealStep, wordEnd } from "@/lib/reveal";
import { stepLabel } from "@/lib/work";
import { applyChannelEvent, emptyStreams, runsInChannel } from "@/realtime/streams";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;

describe("smooth reveal of streamed text", () => {
  const text = "Os 401 no Sentry";

  test("releases whole words, never half of one", () => {
    expect(wordEnd(text, 0)).toBe(0);
    expect(wordEnd(text, 1)).toBe(3);
    expect(wordEnd(text, 3)).toBe(3);
    expect(wordEnd(text, 4)).toBe(7);
    expect(wordEnd(text, 99)).toBe(text.length);
    expect(text.slice(0, revealStep(0, text, 16))).toBe("Os ");
    expect(text.slice(0, revealStep(3, text, 16))).toBe("Os 401 ");
    expect(revealStep(text.length, text, 16)).toBe(text.length);
  });

  test("a big buffer drains fast; a paused tab catches up at once", () => {
    const big = "palavra ".repeat(200);
    const step = revealStep(0, big, 16);
    expect(step).toBeGreaterThan(60);
    expect(big.slice(0, step).endsWith(" ")).toBe(true);
    expect(revealStep(0, big, 10_000)).toBe(big.length);
  });

  test("a fast stream never lags far behind (about REVEAL_MAX_LAG_MS), and drains when it ends", () => {
    let target = "";
    let shown = 0;
    // 600 characters per second in 16 ms frames, for 3 seconds.
    for (let frame = 0; frame < 190; frame++) {
      target += "abcd abcd ";
      shown = revealStep(shown, target, 16);
    }
    const lagMs = ((target.length - shown) / 600) * 1000;
    expect(lagMs).toBeLessThan(REVEAL_MAX_LAG_MS * 1.5);
    let frames = 0;
    while (shown < target.length && frames < 1000) {
      shown = revealStep(shown, target, 16);
      frames++;
    }
    expect(shown).toBe(target.length);
    expect(frames * 16).toBeLessThan(2500);
  });

  test("mid-reply mounts show what's there; a replaced text starts over", () => {
    expect(initialReveal("Oi")).toBe(0);
    expect(initialReveal("x".repeat(400))).toBe(400);
    expect(rebaseReveal(5, "Hello world", "Hello world again")).toBe(5);
    expect(rebaseReveal(5, "Hello world", "Outra coisa")).toBe(0);
    expect(rebaseReveal(20, "Hi", "Hi there")).toBe(2);
  });
});

describe("humanized activity", () => {
  test("tool names → friendly verbs, with a generic fallback", () => {
    expect(toolActivity(undefined)).toEqual({ kind: "thinking" });
    expect(toolActivity("create_issue")).toEqual({ kind: "creatingIssue" });
    expect(toolActivity("read_artifact")).toEqual({ kind: "readingDrive" });
    expect(toolActivity("search_context")).toEqual({ kind: "searchingMemory" });
    expect(toolActivity("github_merge_pr")).toEqual({ kind: "consulting", app: "GitHub" });
    expect(toolActivity("himetrica_get_analytics")).toEqual({ kind: "consulting", app: "himetrica" });
    expect(toolActivity("drive_search_files")).toEqual({ kind: "readingDrive" });
    expect(toolActivity("x_query", "Google Drive")).toEqual({ kind: "readingDrive" });
    expect(toolActivity("query", "Himetrica")).toEqual({ kind: "consulting", app: "Himetrica" });
    expect(toolActivity("send_email")).toEqual({ kind: "usingTool" });
    expect(toolActivity("weird")).toEqual({ kind: "usingTool" });
  });

  test("mission tools (the agent's and the executor's MCP ones) have their own words; no raw names", () => {
    const step = (tool: string) => {
      const a = toolActivity(tool);
      return stepLabel(t, { kind: a.kind, app: a.app, tool } as Parameters<typeof stepLabel>[1]);
    };
    expect(step("propose_mission")).toBe("Propôs uma missão");
    expect(step("send_to_mission")).toBe("Mandou um recado para a missão");
    expect(step("update_plan")).toBe("Atualizou o plano");
    expect(step("mcp__agentes__update_plan")).toBe("Atualizou o plano");
    expect(step("report")).toBe("Relatou o progresso");
    expect(step("ask_decision")).toBe("Pediu uma decisão");
    expect(step("request_review")).toBe("Pediu uma revisão");
    expect(step("request_approval")).toBe("Pediu aprovação");
    expect(step("start_task")).toBe("Começou uma tarefa");
    expect(step("list_tasks")).toBe("Viu as tarefas");
    expect(step("task_status")).toBe("Conferiu uma tarefa");
    expect(step("cancel_task")).toBe("Cancelou uma tarefa");
    expect(step("upload_artifact")).toBe("Mandou um arquivo para o Drive");
    expect(step("get_context")).toBe("Consultou o contexto");
    expect(step("computer_status")).toBe("Conferiu o PC");
    expect(step("search_wiki")).toBe("Leu a wiki");
    expect(step("mcp__github__list_prs")).toBe("Consultou o GitHub");
    // Unknown: a generic sentence around the humanized name.
    expect(step("send_email")).toBe("Usou a ferramenta send email");
    expect(activityText(t, [entry("Theo", toolActivity("update_plan"))])).toBe("Theo está atualizando o plano…");
  });

  const entry = (name: string, activity: ActivityEntry["activity"], type: ActivityEntry["type"] = "agent") => ({
    id: name,
    type,
    name,
    activity,
  });

  test("the bar's sentence (pt-BR)", () => {
    expect(activityText(t, [])).toBe("");
    expect(activityText(t, [entry("Theo", { kind: "thinking" })])).toBe("Theo está pensando…");
    expect(activityText(t, [entry("Theo", toolActivity("himetrica_get_events"))])).toBe(
      "Theo está consultando o himetrica…",
    );
    expect(activityText(t, [entry("Theo", toolActivity("create_issue"))])).toBe("Theo está criando uma issue…");
    expect(activityText(t, [entry("Theo", toolActivity("list_artifacts"))])).toBe("Theo está lendo o Drive…");
    expect(activityText(t, [entry("Theo", toolActivity("send_email"))])).toBe("Theo está usando uma ferramenta…");
    expect(
      activityText(t, [
        entry("Theo", { kind: "thinking" }),
        entry("Ada", { kind: "thinking" }),
        entry("Marina", { kind: "typing" }, "person"),
      ]),
    ).toBe("Theo e Ada estão pensando · Marina está digitando…");
  });

  test("runs carry the tool from `agent.tool`; writing runs leave the bar", () => {
    const base = { channelId: "c", threadId: "t", agentId: "theo", runId: "r" };
    let s = applyChannelEvent(emptyStreams, { type: "agent.thinking", ...base });
    const names = (id: string) => (id === "theo" ? "Theo" : "?");
    const bar = () =>
      activityText(
        t,
        barEntries(runsInChannel(s, "c"), ["u1"], names, (id) => (id === "u1" ? "Marina" : undefined)),
      );
    expect(bar()).toBe("Theo está pensando · Marina está digitando…");
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: "github_list_prs" });
    expect(runsInChannel(s, "c")[0]?.status).toBe("thinking");
    expect(bar()).toBe("Theo está consultando o GitHub · Marina está digitando…");
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: null });
    expect(bar()).toBe("Theo está pensando · Marina está digitando…");
    s = applyChannelEvent(s, { type: "agent.delta", ...base, seq: 1, text: "Achei" });
    expect(bar()).toBe("Marina está digitando…");
    // After the final message, a late tool event is ignored.
    s = applyChannelEvent(s, {
      type: "message.created",
      channelId: "c",
      messageId: "m",
      message: { agentRunId: "r", author: { type: "agent", id: "theo" }, threadId: "t" } as Message,
    });
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: "create_issue" });
    expect(runsInChannel(s, "c")).toHaveLength(0);
  });
});

const msg = (id: string, minute: number, author: Message["author"], extra: Partial<Message> = {}): Message => ({
  id,
  channelId: "c",
  threadId: null,
  author,
  body: id,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString(),
  ...extra,
});
const ada = { type: "agent" as const, id: "ada" };
const joao = { type: "person" as const, id: "joao" };

describe("grouping and day dividers", () => {
  test("consecutive agent messages within 5 minutes collapse, like people's", () => {
    const items = buildTimeline(
      [msg("a1", 1, ada), msg("a2", 3, ada), msg("a3", 9, ada), msg("j1", 10, joao), msg("j2", 11, joao)],
      [],
      [],
    );
    expect(items.map((i) => (i.kind === "message" ? `${i.key}${i.grouped ? "+" : ""}` : i.kind))).toEqual([
      "day",
      "a1",
      "a2+",
      "a3",
      "j1",
      "j2+",
    ]);
    expect(groupsWith(msg("a", 1, ada), ada, msg("b", 4, ada).createdAt)).toBe(true);
    expect(groupsWith(msg("a", 1, ada), { type: "agent", id: "atlas" }, msg("b", 2, ada).createdAt)).toBe(false);
    expect(groupsWith(null, ada, msg("b", 2, ada).createdAt)).toBe(false);
  });

  test("an optimistic message keeps its row key when the server copy replaces it", () => {
    const local = msg("local-1", 1, joao, { clientId: "k1", local: "pending" });
    const server = msg("srv-1", 1, joao, { clientId: "k1" });
    expect(messageKey(local)).toBe(messageKey(server));
    expect(messageKey(msg("x", 1, joao))).toBe("x");
  });

  test("Hoje, Ontem, weekday names within the week, then dates", () => {
    // Wednesday, 14 October 2026.
    const now = new Date(2026, 9, 14, 10, 44);
    const day = (d: Date) => dayLabel(t, "pt-BR", d.toISOString(), now);
    expect(day(new Date(2026, 9, 14, 8, 0))).toBe("Hoje");
    expect(day(new Date(2026, 9, 13, 23, 0))).toBe("Ontem");
    expect(day(new Date(2026, 9, 12, 9, 0))).toBe("Segunda-feira");
    expect(day(new Date(2026, 9, 8, 9, 0))).toBe("Quinta-feira");
    expect(day(new Date(2026, 9, 7, 9, 0))).toBe("7 out");
    expect(day(new Date(2025, 9, 12, 9, 0))).toBe("12 out 2025");
  });
});

describe("chat details", () => {
  test("model and tokens live behind the time; never money (admins see it in Settings → Usage)", () => {
    const usage = { model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 240 };
    expect(usageLine(t, "pt-BR", usage, { modelLabel: "Claude Sonnet 5.5" })).toBe("sonnet 5.5 · 1.240 tokens");
    // An old server's `costUsd` is dropped.
    expect(messageUsage({ usage: { model: "m", inputTokens: 3, costUsd: 0.5 } })).toEqual({
      model: "m",
      inputTokens: 3,
      outputTokens: 0,
    });
    expect(messageUsage({})).toBeNull();
  });

  test("only new, recent rows slide in; following the bottom", () => {
    const mountedAt = Date.UTC(2026, 9, 14, 12, 0);
    const iso = (ms: number) => new Date(ms).toISOString();
    const initial = new Set(["a"]);
    expect(entersWithMotion("a", iso(mountedAt + 1000), initial, mountedAt)).toBe(false);
    expect(entersWithMotion("b", iso(mountedAt + 1000), initial, mountedAt)).toBe(true);
    expect(entersWithMotion("c", iso(mountedAt - 2 * 3_600_000), initial, mountedAt)).toBe(false);
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 500 })).toBe(true);
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 1000, clientHeight: 500 })).toBe(false);
  });

  test("first-message suggestions follow the agent's role", () => {
    expect(suggestionTopic("Dev")).toBe("dev");
    expect(suggestionTopic("Desenvolvedora backend")).toBe("dev");
    expect(suggestionTopic("Suporte ao cliente")).toBe("support");
    expect(suggestionTopic("Analista de dados")).toBe("data");
    expect(suggestionTopic("Growth e conteúdo")).toBe("marketing");
    expect(suggestionTopic("Product manager")).toBe("product");
    expect(suggestionTopic("Assistente pessoal")).toBe("general");
    expect(suggestionTopic(null)).toBe("general");
    const dev = greetingSuggestions(t, "Dev");
    expect(dev).toHaveLength(3);
    expect(dev[0]).toBe("O que quebrou desde o último deploy?");
  });
});
