import { describe, expect, test } from "bun:test";
import type { LiveWork, Message } from "@agenteschat/client";
import { applyChannelEvent, emptyStreams, runsInChannel } from "@agenteschat/client";
import {
  type ActivityEntry,
  activityText,
  barElapsed,
  barEntries,
  barPhrase,
  entriesOffScreen,
  runElapsed,
  toolActivity,
  waitsForWords,
} from "@agenteschat/client/lib/activity";
import {
  entersWithMotion,
  greetingSuggestions,
  messageUsage,
  nearBottom,
  suggestionTopic,
  usageLine,
} from "@agenteschat/client/lib/chat";
import { dayLabel, shortTarget } from "@agenteschat/client/lib/format";
import { initialReveal, REVEAL_MAX_LAG_MS, rebaseReveal, revealStep, wordEnd } from "@agenteschat/client/lib/reveal";
import { buildTimeline, groupsWith, messageKey } from "@agenteschat/client/lib/timeline";
import { barStep, stepLabel, stepPhrase, toolPhrase, toolWhy, waitStep } from "@agenteschat/client/lib/work";
import type { TFunction } from "i18next";
import { createI18n } from "@/i18n";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;
const i18nEn = createI18n("en");
const tEn = i18nEn.t.bind(i18nEn) as TFunction;

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

describe("the card's phrase and the waiting row's step line", () => {
  const name = () => "Theo";
  const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "theo", lastSeq: 0 } as const;
  const call = (over: Partial<Extract<LiveWork, { kind: "call" }>> = {}): LiveWork => ({
    kind: "call",
    id: "k1",
    tool: "browser_navigate",
    connector: null,
    detail: null,
    code: null,
    output: [],
    running: true,
    since: 1000,
    ...over,
  });

  test("one agent on its own: just its name (its row says what it does); several: the sentence", () => {
    for (const run of [
      { ...base, status: "running" as const, text: "" },
      { ...base, status: "running" as const, text: "", tool: "browser_read", work: [call()] },
      { ...base, status: "running" as const, text: "Pronto: criei" },
    ]) {
      const entries = barEntries([run], [], name, () => undefined, [], true);
      expect(barPhrase(t, entries)).toBe("Theo");
      expect(barPhrase(t, entries, (n) => `[${n}]`)).toBe("[Theo]");
    }
    const two = barEntries(
      [
        { ...base, status: "running" as const, text: "" },
        { ...base, runId: "r2", agentId: "iris", status: "running" as const, text: "" },
      ],
      [],
      (id) => (id === "theo" ? "Theo" : "Iris"),
      () => undefined,
      [],
      true,
    );
    expect(barPhrase(t, two)).toBe("Theo e Iris estão trabalhando…");
  });

  test("a turn it stopped, or one that failed, lends the time nothing: the time is the new turn's", () => {
    const again = { ...base, runId: "r2", status: "running" as const, text: "", startedAt: 90_000 };
    for (const status of ["canceled", "failed"] as const) {
      const old = { ...base, status, text: "", startedAt: 0, work: [call({ running: false })] };
      const entries = barEntries([old, again], [], name, () => undefined, [], true);
      expect(barPhrase(t, entries)).toBe("Theo");
      expect(barElapsed(t, entries, [old, again], 100_000)).toBe("10 s");
    }
  });

  test("waiting for words: at work with nothing written, said or read", () => {
    const run = { status: "running" as const, text: "", work: [call()] };
    expect(waitsForWords(run)).toBe(true);
    expect(waitsForWords({ ...run, status: "thinking" })).toBe(true);
    expect(waitsForWords({ ...run, text: "Olá" })).toBe(false);
    expect(waitsForWords({ ...run, work: [{ kind: "say", text: "Vou olhar o login." }] })).toBe(false);
    expect(waitsForWords({ ...run, work: [{ kind: "steer", messageId: "m1" }] })).toBe(false);
    // Waiting on an approval keeps the waiting row (no header in and out again).
    expect(waitsForWords({ ...run, status: "waiting_approval" })).toBe(true);
    for (const status of ["canceled", "failed"] as const) expect(waitsForWords({ ...run, status })).toBe(false);
  });

  test("the step line: 'Pensando…', then the step running now, verb first, its target cut to what names it", () => {
    expect(waitStep(t, [])).toBe("Pensando…");
    expect(waitStep(t, undefined)).toBe("Pensando…");
    expect(waitStep(t, [call({ detail: "https://console.example.com/login?next=/home" })])).toBe(
      "Usando o navegador · console.example.com…",
    );
    expect(waitStep(t, [call({ tool: "read_file", detail: "src/auth/refresh.ts" })])).toBe(
      "Mexendo nos arquivos do PC · refresh.ts…",
    );
    // A step that ended: back to thinking until the next one starts.
    expect(waitStep(t, [call({ running: false })])).toBe("Pensando…");
    expect(waitStep(t, [call({ detail: null })])).toBe("Usando o navegador…");
    expect(waitStep(tEn, [])).toBe("Thinking…");
    expect(waitStep(t, [call({ running: false, held: true })])).toBe("Esperando aprovação…");
    expect(waitStep(tEn, [call({ running: false, held: true })])).toBe("Waiting for approval…");
    // Two of the same step in a row fold into one tool line; the step line names the one running now.
    const site = (id: string, detail: string, running: boolean) => call({ id, detail, running });
    expect(
      waitStep(t, [site("c1", "https://one.example.com/x", false), site("c2", "https://two.example.com/y", true)]),
    ).toBe("Usando o navegador · two.example.com…");
    const file = (id: string, detail: string, running: boolean) => call({ id, tool: "read_file", detail, running });
    expect(waitStep(t, [file("f1", "auth/refresh.ts", false), file("f2", "auth/session.ts", true)])).toBe(
      "Mexendo nos arquivos do PC · session.ts…",
    );
  });

  test("a target is a URL's host, a path's last part, else a short start cut at a word", () => {
    expect(shortTarget("https://console.example.com/a/b")).toBe("console.example.com");
    expect(shortTarget("apps/web/src/auth/refresh.ts")).toBe("refresh.ts");
    expect(shortTarget("/var/log/")).toBe("log");
    expect(shortTarget("console.example.com/login")).toBe("console.example.com");
    expect(shortTarget("./src/auth/refresh.ts")).toBe("refresh.ts");
    expect(shortTarget("~/notes/plan.md")).toBe("plan.md");
    expect(shortTarget("acme/repo")).toBe("acme/repo");
    expect(shortTarget("10/31")).toBe("10/31");
    expect(shortTarget("and/or")).toBe("and/or");
    expect(shortTarget("relatório de vendas")).toBe("relatório de vendas");
    expect(shortTarget("a long line about the quarterly numbers of the north team")).toBe(
      "a long line about the quarterly numbers",
    );
  });

  test("an agent whose row is on screen leaves the bar; a question out and people typing stay", () => {
    const theo = { ...base, status: "running" as const, text: "" };
    const iris = { ...base, runId: "r2", agentId: "iris", status: "running" as const, text: "" };
    const names = (id: string) => (id === "theo" ? "Theo" : "Iris");
    const entries = barEntries([theo, iris], ["u-marina"], names, () => "Marina", [], true);
    const shown = (inView: string[]) =>
      entriesOffScreen(entries, [theo, iris], (r) => inView.includes(r.runId)).map((e) => e.name);
    expect(shown([])).toEqual(["Theo", "Iris", "Marina"]);
    expect(shown(["r1"])).toEqual(["Iris", "Marina"]);
    expect(shown(["r1", "r2"])).toEqual(["Marina"]);
    const asking = barEntries(
      [theo],
      [],
      names,
      () => undefined,
      [
        {
          runId: "r1",
          agentId: "theo",
          consultedAgentId: "iris",
          channelId: "c1",
          threadId: "m1",
          status: "asking",
          since: 0,
          at: 0,
        },
      ],
      true,
    );
    expect(entriesOffScreen(asking, [theo], () => true)).toEqual(asking);
  });

  test("out of view, the bar takes the row's step after the name, its start in lower case; 'escrevendo…' as it writes", () => {
    expect(barStep(t, { text: "", work: [] }, "pt-BR")).toBe("pensando…");
    expect(barStep(t, { text: "", work: [call({ tool: "read_file", detail: "src/auth/refresh.ts" })] }, "pt-BR")).toBe(
      "mexendo nos arquivos do PC · refresh.ts…",
    );
    expect(barStep(t, { text: "Pronto: criei", work: [] }, "pt-BR")).toBe("escrevendo…");
    // A call running while its words wait: the call's step.
    expect(barStep(t, { text: "Vou olhar", work: [call({ detail: null })] }, "pt-BR")).toBe("usando o navegador…");
    expect(barStep(tEn, { text: "", work: [] }, "en")).toBe("thinking…");
  });

  test("a run's time, the bar's and its row's alike: from 2 s on, minutes past a minute", () => {
    expect(runElapsed(t, { startedAt: 10_000 }, 11_500)).toBeNull();
    expect(runElapsed(t, { startedAt: 10_000 }, 22_000)).toBe("12 s");
    expect(runElapsed(t, { startedAt: 0 }, 65_000)).toBe("1 min 5 s");
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
    // Google Drive through Composio: its tools' names, and its accounts' names.
    expect(toolActivity("google_drive_find_file")).toEqual({ kind: "readingDrive" });
    expect(toolActivity("google_drive_2_find_file", "Google Drive (ana@acme.com) 2")).toEqual({ kind: "readingDrive" });
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
    expect(activityText(t, [entry("Theo", { kind: "thinking" })])).toBe("Theo está trabalhando…");
    expect(activityText(t, [entry("Theo", toolActivity("himetrica_get_events"))])).toBe(
      "Theo está consultando o Himetrica…",
    );
    expect(activityText(t, [entry("Theo", toolActivity("create_issue"))])).toBe("Theo está criando uma tarefa…");
    expect(activityText(t, [entry("Theo", toolActivity("list_artifacts"))])).toBe("Theo está lendo o Drive…");
    expect(activityText(t, [entry("Theo", toolActivity("send_email"))])).toBe("Theo está usando uma ferramenta…");
    expect(
      activityText(t, [
        entry("Theo", { kind: "thinking" }),
        entry("Ada", { kind: "thinking" }),
        entry("Marina", { kind: "typing" }, "person"),
      ]),
    ).toBe("Theo e Ada estão trabalhando · Marina está digitando…");
  });

  test("a computer command says what it ran; none of our tools reads as an app named after its first word", () => {
    const step = (tool: string, detail?: string) => stepLabel(t, { ...toolActivity(tool, null, detail), tool });
    expect(step("permission_prompt", "Rerun new unit tests after formatting")).toBe(
      "Rodou: Rerun new unit tests after formatting",
    );
    expect(step("mcp__agentes__permission_prompt", "git commit")).toBe("Rodou: git commit");
    expect(step("permission_prompt")).toBe("Rodou um comando");
    expect(toolPhrase(t, { kind: "runningCommand", app: "rm /etc/x", tool: "permission_prompt", state: "fail" })).toBe(
      "Recusado: rm /etc/x",
    );
    expect(activityText(t, [entry("Theo", toolActivity("permission_prompt", null, "npm test"))])).toBe(
      "Theo está rodando: npm test…",
    );
    // Why it was refused, in the person's words; the task's card never says a refused or waiting one ran.
    const why = (refusal: string) => toolWhy(t, { why: "This command was refused.", refusal });
    expect(["person", "expired", "off", "outside", "tooMany"].map(why)).toEqual([
      "Uma pessoa recusou",
      "Ninguém respondeu a tempo",
      "Rodar comandos está desligado para este agente",
      "Mexe em arquivos fora da pasta do agente",
      "Pedidos demais seguidos para aprovar",
    ]);
    expect(stepPhrase(t, { tool: "permission_prompt", detail: "rm /etc/x", outcome: "refused" })).toBe(
      "Recusado: rm /etc/x",
    );
    expect(stepPhrase(t, { tool: "permission_prompt", detail: "npm publish", outcome: "waiting" })).toBe(
      "Rodando: npm publish",
    );
    const ours: Record<string, string> = {
      desktop_do: "Usou a tela",
      desktop_read: "Usou a tela",
      git_clone: "Clonou um repositório",
      open_pull_request: "Abriu um pull request",
      hand_off: "Entregou um relatório",
      record_findings: "Anotou o que encontrou",
      complete_mission: "Entregou a missão",
      suggest_forum_topic: "Sugeriu um tópico no fórum",
      request_permission: "Pediu acesso",
      request_folder_access: "Pediu acesso",
      request_secret: "Pediu um segredo",
      use_tool: "Procurou ferramentas",
      follow_up: "Agendou a volta à conversa",
      cancel_follow_up: "Cancelou a volta à conversa",
      pg_producao_query: "Consultou o banco de dados",
    };
    expect(Object.fromEntries(Object.keys(ours).map((tool) => [tool, step(tool)]))).toEqual(ours);
    // With the connection the event names, a database is that connection, as before.
    expect(stepLabel(t, { ...toolActivity("pg_producao_query", "Produção"), tool: "pg_producao_query" })).toBe(
      "Consultou o Produção",
    );
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
    expect(bar()).toBe("Theo está trabalhando · Marina está digitando…");
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: "github_list_prs" });
    expect(runsInChannel(s, "c")[0]?.status).toBe("thinking");
    expect(bar()).toBe("Theo está consultando o GitHub · Marina está digitando…");
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: null });
    expect(bar()).toBe("Theo está trabalhando · Marina está digitando…");
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
