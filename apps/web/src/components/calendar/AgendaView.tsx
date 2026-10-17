import { type CalItem, dayRuns, onDay, sameDay } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dayLabel, EventChip } from "./EventChip";
import { dayRunsLabel, MAX_DAY_MARKS, RunMarks } from "./RunMarks";

/**
 * Agenda: the next 30 days as a list, only the days with something. A day's
 * routine runs are one quiet line ("N execuções de rotinas" and their marks)
 * that opens them in a popover.
 */
export function AgendaView({
  days,
  items,
  today,
  openKey,
  onOpenKey,
  details,
}: {
  days: Date[];
  items: CalItem[];
  today: Date;
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
  details: (item: CalItem) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const groups = days
    .map((d) => ({
      d,
      list: items
        .filter((it) => it.kind !== "routine" && onDay(it, d))
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime()),
      runs: dayRuns(items, d),
    }))
    .filter((g) => g.list.length > 0 || g.runs.length > 0);
  if (groups.length === 0) return <p className="cal-agenda__empty muted">{t("calendar.agendaEmpty")}</p>;
  return (
    <div className="cal-agenda">
      {groups.map((g) => (
        <section key={toYmd(g.d)} className="cal-agenda__day" aria-label={dayLabel(i18n.language, g.d)}>
          <h2 className="cal-agenda__date" data-today={sameDay(g.d, today) || undefined}>
            <span className="cal-agenda__num tabular">{g.d.getDate()}</span>
            <span className="small muted">{dayLabel(i18n.language, g.d)}</span>
          </h2>
          <div className="cal-agenda__list">
            {g.list.map((it) => (
              <EventChip
                key={it.key}
                item={it}
                variant="line"
                open={openKey === it.key}
                onOpenChange={(o) => onOpenKey(o ? it.key : null)}
                details={details(it)}
              />
            ))}
            {g.runs.length > 0 && (
              <RunMarks
                runs={g.runs}
                heading={t("calendar.runsOn", { day: dayLabel(i18n.language, g.d) })}
                label={dayRunsLabel(t, g.runs, dayLabel(i18n.language, g.d))}
                text={t("calendar.runsCount", { count: g.runs.reduce((n, r) => n + r.count, 0) })}
                max={MAX_DAY_MARKS}
                side="bottom"
                className="cal-agenda__marks"
                open={openKey === `runs-${toYmd(g.d)}`}
                onOpenChange={(o) => onOpenKey(o ? `runs-${toYmd(g.d)}` : null)}
              />
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
