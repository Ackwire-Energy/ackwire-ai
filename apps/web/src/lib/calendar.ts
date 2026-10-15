import type { Actor, CalendarRange, RoutineTarget } from "@/api/types";

/** Pixels per hour in the day/week grid. */
export const HOUR_PX = 44;
/** Snap for drag-to-create, move and resize. */
export const SNAP_MIN = 15;

export type CalendarView = "day" | "week" | "month" | "agenda";
/** Where an item comes from (its left color). */
export type ItemSource = "person" | "agent" | "routine" | "deadline";

export interface CalItem {
  key: string;
  kind: "event" | "routine" | "deadline";
  source: ItemSource;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean;
  /** The agent behind it (agent events, routines): its avatar and color. */
  agentId?: string;
  eventId?: string;
  seriesId?: string | null;
  occurrenceStart?: string | null;
  routineId?: string;
  issueId?: string;
  issueNumber?: number;
  people: Actor[];
  description?: string;
  location?: string | null;
  target?: RoutineTarget;
}

// ── Dates (local days) ──────────────────────────────────────────────────────

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
export function mondayOf(d: Date) {
  return addDays(startOfDay(d), -((d.getDay() + 6) % 7));
}
export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
export const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

/** The days a view shows around `focus`. */
export function viewDays(view: CalendarView, focus: Date, businessOnly = false): Date[] {
  if (view === "day") return [startOfDay(focus)];
  if (view === "week") {
    const monday = mondayOf(focus);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => !businessOnly || !isWeekend(d));
  }
  if (view === "month") {
    const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
    const start = mondayOf(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }
  return Array.from({ length: 30 }, (_, i) => addDays(startOfDay(focus), i));
}

/** The range to fetch for a view: [from, to). */
export function viewRange(view: CalendarView, focus: Date): { from: Date; to: Date } {
  if (view === "day") return { from: startOfDay(focus), to: addDays(startOfDay(focus), 1) };
  if (view === "week") return { from: mondayOf(focus), to: addDays(mondayOf(focus), 7) };
  const days = viewDays(view, focus);
  return { from: days[0] as Date, to: addDays(days[days.length - 1] as Date, 1) };
}

/** Moves the focus one step of the view (−1 / +1). */
export function stepFocus(view: CalendarView, focus: Date, dir: number): Date {
  if (view === "day") return addDays(focus, dir);
  if (view === "week") return addDays(focus, 7 * dir);
  if (view === "month") return new Date(focus.getFullYear(), focus.getMonth() + dir, 1);
  return addDays(focus, 30 * dir);
}

/** "12–18 de outubro de 2026", "28 de setembro – 4 de outubro de 2026", "outubro de 2026". */
export function rangeLabel(locale: string, view: CalendarView, days: Date[], focus: Date) {
  if (view === "month") return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(focus);
  const first = days[0] ?? focus;
  const last = days[days.length - 1] ?? focus;
  if (view === "day")
    return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
      first,
    );
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).formatRange(first, last);
  } catch {
    const f = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" });
    return `${f.format(first)} – ${f.format(last)}`;
  }
}

// ── Items ───────────────────────────────────────────────────────────────────

/** Range data → items (events, routine runs, issue due dates). */
export function toItems(range: CalendarRange | undefined): CalItem[] {
  if (!range) return [];
  return [
    ...range.events.map((e): CalItem => {
      const agentAuthor = e.createdBy.type === "agent";
      // All-day: the days themselves (`endDate` inclusive), never shifted by a zone.
      const fromDay = (ymd: string) => {
        const [y, m, d] = ymd.split("-").map(Number);
        return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1);
      };
      const start = e.allDay && e.startDate ? fromDay(e.startDate) : new Date(e.start);
      const end =
        e.allDay && e.endDate
          ? addDays(fromDay(e.endDate), 1)
          : e.allDay
            ? startOfDay(new Date(e.end))
            : new Date(e.end);
      return {
        key: e.occurrenceStart ? `${e.seriesId ?? e.id}@${e.occurrenceStart}` : e.id,
        kind: "event",
        source: agentAuthor ? "agent" : "person",
        title: e.title,
        start,
        end: end > start ? end : addMinutes(start, 30),
        allDay: e.allDay,
        recurring: Boolean(e.rule && e.rule.freq !== "once") || e.recurrence !== "none" || Boolean(e.seriesId),
        agentId: agentAuthor ? e.createdBy.id : undefined,
        eventId: e.id,
        seriesId: e.seriesId ?? null,
        occurrenceStart: e.occurrenceStart ?? null,
        people: e.participants,
        description: e.description,
        location: e.location ?? null,
      };
    }),
    ...range.routines.map(
      (r): CalItem => ({
        key: `${r.routineId}@${r.at}`,
        kind: "routine",
        source: "routine",
        title: r.name,
        start: new Date(r.at),
        end: addMinutes(new Date(r.at), 30),
        allDay: false,
        recurring: true,
        agentId: r.agentId,
        routineId: r.routineId,
        people: [{ type: "agent", id: r.agentId }],
        target: r.target,
      }),
    ),
    ...range.deadlines.map((d): CalItem => {
      const [y, m, day] = d.date.split("-").map(Number);
      const start = new Date(y ?? 2000, (m ?? 1) - 1, day ?? 1);
      return {
        key: `deadline-${d.issueId}`,
        kind: "deadline",
        source: "deadline",
        title: d.title,
        start,
        end: addDays(start, 1),
        allDay: true,
        recurring: false,
        issueId: d.issueId,
        issueNumber: d.number,
        people: [],
      };
    }),
  ];
}

/** All-day, or crossing midnight: drawn as a bar above the hour grid. */
export const isBarItem = (it: CalItem) =>
  it.allDay || it.end.getTime() - startOfDay(it.start).getTime() > 86_400_000 + 60_000;

/** Whether an item touches a day. */
export const onDay = (it: CalItem, d: Date) => it.start < addDays(startOfDay(d), 1) && it.end > startOfDay(d);

// ── Layout ──────────────────────────────────────────────────────────────────

export interface Placed {
  item: CalItem;
  /** Minutes from midnight (clipped to the day). */
  top: number;
  height: number;
  /** Side by side when overlapping: column and how many share the cluster. */
  col: number;
  cols: number;
}

/**
 * Timed items of one day laid out side by side when they overlap: each
 * cluster of overlapping items splits the width into as many columns as it
 * needs (greedy, by start).
 */
export function layoutDay(items: CalItem[], day: Date): Placed[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86_400_000;
  const timed = items
    .filter((it) => !isBarItem(it) && onDay(it, day))
    .map((item) => {
      const s = Math.max(item.start.getTime(), dayStart);
      const e = Math.min(Math.max(item.end.getTime(), s + 15 * 60_000), dayEnd);
      return { item, s, e };
    })
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out: Placed[] = [];
  let cluster: { item: CalItem; s: number; e: number; col: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster)
      out.push({
        item: c.item,
        top: (c.s - dayStart) / 60_000,
        height: (c.e - c.s) / 60_000,
        col: c.col,
        cols,
      });
    cluster = [];
  };
  for (const t of timed) {
    if (cluster.length > 0 && t.s >= clusterEnd) flush();
    const colEnds: number[] = [];
    for (const c of cluster) colEnds[c.col] = Math.max(colEnds[c.col] ?? 0, c.e);
    let col = colEnds.findIndex((end) => end <= t.s);
    if (col < 0) col = colEnds.length;
    cluster.push({ ...t, col });
    clusterEnd = Math.max(clusterEnd, t.e);
  }
  if (cluster.length > 0) flush();
  return out;
}

export interface Bar {
  item: CalItem;
  /** First visible day index and how many days it covers. */
  from: number;
  span: number;
  lane: number;
}

/** All-day and multi-day items as bars over the visible days, stacked in lanes. */
export function layoutBars(items: CalItem[], days: Date[]): Bar[] {
  const bars: Bar[] = [];
  const lanes: number[][] = [];
  const sorted = items.filter(isBarItem).sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const item of sorted) {
    const idx = days.map((d, i) => (onDay(item, d) ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) continue;
    const from = idx[0] as number;
    const span = (idx[idx.length - 1] as number) - from + 1;
    let lane = lanes.findIndex((used) => used.every((u) => u < from || u >= from + span));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    for (let i = from; i < from + span; i++) lanes[lane]?.push(i);
    bars.push({ item, from, span, lane });
  }
  return bars;
}

/** A y offset in the grid (px) → minutes from midnight, snapped. */
export function yToMinutes(y: number, hourPx = HOUR_PX, snap = SNAP_MIN) {
  const min = (Math.max(0, y) / hourPx) * 60;
  return Math.min(24 * 60, Math.round(min / snap) * snap);
}

/**
 * A drag in a day column (from y0 to y1, px) → the new event's time range.
 * A click without a drag gives 30 minutes from where it was clicked.
 */
export function dragRange(day: Date, y0: number, y1: number, hourPx = HOUR_PX) {
  const a = yToMinutes(Math.min(y0, y1), hourPx);
  const b = yToMinutes(Math.max(y0, y1), hourPx);
  const startMin = Math.min(a, 24 * 60 - SNAP_MIN * 2);
  const endMin = b - a < SNAP_MIN ? startMin + 30 : b;
  const base = startOfDay(day);
  return { start: addMinutes(base, startMin), end: addMinutes(base, Math.min(endMin, 24 * 60)) };
}

/** Where the week opens: around 07:00, or a little before the first timed item. */
export function initialScrollMinutes(items: CalItem[], days: Date[]) {
  const firsts = days.flatMap((d) => layoutDay(items, d).map((p) => p.top));
  const first = firsts.length ? Math.min(...firsts) : 7 * 60;
  return Math.max(0, Math.min(7 * 60, first - 30));
}

/** The next `n` items from `now` (for "Próximos"). */
export function upcomingItems(items: CalItem[], now: Date, n = 5) {
  return items
    .filter((it) => it.kind !== "deadline" && it.end > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, n);
}
