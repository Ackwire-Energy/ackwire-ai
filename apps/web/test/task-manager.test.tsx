import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type {
  ComputerQueue,
  EndedTask,
  ManagedTask,
  Message,
  QueueTurn,
  RunStep,
  TaskManagerView,
  TaskSteps,
  WorkingRun,
} from "@agenteschat/client";
import { keys, TASK_MANAGER_POLL_MS } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const DM_ADA = "dm-ada";
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

const using = (tool: string, detail: string | null, connector: string | null = null) => ({
  tool,
  detail,
  connector,
  service: connector,
  serviceIcon: null,
  at: ago(0),
});

const task = (over: Partial<ManagedTask> & Pick<ManagedTask, "runId" | "agentId">): ManagedTask => ({
  channelId: ENG_ID,
  channelKind: "channel",
  channelName: "eng",
  threadId: null,
  status: "running",
  startedAt: ago(5),
  createdAt: ago(5),
  label: null,
  background: false,
  routine: null,
  plan: null,
  requester: { userId: "u-walter", name: "Walter" },
  brain: "model",
  machine: null,
  now: null,
  steps: 1,
  pendingMessageIds: [],
  canStop: true,
  ...over,
});

const ended = (over: Partial<EndedTask> & Pick<EndedTask, "runId" | "agentId" | "status">): EndedTask => ({
  channelId: ENG_ID,
  channelKind: "channel",
  channelName: "eng",
  threadId: null,
  label: null,
  background: false,
  routine: null,
  startedAt: ago(90),
  finishedAt: ago(84),
  stoppedBy: null,
  ...over,
});

/**
 * Ada fixes a link in her DM with me (Claude Code, in her browser, on the MacBook), waits for an ok on a PR in #eng
 * and runs her backups routine; Atlas looks into a slow API on our servers, for 41 minutes now.
 */
function busy(): TaskManagerView {
  const line = (peak: number) => Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? peak : 1));
  return {
    tasks: [
      task({
        runId: "r-link",
        agentId: ADA_ID,
        channelId: DM_ADA,
        channelKind: "dm",
        channelName: null,
        label: "Corrigir o link de cancelar",
        brain: "claude_code",
        machine: { id: "machine_1", name: "MacBook" },
        now: using("browser_do", "página de cancelar"),
        startedAt: ago(6),
        createdAt: ago(6),
      }),
      task({
        runId: "r-pr",
        agentId: ADA_ID,
        status: "waiting_approval",
        label: "Revisar o PR #231",
        requester: { userId: "u-joao", name: "João" },
        now: using("github_merge_pull_request", "PR #231", "github"),
        startedAt: ago(18),
        createdAt: ago(18),
      }),
      task({
        runId: "r-api",
        agentId: ATLAS_ID,
        label: "Investigar a lentidão da API",
        now: using("run_code", "consultas lentas"),
        startedAt: ago(41),
        createdAt: ago(41),
      }),
      task({
        runId: "r-backup",
        agentId: ADA_ID,
        background: true,
        routine: { id: "rt-backup", name: "Backups" },
        channelName: null,
        requester: null,
        now: using("run_code", "conferindo arquivos"),
        startedAt: ago(10),
        createdAt: ago(10),
      }),
    ],
    ended: [
      ended({ runId: "r-week", agentId: ATLAS_ID, status: "done", label: "Resumo da semana" }),
      ended({
        runId: "r-tickets",
        agentId: ADA_ID,
        status: "canceled",
        label: "Responder os tickets",
        stoppedBy: { userId: "u-joao", name: "João" },
      }),
    ],
    activity: { [ADA_ID]: line(4), [ATLAS_ID]: line(2) },
  };
}

/** Ada's steps on the link so far: her browser, done; the issues she reads now (no result yet). */
function linkSteps(): TaskSteps {
  const step = (seq: number, kind: string, data: Record<string, unknown>): RunStep => ({
    seq,
    kind,
    data,
    createdAt: ago(6 - seq),
  });
  return {
    run: { createdAt: ago(6), finishedAt: null },
    steps: [
      step(1, "tool_call", { name: "browser_do", toolUseId: "u1", detail: "página de cancelar" }),
      step(2, "tool_result", { toolUseId: "u1", content: "Abriu a página." }),
      step(3, "tool_call", { name: "list_issues", toolUseId: "u2" }),
    ],
  };
}

const turn = (over: Partial<QueueTurn> & Pick<QueueTurn, "runId" | "agentId" | "kind">): QueueTurn => ({
  who: null,
  label: null,
  visible: false,
  mine: false,
  canStop: false,
  since: ago(5),
  ...over,
});

/**
 * Busy, plus Ada's checkout waiting for room on the MacBook (1º of 3, mine) and Atlas's report waiting on a full
 * computer whose line isn't known; the MacBook's line as the server says it: someone's request I don't see, and a
 * turn Ada asked Atlas for.
 */
function withLine() {
  const view = busy();
  view.tasks.push(
    task({
      runId: "r-checkout",
      agentId: ADA_ID,
      status: "waiting_input",
      held: "computer_busy",
      line: { machineId: "machine_1", position: 1, of: 3, people: true, since: ago(4) },
      label: "Ajustar o texto do checkout",
      machine: { id: "machine_1", name: "MacBook" },
      startedAt: ago(4),
      createdAt: ago(4),
    }),
    task({
      runId: "r-report",
      agentId: ATLAS_ID,
      status: "waiting_input",
      held: "computer_busy",
      label: "Gerar o relatório",
      machine: { id: "machine_2", name: "Servidor" },
      startedAt: ago(2),
      createdAt: ago(2),
    }),
  );
  view.computers = [
    { id: "machine_1", name: "MacBook", working: 1, inLine: 3 },
    { id: "machine_2", name: "Servidor", working: 0, inLine: 0 },
  ];
  const mine = { kind: "person" as const, who: "Walter", visible: true, mine: true };
  const queue: ComputerQueue = {
    computer: { id: "machine_1", name: "MacBook" },
    working: [turn({ ...mine, runId: "r-link", agentId: ADA_ID, label: "Corrigir o link de cancelar", since: ago(6) })],
    line: [
      {
        ...turn({ ...mine, runId: "r-checkout", agentId: ADA_ID, label: "Ajustar o texto do checkout", canStop: true }),
        people: true,
      },
      { ...turn({ runId: "r-other", agentId: ATLAS_ID, kind: "person" }), people: true },
      { ...turn({ runId: "r-asked", agentId: ATLAS_ID, kind: "agent", who: "Ada" }), people: false },
    ],
  };
  return { view, queue };
}

/** Me with a DM with Ada (`dm-ada`), and the task manager when given. */
function withDm(over: Partial<FakeState> = {}) {
  const state = seedState(over);
  state.dms.push({ channelId: DM_ADA, with: { type: "agent", id: ADA_ID, name: "Ada", handle: "ada" } });
  state.channelMembers[DM_ADA] = [
    { type: "person", id: "u-walter" },
    { type: "agent", id: ADA_ID },
  ];
  return state;
}

const open = async (state: FakeState, path: string) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(6);
  return r;
};
/** A task's row on the page, by its title (the button that picks it). */
const rowOf = (title: string) => screen().getByRole("button", { name: title }).closest(".tm-row") as HTMLElement;
function cardOf(name: string) {
  const cards = [...document.querySelectorAll<HTMLElement>(".tm-card")];
  return cards.find((c) => c.querySelector(".tm-card__text b")?.textContent === name) as HTMLElement;
}
const stopCalls = (state: FakeState) =>
  state.calls.filter((c) => c.method === "agents.cancelRun").map((c) => c.args.slice(1));

describe("the task manager page", () => {
  test("the agents as cards, then the tasks by agent with what each uses, how long and where it runs; no money", async () => {
    const state = seedState({ taskManager: busy() });
    await open(state, "task-manager");
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Gerenciador de tarefas");
    expect(document.querySelector(".tm-sum")?.textContent).toBe("3 trabalhando1 espera você");
    expect(state.calls.find((c) => c.method === "working.taskManager")?.args[0]).toBe(ORG_ID);

    // Todos first and chosen, then each agent with its tasks and who waits on it, each with its line.
    const cards = [...document.querySelectorAll<HTMLElement>(".tm-card")];
    expect(cards.map((c) => c.querySelector(".tm-card__text")?.textContent)).toEqual([
      "Todos4 tarefas",
      "Atlas1 tarefa",
      "Ada3 tarefas",
    ]);
    expect(cards[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(cardOf("Ada").querySelector(".tm-card__wait")?.getAttribute("aria-label")).toBe("1 espera você");
    expect(cardOf("Ada").querySelector(".chart-spark")?.getAttribute("aria-label")).toBe(
      "O que Ada fez nos últimos 30 min",
    );

    // Asked by people, by agent; the routines apart.
    const asked = screen().getByRole("region", { name: "Pedidas por pessoas" });
    expect(asked.querySelector(".tm-sec")?.textContent).toBe("Pedidas por pessoas3");
    expect(within(asked).getByRole("button", { name: "Mostrar ou esconder as tarefas de Ada" })).toBeTruthy();
    const background = screen().getByRole("region", { name: "Rotinas em segundo plano" });
    expect(within(background).getByRole("button", { name: "Backups" })).toBeTruthy();
    expect(rowOf("Backups").textContent).toContain("Ada · Rotina «Backups»");

    // Claude Code in Ada's browser, on her computer; the wait for my ok; Atlas in a terminal on our servers.
    const link = rowOf("Corrigir o link de cancelar");
    expect(link.textContent).toContain("Trabalhando");
    expect(link.textContent).toContain("Claude Code");
    expect(link.textContent).toContain("Navegador · página de cancelar");
    expect(link.querySelector(".tm-cell--where")?.textContent).toBe("MacBook");
    expect(link.querySelector(".tm-cell--time")?.textContent).toMatch(/^6:0\d$/);
    expect(rowOf("Revisar o PR #231").textContent).toContain("Espera seu ok");
    expect(rowOf("Revisar o PR #231").textContent).toContain("#eng · João pediu");
    const api = rowOf("Investigar a lentidão da API");
    expect(api.textContent).toContain("Terminal");
    expect(api.textContent).toContain("consultas lentas");
    expect(api.querySelector(".tm-cell--where")?.textContent).toBe("Nossos servidores");
    // "Tempo" warms with the time: full past 40 minutes, a little at 6.
    const warmth = (row: HTMLElement) =>
      (row.querySelector(".tm-cell--time") as HTMLElement).style.getPropertyValue("--h");
    expect(warmth(api)).toBe("1");
    expect(Number(warmth(link))).toBeLessThan(0.2);

    // People stop work here; spend stays in Usage.
    expect(document.querySelector(".tm")?.textContent).not.toMatch(/US\$|R\$|\$/);
  });

  test("a row picked: Parar tarefa stops it at once, and it ends today", async () => {
    const state = seedState({ taskManager: busy() });
    await open(state, "task-manager");
    expect((screen().getByRole("button", { name: "Ver passos" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen().getByRole("button", { name: "Parar tarefa" }) as HTMLButtonElement).disabled).toBe(true);

    const slow = () => screen().getByRole("button", { name: "Investigar a lentidão da API" });
    await click(slow());
    expect(slow().getAttribute("aria-pressed")).toBe("true");
    expect(rowOf("Investigar a lentidão da API").hasAttribute("data-selected")).toBe(true);
    await click(screen().getByRole("button", { name: "Parar tarefa" }));
    await settle(4);
    // No question for one task, no reason sent: Atlas is told that I stopped it.
    expect(stopCalls(state)).toEqual([["r-api"]]);
    expect(screen().queryByRole("button", { name: "Investigar a lentidão da API" })).toBeNull();
    expect(screen().getByRole("button", { name: /Terminadas hoje/ }).textContent).toBe("Terminadas hoje3");
  });

  test("Ver passos opens the task's panel: what it does now, its facts, its steps; Abrir na conversa", async () => {
    const state = seedState({ taskManager: busy(), taskSteps: { "r-link": linkSteps() } });
    const { router, services } = await open(state, "task-manager");
    await click(screen().getByRole("button", { name: "Corrigir o link de cancelar" }));
    await click(screen().getByRole("button", { name: "Ver passos" }));
    await settle(4);
    const panel = screen().getByRole("complementary", { name: "Corrigir o link de cancelar" });
    expect(panel.querySelector(".thread-head__meta")?.textContent).toBe("Ada · Conversa direta · Você pediu");
    // Estado, Tempo, Usando agora, Onde roda; no cost.
    const facts = [...panel.querySelectorAll(".tm-panel__facts dt")].map((d) => d.textContent);
    expect(facts).toEqual(["Estado", "Tempo", "Usando agora", "Onde roda"]);
    expect(panel.textContent).toContain("Trabalhando");
    expect(panel.textContent).toContain("Claude Code");
    expect(panel.textContent).toContain("MacBook");
    expect(panel.textContent).not.toMatch(/US\$|R\$|\$/);
    // Its steps as a reply's block lists them: the one done, the one it is on.
    expect(state.calls.find((c) => c.method === "working.taskSteps")?.args).toEqual([ORG_ID, "r-link"]);
    const lines = [...panel.querySelectorAll(".ac-tools__line")].map((l) => l.getAttribute("data-s"));
    expect(lines).toEqual(["done", "run"]);
    // Asked again while it works.
    const every = services.queryClient
      .getQueryCache()
      .find({ queryKey: keys.taskSteps(ORG_ID, "r-link") })
      ?.observers.map((o) => o.options.refetchInterval);
    expect(every).toContain(TASK_MANAGER_POLL_MS);

    await click(within(panel).getByRole("button", { name: "Abrir na conversa" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
  });

  test("the panel's Parar tarefa: the stopped state, then Dizer por quê; Esc closes it", async () => {
    const state = seedState({ taskManager: busy() });
    await open(state, "task-manager");
    // Each row opens its own panel too.
    await click(screen().getByRole("button", { name: "Ver passos: Investigar a lentidão da API" }));
    await settle(4);
    const panel = () => screen().getByRole("complementary", { name: "Investigar a lentidão da API" });
    expect(panel().textContent).toContain("Nenhum passo ainda.");
    await click(within(panel()).getByRole("button", { name: "Parar tarefa" }));
    await settle(4);
    expect(stopCalls(state)).toEqual([["r-api"]]);
    // Still open once it stopped: who stopped it, the agent told, and the reason's field for me.
    expect(panel().textContent).toContain("Parada");
    expect(panel().textContent).toContain("Você parou esta tarefa · Atlas recebeu o aviso");
    expect(within(panel()).queryByRole("button", { name: "Parar tarefa" })).toBeNull();
    const why = "Mudou a prioridade";
    await type(within(panel()).getByRole("textbox", { name: "Quer dizer por quê? (opcional)" }), why);
    await click(within(panel()).getByRole("button", { name: "Mandar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.stopReason")?.args).toEqual([ORG_ID, "r-api", why]);
    expect(panel().textContent).toContain(`Motivo: «${why}»`);
    expect(within(panel()).queryByRole("textbox")).toBeNull();

    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen().queryByRole("complementary", { name: "Investigar a lentidão da API" })).toBeNull();
  });

  test("stopped with a reason from Parar tudo: the open panel says that reason and asks for none", async () => {
    const state = seedState({ taskManager: busy() });
    await open(state, "task-manager");
    await click(screen().getByRole("button", { name: "Ver passos: Revisar o PR #231" }));
    const panel = () => screen().getByRole("complementary", { name: "Revisar o PR #231" });
    // Ada's row's "Parar 2", behind the panel.
    const row = screen().getByRole("button", { name: "Ada" }).closest(".tm-row") as HTMLElement;
    await click(within(row).getByRole("button", { name: "Parar 2" }));
    const ask = screen().getByRole("dialog", { name: "Parar as 2 tarefas de Ada?" });
    await type(within(ask).getByRole("textbox", { name: "Por quê? (opcional)" }), "Vou fazer eu mesmo");
    await click(within(ask).getByRole("button", { name: "Parar 2" }));
    await settle(4);
    expect(panel().textContent).toContain("Você parou esta tarefa");
    expect(panel().textContent).toContain("Motivo: «Vou fazer eu mesmo»");
    expect(within(panel()).queryByRole("textbox")).toBeNull();
  });

  test("an agent's card shows only its tasks; Parar tudo asks first, with the reason the agent reads", async () => {
    const state = seedState({ taskManager: busy() });
    await open(state, "task-manager");
    await click(cardOf("Ada"));
    expect(cardOf("Ada").getAttribute("aria-pressed")).toBe("true");
    expect(screen().getByRole("heading", { level: 2, name: "Tarefas de Ada" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Corrigir o link de cancelar" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Backups" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Investigar a lentidão da API" })).toBeNull();

    await click(screen().getByRole("button", { name: "Parar tudo de Ada" }));
    const ask = screen().getByRole("dialog", { name: "Parar as 3 tarefas de Ada?" });
    expect(ask.textContent).toContain("O que já foi feito fica guardado, e Ada fica sabendo que você parou.");
    // Nothing stops before the confirmation.
    expect(stopCalls(state)).toEqual([]);
    const why = "Já resolvi por outro caminho";
    await type(within(ask).getByRole("textbox", { name: "Por quê? (opcional)" }), why);
    await click(within(ask).getByRole("button", { name: "Parar 3" }));
    await settle(4);
    expect(stopCalls(state).sort()).toEqual([
      ["r-backup", why],
      ["r-link", why],
      ["r-pr", why],
    ]);
    expect(screen().queryByRole("dialog", { name: "Parar as 3 tarefas de Ada?" })).toBeNull();
  });

  test("Cancelar leaves every task as it was", async () => {
    const state = seedState({ taskManager: busy() });
    await open(state, "task-manager");
    await click(screen().getByRole("button", { name: "Ada" }));
    await click(screen().getByRole("button", { name: "Parar tudo de Ada" }));
    await click(within(screen().getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(stopCalls(state)).toEqual([]);
    expect(screen().getByRole("button", { name: "Corrigir o link de cancelar" })).toBeTruthy();
  });

  test("an agent's row folds its tasks and stops them all from its own Parar", async () => {
    const state = seedState({ taskManager: busy() });
    await open(state, "task-manager");
    const fold = screen().getByRole("button", { name: "Mostrar ou esconder as tarefas de Ada" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    await click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen().queryByRole("button", { name: "Corrigir o link de cancelar" })).toBeNull();
    // The routines' run stays in its own section.
    expect(screen().getByRole("button", { name: "Backups" })).toBeTruthy();

    const row = screen().getByRole("button", { name: "Ada" }).closest(".tm-row") as HTMLElement;
    await click(within(row).getByRole("button", { name: "Parar 2" }));
    const ask = screen().getByRole("dialog", { name: "Parar as 2 tarefas de Ada?" });
    await click(within(ask).getByRole("button", { name: "Parar 2" }));
    await settle(4);
    expect(stopCalls(state).sort()).toEqual([["r-link"], ["r-pr"]]);
  });

  test("Terminadas hoje, folded at the end: how each ended and who stopped it", async () => {
    await open(seedState({ taskManager: busy() }), "task-manager");
    const more = screen().getByRole("button", { name: /Terminadas hoje/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen().queryByText("Resumo da semana")).toBeNull();
    await click(more);
    const rows = [...document.querySelectorAll(".tm-row--ended")].map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Resumo da semana");
    expect(rows[0]).toContain("Atlas · #eng");
    expect(rows[0]).toContain("Terminou");
    expect(rows[1]).toContain("Responder os tickets");
    expect(rows[1]).toContain("João parou");
  });

  test("the search finds a task by its title, its agent or the program it uses", async () => {
    await open(seedState({ taskManager: busy() }), "task-manager");
    const search = screen().getByRole("searchbox", { name: "Buscar tarefa, agente ou programa" });
    await type(search, "terminal");
    expect(screen().getByRole("button", { name: "Investigar a lentidão da API" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Corrigir o link de cancelar" })).toBeNull();
    await type(search, "nada disso");
    expect(document.body.textContent).toContain("Nenhuma tarefa com essa busca.");
  });

  test("nothing at work: the calm state, and what ended today stays under it", async () => {
    await open(seedState({ taskManager: { tasks: [], ended: [], activity: {} } }), "task-manager");
    expect(document.body.textContent).toContain("Nenhum agente trabalhando agora");
    expect(document.querySelector(".tm-card")).toBeNull();
    await click(screen().getByRole("button", { name: /Terminadas hoje/ }));
    expect(document.body.textContent).toContain("Nada terminou hoje ainda.");
  });

  test("Início's agents at work open it", async () => {
    const api = createFakeApi(seedState({ taskManager: busy() }));
    const run: WorkingRun = {
      runId: "r-api",
      agentId: ATLAS_ID,
      status: "running",
      channelId: ENG_ID,
      channelKind: "channel",
      channelName: "eng",
      threadId: null,
      startedAt: ago(3),
      createdAt: ago(3),
      label: null,
    };
    api.working = { list: async () => [run], taskManager: api.working?.taskManager };
    await renderApp(`/org/${ORG_ID}/home`, { api });
    await settle(6);
    const working = screen().getByRole("region", { name: "Trabalhando agora" });
    const link = within(working).getByRole("link", { name: "Abrir no gerenciador" });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/task-manager`);
  });

  test("More in the sidebar opens it", async () => {
    await open(seedState({ taskManager: busy() }), `c/${ENG_ID}`);
    const nav = document.getElementById("app-nav") as HTMLElement;
    await click(within(nav).getByRole("button", { name: "Mais" }));
    const more = screen().getByRole("dialog", { name: "Mais" });
    const link = within(more).getByRole("link", { name: /Gerenciador de tarefas/ });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/task-manager`);
  });
});

describe("an agent's tasks beside its DM", () => {
  const PILL = "3 tarefas · 1 espera você";

  test("the header's pill says her tasks and who waits; it opens them in the thread's side panel", async () => {
    const view = busy();
    view.ended.push(ended({ runId: "r-price", agentId: ADA_ID, status: "done", label: "Atualizar o preço" }));
    const state = withDm({ taskManager: view });
    await open(state, `dm/agent/${ADA_ID}`);
    const pill = screen().getByRole("button", { name: PILL });
    expect(pill.closest(".channel__header")).toBeTruthy();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    await click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const panel = screen().getByRole("complementary", { name: "Tarefas de Ada" });
    expect(panel.classList.contains("thread-panel")).toBe(true);
    expect(panel.querySelector(".thread-head__meta")?.textContent).toBe("3 agora · 1 espera você");
    const wells = [...panel.querySelectorAll(".tm-agentpanel__wells > div")].map((w) => w.textContent);
    expect(wells).toEqual(["Agora3", "Esperam você1", "Feitas hoje1"]);
    // People's tasks first, oldest first, then her routine's; this conversation's is marked.
    const cards = [...panel.querySelectorAll(".tm-taskcard")];
    expect(cards.map((c) => c.querySelector(".tm-taskcard__title b")?.textContent)).toEqual([
      "Revisar o PR #231",
      "Corrigir o link de cancelar",
      "Backups",
    ]);
    expect(cards[0]?.querySelector(".tm-taskcard__label small")?.textContent).toBe("Espera seu ok · #eng");
    expect(cards[1]?.querySelector(".tm-here")?.textContent).toBe("aqui");
    expect(cards[2]?.querySelector(".tm-taskcard__label small")?.textContent).toMatch(/^Rotina «Backups» · /);
    // Esc closes it, and stops nothing.
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen().queryByRole("complementary", { name: "Tarefas de Ada" })).toBeNull();
    expect(stopCalls(state)).toEqual([]);
  });

  test("a card: Passos opens its steps in place, Parar stops it; Parar todas confirms in the foot", async () => {
    const state = withDm({ taskManager: busy(), taskSteps: { "r-link": linkSteps() } });
    await open(state, `dm/agent/${ADA_ID}`);
    await click(screen().getByRole("button", { name: PILL }));
    const panel = screen().getByRole("complementary", { name: "Tarefas de Ada" });
    const card = (title: string) => {
      const cards = [...panel.querySelectorAll<HTMLElement>(".tm-taskcard")];
      return cards.find((c) => c.textContent?.includes(title)) as HTMLElement;
    };
    // Passos only while it works: not on the one waiting for my ok.
    expect(within(card("Revisar o PR #231")).queryByRole("button", { name: "Passos" })).toBeNull();
    await click(within(card("Corrigir o link de cancelar")).getByRole("button", { name: "Passos" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "working.taskSteps")?.args).toEqual([ORG_ID, "r-link"]);
    const lines = [...card("Corrigir o link de cancelar").querySelectorAll(".ac-tools__line")];
    expect(lines.map((l) => l.getAttribute("data-s"))).toEqual(["done", "run"]);
    await click(within(card("Corrigir o link de cancelar")).getByRole("button", { name: /^Parar: / }));
    await settle(4);
    expect(stopCalls(state)).toEqual([["r-link"]]);

    await click(within(panel).getByRole("button", { name: "Parar todas" }));
    const ask = within(panel).getByRole("alertdialog", { name: "Parar as 2 tarefas de Ada?" });
    // In place of the foot, not a card over the panel.
    expect(ask.closest(".tm-panel__foot")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Abrir no gerenciador" })).toBeNull();
    const why = "Vou fazer eu mesmo";
    await type(within(ask).getByRole("textbox", { name: "Por quê? (opcional)" }), why);
    await click(within(ask).getByRole("button", { name: "Parar 2" }));
    await settle(4);
    expect(stopCalls(state).sort()).toEqual([["r-backup", why], ["r-link"], ["r-pr", why]]);
  });

  test("Abrir no gerenciador opens the page with her card chosen", async () => {
    const { router } = await open(withDm({ taskManager: busy() }), `dm/agent/${ADA_ID}`);
    await click(screen().getByRole("button", { name: PILL }));
    await click(screen().getByRole("button", { name: "Abrir no gerenciador" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/task-manager`);
    expect(router.state.location.search).toEqual({ agent: ADA_ID });
    expect(screen().getByRole("heading", { level: 2, name: "Tarefas de Ada" })).toBeTruthy();
  });

  test("a click beside the panel closes it; no pill in a channel, nor for an agent with nothing on", async () => {
    await open(withDm({ taskManager: busy() }), `dm/agent/${ADA_ID}`);
    await click(screen().getByRole("button", { name: PILL }));
    await click(document.querySelector(".thread-panel__scrim") as HTMLElement);
    expect(screen().queryByRole("complementary", { name: "Tarefas de Ada" })).toBeNull();
    cleanup();
    await open(seedState({ taskManager: busy() }), `c/${ENG_ID}`);
    expect(document.querySelector(".tm-pill")).toBeNull();
    cleanup();
    await open(withDm({ taskManager: { tasks: [], ended: [], activity: {} } }), `dm/agent/${ADA_ID}`);
    expect(document.querySelector(".tm-pill")).toBeNull();
  });
});

describe("a computer's line", () => {
  test("a task waiting for room says its place in the line; with no line known, Computador cheio", async () => {
    const { view } = withLine();
    await open(seedState({ taskManager: view }), "task-manager");
    const checkout = rowOf("Ajustar o texto do checkout");
    expect(checkout.querySelector(".tm-cell--state")?.textContent).toBe("Na fila · 1º");
    // Grey with the clock: it waits on its computer, not on me.
    expect(checkout.querySelector(".tm-cell--state .ac-chip--waiting")).toBeNull();
    expect(checkout.querySelector(".tm-cell--use")?.textContent).toMatch(/^esperando há /);
    expect(rowOf("Gerar o relatório").querySelector(".tm-cell--state")?.textContent).toBe("Computador cheio");
    expect(document.querySelector(".tm-sum")?.textContent).toBe("3 trabalhando1 espera você");
  });

  test("Computadores: room or a line for each; Ver fila opens the line in the side panel", async () => {
    const { view, queue } = withLine();
    const state = seedState({ taskManager: view, computerQueues: { machine_1: queue } });
    await open(state, "task-manager");
    const list = screen().getByRole("region", { name: "Computadores" });
    const rows = [...list.querySelectorAll(".tm-computer__text")].map((r) => r.textContent);
    expect(rows).toEqual(["MacBookCheio · 3 na fila · 1 trabalhando", "ServidorTem espaço"]);
    // Nothing on it: nothing to see.
    expect(within(list).queryByRole("button", { name: "Ver fila: Servidor" })).toBeNull();
    await click(within(list).getByRole("button", { name: "Ver fila: MacBook" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "working.computerQueue")?.args).toEqual([ORG_ID, "machine_1"]);
    const panel = screen().getByRole("complementary", { name: "Fila do computador" });
    expect(panel.querySelector(".thread-head__meta")?.textContent).toBe(
      "MacBook · todo mundo no workspace vê a mesma ordem",
    );
    expect(panel.querySelector(".tm-line__well")?.textContent).toBe("Cheio · 3 na fila1 trabalhando");
    const working = within(panel).getByRole("region", { name: "Trabalhando agora" });
    expect(working.textContent).toContain("Ada · Corrigir o link de cancelar");
    const line = [...within(panel).getByRole("region", { name: "Na fila" }).querySelectorAll(".tm-turn")];
    expect(line.map((r) => r.querySelector(".tm-turn__place")?.textContent)).toEqual(["1º", "2º", "3º"]);
    // Mine says what it is for; someone else's, only whose it is.
    expect(line.map((r) => r.querySelector(".tm-turn__title")?.textContent)).toEqual([
      "Ada · Ajustar o texto do checkoutVocê vai primeiro",
      "Atlas · Pedido de uma pessoa",
      "Atlas · Pedido de Ada",
    ]);
    expect(within(panel).getAllByRole("button", { name: /^Parar: / })).toHaveLength(1);
    expect(panel.textContent).toContain("Pessoas vão primeiro.");
    expect(panel.textContent).not.toMatch(/GB|memória/i);
  });

  test("Onde roda opens its computer's line; a turn I can see opens its task", async () => {
    const { view, queue } = withLine();
    await open(seedState({ taskManager: view, computerQueues: { machine_1: queue } }), "task-manager");
    const where = within(rowOf("Corrigir o link de cancelar")).getByRole("button", { name: "Ver fila: MacBook" });
    await click(where);
    await settle(4);
    const line = screen().getByRole("complementary", { name: "Fila do computador" });
    // Someone else's turn opens nothing.
    expect(within(line).queryByRole("button", { name: "Atlas · Pedido de uma pessoa" })).toBeNull();
    await click(within(line).getByRole("button", { name: "Ada · Ajustar o texto do checkout" }));
    await settle(4);
    expect(screen().queryByRole("complementary", { name: "Fila do computador" })).toBeNull();
    expect(screen().getByRole("complementary", { name: "Ajustar o texto do checkout" })).toBeTruthy();
  });

  test("in her DM's panel a task in line says its place; Ver fila shows the line in place, and back", async () => {
    const { view, queue } = withLine();
    await open(withDm({ taskManager: view, computerQueues: { machine_1: queue } }), `dm/agent/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "4 tarefas · 1 espera você" }));
    const tasks = () => screen().getByRole("complementary", { name: "Tarefas de Ada" });
    const checkout = () => {
      const cards = [...tasks().querySelectorAll<HTMLElement>(".tm-taskcard")];
      return cards.find((c) => c.textContent?.includes("Ajustar o texto do checkout")) as HTMLElement;
    };
    const sub = checkout().querySelector(".tm-taskcard__label small");
    expect(sub?.textContent).toBe("Na fila · 1º · #eng");
    expect(sub?.hasAttribute("data-wait")).toBe(false);
    await click(within(checkout()).getByRole("button", { name: "Ver fila" }));
    await settle(4);
    const line = screen().getByRole("complementary", { name: "Fila do computador" });
    expect(screen().queryByRole("complementary", { name: "Tarefas de Ada" })).toBeNull();
    expect(line.textContent).toContain("Atlas · Pedido de uma pessoa");
    await click(within(line).getByRole("button", { name: "Voltar para as tarefas" }));
    expect(tasks().querySelectorAll(".tm-taskcard")).toHaveLength(4);
  });
});

describe("the stopped notice in the conversation", () => {
  const notice = (refs: Record<string, string>): Message => ({
    id: "m-stopped",
    channelId: DM_ADA,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Walter stopped your task.",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {
      notice: {
        kind: "run_stopped",
        text: "Walter stopped your task.",
        refs: { runId: "r-old", label: "Corrigir o link", was: "working", ...refs },
      },
    },
    createdAt: ago(2),
  });

  test("one calm line; who stopped it can still say why, and Ada reads it", async () => {
    const state = withDm();
    state.messages.push(notice({ byUserId: "u-walter", byName: "Walter" }));
    await open(state, `dm/agent/${ADA_ID}`);
    const line = document.querySelector(".cn-stopped") as HTMLElement;
    expect(line.textContent).toContain("Você parou esta tarefa · Ada recebeu o aviso");
    expect(line.textContent).not.toContain("Motivo");
    await click(within(line).getByRole("button", { name: "Dizer por quê" }));
    const field = within(line).getByRole("textbox", { name: "Quer dizer por quê? (opcional)" });
    expect((within(line).getByRole("button", { name: "Mandar" }) as HTMLButtonElement).disabled).toBe(true);
    await type(field, "Já resolvi por outro caminho");
    await click(within(line).getByRole("button", { name: "Mandar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.stopReason")?.args).toEqual([
      ORG_ID,
      "r-old",
      "Já resolvi por outro caminho",
    ]);
    const after = document.querySelector(".cn-stopped") as HTMLElement;
    expect(after.textContent).toContain("Motivo: «Já resolvi por outro caminho»");
    expect(within(after).queryByRole("button", { name: "Dizer por quê" })).toBeNull();
  });

  test("someone else stopped it: their name, the reason they gave, and no Dizer por quê for me", async () => {
    const state = withDm();
    state.messages.push(notice({ byUserId: "u-joao", byName: "João", reason: "Mudou o plano" }));
    await open(state, `dm/agent/${ADA_ID}`);
    const line = document.querySelector(".cn-stopped") as HTMLElement;
    expect(line.textContent).toContain("João parou esta tarefa · Ada recebeu o aviso");
    expect(line.textContent).toContain("Motivo: «Mudou o plano»");
    expect(within(line).queryByRole("button", { name: "Dizer por quê" })).toBeNull();
  });
});
