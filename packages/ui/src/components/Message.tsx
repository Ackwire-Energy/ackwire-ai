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
  /** A person-facing state on the header line, with an icon: "enviando…". */
  status?: { icon: IconName; label: ReactNode };
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
  /** Muted, right-aligned on the header line (e.g. the receipt check). */
  aside?: ReactNode;
}

/** A chat line: avatar, author, time and text. Agents are told apart by the avatar only. */
export function Message({
  avatar,
  author,
  time,
  meta,
  status,
  entering,
  grouped,
  streaming,
  agent,
  children,
  stacked,
  aside,
  className,
  ...rest
}: MessageProps) {
  const tipId = useId();
  const tip = meta ? (
    <span className="ac-msg__meta ac-msg__tip" role="tooltip" id={tipId}>
      {meta}
    </span>
  ) : null;
  return (
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
          {status && (
            <span className="ac-msg__status">
              <Icon name={status.icon} size={14} />
              {status.label}
            </span>
          )}
          {aside && !grouped && <span className="ac-msg__aside">{aside}</span>}
        </div>
        {aside && grouped && <span className="ac-msg__aside ac-msg__aside--floating">{aside}</span>}
        {children}
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
