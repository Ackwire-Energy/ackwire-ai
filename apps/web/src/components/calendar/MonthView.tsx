import { type CalItem, dayRuns, onDay, sameDay } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import { Popover } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dayLabel, EventChip } from "./EventChip";
import { dayRunsLabel, MAX_DAY_MARKS, RunMarks } from "./RunMarks";

/** Chips shown per day before "+N mais". */
const PER_DAY = 3;

/**
 * Mês: 6 weeks; each day lists its first events and "+N mais" opens the rest
 * in a popover; the day's routine runs are one row of pixel marks under them.
 */
export function MonthView({
  days,
  month,
  items,
  today,
  focusDay,
  openKey,
  onOpenKey,
  details,
  onFocusDay,
}: {
  days: Date[];
  month: number;
  items: CalItem[];
  today: Date;
  focusDay: Date;
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
  details: (item: CalItem) => ReactNode;
  onFocusDay: (d: Date) => void;
}) {
  const { t, i18n } = useTranslation();
  const weekdays = days.slice(0, 7);
  return (
    <section className="cal-month" aria-label={t("calendar.grid")}>
      <div className="cal-month__head">
        {weekdays.map((d) => (
          <span key={toYmd(d)} className="small muted">
            {new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d).replace(/\.$/, "")}
          </span>
        ))}
      </div>
      <div className="cal-month__grid">
        {days.map((d) => {
          // Routines are pixel marks under the events, not chips.
          const list = items
            .filter((it) => it.kind !== "routine" && onDay(it, d))
            .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
          const shown = list.slice(0, PER_DAY);
          const rest = list.length - shown.length;
          const runs = dayRuns(items, d);
          const runsKey = `runs-${toYmd(d)}`;
          return (
            <div
              key={toYmd(d)}
              className="cal-month__cell"
              data-day={toYmd(d)}
              data-other={d.getMonth() !== month || undefined}
              data-today={sameDay(d, today) || undefined}
            >
              <button
                type="button"
                className="cal-month__num tabular"
                aria-current={sameDay(d, today) ? "date" : undefined}
                aria-pressed={sameDay(d, focusDay)}
                aria-label={dayLabel(i18n.language, d)}
                onClick={() => onFocusDay(d)}
              >
                {d.getDate()}
              </button>
              {shown.map((it) => (
                <EventChip
                  key={it.key}
                  item={it}
                  variant="line"
                  open={openKey === it.key}
                  onOpenChange={(o) => onOpenKey(o ? it.key : null)}
                  details={details(it)}
                />
              ))}
              {runs.length > 0 && (
                <RunMarks
                  runs={runs}
                  heading={t("calendar.runsOn", { day: dayLabel(i18n.language, d) })}
                  label={dayRunsLabel(t, runs, dayLabel(i18n.language, d))}
                  max={MAX_DAY_MARKS}
                  side="bottom"
                  className="cal-month__marks"
                  open={openKey === runsKey}
                  onOpenChange={(o) => onOpenKey(o ? runsKey : null)}
                />
              )}
              {rest > 0 && (
                <Popover
                  label={dayLabel(i18n.language, d)}
                  side="bottom"
                  className="cal-more"
                  trigger={
                    <button type="button" className="cal-month__more">
                      {t("calendar.more", { count: rest })}
                    </button>
                  }
                >
                  <p className="cal-more__title">{dayLabel(i18n.language, d)}</p>
                  <div className="cal-more__list">
                    {list.map((it) => (
                      <EventChip
                        key={it.key}
                        item={it}
                        variant="line"
                        open={openKey === it.key}
                        onOpenChange={(o) => onOpenKey(o ? it.key : null)}
                        details={details(it)}
                      />
                    ))}
                  </div>
                </Popover>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
