import { describe, expect, test } from "bun:test";
import {
  type CalItem,
  dragRange,
  HOUR_PX,
  initialScrollMinutes,
  layoutBars,
  layoutDay,
  rangeLabel,
  viewDays,
} from "@/lib/calendar";

const day = new Date(2026, 9, 14);
const at = (h: number, m = 0, d = day) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
const item = (key: string, start: Date, end: Date, allDay = false): CalItem => ({
  key,
  kind: "event",
  source: "person",
  title: key,
  start,
  end,
  allDay,
  recurring: false,
  people: [],
});

describe("calendar layout", () => {
  test("overlapping events sit side by side; a later one gets the full width again", () => {
    const placed = layoutDay(
      [
        item("a", at(9), at(10)),
        item("b", at(9, 30), at(11)),
        item("c", at(10), at(10, 30)),
        item("d", at(14), at(15)),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((p) => [p.item.key, [p.col, p.cols, p.top, p.height]]));
    expect(by).toEqual({
      a: [0, 2, 540, 60],
      b: [1, 2, 570, 90],
      c: [0, 2, 600, 30],
      d: [0, 1, 840, 60],
    });
  });

  test("all-day and multi-day items become bars in lanes", () => {
    const days = viewDays("week", day);
    const bars = layoutBars(
      [
        item("trip", at(0, 0, days[1] as Date), at(0, 0, days[4] as Date), true),
        item("deadline", at(0, 0, days[2] as Date), at(0, 0, days[3] as Date), true),
        item("late", at(22, 0, days[5] as Date), at(2, 0, days[6] as Date)),
      ],
      days,
    );
    expect(bars.map((b) => [b.item.key, b.from, b.span, b.lane])).toEqual([
      ["trip", 1, 3, 0],
      ["deadline", 2, 1, 1],
      ["late", 5, 2, 0],
    ]);
  });

  test("drag to create: snapped to 15 minutes; a click gives 30 minutes", () => {
    const r = dragRange(day, 9 * HOUR_PX + 5, 10.5 * HOUR_PX + 3);
    expect([r.start.getHours(), r.start.getMinutes(), r.end.getHours(), r.end.getMinutes()]).toEqual([9, 0, 10, 30]);
    const click = dragRange(day, 14 * HOUR_PX, 14 * HOUR_PX);
    expect([click.start.getHours(), click.end.getHours(), click.end.getMinutes()]).toEqual([14, 14, 30]);
  });

  test("the grid opens around 07:00, or a little before an earlier event", () => {
    expect(initialScrollMinutes([], [day])).toBe(7 * 60);
    expect(initialScrollMinutes([item("early", at(6), at(7))], [day])).toBe(5 * 60 + 30);
  });

  test("week of 7 days, or only business days; the header range", () => {
    expect(viewDays("week", day)).toHaveLength(7);
    expect(viewDays("week", day, true).map((d) => d.getDay())).toEqual([1, 2, 3, 4, 5]);
    const week = rangeLabel("pt-BR", "week", viewDays("week", day), day);
    expect(week).toContain("12");
    expect(week).toContain("18");
    expect(week).toContain("2026");
    expect(rangeLabel("pt-BR", "month", [], day)).toBe("outubro de 2026");
  });
});

describe("hour labels", () => {
  test("12-hour locales: 1 AM … 12 PM; 24-hour: 01:00 … 23:00", async () => {
    const { hourLabel, uses12h } = await import("@/lib/calendar");
    expect(uses12h("en")).toBe(true);
    expect(uses12h("pt-BR")).toBe(false);
    expect([1, 12, 13].map((h) => hourLabel("en", h).replace(/\s/g, " "))).toEqual(["1 AM", "12 PM", "1 PM"]);
    expect([1, 13, 23].map((h) => hourLabel("pt-BR", h))).toEqual(["01:00", "13:00", "23:00"]);
  });
});
