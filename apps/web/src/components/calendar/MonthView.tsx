import { Popover } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type CalItem, onDay, sameDay } from "@/lib/calendar";
import { toYmd } from "@/lib/format";
import { dayLabel, EventChip } from "./EventChip";

/** Chips shown per day before "+N mais". */
const PER_DAY = 3;

/** Mês: 6 weeks; each day lists its first items and "+N mais" opens the rest in a popover. */
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
          const list = items
            .filter((it) => onDay(it, d))
            .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
          const shown = list.slice(0, PER_DAY);
          const rest = list.length - shown.length;
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
