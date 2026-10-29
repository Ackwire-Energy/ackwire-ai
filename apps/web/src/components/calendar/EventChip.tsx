import type { RoutineTarget } from "@agenteschat/client";
import { useChannels } from "@agenteschat/client";
import type { CalItem } from "@agenteschat/client/lib/calendar";
import { formatTime } from "@agenteschat/client/lib/format";
import { appearanceStyle, Button, cx, Icon, Popover } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { useOrg } from "@/components/org-context";
import { lookOf } from "@/lib/look";

/** The chip's left color: only by source (person, the agent's own color, routine, due date). */
export function useAccent(item: CalItem): CSSProperties {
  const actors = useActors();
  if (item.source === "agent" || (item.source === "routine" && item.agentId)) {
    const look = lookOf(actors.dir.agentById.get(item.agentId ?? ""));
    const vars = appearanceStyle(look) as Record<string, string> | undefined;
    return { "--cal-accent": vars?.["--av-bottom"] ?? "var(--agent)" } as CSSProperties;
  }
  return {};
}

/** "09:00–10:00"; a routine run is a moment: "09:00". */
export const timeRange = (locale: string, it: CalItem) =>
  it.kind === "routine"
    ? formatTime(locale, it.start.toISOString())
    : `${formatTime(locale, it.start.toISOString())}–${formatTime(locale, it.end.toISOString())}`;

/** How often a routine band runs: "a cada hora", "a cada 15 min", "6× por dia". */
export function useCadence() {
  const { t } = useTranslation();
  return (it: CalItem) => {
    const every = it.every;
    if (every && every % 60 === 0)
      return every === 60 ? t("calendar.every.hour") : t("calendar.every.hours", { count: every / 60 });
    if (every) return t("calendar.every.minutes", { count: every });
    const spanDays = Math.max(1, Math.round((it.end.getTime() - it.start.getTime()) / 86_400_000));
    return t("calendar.perDay", { count: Math.round((it.runs?.length ?? 0) / spanDays) });
  };
}

/** "seg, 12 out". */
export const dayLabel = (locale: string, d: Date) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");

/**
 * One item on the calendar: a neutral card with a left color by source, the
 * recurrence icon and the agent's avatar (a routine band shows its cadence
 * instead of a time). A click opens its details in a popover.
 */
export function EventChip({
  item,
  variant,
  style,
  open,
  onOpenChange,
  details,
  onPointerDown,
  resizeHandle,
}: {
  item: CalItem;
  /** `block` in the hour grid, `bar` for all-day/multi-day, `line` in the month and lists. */
  variant: "block" | "bar" | "line";
  style?: CSSProperties;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: ReactNode;
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  resizeHandle?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const accent = useAccent(item);
  const cadence = useCadence();
  const band = Boolean(item.runs);
  const time = band ? cadence(item) : item.allDay ? t("calendar.allDay") : timeRange(i18n.language, item);
  const title =
    item.kind === "deadline" ? t("calendar.deadline", { number: item.issueNumber, title: item.title }) : item.title;
  const label =
    !band && (item.allDay || item.kind === "deadline")
      ? t("calendar.allDayAria", { title })
      : t("calendar.eventAria", { title: item.title, time });
  const face = variant !== "line" ? item.agentId : null;
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={title}
      side="right"
      align="start"
      className="cal-pop"
      trigger={
        <button
          type="button"
          className={cx("cal-chip", `cal-chip--${variant}`, face && "ac-iconline")}
          data-source={item.source}
          data-kind={item.kind}
          data-recurring={item.recurring || undefined}
          style={{ ...accent, ...style }}
          aria-label={label}
          aria-pressed={open}
          onPointerDown={onPointerDown}
        >
          {face && <AgentAvatar agentId={face} size="xs" name="" className="cal-chip__avatar" />}
          <span className="cal-chip__text">
            <span className="cal-chip__title">{title}</span>
            {variant === "block" && <span className="cal-chip__time tabular">{time}</span>}
            {variant === "line" && (band || !item.allDay) && (
              <span className="cal-chip__time tabular">
                {band ? time : formatTime(i18n.language, item.start.toISOString())}
              </span>
            )}
          </span>
          {item.recurring && !band && <Icon name="repeat" size={14} className="cal-chip__repeat" aria-hidden="true" />}
          {resizeHandle}
        </button>
      }
    >
      {details}
    </Popover>
  );
}

/** What the popover says about an item, with its actions. */
export function ItemDetails({ item, onEdit, onDelete }: { item: CalItem; onEdit?: () => void; onDelete?: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const cadence = useCadence();
  const channels = useChannels(org.id);
  const target = (tg: RoutineTarget) => {
    if (tg.type === "channel") return `#${channels.data?.find((c) => c.id === tg.channelId)?.name ?? ""}`;
    if (tg.type === "forum") return t("routines.target.forumShort");
    if (tg.type === "conversation") {
      const c = channels.data?.find((x) => x.id === tg.channelId);
      return c ? `#${c.name}` : t("routines.inConversation");
    }
    return t(tg.type === "dm" ? "routines.target.dmShort" : "routines.target.artifactShort");
  };
  return (
    <section className="cal-details" aria-label={item.title}>
      <span className="ac-eyebrow">
        {t(`calendar.kind.${item.kind}`)}
        {item.recurring && (
          <>
            {" · "}
            <Icon name="repeat" size={14} aria-hidden="true" /> {t("calendar.recurring")}
          </>
        )}
      </span>
      <span className="cal-details__title">
        {item.kind === "deadline"
          ? t("calendar.deadline", { number: item.issueNumber, title: item.title })
          : item.title}
      </span>
      <span className="small muted">
        {dayLabel(i18n.language, item.start)}
        {item.runs
          ? `${item.end.getTime() - item.start.getTime() > 86_400_000 ? ` – ${dayLabel(i18n.language, new Date(item.end.getTime() - 1))}` : ""} · ${cadence(item)}`
          : item.allDay
            ? ` · ${t("calendar.allDay")}`
            : ` · ${timeRange(i18n.language, item)}`}
      </span>
      {item.runs && <span className="small">{t("calendar.runs", { count: item.runs.length })}</span>}
      {item.location && (
        <span className="small cal-details__row">
          <Icon name="link" size={14} aria-hidden="true" />
          {/^https?:\/\//.test(item.location) ? (
            <a className="ac-link" href={item.location} target="_blank" rel="noreferrer">
              {item.location}
            </a>
          ) : (
            item.location
          )}
        </span>
      )}
      {item.description && <span className="small">{item.description}</span>}
      {item.kind === "routine" && item.target && (
        <span className="small">
          {t("calendar.routineDetail", {
            agent: actors.name({ type: "agent", id: item.agentId ?? "" }),
            target: target(item.target),
          })}
        </span>
      )}
      {item.kind === "deadline" && <span className="small">{t("calendar.deadlineDetail")}</span>}
      {item.people.length > 0 && (
        <ul className="cal-details__people">
          {item.people.map((p) => (
            <li key={`${p.type}:${p.id}`} className="actor-label">
              {actors.avatar(p)}
              <span>{actors.name(p)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="cal-details__actions">
        {item.kind === "deadline" && item.issueNumber !== undefined && (
          <Link
            to="/org/$orgId/issues/$number"
            params={{ orgId: org.id, number: String(item.issueNumber) }}
            className="ac-link small"
          >
            {t("calendar.openIssue")}
          </Link>
        )}
        {item.kind === "routine" && (
          <Link
            to="/org/$orgId/routines"
            params={{ orgId: org.id }}
            search={item.routineId ? { open: item.routineId } : {}}
            className="ac-link small"
          >
            {t("calendar.openRoutines")}
          </Link>
        )}
        {onDelete && (
          <Button size="sm" variant="ghost" icon="trash" onClick={onDelete}>
            {t("calendar.delete")}
          </Button>
        )}
        {onEdit && (
          <Button size="sm" variant="primary" icon="edit" onClick={onEdit}>
            {t("calendar.edit")}
          </Button>
        )}
      </div>
    </section>
  );
}
