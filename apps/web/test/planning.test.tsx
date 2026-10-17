import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { toYmd } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { mondayOf } from "@/pages/CalendarPage";
import { splitCriteria } from "@/pages/IssuesPage";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { nextCronRun, parseSchedulePhrase } from "./fakes/planning";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const pick = async (combobox: HTMLElement, option: string | RegExp) => {
  combobox.focus();
  await key(combobox, "Enter");
  await click(within(screen().getByRole("listbox")).getByRole("option", { name: option }));
  await settle(3);
};
const go = async (path: string, api = createFakeApi(seedState())) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return { ...r, api };
};
const column = (name: string) => screen().getByRole("region", { name });
const cardTitles = (el: HTMLElement) => Array.from(el.querySelectorAll(".issue-card__title")).map((x) => x.textContent);

describe("Issues (board and list)", () => {
  test("board by status with counts, summary, PR, priority and due date", async () => {
    await go("issues");
    expect(screen().getByRole("heading", { level: 1, name: "Issues" })).toBeTruthy();
    expect(screen().getByText("5 abertas · 3 com agentes")).toBeTruthy();
    expect(cardTitles(column("A fazer"))).toEqual([
      "Tabela de concorrentes atualizada",
      "Confirmação do agendamento por WhatsApp",
    ]);
    expect(column("Em revisão").textContent).toContain("PR #42");
    const wa = screen().getByRole("link", { name: "#131 Confirmação do agendamento por WhatsApp" });
    expect(wa.textContent).toContain("Alta");
    expect(wa.textContent).toContain("produto");
    expect(wa.textContent).toContain("João");
    expect(column("Feito").textContent).toContain("2");
    // The route title link goes to the detail.
    expect(wa.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/131`);
    // An agent with a live run: "working now", its step on the card, criteria in pixels.
    const now = screen().getByRole("region", { name: "Agentes trabalhando agora" });
    expect(now.textContent).toContain("Timeout no agendamento em horários de pico");
    expect(now.textContent).toContain("Atualizou uma issue · #129");
    const timeout = screen().getByRole("link", { name: "#129 Timeout no agendamento em horários de pico" });
    expect(within(timeout).getByRole("img", { name: "1 de 2 critérios de aceite" })).toBeTruthy();
  });

  test("a click opens the details dialog (kept in the URL); Escape closes it", async () => {
    const { router } = await go("issues");
    await click(screen().getByRole("link", { name: "#131 Confirmação do agendamento por WhatsApp" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" });
    expect(dialog.textContent).toContain("#131");
    expect(within(dialog).getByRole("region", { name: "Pedir a um agente" })).toBeTruthy();
    expect(within(dialog).getByRole("complementary", { name: "Detalhes da issue" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Abrir página da issue" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/issues/131`,
    );
    expect(router.state.location.href).toContain("?open=131");
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(router.state.location.href).not.toContain("open=");
  });

  test("an issue's link with ?open= reopens its details", async () => {
    await go("issues?open=131");
    expect(screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" })).toBeTruthy();
  });

  test("filters, search and the list view", async () => {
    await go("issues");
    await click(screen().getByRole("button", { name: "Com agentes" }));
    expect(screen().getByRole("button", { name: "Com agentes" }).getAttribute("aria-pressed")).toBe("true");
    expect(cardTitles(column("Em andamento"))).toEqual(["Timeout no agendamento em horários de pico"]);
    await click(screen().getByRole("button", { name: "Minhas" }));
    expect(screen().getByText("Nenhuma issue com esses filtros.")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Todas" }));
    await type(screen().getByRole("searchbox", { name: "Buscar issues" }), "#128");
    await settle(4);
    expect(screen().getAllByRole("link", { name: /^#\d+/ })).toHaveLength(1);
    await type(screen().getByRole("searchbox", { name: "Buscar issues" }), "");
    await settle(4);
    await click(screen().getByRole("radio", { name: "Lista" }));
    const rows = screen().getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    expect(rows[0]?.textContent).toContain("#132");
    expect(rows.find((r) => r.textContent?.includes("#126"))?.textContent).toContain("Feito");
  });

  test("Nova issue: title, criteria from '-' lines, assignee and priority", async () => {
    const { api } = await go("issues");
    await click(screen().getByRole("button", { name: "Nova issue" }));
    const dialog = screen().getByRole("dialog", { name: "Nova issue" });
    const create = within(dialog).getByRole("button", { name: "Criar issue" });
    expect(create.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Título"), "Exportar agenda em PDF");
    await type(
      within(dialog).getByLabelText("Descrição e critérios de aceite"),
      "Pedido de 18 reviews.\n- Botão na agenda\n- PDF com o logo da clínica",
    );
    await pick(within(dialog).getByRole("combobox", { name: "Responsável" }), /Ada/);
    await pick(within(dialog).getByRole("combobox", { name: "Prioridade" }), "Alta");
    await type(within(dialog).getByLabelText("Prazo (opcional)"), "31/02");
    expect(dialog.textContent).toContain("Use dd/mm ou dd/mm/aaaa.");
    await type(within(dialog).getByLabelText("Prazo (opcional)"), "");
    await click(create);
    await settle(5);
    expect(screen().getByText("Issue #133 criada.")).toBeTruthy();
    // An agent picked at creation starts right away ("Pedir"): in progress.
    expect(cardTitles(column("Em andamento"))).toContain("Exportar agenda em PDF");
    const created = await api.issues.get(ORG_ID, 133);
    expect(created).toMatchObject({
      description: "Pedido de 18 reviews.",
      priority: "high",
      assignee: { type: "agent" },
    });
    expect(created.criteria.map((c) => c.text)).toEqual(["Botão na agenda", "PDF com o logo da clínica"]);
  });
});

describe("Issue detail", () => {
  test("source, description, criteria with progress, details aside", async () => {
    await go("issues/131");
    expect(screen().getByRole("heading", { level: 1, name: "Confirmação do agendamento por WhatsApp" })).toBeTruthy();
    expect(screen().getByText(/#131 · criada por João/).textContent).toContain("a partir de uma mensagem no #eng");
    expect(screen().getByRole("link", { name: "uma mensagem no #eng" })).toBeTruthy();
    const criteria = screen().getByRole("region", { name: "Critérios de aceite" });
    expect(criteria.textContent).toContain("0 de 4");
    await click(within(criteria).getByLabelText("Paciente sem WhatsApp recebe SMS"));
    await settle(4);
    expect(screen().getByRole("region", { name: "Critérios de aceite" }).textContent).toContain("1 de 4");
    const aside = screen().getByRole("complementary", { name: "Detalhes da issue" });
    expect(within(aside).getByRole("combobox", { name: "Status" }).textContent).toContain("A fazer");
    expect(within(aside).getByRole("combobox", { name: "Prioridade" }).textContent).toContain("Alta");
    expect(within(aside).getByRole("link", { name: "ver no calendário" })).toBeTruthy();
    expect(aside.textContent).toContain("agendamento");
  });

  test("Pedir à Ada: assigns the agent, moves to Em andamento and logs it", async () => {
    await go("issues/131");
    const ask = screen().getByRole("region", { name: "Pedir a um agente" });
    expect(ask.textContent).toContain("Pedir à Ada para implementar");
    expect(ask.textContent).toContain("A Ada lê o código, comenta o plano aqui e abre um PR.");
    await click(within(ask).getByRole("button", { name: "Pedir à Ada" }));
    await settle(6);
    expect(screen().queryByRole("region", { name: "Pedir a um agente" })).toBeNull();
    const aside = screen().getByRole("complementary", { name: "Detalhes da issue" });
    expect(within(aside).getByRole("combobox", { name: "Status" }).textContent).toContain("Em andamento");
    expect(within(aside).getByRole("combobox", { name: "Responsável" }).textContent).toContain("Ada");
    const activity = screen().getByRole("region", { name: "Atividade" });
    expect(activity.textContent).toContain("Walter pediu a Ada para implementar");
  });

  test("comment and change the status", async () => {
    await go("issues/131");
    await type(screen().getByRole("combobox", { name: "Comentar na issue" }), "Começo amanhã.");
    await act(async () =>
      fireEvent.keyDown(screen().getByRole("combobox", { name: "Comentar na issue" }), { key: "Enter" }),
    );
    await settle(5);
    const activity = screen().getByRole("region", { name: "Atividade" });
    expect(activity.textContent).toContain("Começo amanhã.");
    const aside = screen().getByRole("complementary", { name: "Detalhes da issue" });
    await pick(within(aside).getByRole("combobox", { name: "Status" }), "Em revisão");
    await settle(4);
    expect(screen().getByRole("region", { name: "Atividade" }).textContent).toContain("mudou o status para Em revisão");
  });

  test("a missing issue says so", async () => {
    await go("issues/999");
    expect(screen().getByText("Esta issue não existe ou você não tem acesso.")).toBeTruthy();
  });
});

describe("Rotinas", () => {
  test("rows with agent, target, schedule, next and last run; no money", async () => {
    await go("routines");
    const weekly = screen().getByRole("article", { name: "Resumo da semana" });
    expect(weekly.textContent).toContain("entrega em #eng");
    expect(weekly.textContent).toContain("Toda semana, seg, às 09:00");
    expect(weekly.textContent).toMatch(/Próxima/);
    // No money on the rows (the routine's budget lives in its details).
    expect(weekly.textContent).not.toContain("US$");
    // The last runs as a pixel strip, said in words.
    expect(within(weekly).getByRole("img", { name: /^(Últimas execuções|Nenhuma execução)/ })).toBeTruthy();
    const pr = screen().getByRole("article", { name: "Revisar PR aberto" });
    expect(pr.textContent).toContain("PR aberto no GitHub");
    expect(pr.textContent).toMatch(/Espera/);
    // My own zone isn't repeated on the row.
    expect(weekly.textContent).not.toContain("Brasília");
    expect(within(weekly).getByRole("switch", { name: "Ativa: Resumo da semana" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const monthly = screen().getByRole("article", { name: "Relatório mensal de reviews" });
    expect(monthly.getAttribute("data-paused")).toBe("true");
    expect(within(monthly).getByText("Pausada")).toBeTruthy();
    expect(within(monthly).queryByRole("checkbox")).toBeNull();
    // The horizon: one lane per scheduled, active routine.
    expect(screen().getByRole("region", { name: "Próximas horas" })).toBeTruthy();
  });

  test("pause with the switch, run now and see runs in the details", async () => {
    await go("routines");
    const weekly = () => screen().getByRole("article", { name: "Resumo da semana" });
    await click(within(weekly()).getByRole("switch", { name: "Ativa: Resumo da semana" }));
    await settle(5);
    expect(weekly().getAttribute("data-paused")).toBe("true");
    expect(within(weekly()).getByText("Pausada")).toBeTruthy();
    expect(screen().getByText(/Rotina pausada\./)).toBeTruthy();
    await click(within(weekly()).getByRole("switch", { name: "Ativa: Resumo da semana" }));
    await settle(5);
    expect(weekly().hasAttribute("data-paused")).toBe(false);
    const run = within(weekly()).getByRole("button", { name: "Rodar agora" });
    expect(run.getAttribute("title")).toBe("Rodar agora");
    await click(run);
    await settle(4);
    expect(within(weekly()).getByRole("button", { name: "Rodando…" }).hasAttribute("disabled")).toBe(true);
    // The title opens the details: what it does, when, where, and the run history.
    await click(within(weekly()).getByRole("button", { name: "Resumo da semana" }));
    await settle(4);
    const details = screen().getByRole("dialog", { name: "Resumo da semana" });
    expect(details.textContent).toContain("Resuma o que");
    expect(details.textContent).toContain("Orçamento do mês esgotado");
    expect(details.textContent).toContain("não rodou");
    expect(details.textContent).toContain("Resumo postado no canal");
    await click(within(details).getByRole("button", { name: "Fechar detalhes" }));
    expect(screen().queryByRole("dialog", { name: "Resumo da semana" })).toBeNull();
  });

  test("Nova rotina: natural-language schedule is parsed before creating", async () => {
    await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    expect(dialog.textContent).toContain("Toda semana, seg, às 09:00 · horário de Brasília (UTC−3)");
    // The zone has its own select, so the person can change it.
    expect(within(dialog).getByRole("combobox", { name: "Fuso horário" }).textContent).toContain(
      "Horário de Brasília · UTC−3",
    );
    await type(within(dialog).getByLabelText("Frequência"), "quando der");
    await settle(4);
    expect(dialog.textContent).toContain("Não entendi.");
    expect(within(dialog).getByRole("button", { name: "Criar rotina" }).hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Frequência"), "dias úteis às 8h30");
    await settle(4);
    expect(dialog.textContent).toContain("De segunda a sexta, às 08:30");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    expect(dialog.textContent).toContain("Diga o que o agente deve fazer.");
    await type(within(dialog).getByLabelText("O que fazer"), "Liste os PRs abertos há mais de 2 dias.");
    await type(within(dialog).getByLabelText("Nome (opcional)"), "PRs parados");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(5);
    const card = screen().getByRole("article", { name: "PRs parados" });
    expect(card.textContent).toContain("De segunda a sexta, às 08:30");
    expect(card.textContent).toContain("Ainda não rodou");
  });

  test("an event-driven routine", async () => {
    await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await click(within(dialog).getByRole("radio", { name: "Quando algo acontecer" }));
    expect(dialog.textContent).toContain("Vem pelos conectores da Acme.");
    await pick(within(dialog).getByRole("combobox", { name: "Evento" }), "Deploy concluído");
    await type(within(dialog).getByLabelText("O que fazer"), "Confira os erros depois do deploy.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(5);
    expect(
      screen()
        .getAllByRole("article")
        .some((a) => a.textContent?.includes("Deploy concluído")),
    ).toBe(true);
  });
});

describe("Calendário", () => {
  const openPanel = async () => {
    const show = screen().queryByRole("button", { name: "Mostrar painel" });
    if (show) await click(show);
  };
  test("week of 7 days with events, routine runs and issue due dates; filter chips hide them", async () => {
    const api = createFakeApi(seedState());
    const monday = mondayOf(new Date());
    await api.issues.create(ORG_ID, { title: "Fechar a release", dueDate: toYmd(monday) });
    await go("calendar", api);
    expect(screen().getByRole("heading", { level: 1, name: "Calendário" })).toBeTruthy();
    expect(document.querySelectorAll(".cal-week__col")).toHaveLength(7);
    expect(screen().getByRole("button", { name: "Daily de produto, 10:00–11:00" })).toBeTruthy();
    expect(screen().getAllByRole("button", { name: "Rotina Erros do Sentry do dia, 18:00" })).toHaveLength(5);
    expect(screen().getByRole("button", { name: "#133 Fechar a release, dia todo" })).toBeTruthy();
    // A routine run is a quiet pixel mark, not a chip; a click lists the slot's runs.
    const routine = screen().getByRole("button", { name: "Rotina Resumo da semana, 09:00" });
    expect(routine.classList.contains("cal-marks")).toBe(true);
    expect(routine.querySelectorAll(".ac-run-mark")).toHaveLength(1);
    expect(routine.querySelector(".cal-chip__title")).toBeNull();
    await click(routine);
    await settle(2);
    const runs = screen().getByRole("region", { name: "Rotinas às 09:00" });
    expect(runs.textContent).toContain("Resumo da semana");
    expect(runs.textContent).toContain("última: respondeu");
    expect(within(runs).getByRole("link", { name: "Abrir rotina" }).getAttribute("href")).toContain("?open=");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);

    await openPanel();
    const filters = screen().getByRole("group", { name: "Filtros" });
    await click(within(filters).getByRole("button", { name: /^Rotinas/ }));
    expect(screen().queryByRole("button", { name: /Resumo da semana/ })).toBeNull();
    await click(within(filters).getByRole("button", { name: /^Prazos de issues/ }));
    expect(screen().queryByRole("button", { name: /Fechar a release/ })).toBeNull();
    expect(screen().getByRole("button", { name: "Daily de produto, 10:00–11:00" })).toBeTruthy();
    // "Dias úteis": Monday to Friday only.
    await click(screen().getByRole("button", { name: "Dias úteis" }));
    expect(document.querySelectorAll(".cal-week__col")).toHaveLength(5);
  });

  test("an event opens its details in a popover; an agent's proposal is confirmed by a person", async () => {
    await go("calendar");
    await click(screen().getByRole("button", { name: "Daily de produto, 10:00–11:00" }));
    await settle(2);
    const details = screen().getByRole("region", { name: "Daily de produto" });
    expect(details.textContent).toContain("Evento");
    expect(details.textContent).toContain("Walter");
    expect(within(details).getByRole("button", { name: "Editar" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    await openPanel();
    const side = screen().getByRole("complementary", { name: "Painel do calendário" });
    expect(side.textContent).toContain("Agentes só propõem horários.");
    const proposal = within(side).getByRole("group", { name: "Proposta de evento" });
    expect(proposal.textContent).toContain("Revisão do roadmap");
    expect(proposal.textContent).toContain("livre para todos");
    await click(within(proposal).getByRole("button", { name: "Confirmar e convidar" }));
    await settle(5);
    expect(screen().getByText("Evento criado e convites enviados.")).toBeTruthy();
    expect(screen().getByRole("button", { name: "Revisão do roadmap, 15:00–15:45" })).toBeTruthy();
  });
});

describe("sidebar", () => {
  test("Issues, Rotinas and Calendário are in the workspace navigation", async () => {
    await go("issues");
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    for (const [name, path] of [
      ["Issues", "issues"],
      ["Rotinas", "routines"],
      ["Calendário", "calendar"],
    ]) {
      expect(within(nav).getByRole("link", { name }).getAttribute("href")).toBe(`/org/${ORG_ID}/${path}`);
    }
  });
});

describe("planning helpers", () => {
  test("the mock's schedule table and next runs", () => {
    expect(parseSchedulePhrase("toda segunda às 9h")).toMatchObject({ ok: true, cron: "0 9 * * 1" });
    expect(parseSchedulePhrase("dias úteis às 18h")).toMatchObject({ ok: true, cron: "0 18 * * 1-5" });
    expect(parseSchedulePhrase("dia 1 às 8h")).toMatchObject({ ok: true, cron: "0 8 1 * *" });
    expect(parseSchedulePhrase("")).toMatchObject({ ok: false });
    expect(parseSchedulePhrase("quando der")).toMatchObject({ ok: false });
    const wed = new Date(2026, 9, 14, 12, 0);
    expect(nextCronRun("0 9 * * 1", wed)?.toDateString()).toBe(new Date(2026, 9, 19).toDateString());
    expect(nextCronRun("0 18 * * 1-5", wed)?.getHours()).toBe(18);
  });

  test("criteria come from list lines", () => {
    expect(splitCriteria("Contexto.\n- um\n* dois\n[ ] três")).toEqual({
      description: "Contexto.",
      criteria: ["um", "dois", "três"],
    });
  });
});
