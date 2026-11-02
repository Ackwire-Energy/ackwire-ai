import { describe, expect, test } from "bun:test";
import type { AgentStatusLine, WorkView } from "@agenteschat/client";
import { autoUpdateText, blockedText, workLine, workStatusText } from "@agenteschat/client/lib/long-work";
import { serverBody } from "@agenteschat/client/lib/message-body";
import { workingNow } from "@agenteschat/client/lib/working";
import { translator } from "./fixtures";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const work = (over: Partial<WorkView> = {}): WorkView => ({
  id: "w1",
  agentId: "ada",
  channelId: "c1",
  title: "Migrar a cobrança",
  status: "live",
  state: "working",
  how: "agent",
  anchorMessageId: "a1",
  threadId: "a1",
  homeThreadId: null,
  runId: "r1",
  requestedByUserId: "me",
  startedAt: ago(12),
  finishedAt: null,
  nextUpdateAt: new Date(NOW.getTime() + 8 * 60_000).toISOString(),
  lastUpdate: { text: "Esquema lido; migrando as tabelas.", at: ago(2), seq: 1 },
  plan: [],
  issue: { id: "i42", number: 42 },
  resultMessageId: null,
  queuePosition: null,
  pausedUntil: null,
  canceledByUserId: null,
  errorCode: null,
  ...over,
});

const ctx = { locale: "pt-BR", now: NOW, meId: "me", agentName: "Ada", canStop: true, nameOf: () => "Heitor" };

describe("the line under 'Vou cuidar disso' (phone and web share it)", () => {
  test("every state, in pt-BR", async () => {
    const t = await translator("pt-BR");
    const live = workLine(t, work(), ctx);
    expect(live.text).toBe("Em segundo plano · 12 min · próximo update em ~8 min");
    expect(live.update).toBe("Esquema lido; migrando as tabelas.");
    expect(live.task?.label).toBe("Tarefa #42");
    expect(live.stop).toEqual({ runId: "r1" });
    expect(workLine(t, work(), { ...ctx, canStop: false }).stop).toBeNull();
    expect(workLine(t, work({ state: "queued", status: "queued", queuePosition: 1 }), ctx).text).toBe(
      "Na fila · começa quando um dos trabalhos de Ada terminar (1º na fila)",
    );
    expect(workLine(t, work({ state: "waiting_approval" }), ctx).text).toBe("Aguardando sua aprovação");
    expect(workLine(t, work({ state: "waiting_approval", requestedByUserId: "bia" }), ctx).text).toBe(
      "Aguardando aprovação",
    );
    expect(workLine(t, work({ state: "paused", pausedUntil: null }), ctx).text).toBe("Pausado no limite do plano");
    const done = workLine(t, work({ status: "done", state: null, finishedAt: ago(-26), resultMessageId: "r" }), ctx);
    expect(done.text).toBe("Concluído em 38 min");
    expect(done.result?.label).toBe("Ver resultado");
    expect(done.stop).toBeNull();
    expect(workLine(t, work({ status: "failed", state: null, resultMessageId: "e" }), ctx).result?.label).toBe(
      "Ver o que aconteceu",
    );
    expect(
      workLine(t, work({ status: "canceled", state: null, finishedAt: NOW.toISOString(), canceledByUserId: "u" }), ctx)
        .text,
    ).toBe("Parado por Heitor aos 12 min");
  });

  test("in English, and a long work's hours", async () => {
    const t = await translator("en");
    expect(workLine(t, work({ startedAt: ago(80) }), { ...ctx, locale: "en" }).text).toBe(
      "In the background · 1 h 20 min · next update in about 8 min",
    );
  });

  test("the agent's status line and the card's blocked badge", async () => {
    const t = await translator("pt-BR");
    const line = (over: Partial<AgentStatusLine>): AgentStatusLine => ({
      by: "auto",
      text: null,
      kind: "work",
      subject: "Migrar a cobrança",
      emoji: null,
      until: null,
      since: ago(20),
      count: 1,
      ...over,
    });
    expect(workStatusText(t, line({}), NOW)).toBe("Trabalhando em: Migrar a cobrança · 20 min");
    expect(workStatusText(t, line({ count: 2, second: "Relatório de churn" }), NOW)).toBe(
      "Em 2 trabalhos: Migrar a cobrança e Relatório de churn",
    );
    expect(workStatusText(t, line({ count: 3 }), NOW)).toBe("Em 3 trabalhos: Migrar a cobrança e mais 2");
    expect(workStatusText(t, line({ wait: "approval" }), NOW)).toBe("Aguardando aprovação: Migrar a cobrança");
    expect(workStatusText(t, line({ subject: null }), NOW)).toBe("Trabalhando em segundo plano · 20 min");
    expect(blockedText(t, { reason: "waiting_approval" })).toBe("Bloqueado · aguardando aprovação");
    expect(blockedText(t, { reason: "paused" })).toBe("Pausado · limite do plano");
    expect(blockedText(t, { reason: "failed", text: "run.budget_exceeded" })).toBe(
      "Bloqueado · não terminou: O orçamento do mês acabou",
    );
  });

  test("the server's own update and auto anchor, in the reader's words", async () => {
    const t = await translator("pt-BR");
    expect(autoUpdateText(t, { minutes: "22", kind: "coding" })).toBe(
      "Ainda trabalhando nisso (22 min). Agora: programando.",
    );
    expect(serverBody(t, "fallback", { bodyCode: "work_auto_moved", bodyParams: { minutes: "10" } })).toBe(
      "Isso vai levar um tempo, então sigo em segundo plano. Te aviso aqui; o próximo update deve sair em ~10 min.",
    );
    const en = await translator("en");
    expect(serverBody(en, "x", { bodyCode: "work_auto_update", bodyParams: { minutes: "22" } })).toBe(
      "Still on it (22 min).",
    );
  });

  test("Conversas and Agentes list a work by its title and plan", () => {
    const items = workingNow(
      [
        {
          runId: "r1",
          agentId: "ada",
          channelId: "c1",
          channelKind: "channel",
          channelName: "geral",
          threadId: "a1",
          status: "running",
          startedAt: ago(5),
          createdAt: ago(20),
          label: "@ada migra a cobrança",
          work: { id: "w1", title: "Migrar a cobrança", plan: { done: 1, total: 3 }, since: ago(20) },
        },
      ],
      [],
    );
    expect(items[0]).toMatchObject({ kind: "work", what: "Migrar a cobrança", plan: { done: 1, total: 3 } });
  });
});
