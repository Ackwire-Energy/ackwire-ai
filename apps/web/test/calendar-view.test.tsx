import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { HOUR_PX } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = new Date();
const at = (h: number, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m);

const go = async (prepare?: (api: ReturnType<typeof createFakeApi>) => Promise<unknown>) => {
  const state = seedState();
  const api = createFakeApi(state);
  await prepare?.(api);
  await renderApp(`/org/${ORG_ID}/calendar`, { api });
  await settle(8);
  return { state, api };
};
/** Drags a chip vertically by `dy` px (pointer down on it, move and release on the window). */
const drag = async (el: HTMLElement, dy: number) => {
  await act(async () => fireEvent.pointerDown(el, { clientX: 10, clientY: 100, button: 0 }));
  await settle(1);
  await act(async () => fireEvent.pointerMove(window, { clientX: 10, clientY: 100 + dy }));
  await act(async () => fireEvent.pointerUp(window, { clientX: 10, clientY: 100 + dy }));
  await settle(3);
};

describe("Calendário: views, moves and series", () => {
  test("moving a single event updates it (snapped to 15 minutes)", async () => {
    const { state } = await go();
    const chip = screen().getByRole("button", { name: "Daily de produto, 10:00–11:00" });
    await drag(chip, HOUR_PX / 2);
    const call = state.calls.find((c) => c.method === "calendar.update");
    expect(call?.args[2]).toBeUndefined();
    const patch = call?.args[1] as { start: string; end: string };
    expect(new Date(patch.start).getMinutes()).toBe(30);
    expect(new Date(patch.end).getHours() * 60 + new Date(patch.end).getMinutes()).toBe(11 * 60 + 30);
  });

  test("moving one occurrence of a recurring event asks: Só este / Este e os próximos / Todos", async () => {
    const { state } = await go((api) =>
      api.calendar.create(ORG_ID, {
        title: "Standup",
        start: at(8).toISOString(),
        end: at(8, 30).toISOString(),
        recurrence: "none",
        participants: [],
        rule: { freq: "daily", interval: 1, times: ["08:00"], timezone: localZone, start: toYmd(today) },
      }),
    );
    const col = document.querySelector(`[data-day="${toYmd(today)}"]`) as HTMLElement;
    const chip = within(col).getByRole("button", { name: "Standup, 08:00–08:30" });
    expect(chip.querySelector(".cal-chip__repeat")).not.toBeNull();
    await drag(chip, HOUR_PX);
    const prompt = screen().getByRole("dialog", { name: "Alterar evento recorrente" });
    for (const name of ["Só este", "Este e os próximos", "Todos"])
      expect(within(prompt).getByRole("button", { name })).toBeTruthy();
    await click(within(prompt).getByRole("button", { name: "Só este" }));
    await settle(4);
    const [, patch, series] = (state.calls.find((c) => c.method === "calendar.update")?.args ?? []) as [
      string,
      { start: string },
      { scope: string },
    ];
    expect(series.scope).toBe("this");
    expect(new Date(patch.start).getHours()).toBe(9);
    // That day moved; the others stayed.
    expect(within(col).getByRole("button", { name: "Standup, 09:00–09:30" })).toBeTruthy();
  });

  test("an invitation's link opens its event on the event's week; closing it drops the link", async () => {
    const api = createFakeApi(seedState());
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 21, 15);
    const event = await api.calendar.create(ORG_ID, {
      title: "Revisão trimestral",
      start: day.toISOString(),
      end: new Date(day.getTime() + 3600_000).toISOString(),
      recurrence: "none",
      participants: [],
    });
    const { router } = await renderApp(`/org/${ORG_ID}/calendar?open=${event.id}&day=${toYmd(day)}`, { api });
    await settle(8);
    const details = screen().getByRole("region", { name: "Revisão trimestral" });
    expect(details.textContent).toContain("15:00");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(3);
    expect(screen().queryByRole("region", { name: "Revisão trimestral" })).toBeNull();
    expect(router.state.location.search).toEqual({});
    expect(screen().getByRole("button", { name: "Revisão trimestral, 15:00–16:00" })).toBeTruthy();
  });

  test("views: Mês and Agenda; T goes back to today; arrows move the day", async () => {
    await go();
    const range = () => document.querySelector(".cal-page__range")?.textContent ?? "";
    const thisWeek = range();
    await act(async () => fireEvent.keyDown(document.body, { key: "ArrowRight" }));
    for (let i = 0; i < 7; i++) await act(async () => fireEvent.keyDown(document.body, { key: "ArrowRight" }));
    await settle(3);
    expect(range()).not.toBe(thisWeek);
    await act(async () => fireEvent.keyDown(document.body, { key: "t" }));
    await settle(3);
    expect(range()).toBe(thisWeek);
    await click(screen().getByRole("radio", { name: "Mês" }));
    await settle(4);
    expect(document.querySelectorAll(".cal-month__cell")).toHaveLength(42);
    expect(range()).toBe(new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(today));
    await click(screen().getByRole("radio", { name: "Agenda" }));
    await settle(4);
    expect(document.querySelector(".cal-agenda, .cal-agenda__empty")).not.toBeNull();
  });

  /** Seven daily routines (07:01…07:07): more than a month cell shows. */
  const dailyRoutines = async (api: ReturnType<typeof createFakeApi>, n = 7, time = (i: number) => `07:0${i + 1}`) => {
    const agentId = seedState().agents[0]?.id ?? "";
    for (let i = 0; i < n; i++)
      await api.routines.create(ORG_ID, {
        name: `Diária ${i + 1}`,
        agentId,
        prompt: "Faça algo.",
        target: { type: "dm" },
        trigger: { type: "schedule", rule: { freq: "daily", times: [time(i)], timezone: localZone } },
      });
  };

  test("Mês: a day's routine runs are one row of pixel marks under the events (6, then +N), opening their list", async () => {
    await go((api) => dailyRoutines(api));
    await click(screen().getByRole("radio", { name: "Mês" }));
    await settle(4);
    const cell = document.querySelector(`.cal-month__cell[data-day="${toYmd(today)}"]`) as HTMLElement;
    // No routine chips in the cell: the runs are marks.
    expect(cell.querySelector('[data-source="routine"]')).toBeNull();
    const marks = cell.querySelector(".cal-month__marks") as HTMLElement;
    expect(marks.classList.contains("cal-marks")).toBe(true);
    expect(marks.querySelectorAll(".ac-run-mark")).toHaveLength(6);
    expect(marks.querySelector(".cal-marks__more")?.textContent).toMatch(/^\+\d+$/);
    expect(marks.getAttribute("aria-label")).toMatch(/^\d+ execuções de rotinas em .+: .*Diária 1/);
    // The marks come after the day's events.
    const chips = [...cell.querySelectorAll(".cal-chip")];
    for (const chip of chips)
      expect(chip.compareDocumentPosition(marks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(marks);
    await settle(2);
    const list = screen().getByRole("region", { name: /^Rotinas · / });
    const text = list.textContent ?? "";
    expect(text.indexOf("Diária 1")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Diária 1")).toBeLessThan(text.indexOf("Diária 7"));
    expect(list.querySelectorAll(".cal-runs__item").length).toBeGreaterThanOrEqual(7);
    expect(within(list).getAllByRole("link", { name: "Abrir rotina" })[0]?.getAttribute("href")).toContain("?open=");
  });

  test("Agenda: a day's routine runs are one quiet line (N execuções de rotinas + marks) that lists them", async () => {
    await go((api) => dailyRoutines(api, 2));
    await click(screen().getByRole("radio", { name: "Agenda" }));
    await settle(4);
    const agenda = document.querySelector(".cal-agenda") as HTMLElement;
    expect(agenda.querySelector('[data-source="routine"]')).toBeNull();
    const first = agenda.querySelector(".cal-agenda__day") as HTMLElement;
    const lines = first.querySelectorAll(".cal-agenda__marks");
    expect(lines).toHaveLength(1);
    const line = lines[0] as HTMLElement;
    expect(line.querySelector(".cal-marks__text")?.textContent).toMatch(/^\d+ execuções de rotinas$/);
    expect(line.querySelectorAll(".ac-run-mark").length).toBeGreaterThanOrEqual(2);
    await click(line);
    await settle(2);
    const list = screen().getByRole("region", { name: /^Rotinas · / });
    expect(list.textContent).toContain("Diária 1");
    expect(list.textContent).toContain("Diária 2");
    expect(within(list).getAllByRole("link", { name: "Abrir rotina" })[0]?.getAttribute("href")).toContain("?open=");
  });

  test("week grid: run marks sit in their own lane; an event at the same time ends before it", async () => {
    await go(async (api) => {
      await dailyRoutines(api, 1, () => "05:00");
      await api.calendar.create(ORG_ID, {
        title: "Planejamento",
        start: at(5).toISOString(),
        end: at(6).toISOString(),
        recurrence: "none",
        participants: [],
      });
    });
    const col = document.querySelector(`.cal-week__col[data-day="${toYmd(today)}"]`) as HTMLElement;
    expect(col.hasAttribute("data-marks")).toBe(true);
    const mark = within(col).getByRole("button", { name: "Rotina Diária 1, 05:00" });
    expect(mark.classList.contains("cal-week__marks")).toBe(true);
    const chip = within(col).getByRole("button", { name: "Planejamento, 05:00–06:00" });
    // The event leaves the 16px lane (plus its 4px gutter) free.
    expect(chip.style.width).toContain("20px");
  });

  test("Próximos: neutral rows (avatar or event icon, title, day · time), no source bar", async () => {
    await go();
    const show = screen().queryByRole("button", { name: "Mostrar painel" });
    if (show) await click(show);
    const side = screen().getByRole("region", { name: "Próximos" });
    const rows = [...side.querySelectorAll<HTMLElement>(".ac-row")];
    expect(rows.length).toBeGreaterThan(0);
    expect(side.querySelector(".cal-upcoming__item, [data-source]")).toBeNull();
    for (const row of rows) {
      expect(row.querySelector(".ac-row__lead")).not.toBeNull();
      const title = row.querySelector(".ac-row__title");
      expect(title?.getAttribute("title")).toBe(title?.textContent ?? "");
    }
    expect(rows.some((r) => / · \d{2}:\d{2}$/.test(r.querySelector(".ac-row__meta")?.textContent ?? ""))).toBe(true);
  });

  test("an empty week keeps the grid with a quiet hint", async () => {
    await go();
    const show = screen().queryByRole("button", { name: "Mostrar painel" });
    if (show) await click(show);
    const filters = screen().getByRole("group", { name: "Filtros" });
    for (const b of within(filters).getAllByRole("button")) await click(b);
    await settle(2);
    expect(document.querySelectorAll(".cal-week__col")).toHaveLength(7);
    expect(screen().getByText("Nada marcado. Arraste para criar ou aperte N")).toBeTruthy();
  });
});
