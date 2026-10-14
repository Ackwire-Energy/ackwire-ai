import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";

export interface MessageProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** The avatar element. Omitted for grouped (continuation) messages. */
  avatar?: ReactNode;
  author: ReactNode;
  time: ReactNode;
  /** Machine numbers next to the time: "sonnet 5.5 · 1.240 tokens · US$ 0,004", or "escrevendo…". */
  meta?: ReactNode;
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
  grouped,
  streaming,
  agent,
  children,
  stacked,
  aside,
  className,
  ...rest
}: MessageProps) {
  return (
    <article
      className={cx(
        "ac-msg",
        agent && "ac-msg--agent",
        grouped && "ac-msg--grouped",
        streaming && "ac-msg--streaming",
        className,
      )}
      aria-busy={streaming || undefined}
      {...rest}
    >
      {grouped ? <span className="ac-msg__gutter" /> : avatar}
      <div className="ac-msg__body" style={stacked ? { display: "flex", flexDirection: "column", gap: 8 } : undefined}>
        <div className={grouped ? "ac-visually-hidden" : "ac-msg__head"}>
          <span className="ac-msg__author">{author}</span>
          <span className="ac-msg__time">{time}</span>
          {meta && <span className="ac-msg__meta">{meta}</span>}
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
