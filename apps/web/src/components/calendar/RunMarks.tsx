import { Chip, type IconName, Popover, RunMark } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { useOrg } from "@/components/org-context";
import type { CalItem, RunSlot, RunStatus } from "@/lib/calendar";
import { formatTime, joinNames } from "@/lib/format";
import { lookOf } from "@/lib/look";

/** Marks drawn side by side in one slot; past that, "+N". */
export const MAX_MARKS = 3;

const RESULT_ICON: Record<RunStatus, IconName> = { ok: "check", silent: "dash", failed: "close", skipped: "wallet" };

/**
 * One hour's routine runs in the day/week grid: a pixel mark per run (in
 * its agent's tones, at most three, then "+N"), quiet next to the events.
 * Hover names them; a click (or Enter) opens the slot's runs in the
 * calendar's popover, each with its agent, time, how it went and a link to
 * the routine.
 */
export function RunMarks({
  slot,
  style,
  open,
  onOpenChange,
}: {
  slot: RunSlot;
  style?: CSSProperties;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const time = (it: CalItem) => formatTime(i18n.language, it.start.toISOString());
  const agentName = (it: CalItem) => actors.name({ type: "agent", id: it.agentId ?? "" });
  const colorOf = (it: CalItem) => lookOf(actors.dir.agentById.get(it.agentId ?? ""))?.color ?? "sky";
  const first = slot.runs[0] as CalItem;
  const shown = slot.runs.slice(0, MAX_MARKS);
  const extra = slot.runs.length - shown.length;
  const label =
    slot.runs.length === 1
      ? t("calendar.runAria", { name: first.title, time: time(first) })
      : t("calendar.runsAria", {
          count: slot.runs.length,
          time: time(first),
          names: joinNames(
            slot.runs.map((r) => r.title),
            t("newAgent.and"),
          ),
        });
  const heading = t("calendar.runsAt", { time: time(first) });
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={heading}
      side="right"
      align="start"
      className="cal-pop"
      trigger={
        <button
          type="button"
          className="cal-marks"
          style={style}
          aria-label={label}
          aria-pressed={open}
          title={slot.runs
            .map((r) => t("calendar.runHint", { name: r.title, agent: agentName(r), time: time(r) }))
            .join("\n")}
        >
          {shown.map((r) => (
            <RunMark key={r.key} color={colorOf(r)} status={r.result ?? "next"} />
          ))}
          {extra > 0 && <span className="cal-marks__more tabular">+{extra}</span>}
        </button>
      }
    >
      <section className="cal-details" aria-label={heading}>
        <span className="ac-eyebrow">{heading}</span>
        <ul className="cal-runs">
          {slot.runs.map((r) => {
            const status = r.result ?? r.lastResult;
            return (
              <li key={r.key} className="cal-runs__item">
                {r.agentId && <AgentAvatar agentId={r.agentId} size="xs" name="" className="cal-runs__avatar" />}
                <span className="cal-runs__text">
                  <b className="cal-runs__name">{r.title}</b>
                  <span className="small muted tabular">
                    {agentName(r)} · {time(r)}
                  </span>
                  <span className="cal-runs__foot">
                    {status && (
                      <Chip icon={RESULT_ICON[status]} tone={status === "ok" ? "done" : "neutral"}>
                        {r.result
                          ? t(`calendar.result.${status}`)
                          : t("calendar.lastResult", { result: t(`calendar.result.${status}`) })}
                      </Chip>
                    )}
                    {r.routineId && (
                      <Link
                        to="/org/$orgId/routines"
                        params={{ orgId: org.id }}
                        search={{ open: r.routineId }}
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
