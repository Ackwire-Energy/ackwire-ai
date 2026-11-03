import { type HTMLAttributes, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { cx } from "../cx";
import { useDarkTheme } from "../hooks/useDarkTheme";
import { Icon } from "../icons/Icon";
import type { WidgetSpec, WidgetStatus } from "./spec";
import { widgetTileVars } from "./tiles";
import { WidgetBody } from "./WidgetBody";

/** "Organize" on a board: the size button, remove, and the grip to drag (or move with the arrow keys). */
export interface WidgetOrganize {
  /** "Size". */
  sizeLabel: string;
  /** The size now: "S", "M", "L". */
  sizeText: string;
  removeLabel: string;
  /** "Drag to move". */
  dragLabel: string;
  onSize: () => void;
  onRemove: () => void;
  /** The grip's arrow keys: one place earlier (-1) or later (1). Without it, the grip is only for the pointer. */
  onMove?: (delta: -1 | 1) => void;
}

export type WidgetCardProps = {
  title: string;
  spec: WidgetSpec | null;
  status: WidgetStatus;
  /** The agent who looks after it: its color, as `AgentAvatar` takes it. */
  color: string;
  size: { w: 1 | 2; h: 1 | 2 };
  locale: string;
  /** Under the body: who updated it and when, "updating…", or why it failed with Resolve. */
  footer: ReactNode;
  buildingText?: string;
  /** The head's own buttons (Update now, its menu), shown on hover and focus. */
  actions?: ReactNode;
  /** The title opens the widget (its panel). */
  onOpen?: () => void;
  /** On a board in Organize: its controls in place of `actions`. */
  organize?: WidgetOrganize | null;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "title" | "color">;

const FLASH_MS = 1200;

/**
 * A widget on a board (ADR 0134): a neutral card with the cut corner, its title, the block it shows, and a footer.
 * A refresh draws a dither sweep along its top edge and dims the last data under it; new data flashes once in the
 * agent's tone and a number counts up to it. A failure greys the last data out.
 */
export function WidgetCard({
  title,
  spec,
  status,
  color,
  size,
  locale,
  footer,
  buildingText,
  actions,
  onOpen,
  organize,
  className,
  style,
  ...rest
}: WidgetCardProps) {
  const dark = useDarkTheme();
  const flash = useFlash(spec);
  const grip = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta =
      e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
    if (!delta || !organize?.onMove) return;
    e.preventDefault();
    organize.onMove(delta);
  };
  return (
    <article
      className={cx("ac-card wg", className)}
      data-state={status}
      data-w={size.w}
      data-h={size.h}
      data-organize={organize ? "" : undefined}
      aria-label={title}
      aria-busy={status === "building" || status === "updating" || undefined}
      style={{ ...widgetTileVars(color, dark), ...style }}
      {...rest}
    >
      <span className="wg__sweep" aria-hidden="true" />
      <div className="wg__head">
        {onOpen && !organize ? (
          <button type="button" className="wg__title" onClick={onOpen}>
            {title}
          </button>
        ) : (
          <span className="wg__title">{title}</span>
        )}
        {organize ? (
          <span className="wg__arr">
            <button
              type="button"
              className="wg__size"
              aria-label={`${organize.sizeLabel}: ${organize.sizeText}`}
              title={organize.sizeLabel}
              onClick={organize.onSize}
            >
              {organize.sizeText}
            </button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="close"
              aria-label={organize.removeLabel}
              title={organize.removeLabel}
              onClick={organize.onRemove}
            />
            {organize.onMove ? (
              <button
                type="button"
                className="wg__grip"
                aria-label={organize.dragLabel}
                title={organize.dragLabel}
                onKeyDown={grip}
              >
                <Icon name="grip" size={16} />
              </button>
            ) : (
              <span className="wg__grip" title={organize.dragLabel}>
                <Icon name="grip" size={16} />
              </span>
            )}
          </span>
        ) : (
          actions && <span className="wg__acts">{actions}</span>
        )}
      </div>
      <div className={cx("wg__body", flash && "wg__flash")}>
        <WidgetBody
          spec={spec}
          status={status}
          color={color}
          size={size}
          locale={locale}
          buildingText={buildingText}
        />
      </div>
      <div className="wg__foot">{footer}</div>
    </article>
  );
}

/** True for a moment after the data changed (not on the first draw). */
function useFlash(spec: WidgetSpec | null): boolean {
  const key = spec ? JSON.stringify(spec) : "";
  const before = useRef(key);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (before.current === key) return;
    const had = before.current !== "";
    before.current = key;
    if (!had || !key) {
      setOn(false);
      return;
    }
    setOn(true);
    const timer = setTimeout(() => setOn(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return on;
}

/** The board's last cell: "+ Widget", a dashed tile with the cut corner (`label` names it for screen readers). */
export function WidgetAddTile({ text, label, onClick }: { text: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className="wg-add" aria-label={label} title={label} onClick={onClick}>
      <Icon name="plus" size={18} />
      {text}
    </button>
  );
}
