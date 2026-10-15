import { appearanceStyle, Button, Icon, Popover } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useChannels } from "@/api/queries";
import type { RoutineTarget } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { useOrg } from "@/components/org-context";
import type { CalItem } from "@/lib/calendar";
import { formatTime } from "@/lib/format";
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

export const timeRange = (locale: string, it: CalItem) =>
  `${formatTime(locale, it.start.toISOString())}–${formatTime(locale, it.end.toISOString())}`;

/** "seg, 12 out". */
export const dayLabel = (locale: string, d: Date) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");

/**
 * One item on the calendar: a neutral card with a left color by source, the
 * recurrence icon and the agent's avatar. A click opens its details in a
 * popover anchored to it.
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
  const time = item.allDay ? t("calendar.allDay") : timeRange(i18n.language, item);
  const title =
    item.kind === "deadline" ? t("calendar.deadline", { number: item.issueNumber, title: item.title }) : item.title;
  const label =
    item.allDay || item.kind === "deadline"
      ? t("calendar.allDayAria", { title })
      : t("calendar.eventAria", { title: item.title, time });
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
          className={`cal-chip cal-chip--${variant}`}
          data-source={item.source}
          data-kind={item.kind}
          data-recurring={item.recurring || undefined}
          style={{ ...accent, ...style }}
          aria-label={label}
          aria-pressed={open}
          onPointerDown={onPointerDown}
        >
          {item.agentId && variant !== "line" && (
            <AgentAvatar agentId={item.agentId} size="xs" name="" className="cal-chip__avatar" />
          )}
          <span className="cal-chip__text">
            <span className="cal-chip__title">{title}</span>
            {variant === "block" && <span className="cal-chip__time tabular">{time}</span>}
            {variant === "line" && !item.allDay && (
              <span className="cal-chip__time tabular">{formatTime(i18n.language, item.start.toISOString())}</span>
            )}
          </span>
          {item.recurring && <Icon name="repeat" size={14} className="cal-chip__repeat" aria-hidden="true" />}
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
        {item.allDay ? ` · ${t("calendar.allDay")}` : ` · ${timeRange(i18n.language, item)}`}
      </span>
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
          <Link to="/org/$orgId/routines" params={{ orgId: org.id }} className="ac-link small">
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
