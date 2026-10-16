import { Popover, RunLane } from "@agenteschat/ui";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import type { CalItem } from "@/lib/calendar";
import { lookOf } from "@/lib/look";
import { useCadence } from "./EventChip";

/**
 * A routine that runs often, as its lane on the Rotinas horizon: the name
 * and cadence on top, then the dotted line over its days, past runs as
 * pixel columns, future runs as pixels and the next one as the agent's
 * sprite. A click opens its details.
 */
export function RoutineBand({
  item,
  now,
  style,
  open,
  onOpenChange,
  details,
}: {
  item: CalItem;
  /** The view's wall clock. */
  now: Date;
  style?: CSSProperties;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: ReactNode;
}) {
  const { t } = useTranslation();
  const actors = useActors();
  const cadence = useCadence()(item);
  const look = lookOf(actors.dir.agentById.get(item.agentId ?? ""));
  const past = (item.pastRuns ?? []).filter((r) => r.at >= item.start && r.at <= now);
  const future = (item.runs ?? []).filter((r) => r > now);
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={item.title}
      side="bottom"
      align="start"
      className="cal-pop"
      trigger={
        <button
          type="button"
          className="cal-band"
          style={style}
          aria-label={t("calendar.eventAria", { title: item.title, time: cadence })}
          aria-pressed={open}
        >
          <span className="cal-band__label">
            {item.agentId && <AgentAvatar agentId={item.agentId} size="xs" name="" />}
            <b>{item.title}</b>
            <span className="cal-band__cadence">{cadence}</span>
          </span>
          <span className="cal-band__track" aria-hidden="true">
            <RunLane
              from={item.start}
              to={item.end}
              now={now}
              past={past}
              future={future}
              color={look?.color ?? "sky"}
              eyes={look?.eyes ?? "round"}
              running={item.running}
            />
          </span>
        </button>
      }
    >
      {details}
    </Popover>
  );
}
