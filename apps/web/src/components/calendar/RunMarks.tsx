import type { CalItem, RunEntry, RunStatus } from "@agenteschat/client/lib/calendar";
import { formatTime, joinNames } from "@agenteschat/client/lib/format";
import { Chip, cx, type IconName, Popover, RunMark } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { useOrg } from "@/components/org-context";
import { lookOf } from "@/lib/look";

/** Marks drawn side by side in one hour slot of the day/week grid; past that, "+N". */
export const MAX_MARKS = 3;
/** Marks per day in the month and agenda views. */
export const MAX_DAY_MARKS = 6;
/** Width of the marks' lane on the right of a day column in the grid (events end before it). */
export const MARK_LANE_PX = 16;

/** A day's runs, named for the month/agenda button: "12 execuções de rotinas em <day>: A, B e C". */
export function dayRunsLabel(t: TFunction, runs: RunEntry[], day: string) {
  return t("calendar.dayRunsAria", {
    count: runs.reduce((n, r) => n + r.count, 0),
    day,
    names: joinNames([...new Set(runs.map((r) => r.item.title))], t("newAgent.and")),
  });
}

const RESULT_ICON: Record<RunStatus, IconName> = { ok: "check", silent: "dash", failed: "close", skipped: "wallet" };

/**
 * Routine runs as pixel marks: an hour's runs in the day/week grid, or a
 * day's in the month and agenda views. A mark per run (a frequent routine is
 * one mark with its count), in its agent's tones, up to `max`, then "+N".
 * Hover names them; a click (or Enter) opens them in the calendar's popover,
 * each with its agent, time, how it went and a link to the routine.
 */
export function RunMarks({
  runs,
  heading,
  label,
  text,
  max = MAX_MARKS,
  side = "right",
  className,
  style,
  open,
  onOpenChange,
}: {
  runs: RunEntry[];
  /** The popover's title; by default "Rotinas às <first run's time>". */
  heading?: string;
  /** The button's accessible name; by default it names the runs and their time. */
  label?: string;
  /** A quiet line before the marks (the agenda's "N execuções de rotinas"). */
  text?: string;
  max?: number;
  side?: "right" | "bottom";
  className?: string;
  style?: CSSProperties;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const time = (r: RunEntry) => formatTime(i18n.language, r.at.toISOString());
  const agentName = (it: CalItem) => actors.name({ type: "agent", id: it.agentId ?? "" });
  const colorOf = (it: CalItem) => lookOf(actors.dir.agentById.get(it.agentId ?? ""))?.color ?? "sky";
  const first = runs[0] as RunEntry;
  const shown = runs.slice(0, max);
  const extra = runs.length - shown.length;
  const title = heading ?? t("calendar.runsAt", { time: time(first) });
  const name =
    label ??
    (runs.length === 1
      ? t("calendar.runAria", { name: first.item.title, time: time(first) })
      : t("calendar.runsAria", {
          count: runs.length,
          time: time(first),
          names: joinNames(
            runs.map((r) => r.item.title),
            t("newAgent.and"),
          ),
        }));
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={title}
      side={side}
      align="start"
      className="cal-pop"
      trigger={
        <button
          type="button"
          className={className ? `cal-marks ${className}` : "cal-marks"}
          style={style}
          aria-label={name}
          aria-pressed={open}
          title={runs
            .map((r) => t("calendar.runHint", { name: r.item.title, agent: agentName(r.item), time: time(r) }))
            .join("\n")}
        >
          {text && <span className="cal-marks__text">{text}</span>}
          <span className="cal-marks__pixels">
            {shown.map((r) => (
              <RunMark key={r.key} color={colorOf(r.item)} status={r.status ?? "next"} />
            ))}
            {extra > 0 && <span className="cal-marks__more tabular">+{extra}</span>}
          </span>
        </button>
      }
    >
      <section className="cal-details" aria-label={title}>
        <span className="ac-eyebrow">{title}</span>
        <ul className="cal-runs">
          {runs.map((r) => {
            const it = r.item;
            const status = r.status ?? (r.count > 1 ? undefined : it.lastResult);
            return (
              <li key={r.key} className={cx("cal-runs__item", it.agentId && "ac-iconline")}>
                {it.agentId && <AgentAvatar agentId={it.agentId} size="xs" name="" />}
                <span className="cal-runs__text">
                  <b className="cal-runs__name">{it.title}</b>
                  <span className="small muted tabular">
                    {agentName(it)} · {time(r)}
                    {r.count > 1 && <> · {t("calendar.runTimes", { count: r.count })}</>}
                  </span>
                  <span className="cal-runs__foot">
                    {status && (
                      <Chip icon={RESULT_ICON[status]} tone={status === "ok" ? "done" : "neutral"}>
                        {r.status
                          ? t(`calendar.result.${status}`)
                          : t("calendar.lastResult", { result: t(`calendar.result.${status}`) })}
                      </Chip>
                    )}
                    {it.routineId && (
                      <Link
                        to="/org/$orgId/routines"
                        params={{ orgId: org.id }}
                        search={{ open: it.routineId }}
                        className="ac-link small"
                      >
                        {t("calendar.openRoutine")}
                      </Link>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </Popover>
  );
}
