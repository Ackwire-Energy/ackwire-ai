import { type HTMLAttributes, type MouseEvent, type ReactNode, useId, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { MenuAt } from "./Menu";

export interface MessageProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** The avatar element. Omitted for grouped (continuation) messages. */
  avatar?: ReactNode;
  author: ReactNode;
  time: ReactNode;
  /**
   * Details behind the time, never in the header: "terça-feira, 14 de outubro
   * às 21:10 · sonnet 5.5 · 1.240 tokens · US$ 0,004". Shown in a tooltip on
   * hover or keyboard focus of the time (and read by screen readers).
   */
  meta?: ReactNode;
  /**
   * A faint word next to the time with a glass tip that says why (on hover
   * or keyboard focus): "entrou na conversa" on a reply nobody asked for.
   */
  note?: { label: ReactNode; tip: ReactNode };
  /** A person-facing state on the header line, with an icon (or a `mark`, e.g. a PixelSpinner): "enviando…". */
  status?: { icon?: IconName; mark?: ReactNode; label: ReactNode };
  /** A new row: slides in (opacity/transform only; none with reduced motion). */
  entering?: boolean;
  /** Same author as the previous message: hide avatar and header (text keeps its column). */
  grouped?: boolean;
  /** Agent still writing: adds the `agent` cursor at the end of the text. */
  streaming?: boolean;
  agent?: boolean;
  /** The message text (use `MessageText`), plus attachments or cards. */
  children: ReactNode;
  /** Wraps the body in a column with gaps (approval cards). */
  stacked?: boolean;
  /** Muted, at the end of the first line, the header's or a grouped message's text's (e.g. the receipt check). */
  aside?: ReactNode;
  /** A line under the message, the same on a first and a grouped one (e.g. a receipt with words). */
  foot?: ReactNode;
  /**
   * The row's actions on touch, which has no hover: a tap on the row (not on a link or a button in it) opens these
   * items (`MenuReactions`, `MenuItem`…) in a menu beside the row, under it or over it, never on its text, and lights
   * the row while it is open. A mouse or a keyboard gets the row's bar (`.ac-msg__actions`) instead.
   */
  menu?: { label: string; items: ReactNode };
}

/** Taps on these keep doing their own thing (no menu opens). */
const INTERACTIVE = "a[href], button, input, textarea, select, label, summary, [role='button'], [tabindex='0']";

/** The touch menu's height with a person's actions: with less room over and under the row, it opens at the tap. */
const MENU_ROOM = 240;

/** Where a tap opens the row's menu: beside the row's part on screen, or at the tap. Null: not a touch tap on it. */
function menuPlace(e: MouseEvent<HTMLElement>) {
  if (typeof window.matchMedia !== "function") return null;
  if (!(navigator.maxTouchPoints > 0) || !window.matchMedia("(hover: none)").matches) return null;
  const row = e.currentTarget;
  // The menu's own taps bubble here through its portal.
  if (!(e.target instanceof Element) || !row.contains(e.target)) return null;
  if (e.target !== row && e.target.closest(INTERACTIVE)) return null;
  const box = row.getBoundingClientRect();
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  if (Math.max(top, window.innerHeight - bottom) < MENU_ROOM) return { x: e.clientX, y: e.clientY };
  return { x: box.left, y: top, width: box.width, height: bottom - top };
}

/** A chat line: avatar, author, time and text. Agents are told apart by the avatar only. */
export function Message({
  avatar,
  author,
  time,
  meta,
  note,
  status,
  entering,
  grouped,
  streaming,
  agent,
  children,
  stacked,
  aside,
  foot,
  menu,
  className,
  onClick,
  ...rest
}: MessageProps) {
  const tipId = useId();
  const noteId = useId();
  const [menuAt, setMenuAt] = useState<ReturnType<typeof menuPlace>>(null);
  const tip = meta ? (
    <span className="ac-msg__meta ac-msg__tip" role="tooltip" id={tipId}>
      {meta}
    </span>
  ) : null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tap opens on touch what the row's bar has for a keyboard
    <article
      className={cx(
        "ac-msg",
        agent && "ac-msg--agent",
        grouped && "ac-msg--grouped",
        streaming && "ac-msg--streaming",
        entering && "ac-msg--enter",
        className,
      )}
      aria-busy={streaming || undefined}
      data-menu-open={menuAt ? "true" : undefined}
      onClick={(e) => {
        onClick?.(e);
        const place = menu ? menuPlace(e) : null;
        if (place) setMenuAt(place);
      }}
      {...rest}
    >
      {grouped ? (
        // Same width as the avatar column; the time shows here on hover (it's also in the hidden header).
        <span className="ac-msg__gutter" aria-hidden="true">
          <span className="ac-msg__gutter-time">
            {time}
            {meta && <span className="ac-msg__tip">{meta}</span>}
          </span>
        </span>
      ) : (
        <span className="ac-msg__avatar">{avatar}</span>
      )}
      <div className="ac-msg__body" style={stacked ? { display: "flex", flexDirection: "column", gap: 8 } : undefined}>
        <div className={grouped ? "ac-visually-hidden" : "ac-msg__head"}>
          <span className="ac-msg__author">{author}</span>
          {meta ? (
            // Focusable so the details are reachable without a mouse.
            <span className="ac-msg__time ac-msg__time--details" tabIndex={grouped ? -1 : 0} aria-describedby={tipId}>
              {time}
              {tip}
            </span>
          ) : (
            <span className="ac-msg__time">{time}</span>
          )}
          {note && (
            // Focusable so the reason is reachable without a mouse.
            <span className="ac-msg__note" tabIndex={grouped ? -1 : 0} aria-describedby={noteId}>
              {note.label}
              <span className="ac-msg__note-tip ac-glass" role="tooltip" id={noteId}>
                {note.tip}
              </span>
            </span>
          )}
          {status && (
            <span className="ac-msg__status">
              {status.mark ?? (status.icon ? <Icon name={status.icon} size={14} /> : null)}
              {status.label}
            </span>
          )}
          {aside && !grouped && <span className="ac-msg__aside">{aside}</span>}
        </div>
        {aside && grouped && <span className="ac-msg__aside ac-msg__aside--floating">{aside}</span>}
        {children}
        {foot && <div className="ac-msg__foot">{foot}</div>}
      </div>
      {menu &&
        menuAt &&
        // On the page itself: the row's containment (a list's `content-visibility`) would place a fixed box in it.
        createPortal(
          <MenuAt at={menuAt} onClose={() => setMenuAt(null)} label={menu.label} align="end">
            {menu.items}
          </MenuAt>,
          document.body,
        )}
    </article>
  );
}

export function MessageText({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ac-msg__text", className)} {...rest} />;
}

/** "Hoje", "Ontem", a date. */
export function DayDivider({ children }: { children: ReactNode }) {
  return <div className="ac-divider">{children}</div>;
}
