import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, Routine, RoutineRun } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { RUN_CODES, runOutcome } from "@agenteschat/client/lib/routine-view";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { createI18n } from "@/i18n";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { routineRun } from "./fakes/planning";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const rule = { freq: "daily" as const, times: ["09:00"], timezone: "America/Sao_Paulo" };
const daily = {
  type: "schedule" as const,
  phrase: null,
  rule,
  cron: "0 9 * * *",
  timezone: "America/Sao_Paulo",
  description: "Todos os dias, às 09:00",
};

/** A routine as the server sends it (ADR 0053 §11), active by default. */
const routine = (over: Partial<Routine> & Pick<Routine, "id" | "name">): Routine => ({
  agentId: ATLAS_ID,
  prompt: "Olhe os erros novos do Sentry e conte o que achar.",
  target: { type: "channel", channelId: ENG_ID },
  trigger: daily,
  active: true,
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: ago(60 * 24 * 10),
  access: "read",
  report: "when_new",
  pausedReason: null,
  failuresInRow: 0,
  state: "active",
  waitingFor: null,
  brain: { kind: "model", machineName: null },
  health: { ok: 0, silent: 0, failed: 0, skipped: 0, missed: 0, total: 0 },
  canSeeDetails: true,
  canManage: true,
  lastRun: null,
  recentRuns: [],
  usage: { runs: 0, tokens: 0, costNanoUsd: 0, billedTo: "api" },
  ...over,
});

/** The fake backend, with these routines and runs in Rotinas; every routine call is recorded. */
function withRoutines(list: Routine[], runs: Record<string, RoutineRun[]> = {}, state: FakeState = seedState()) {
  const base = createFakeApi(state);
  const calls: string[] = [];
  const find = (id: string) => list.find((r) => r.id === id) as Routine;
  const api: ApiClient = {
    ...base,
    routines: {
      ...base.routines,
      list: async () => structuredClone(list),
      runs: async (_orgId, id) => structuredClone(runs[id] ?? []),
      setActive: async (_orgId, id, active) => {
        calls.push(`active:${id}:${active}`);
        const r = find(id);
        Object.assign(r, { active, state: active ? "active" : "paused" }, active ? { pausedReason: null } : {});
        return structuredClone(r);
      },
      stop: async (_orgId, id) => {
        calls.push(`stop:${id}`);
        const r = find(id);
        r.state = "active";
        return structuredClone(r);
      },
      takeOver: async (_orgId, id) => {
        calls.push(`takeOver:${id}`);
        return structuredClone(find(id));
      },
    },
  };
  return { api, calls, state, machines: fakeMachinesOf.get(base) };
}

const open = async (list: Routine[], runs?: Record<string, RoutineRun[]>, state?: FakeState) => {
  const r = withRoutines(list, runs, state);
  await renderApp(`/org/${ORG_ID}/routines`, { api: r.api });
  await settle(8);
  return r;
};
const card = (name: string) => screen().getByRole("article", { name });
const details = async (name: string) => {
  await click(within(card(name)).getByRole("button", { name }));
  await settle(4);
  return screen().getByRole("dialog", { name });
};

describe("Rotinas: each routine's state, with its one-tap fix", () => {
  test("paused because the agent left the channel: the reason and 'Adicionar agente ao canal'", async () => {
    const { calls, state } = await open([
      routine({
        id: "rt-left",
        name: "Vigiar erros",
        active: false,
        state: "paused",
        pausedReason: "agent_not_in_channel",
        nextRunAt: null,
      }),
    ]);
    const row = card("Vigiar erros");
    expect(row.textContent).toContain("Pausada: o agente não está mais no canal");
    await click(within(row).getByRole("button", { name: "Adicionar agente ao canal" }));
    await settle(6);
    // The agent joins the channel it reports to, then the routine runs again.
    expect(state.calls.find((c) => c.method === "chat.addMember")?.args).toEqual([
      ORG_ID,
      ENG_ID,
      { agentId: ATLAS_ID },
    ]);
    expect(calls).toContain("active:rt-left:true");
    expect(screen().getByText("Atlas voltou ao canal e a rotina está ativa de novo.")).toBeTruthy();
  });

  test("paused because its creator left: someone takes it over", async () => {
    const { calls } = await open([
      routine({ id: "rt-gone", name: "Resumo diário", active: false, state: "paused", pausedReason: "creator_left" }),
    ]);
    const row = card("Resumo diário");
    expect(row.textContent).toContain("Pausada: quem criou saiu do workspace");
    await click(within(row).getByRole("button", { name: "Assumir rotina" }));
    await settle(6);
    expect(calls).toEqual(["takeOver:rt-gone", "active:rt-gone:true"]);
  });

  test("failing, waiting for the computer: said on the row; a plain pause stays quiet", async () => {
    await open([
      routine({ id: "rt-fail", name: "Caixa de entrada", state: "failing", failuresInRow: 3 }),
      routine({
        id: "rt-mac",
        name: "Relatório de vendas",
        state: "waiting_computer",
        waitingFor: { machineId: "mac-1", machineName: "MacBook do Walter", since: ago(40) },
        brain: { kind: "claude_code", machineName: "MacBook do Walter" },
      }),
      routine({ id: "rt-off", name: "Pausada à mão", active: false, state: "paused", nextRunAt: null }),
    ]);
    expect(card("Caixa de entrada").textContent).toContain("Falhando (3 seguidas)");
    expect(card("Relatório de vendas").textContent).toContain("Esperando o MacBook do Walter desde");
    // Paused by a person: "Pausada" as before, no fix button on the row.
    const off = card("Pausada à mão");
    expect(off.querySelector(".ac-chip--waiting")).toBeNull();
    expect(within(off).queryByRole("button", { name: "Retomar" })).toBeNull();
  });

  test("a run a person stopped reads 'Parada', not 'Não rodou'; every N minutes in Portuguese", async () => {
    const stopped = routineRun({ at: ago(5), status: "canceled", code: "stopped" });
    await open([
      routine({ id: "rt-stop", name: "Issues da Ada", lastRun: stopped, recentRuns: [stopped] }),
      routine({
        id: "rt-30",
        name: "Avaliações",
        trigger: {
          type: "schedule",
          cron: "*/30 * * * *",
          timezone: "America/Sao_Paulo",
          description: "Every 30 minutes",
        },
      }),
    ]);
    expect(card("Issues da Ada").textContent).toContain("Parada há 5 min");
    expect(card("Issues da Ada").textContent).not.toContain("Não rodou");
    expect(card("Avaliações").textContent).toContain("A cada 30 minutos");
    expect(card("Avaliações").textContent).not.toContain("Every");
  });

  test("the strip's last runs read as sentences: each after the first starts with a capital", async () => {
    const now = routineRun({ at: ago(0.5), status: "reported" });
    const yesterday = routineRun({ at: ago(24 * 60), status: "silent" });
    await open([routine({ id: "rt-runs", name: "Erros do Sentry", lastRun: now, recentRuns: [now, yesterday] })]);
    const strip = within(card("Erros do Sentry")).getByRole("img", { name: /^Últimas execuções/ });
    expect(strip.getAttribute("aria-label")).toMatch(
      /^Últimas execuções: agora: respondeu\. Ontem \d{1,2}:\d{2}: nada novo, ficou em silêncio$/,
    );
  });
});

describe("Rotinas: a routine's details", () => {
  const busy = routine({
    id: "rt-run",
    name: "Revisar PRs",
    agentId: ADA_ID,
    state: "running",
    access: "act",
    report: "always",
    trigger: { ...daily, rule: { freq: "hourly", interval: 1, times: ["00:15"], timezone: "America/Sao_Paulo" } },
    brain: { kind: "claude_code", machineName: "MacBook do Walter" },
    health: { ok: 10, silent: 2, failed: 0, skipped: 1, missed: 1, total: 14 },
    usage: { runs: 14, tokens: 120_000, costNanoUsd: 0, billedTo: "plan" },
  });
  const runs = {
    "rt-run": [
      routineRun({ at: ago(5), status: "running" }),
      routineRun({
        at: ago(60),
        status: "reported",
        summary: "3 erros novos no checkout",
        link: { channelId: ENG_ID, threadId: null, messageId: "m-1" },
      }),
      routineRun({ at: ago(120), status: "skipped", code: "previous_running" }),
      routineRun({ at: ago(180), status: "waiting", approvalId: "ap-merge" }),
      routineRun({ at: ago(240), status: "canceled", code: "stopped", codeParams: { by: "u-joao" } }),
      routineRun({ at: ago(300), status: "failed", code: "something_new" }),
    ],
  };

  test("waiting for its computer: 'Trocar computador' where people connect their own, none on the Cloud", async () => {
    const waiting = routine({
      id: "rt-mac",
      name: "Relatório de vendas",
      state: "waiting_computer",
      waitingFor: { machineId: "mac-1", machineName: "MacBook do Walter", since: ago(40) },
      brain: { kind: "claude_code", machineName: "MacBook do Walter" },
    });
    const agents = [
      { agentId: ATLAS_ID, name: "Atlas", brain: "claude_code" as const, waiting: { routines: 1, conversations: 0 } },
    ];
    for (const cloud of [false, true]) {
      const r = withRoutines([structuredClone(waiting)]);
      r.machines?.setOutages({
        outages: [
          {
            machineId: "mac-1",
            name: "MacBook do Walter",
            platform: "darwin",
            offlineSince: ago(40),
            agents,
            waitingRuns: 1,
          },
        ],
        targets: [],
      });
      if (cloud) r.machines?.setSetup({ state: "ready" });
      const view = await renderApp(`/org/${ORG_ID}/routines`, { api: r.api });
      await settle(8);
      const panel = await details("Relatório de vendas");
      expect(within(panel).queryByRole("button", { name: "Trocar computador" }) !== null).toBe(!cloud);
      view.unmount();
    }
  });

  test("the week, where it runs, how it works and each run in plain words", async () => {
    await open([busy], runs);
    const panel = await details("Revisar PRs");
    const text = panel.textContent ?? "";
    expect(text).toContain("12 de 14 OK esta semana · 2 puladas");
    expect(text).toContain("14 execuções · 120 mil tokens do plano");
    expect(text).toContain("Claude Code no MacBook do Walter");
    // Hourly on someone's computer: how often it wakes it.
    expect(text).toContain("Roda 24 vezes por dia no MacBook do Walter");
    expect(text).not.toContain("Pode agir");
    expect(text).toContain("Toda vez");
    expect(text).toContain("Trabalhando agora");
    expect(text).toContain("Contou o que achou");
    expect(text).toContain("3 erros novos no checkout");
    expect(text).toContain("Pulada: a anterior ainda estava rodando");
    expect(text).toContain("Parada por João");
    // An unknown code still says what happened.
    expect(text).toContain("Não deu certo");
    expect(within(panel).getByRole("link", { name: "Abrir na conversa" }).getAttribute("href")).toContain(
      `/c/${ENG_ID}?m=m-1`,
    );
    expect(within(panel).getByRole("link", { name: "Esperando sua aprovação" }).getAttribute("href")).toContain(
      "open=ap-merge",
    );
    // No internal names anywhere.
    expect(text).not.toMatch(/runner|MCP|Jev/);
  });

  test("running: Parar stops it quietly", async () => {
    const { calls } = await open([busy], runs);
    await click(within(card("Revisar PRs")).getByRole("button", { name: "Parar Revisar PRs" }));
    await settle(4);
    expect(calls).toContain("stop:rt-run");
    expect(screen().getByText("Execução parada.")).toBeTruthy();
  });

  test("someone who may only see outcomes: no prompt, no text, no actions", async () => {
    await open(
      [routine({ id: "rt-priv", name: "Caixa do suporte", prompt: null, canSeeDetails: false, canManage: false })],
      { "rt-priv": [routineRun({ at: ago(30), status: "reported", summary: "" })] },
    );
    const row = card("Caixa do suporte");
    expect(within(row).queryByRole("switch")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Rodar agora" })).toBeNull();
    const panel = await details("Caixa do suporte");
    expect(panel.textContent).toContain("Só quem criou, o dono do agente, admins e quem está na conversa veem isto.");
    expect(panel.textContent).toContain("Contou o que achou");
    expect(within(panel).queryByRole("button", { name: "Editar" })).toBeNull();
    // Every routine does what its agent can (ADR 0109): no access section; when it speaks: the answer alone.
    expect(within(panel).queryByRole("region", { name: "O que pode fazer sozinha" })).toBeNull();
    expect(within(panel).getByRole("region", { name: "Quando falar" }).querySelectorAll("p")).toHaveLength(1);
  });
});

describe("Rotinas: a run at work, whatever the routine says", () => {
  test("a paused routine's manual run and a fired one-off's run read as running, with Parar", async () => {
    const once = { type: "once" as const, at: ago(5), timezone: "America/Sao_Paulo", description: "" };
    const { calls } = await open([
      routine({ id: "rt-paused", name: "Resumo pausado", active: false, state: "running", nextRunAt: null }),
      routine({
        id: "rt-once",
        name: "Resumo de hoje",
        active: false,
        state: "running",
        nextRunAt: null,
        trigger: once,
      }),
    ]);
    // The one-off isn't done while its run works: it is in the list, not under "Concluídos".
    expect(screen().queryByRole("button", { name: /Concluídos/ })).toBeNull();
    expect(within(card("Resumo pausado")).getByRole("button", { name: "Parar Resumo pausado" })).toBeTruthy();
    const fired = card("Resumo de hoje");
    // Nothing to turn on or run again: only Parar.
    expect(within(fired).queryByRole("switch")).toBeNull();
    expect(within(fired).queryByRole("button", { name: "Rodar agora" })).toBeNull();
    await click(within(fired).getByRole("button", { name: "Parar Resumo de hoje" }));
    await settle(4);
    expect(calls).toContain("stop:rt-once");
    // The details say it runs, with Parar, instead of "Pausada".
    const panel = await details("Resumo pausado");
    expect(panel.textContent).toContain("Rodando");
    expect(within(panel).getByRole("button", { name: "Parar" })).toBeTruthy();
  });
});

describe("Rotinas: every code in the person's words", () => {
  test("each run code the server writes has its own words; a report it couldn't deliver isn't 'Não rodou'", () => {
    const i18n = createI18n("pt-BR");
    const said = (lng: string, code: string) => i18n.getResource(lng, "translation", `routines.code.${code}`);
    const missing = ["pt-BR", "en"].flatMap((lng) => RUN_CODES.filter((c) => !said(lng, c)).map((c) => `${lng}:${c}`));
    expect(missing).toEqual([]);
    const say = i18n.t.bind(i18n) as unknown as (key: string) => string;
    expect(say(runOutcome({ status: "skipped", code: "creator_no_access" }).key)).toBe(
      "Não pôde contar: quem criou não pode mais escrever ali",
    );
    expect(say(runOutcome({ status: "failed", code: "empty_reply" }).key)).toBe("O modelo não respondeu nada");
  });

  test("a routine refused by the server says why in the person's language", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n) as TFunction;
    const refused = (status: number, code: string) => errorText(t, new ApiError(status, code, "English message"));
    expect(refused(400, "routine.creator_cannot_post")).toBe(
      "Quem cria a rotina precisa estar na conversa e poder escrever nela.",
    );
    expect(refused(403, "routine.take_over_no_access")).toBe("Entre na conversa da rotina antes de assumi-la.");
    expect(refused(400, "routine.agent_not_in_channel")).toBe("Adicione o agente à conversa antes.");
    const en = createI18n("en");
    expect(errorText(en.t.bind(en) as TFunction, new ApiError(400, "routine.agent_not_in_channel", "x"))).toBe(
      "Add the agent to the conversation first.",
    );
  });
});

describe("Rotinas: the form's two plain questions", () => {
  test("no routines: the title and Nova rotina, nothing else", async () => {
    await open([]);
    const empty = document.querySelector(".ac-empty") as HTMLElement;
    expect(empty.querySelector(".ac-empty__title")?.textContent).toBe("Nenhuma rotina ainda");
    expect(empty.querySelector(".ac-empty__text")).toBeNull();
    expect(within(empty).getByRole("button", { name: "Nova rotina" })).toBeTruthy();
    expect(document.querySelector(".routines-head")?.querySelectorAll("p")).toHaveLength(1);
  });

  test("Quando falar, sent with the routine; no access choice", async () => {
    const api = createFakeApi(seedState());
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    // The default: only when there's news. Every routine does what its agent can: nothing to choose there.
    expect(within(dialog).getByRole("radio", { name: "Só quando tiver novidade" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(dialog).queryByRole("radio", { name: "Só olhar e contar" })).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: "Pode agir" })).toBeNull();
    await click(within(dialog).getByRole("radio", { name: "Toda vez" }));
    expect(dialog.querySelectorAll(".routine-kind p")).toHaveLength(0);
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("O que fazer"), { target: { value: "Revise os PRs abertos." } }),
    );
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Nome (opcional)"), { target: { value: "PRs abertos" } }),
    );
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(6);
    const made = (await api.routines.list(ORG_ID)).find((r) => r.name === "PRs abertos");
    expect(made).toMatchObject({ report: "always" });
    expect(made?.access).toBe("act");
  });
});

describe("Approval cards: why, and asked while nobody watched", () => {
  test("the request: the agent's why in its words, then the action, then the routine that asked", async () => {
    const state = seedState();
    const first = state.approvals[0];
    if (first) {
      first.why = "O PR #42 corrige o login que quebrou no deploy das 9h; os testes passaram.";
      first.origin = { kind: "routine", routineId: "rt-1", routineName: "Revisar PRs" };
    }
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const group = screen().getByRole("group", { name: "Pedido de aprovação" });
    // Where it came from is with the rest of the action, behind "Ver detalhes".
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "Ver detalhes" })));
    const text = group.textContent ?? "";
    const why = text.indexOf("O PR #42 corrige o login");
    const action = text.indexOf("Merge PR #42 into main");
    const origin = text.indexOf("rotina «Revisar PRs»");
    expect(why).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(why);
    expect(origin).toBeGreaterThan(action);
  });
});

describe("Chat: what a routine found", () => {
  test("the agent's message is tagged with the routine; the report it answers folds into it", async () => {
    const state = seedState();
    const at = (minutes: number) => ago(minutes);
    state.messages.push(
      {
        id: "m-report",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ATLAS_ID },
        body: "",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: {
          notice: {
            kind: "routine_handoff",
            text: "Relatório: 3 erros novos no checkout desde ontem.",
            refs: { routineName: "Sentry diário", routineId: "rt-s" },
          },
        },
        createdAt: at(3),
      },
      {
        id: "m-told",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ATLAS_ID },
        body: "Achei 3 erros novos no checkout; o maior afeta 12% dos pagamentos.",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: { routine: { id: "rt-s", name: "Sentry diário", runId: "rr-1", noticeId: "m-report" } },
        createdAt: at(2),
      },
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    // The report's own line is folded into the message that tells it.
    expect(screen().queryByText(/Rotina «Sentry diário» entregou um relatório/)).toBeNull();
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Achei 3 erros novos")) as HTMLElement;
    const tag = within(row).getByRole("link", { name: "Rotina «Sentry diário»" });
    expect(tag.getAttribute("href")).toContain("open=rt-s");
    expect(row.textContent).not.toContain("Relatório: 3 erros novos");
    await click(within(row).getByRole("button", { name: "Ver relatório" }));
    expect(row.textContent).toContain("Relatório: 3 erros novos no checkout desde ontem.");
  });
});
