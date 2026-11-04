import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { IssuesView } from "@agenteschat/client";
import { ISSUES_VIEW_DEFAULT } from "@agenteschat/client/lib/issues-view";
import { box, place } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const view = (over: Partial<IssuesView>): IssuesView => ({ ...structuredClone(ISSUES_VIEW_DEFAULT), ...over });
const go = async (state = seedState()) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/issues`, { api });
  await settle(8);
  return { ...r, api, state };
};
const column = (name: string) => screen().getByRole("region", { name });
// The title after its number ("#131 Confirmação…" on one row).
const cardTitles = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(".issue-card__title")).map((x) => x.textContent?.replace(/^#\d+ /, ""));
const cardOf = (number: number) => document.querySelector<HTMLElement>(`[data-card="${number}"]`) as HTMLElement;
const toast = () => document.querySelector(".ac-toast")?.textContent ?? "";
const live = () => document.querySelector(".issues-body [aria-live]")?.textContent ?? "";

/** happy-dom lays nothing out: each column a box side by side, its cards stacked inside, 90px apart. */
function layBoard() {
  const cols = [...document.querySelectorAll<HTMLElement>("[data-col]")];
  cols.forEach((col, k) => {
    const left = 40 + k * 260;
    place(col, box(left, 200, 250, 600));
    for (const [j, slot] of [...col.querySelectorAll<HTMLElement>("[data-slot]")].entries())
      place(slot, box(left + 8, 240 + j * 90, 234, 80));
  });
  return cols.map((c) => c.getAttribute("aria-label"));
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" });
/** A mouse press on the card, a move past the slop (it lifts), then on to the point. */
async function drag(card: HTMLElement, x: number, y: number) {
  await act(async () => {
    fireEvent.pointerDown(card, at(60, 250));
    fireEvent.pointerMove(document, at(70, 262));
    fireEvent.pointerMove(document, at(x, y));
  });
  await settle(2);
}
const drop = async (x: number, y: number) => {
  await act(async () => fireEvent.pointerUp(document, at(x, y)));
  await settle(6);
};
const press = async (k: string, el: Element = document.activeElement ?? document.body) => {
  await act(async () => fireEvent.keyDown(el, { key: k }));
  await settle(3);
};

describe("Tarefas: how I left it", () => {
  test("Exibição keeps layout, grouping, fields and canceled ones; they come back, the search doesn't", async () => {
    const state = seedState();
    const { api } = await go(state);
    const trigger = screen().getByRole("button", { name: "Exibição: Quadro · Etapa" });
    await click(trigger);
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Exibição" });
    expect(within(dialog).getByRole("button", { name: "Quadro" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).queryByRole("button", { name: "Voltar ao padrão" })).toBeNull();
    expect(dialog.textContent).toContain("Salvo para você neste workspace");
    await click(within(dialog).getByRole("button", { name: "Lista" }));
    const groupBy = within(dialog).getByRole("radiogroup", { name: "Agrupar por" });
    await click(within(groupBy).getByRole("radio", { name: "Prioridade" }));
    await click(within(dialog).getByRole("button", { name: "Prazo" }));
    await click(within(dialog).getByRole("switch", { name: "Mostrar canceladas" }));
    await settle(5);
    expect(within(dialog).getByRole("button", { name: "Voltar ao padrão" })).toBeTruthy();
    const fields = { ...ISSUES_VIEW_DEFAULT.fields, due: false };
    expect(state.issuesView).toEqual(view({ layout: "list", group: "priority", showCanceled: true, fields }));
    // Grouped by priority in the list, without the due dates.
    expect(screen().getByRole("region", { name: "Alta" }).textContent).toContain("#131");
    expect(screen().getByRole("region", { name: "Normal" }).textContent).toContain("#132");
    expect(document.querySelector(".issue-due")).toBeNull();
    await act(async () =>
      fireEvent.change(screen().getByRole("searchbox", { name: "Buscar tarefas" }), { target: { value: "#128" } }),
    );
    await settle(4);

    // Another visit (a reload, the desktop app, a new tab): the same view, an empty search.
    cleanup();
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    expect(screen().getByRole("button", { name: "Exibição: Lista · Prioridade" })).toBeTruthy();
    expect((screen().getByRole("searchbox", { name: "Buscar tarefas" }) as HTMLInputElement).value).toBe("");
    expect(screen().getAllByRole("link", { name: /^#\d+/ })).toHaveLength(7);
    expect(screen().getByRole("region", { name: "Alta" })).toBeTruthy();

    // "Voltar ao padrão": the board by stage again, for every device.
    await click(screen().getByRole("button", { name: "Exibição: Lista · Prioridade" }));
    await settle(2);
    const display = screen().getByRole("dialog", { name: "Exibição" });
    await click(within(display).getByRole("button", { name: "Voltar ao padrão" }));
    await settle(3);
    expect(state.issuesView).toEqual(ISSUES_VIEW_DEFAULT);
    expect(screen().getByRole("button", { name: "Exibição: Quadro · Etapa" })).toBeTruthy();
    expect(column("A fazer")).toBeTruthy();
  });

  test("grouped by Etapa the column menu stays; grouped otherwise there is no column to add", async () => {
    await go(seedState({ issuesView: view({ group: "assignee" }) }));
    expect(screen().queryByRole("button", { name: "Mais opções" })).toBeNull();
    cleanup();
    await go();
    expect(screen().getByRole("button", { name: "Mais opções" })).toBeTruthy();
  });
});

describe("Tarefas: a card", () => {
  test("'#N' and the title on one row, its fields under it; its conversation as chat's thread line", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const list = api.issues.list;
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const talk = (count: number, working: boolean, lastAt: string) => ({
      channelId: "c-task",
      rootId: "m-root",
      count,
      lastAt,
      participants: [
        { type: "agent" as const, id: ADA_ID },
        { type: "person" as const, id: "u-walter" },
      ],
      working,
    });
    api.issues.list = async (...args) =>
      (await list(...args)).map((i) =>
        i.number === 128
          ? { ...i, conversation: talk(2, false, ago(4)) }
          : i.number === 129
            ? { ...i, conversation: talk(6, true, ago(1)) }
            : i.number === 130
              ? { ...i, conversation: talk(0, false, ago(1)) }
              : i,
      );
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    const card = cardOf(128);
    const title = card.querySelector(".issue-card__title") as HTMLElement;
    expect(title.querySelector(".issue-card__number")?.textContent).toBe("#128");
    expect(title.textContent).toBe("#128 Login devolve 401 depois do deploy das 9h");
    // The fields after the title, the label without its old dot.
    expect(title.nextElementSibling?.classList.contains("issue-card__top")).toBe(true);
    expect(card.querySelector(".issue-card__top")?.textContent).toMatch(/^bug/);
    const line = card.querySelector(".issue-card__talk") as HTMLElement;
    expect(line.classList.contains("thread-line")).toBe(true);
    expect(line.querySelectorAll(".thread-line__who .ac-avatar")).toHaveLength(2);
    expect(line.querySelector("b")?.textContent).toBe("2 mensagens");
    expect(line.querySelector("time")?.textContent).toBe("há 4 min");
    expect(line.querySelector(".thread-line__state")).toBeNull();
    // Not a control of its own inside the card's link.
    expect(line.closest("button")).toBeNull();
    // An agent at work on it: "Trabalhando" in the agent's blue, no time.
    const busy = cardOf(129).querySelector(".issue-card__talk") as HTMLElement;
    expect(busy.querySelector("b")?.textContent).toBe("6 mensagens");
    expect(busy.querySelector(".thread-line__state--working")?.textContent).toBe("Trabalhando");
    expect(busy.querySelector("time")).toBeNull();
    // No messages, or no conversation: no line.
    expect(cardOf(130).querySelector(".issue-card__talk")).toBeNull();
    expect(cardOf(131).querySelector(".issue-card__talk")).toBeNull();
  });
});

describe("Tarefas: moving a card", () => {
  test("grouped by assignee: dropped in another column, the task changes hands, with Desfazer", async () => {
    const { api } = await go(seedState({ issuesView: view({ group: "assignee" }) }));
    // Everyone with a task, by name, then nobody.
    expect(layBoard()).toEqual(["Ada", "Atlas", "João", "Sem responsável"]);
    expect(cardTitles(column("Ada"))).toEqual([
      "Tabela de concorrentes atualizada",
      "Timeout no agendamento em horários de pico",
      "Login devolve 401 depois do deploy das 9h",
    ]);
    // At rest an empty column is quiet; while a card moves it says what a drop there does.
    expect(column("Sem responsável").textContent).toContain("Nada aqui.");
    await drag(cardOf(132), 600, 760);
    expect(document.querySelector(".issue-ghost")).toBeTruthy();
    expect(column("Sem responsável").textContent).toContain("Solte para tirar o responsável");
    expect(column("João").classList.contains("is-over")).toBe(true);
    expect(column("João").querySelector("[data-spot]")).toBeTruthy();
    await drop(600, 760);
    expect(document.querySelector(".issue-ghost")).toBeNull();
    expect((await api.issues.get(ORG_ID, 132)).assignee).toEqual({ type: "person", id: "u-joao" });
    expect(cardTitles(column("João"))).toContain("Tabela de concorrentes atualizada");
    expect(toast()).toContain("#132 agora está com João.");
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(10);
    expect((await api.issues.get(ORG_ID, 132)).assignee).toEqual({ type: "agent", id: ADA_ID });
  });

  test("dropped on Sem responsável the task has nobody", async () => {
    const { api } = await go(seedState({ issuesView: view({ group: "assignee" }) }));
    layBoard();
    await drag(cardOf(130), 900, 300);
    await drop(900, 300);
    expect((await api.issues.get(ORG_ID, 130)).assignee).toBeNull();
    expect(toast()).toContain("#130 ficou sem responsável.");
    // The card without anyone: an empty face before the words.
    expect(cardOf(130).querySelector(".issue-nobody")).toBeTruthy();
  });

  test("a press and a release without moving is a click: the task opens", async () => {
    const { router } = await go();
    layBoard();
    await act(async () => {
      fireEvent.pointerDown(cardOf(131), at(60, 250));
      fireEvent.pointerMove(document, at(62, 251));
      fireEvent.pointerUp(document, at(62, 251));
      fireEvent.click(cardOf(131));
    });
    await settle(4);
    expect(document.querySelector(".issue-ghost")).toBeNull();
    expect(router.state.location.href).toContain("?open=131");
  });

  test("grouped by priority: the drop sets the priority", async () => {
    const { api } = await go(seedState({ issuesView: view({ group: "priority" }) }));
    expect(layBoard()).toEqual(["Alta", "Normal", "Baixa"]);
    await drag(cardOf(132), 560, 300);
    await drop(560, 300);
    expect((await api.issues.get(ORG_ID, 132)).priority).toBe("low");
    expect(toast()).toContain("#132 agora tem prioridade baixa.");
  });

  test("by stage: Esc while dragging sends the card back and saves nothing", async () => {
    const { api } = await go();
    expect(layBoard()).toEqual(["A fazer", "Em andamento", "Em revisão", "Feito"]);
    await drag(cardOf(131), 560, 760);
    expect(column("Em revisão").classList.contains("is-over")).toBe(true);
    await press("Escape", document.body);
    expect(document.querySelector(".issue-ghost")).toBeNull();
    expect(document.querySelector("[data-spot]")).toBeNull();
    expect(cardTitles(column("A fazer"))).toContain("Confirmação do agendamento por WhatsApp");
    expect((await api.issues.get(ORG_ID, 131)).status).toBe("todo");
    // The release after Esc drops nothing.
    await drop(560, 760);
    expect((await api.issues.get(ORG_ID, 131)).status).toBe("todo");
  });

  test("by stage: dropped in Feito the task is done, at that place", async () => {
    const { api } = await go();
    layBoard();
    // Feito has two cards: between them.
    await drag(cardOf(131), 860, 300);
    await drop(860, 300);
    const moved = await api.issues.get(ORG_ID, 131);
    expect(moved.status).toBe("done");
    expect(cardTitles(column("Feito"))).toEqual([
      "Resumo semanal de erros do Sentry no #eng",
      "Confirmação do agendamento por WhatsApp",
      "Organizar o roadmap do trimestre",
    ]);
    expect(toast()).toContain("Movida para Feito");
  });

  test("the keyboard: Space picks the card up, the arrows move it, Enter drops it; Esc puts it back", async () => {
    const { api } = await go();
    const card = cardOf(131);
    card.focus();
    await press(" ", card);
    expect(cardOf(131).classList.contains("is-picked")).toBe(true);
    expect(live()).toBe("Você pegou a #131. As setas movem, Espaço solta, Esc cancela.");
    await press("ArrowRight");
    // In Em andamento now, at the place it had in its column: second of three.
    expect(cardTitles(column("Em andamento"))).toContain("Confirmação do agendamento por WhatsApp");
    expect(live()).toBe("#131: Em andamento, posição 2 de 3.");
    expect(document.activeElement === cardOf(131)).toBe(true);
    await press("ArrowUp");
    expect(live()).toBe("#131: Em andamento, posição 1 de 3.");
    await press("Enter");
    expect(live()).toBe("Você soltou a #131 em Em andamento.");
    const moved = await api.issues.get(ORG_ID, 131);
    expect(moved.status).toBe("in_progress");
    expect(cardTitles(column("Em andamento"))[0]).toBe("Confirmação do agendamento por WhatsApp");

    // Esc: back where it was, nothing saved.
    const other = cardOf(132);
    other.focus();
    await press(" ", other);
    await press("ArrowRight");
    await press("ArrowRight");
    expect(cardTitles(column("Em revisão"))).toContain("Tabela de concorrentes atualizada");
    await press("Escape");
    expect(live()).toBe("A #132 voltou para o lugar.");
    expect(cardTitles(column("A fazer"))).toContain("Tabela de concorrentes atualizada");
    expect((await api.issues.get(ORG_ID, 132)).status).toBe("todo");
  });

  test("in the list the arrows go on into the next group", async () => {
    const { api } = await go(seedState({ issuesView: view({ layout: "list", group: "priority" }) }));
    const row = cardOf(131);
    row.focus();
    await press(" ", row);
    // Alta has #131 and #128: down below #128, then on to the top of Normal (five there).
    await press("ArrowDown");
    await press("ArrowDown");
    expect(live()).toBe("#131: Normal, posição 1 de 6.");
    await press(" ");
    expect((await api.issues.get(ORG_ID, 131)).priority).toBe("normal");
  });
});
