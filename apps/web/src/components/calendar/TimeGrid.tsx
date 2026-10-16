import { Icon, Skeleton } from "@agenteschat/ui";
import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  addMinutes,
  type CalItem,
  dragRange,
  HOUR_PX,
  hourLabel,
  initialScrollMinutes,
  isRunMark,
  layoutBars,
  layoutDay,
  minutesOfDay,
  runSlots,
  SNAP_MIN,
  sameDay,
  shiftDays,
  uses12h,
  yToMinutes,
} from "@/lib/calendar";
import { toYmd } from "@/lib/format";
import { EventChip } from "./EventChip";
import { RoutineBand } from "./RoutineBand";
import { RunMarks } from "./RunMarks";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Movement before a press on a chip becomes a drag (px). */
const DRAG_SLOP = 4;

interface Gesture {
  kind: "create" | "move" | "resize";
  dayIndex: number;
  /** Pointer start (client px). */
  x0: number;
  y0: number;
  /** Create: y in the column. */
  colY0: number;
  colY1: number;
  item?: CalItem;
  dMin: number;
  dDay: number;
  moved: boolean;
}

/**
 * The day/week grid: hours 00:00–24:00 in a scroll area (opens around 07:00
 * or the first event), all-day and multi-day items as bars on top,
 * routines that run often as one band each (their runs as ticks), single
 * routine runs as small pixel marks at their time (a click lists them),
 * overlapping items side by side, today's column tinted with a filled day
 * pill, and the current-time line. Drag on empty space to create; drag a
 * chip to move it, its bottom edge to resize.
 */
export function TimeGrid({
  days,
  items,
  today,
  now,
  loading,
  focusDay,
  openKey,
  onOpenKey,
  details,
  onCreate,
  onMove,
  onFocusDay,
  emptyHint,
}: {
  days: Date[];
  items: CalItem[];
  today: Date;
  now: Date;
  loading: boolean;
  focusDay: Date;
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
  details: (item: CalItem) => ReactNode;
  onCreate: (range: { start: Date; end: Date }) => void;
  onMove: (item: CalItem, range: { start: Date; end: Date }) => void;
  onFocusDay: (d: Date) => void;
  emptyHint: string | null;
}) {
  const { t, i18n } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;
  const suppressClick = useRef(false);
  // Routines that run often get their own band under the all-day bars.
  const bars = layoutBars(
    items.filter((it) => !it.runs),
    days,
  );
  const bands = layoutBars(
    items.filter((it) => it.runs),
    days,
  );
  const lanes = Math.max(0, ...bars.map((b) => b.lane + 1));
  const bandLanes = Math.max(0, ...bands.map((b) => b.lane + 1));
  const cols = days.length;

  // Opens scrolled to ~07:00 or a little before the first event (once per set of days).
  const daysKey = days.map(toYmd).join(",");
  const scrolledFor = useRef("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll once per set of days, when items first arrive
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || loading || scrolledFor.current === daysKey) return;
    scrolledFor.current = daysKey;
    el.scrollTop = (initialScrollMinutes(items, days) / 60) * HOUR_PX;
  }, [daysKey, loading]);

  const colAt = (clientX: number, clientY: number) => {
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(clientX, clientY) : null;
    const col = hit?.closest<HTMLElement>("[data-col-index]");
    return col ? Number(col.dataset.colIndex) : null;
  };

  // Pointer moves and the release, wherever the pointer goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listen while a gesture lasts; the latest state is in a ref
  useEffect(() => {
    if (!gesture) return;
    const move = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      const moved = g.moved || Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP;
      if (g.kind === "create") {
        setGesture({ ...g, colY1: g.colY0 + dy, moved });
        return;
      }
      const dMin = Math.round(((dy / HOUR_PX) * 60) / SNAP_MIN) * SNAP_MIN;
      const over = g.kind === "move" ? colAt(e.clientX, e.clientY) : null;
      setGesture({ ...g, dMin, dDay: over === null ? g.dDay : over - g.dayIndex, moved });
    };
    const up = () => {
      const g = gestureRef.current;
      setGesture(null);
      if (!g) return;
      const day = days[g.dayIndex];
      if (!day) return;
      if (g.kind === "create") {
        onCreate(dragRange(day, g.colY0, g.moved ? g.colY1 : g.colY0));
        return;
      }
      if (!g.moved || !g.item) return;
      suppressClick.current = true;
      const it = g.item;
      if (g.kind === "move") {
        const start = addMinutes(shiftDays(it.start, g.dDay), g.dMin);
        onMove(it, { start, end: new Date(start.getTime() + (it.end.getTime() - it.start.getTime())) });
      } else {
        const end = addMinutes(it.end, g.dMin);
        onMove(it, { start: it.start, end: end > it.start ? end : addMinutes(it.start, SNAP_MIN) });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [gesture !== null]);

  const startCreate = (e: ReactPointerEvent<HTMLDivElement>, dayIndex: number) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setGesture({
      kind: "create",
      dayIndex,
      x0: e.clientX,
      y0: e.clientY,
      colY0: y,
      colY1: y,
      dMin: 0,
      dDay: 0,
      moved: false,
    });
  };
  const startMove = (e: ReactPointerEvent<HTMLElement>, item: CalItem, dayIndex: number, kind: "move" | "resize") => {
    if (e.button !== 0 || item.kind !== "event") return;
    e.stopPropagation();
    setGesture({
      kind,
      dayIndex,
      x0: e.clientX,
      y0: e.clientY,
      colY0: 0,
      colY1: 0,
      item,
      dMin: 0,
      dDay: 0,
      moved: false,
    });
  };

  const nowTop = (minutesOfDay(now) / 60) * HOUR_PX;
  return (
    <section
      className="cal-week"
      style={
        {
          "--hour-px": `${HOUR_PX}px`,
          "--cols": cols,
          "--lanes": lanes,
          // "12 PM" needs a little more room than "13:00".
          "--gutter": uses12h(i18n.language) ? "48px" : "44px",
        } as CSSProperties
      }
      aria-label={t("calendar.grid")}
      aria-busy={loading || undefined}
    >
      <div className="cal-week__head">
        <div className="cal-week__gutter" />
        {days.map((d) => {
          const isToday = sameDay(d, today);
          return (
            <div key={toYmd(d)} className="cal-week__day" data-today={isToday || undefined}>
              <button
                type="button"
                className="cal-week__daybtn"
                aria-current={isToday ? "date" : undefined}
                aria-pressed={sameDay(d, focusDay)}
                onClick={() => onFocusDay(d)}
              >
                <span className="cal-week__dow">
                  {new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d).replace(/\.$/, "")}
                </span>
                <span className="cal-week__num tabular">{d.getDate()}</span>
              </button>
            </div>
          );
        })}
      </div>
      {lanes > 0 && (
        <div className="cal-week__bars">
          <div className="cal-week__gutter small muted">{t("calendar.allDay")}</div>
          <div className="cal-week__barlane">
            {bars.map((b) => (
              <EventChip
                key={b.item.key}
                item={b.item}
                variant="bar"
                style={{
                  gridColumn: `${b.from + 1} / span ${b.span}`,
                  gridRow: b.lane + 1,
                }}
                open={openKey === b.item.key}
                onOpenChange={(o) => onOpenKey(o ? b.item.key : null)}
                details={details(b.item)}
              />
            ))}
          </div>
        </div>
      )}
      {bandLanes > 0 && (
        <div className="cal-week__bars cal-week__bars--routines">
          <div className="cal-week__gutter cal-week__gutter--top muted" title={t("calendar.filter.routine")}>
            <Icon name="routines" size={14} label={t("calendar.filter.routine")} />
          </div>
          <div className="cal-week__barlane">
            {[...bands]
              .sort((a, b) => a.from - b.from || a.item.title.localeCompare(b.item.title))
              .map((b, row) => (
                <RoutineBand
                  key={b.item.key}
                  item={b.item}
                  now={now}
                  // One row per routine across the week (names line up on the left); the line covers its days.
                  track={{ from: b.from, span: b.span, cols }}
                  style={{ gridColumn: "1 / -1", gridRow: row + 1 }}
                  open={openKey === b.item.key}
                  onOpenChange={(o) => onOpenKey(o ? b.item.key : null)}
                  details={details(b.item)}
                />
              ))}
          </div>
        </div>
      )}
      <div className="cal-week__scroll" ref={scroller}>
        <div className="cal-week__body">
          <div className="cal-week__hours" aria-hidden="true">
            {HOURS.map((h) => (
              <div key={h} className="cal-week__hour">
                {h > 0 && <span className="cal-week__hour-label tabular">{hourLabel(i18n.language, h)}</span>}
              </div>
            ))}
          </div>
          {days.map((d, i) => {
            const placed = layoutDay(
              items.filter((it) => !isRunMark(it)),
              d,
            );
            const slots = runSlots(items, d);
            const isToday = sameDay(d, today);
            const ghost =
              gesture?.kind === "create" && gesture.dayIndex === i
                ? dragRange(d, gesture.colY0, gesture.moved ? gesture.colY1 : gesture.colY0)
                : null;
            return (
              <div
                key={toYmd(d)}
                className="cal-week__col"
                data-day={toYmd(d)}
                data-col-index={i}
                data-today={isToday || undefined}
                onPointerDown={(e) => startCreate(e, i)}
              >
                {loading && i % 2 === 1 && (
                  <Skeleton
                    shape="block"
                    className="cal-chip cal-chip--skeleton"
                    style={{ top: (9 + i) * HOUR_PX + 2, height: HOUR_PX - 4 }}
                  />
                )}
                {placed.map((p) => {
                  const g = gesture && gesture.item?.key === p.item.key && gesture.moved ? gesture : null;
                  const top = p.top + (g?.kind === "move" ? g.dMin : 0);
                  const height = Math.max(SNAP_MIN, p.height + (g?.kind === "resize" ? g.dMin : 0));
                  return (
                    <EventChip
                      key={p.item.key}
                      item={p.item}
                      variant="block"
                      style={{
                        top: (top / 60) * HOUR_PX + 1,
                        height: Math.max(20, (height / 60) * HOUR_PX - 2),
                        left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                        width: `calc(${100 / p.cols}% - 4px)`,
                        ...(g?.kind === "move" && g.dDay
                          ? { transform: `translateX(calc(${g.dDay * 100}% * ${p.cols}))` }
                          : {}),
                      }}
                      open={openKey === p.item.key && !gesture}
                      onOpenChange={(o) => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        onOpenKey(o ? p.item.key : null);
                      }}
                      details={details(p.item)}
                      onPointerDown={(e) => startMove(e, p.item, i, "move")}
                      resizeHandle={
                        p.item.kind === "event" ? (
                          <span
                            className="cal-chip__resize"
                            aria-hidden="true"
                            onPointerDown={(e) => startMove(e, p.item, i, "resize")}
                          />
                        ) : null
                      }
                    />
                  );
                })}
                {slots.map((slot) => (
                  <RunMarks
                    key={slot.key}
                    slot={slot}
                    style={{ top: (slot.top / 60) * HOUR_PX + 2 }}
                    open={openKey === slot.key && !gesture}
                    onOpenChange={(o) => onOpenKey(o ? slot.key : null)}
                  />
                ))}
                {ghost && (
                  <div
                    className="cal-week__ghost"
                    style={{
                      top: (minutesOfDay(ghost.start) / 60) * HOUR_PX,
                      height:
                        ((ghost.end.getTime() - ghost.start.getTime()) / 3_600_000) * HOUR_PX ||
                        (yToMinutes(HOUR_PX / 2) / 60) * HOUR_PX,
                    }}
                    aria-hidden="true"
                  />
                )}
                {isToday && (
                  <div className="cal-week__now" style={{ top: nowTop }} title={t("calendar.now")} aria-hidden="true" />
                )}
              </div>
            );
          })}
          {emptyHint && (
            <p className="cal-week__empty" role="status">
              {emptyHint}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
