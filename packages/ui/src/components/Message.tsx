import { type HTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

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
}

/** Taps on these keep doing their own thing (the bar stays as it is). */
const INTERACTIVE = "a[href], button, input, textarea, select, label, summary, [role='button'], [tabindex='0']";

/**
 * Touch screens have no hover: tapping a message (not a link or button in it)
 * focuses the row, which reveals its action bar (Reagir, Responder, …) the
 * same way keyboard focus does. Tapping another message moves it there.
 */
function revealActionsOnTap(row: HTMLElement, target: EventTarget) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  if (!(navigator.maxTouchPoints > 0) || !window.matchMedia("(hover: none)").matches) return;
  if (target instanceof Element && target !== row && target.closest(INTERACTIVE)) return;
  if (!row.querySelector(".ac-msg__actions")) return;
  if (!row.hasAttribute("tabindex")) row.tabIndex = -1;
  row.focus({ preventScroll: true });
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
  className,
  onClick,
  ...rest
}: MessageProps) {
  const tipId = useId();
  const noteId = useId();
  const tip = meta ? (
    <span className="ac-msg__meta ac-msg__tip" role="tooltip" id={tipId}>
      {meta}
    </span>
  ) : null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tap only reveals the action bar, which keyboard focus already reveals
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
      onClick={(e) => {
        onClick?.(e);
        revealActionsOnTap(e.currentTarget, e.target);
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
