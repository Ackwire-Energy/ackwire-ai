import {
  type CSSProperties,
  createContext,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { MenuAt } from "./Menu";

/**
 * How the rows under it are drawn. Every row reads it, so a view sets it once: `comfortable` keeps my rows on the right
 * in a gray bubble, `left` draws them as anyone's, `bubbles` puts everyone's words in a bubble, `compact` is one line a
 * row. No provider: `comfortable`.
 */
export interface MessageLook {
  style: "comfortable" | "left" | "bubbles" | "compact";
  /** My bubbles in `bubbles`: a tint of `mine`, or `mine` itself. */
  tone: "light" | "strong";
  /** The color of my bubbles in `bubbles`. */
  mine: string;
  /**
   * False where the name says nothing (a DM's two speakers): `bubbles` leaves it to screen readers. A row with no bubble
   * (a card alone) keeps it, ahead of its time, as anywhere else: a time alone beside a face reads as a broken line.
   */
  names: boolean;
}
export const MessageLookContext = createContext<MessageLook | null>(null);

/** What a row's `MessageText` holds besides its words in `bubbles`: the name on top, the time at the end. */
const BubbleContext = createContext<{ head: ReactNode; tail: ReactNode; quote?: ReactNode } | null>(null);

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
  /**
   * An agent at work before its first words: only its face shows, the name and time stay for screen readers until the
   * words arrive (the same row, so nothing moves).
   */
  waiting?: boolean;
  agent?: boolean;
  /**
   * The viewer's own row: on the right in a bubble (`MessageText`), no face or name on screen (both stay for screen
   * readers); the time goes under the bubble, a sending state in its place.
   */
  own?: boolean;
  /** An own row's place in a run of the viewer's rows: the corners it shares square off, the time shows under "end". */
  run?: "solo" | "start" | "mid" | "end";
  /** The message text (use `MessageText`), plus attachments or cards. */
  children: ReactNode;
  /** The message this one answers, in one line: on top of the words in a bubble, else above the row, joined to its face. */
  quote?: ReactNode;
  /** Nothing in a `MessageText` (a card, a picture): in `bubbles` its name and time stay above it, with no bubble. */
  bare?: boolean;
  /** The name's color in `bubbles`, on a light and on a dark surface. */
  nameColor?: readonly [string, string];
  /** Lays the body out as a column (approval cards). */
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

/**
 * The touch menu's reactions and most of two items (130px), 2px off the row and 8px inside the window. A row with less
 * room over and under it fills the screen, and the menu opens at the tap; with more, beside the row, and the rest of
 * its items scroll.
 */
const MENU_ROOM = 140;

/** A tap on touch on the row itself, not on a link or a button in it. */
function touchTap(e: MouseEvent<HTMLElement>) {
  if (typeof window.matchMedia !== "function") return false;
  if (!(navigator.maxTouchPoints > 0) || !window.matchMedia("(hover: none)").matches) return false;
  // The menu's own taps bubble here through its portal.
  if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return false;
  return e.target === e.currentTarget || !e.target.closest(INTERACTIVE);
}

/** Where the row's menu opens: beside the row's part on screen, or at the tap (`tap`, in the row). Null: off screen. */
function menuPlace(row: HTMLElement, tap: { x: number; y: number }) {
  const box = row.getBoundingClientRect();
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  if (bottom < top) return null;
  if (Math.max(top, window.innerHeight - bottom) < MENU_ROOM) return { x: box.left + tap.x, y: box.top + tap.y };
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
  waiting,
  agent,
  own,
  run = "solo",
  children,
  quote,
  bare,
  nameColor,
  stacked,
  aside,
  foot,
  menu,
  className,
  onClick,
  style,
  ...rest
}: MessageProps) {
  const look = useContext(MessageLookContext);
  const drawn = look?.style ?? "comfortable";
  // In `left` and `compact` a row of mine is a row like anyone's.
  const mine = own && (drawn === "comfortable" || drawn === "bubbles");
  const inBubble = drawn === "bubbles" && !bare;
  const quoteInBubble = (inBubble || mine) && !bare;
  const tipId = useId();
  const noteId = useId();
  const row = useRef<HTMLElement>(null);
  const tap = useRef({ x: 0, y: 0 });
  const [menuAt, setMenuAt] = useState<ReturnType<typeof menuPlace>>(null);
  const menuOpen = Boolean(menu) && menuAt !== null;
  const footed = mine && !inBubble && (run === "end" || run === "solo");
  useEffect(() => {
    if (!menuOpen) return;
    // The menu follows its row and closes when the row leaves the screen: a phone's keyboard going down resizes the
    // page, the list scrolls, or a row above changes height (a reply still being written).
    let frame = requestAnimationFrame(function follow() {
      const next = row.current && menuPlace(row.current, tap.current);
      setMenuAt((at) =>
        at && next && at.x === next.x && at.y === next.y && at.width === next.width && at.height === next.height
          ? at
          : next,
      );
      frame = requestAnimationFrame(follow);
    });
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);
  const tip = meta ? (
    <span className="ac-msg__meta ac-msg__tip" role="tooltip" id={tipId}>
      {meta}
    </span>
  ) : null;
  const clock = meta ? (
    // Focusable so the details are reachable without a mouse.
    <span className="ac-msg__time ac-msg__time--details" tabIndex={grouped || mine ? -1 : 0} aria-describedby={tipId}>
      {time}
      {tip}
    </span>
  ) : (
    <span className="ac-msg__time">{time}</span>
  );
  const statusNode = status && (
    <span className="ac-msg__status">
      {status.mark ?? (status.icon ? <Icon name={status.icon} size={14} /> : null)}
      {status.label}
    </span>
  );
  const head = (
    <div
      className={grouped || waiting || mine ? "ac-visually-hidden" : inBubble ? "ac-msg__bubble-head" : "ac-msg__head"}
    >
      <span className="ac-msg__author">{author}</span>
      {/* In a bubble the time is its last thing; my row's hidden head still reads it. */}
      {(!inBubble || mine) && clock}
      {note && (
        // Focusable so the reason is reachable without a mouse.
        <span className="ac-msg__note" tabIndex={grouped ? -1 : 0} aria-describedby={noteId}>
          {note.label}
          <span className="ac-msg__note-tip ac-glass" role="tooltip" id={noteId}>
            {note.tip}
          </span>
        </span>
      )}
      {/* A run's earlier row of mine has no line under it once sent, so none while it sends: its hidden head
          reads the state out. */}
      {!footed && !inBubble && statusNode}
      {aside && !grouped && !mine && !inBubble && <span className="ac-msg__aside">{aside}</span>}
    </div>
  );
  // What a bubble ends with: the time, what the row is doing (a send in flight stands in the time's place, as under
  // a bubble of mine), and the receipt's mark.
  const stamp = inBubble ? (
    <span className="ac-msg__stamp">
      {mine ? (
        (statusNode ?? (
          <span className="ac-msg__time ac-msg__time--details" aria-hidden="true">
            {time}
            {meta && <span className="ac-msg__tip">{meta}</span>}
          </span>
        ))
      ) : (
        <>
          {clock}
          {statusNode}
        </>
      )}
      {aside && <span className="ac-msg__aside">{aside}</span>}
    </span>
  ) : null;
  const rowVars = {
    ...(mine && drawn === "bubbles" ? { "--msg-mine": look?.mine } : {}),
    ...(nameColor && drawn === "bubbles" ? { "--msg-name": nameColor[0], "--msg-name-dark": nameColor[1] } : {}),
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tap opens on touch what the row's bar has for a keyboard
    <article
      ref={row}
      className={cx(
        "ac-msg",
        agent && "ac-msg--agent",
        mine && "ac-msg--own",
        grouped && "ac-msg--grouped",
        streaming && "ac-msg--streaming",
        waiting && "ac-msg--waiting",
        entering && "ac-msg--enter",
        className,
      )}
      aria-busy={streaming || undefined}
      style={{ ...rowVars, ...style } as CSSProperties}
      data-look={look ? drawn : undefined}
      data-tone={mine && drawn === "bubbles" ? look?.tone : undefined}
      data-names={inBubble && look?.names === false ? "false" : undefined}
      data-run={mine || drawn === "bubbles" ? run : undefined}
      data-menu-open={menuOpen ? "true" : undefined}
      onClick={(e) => {
        onClick?.(e);
        if (!menu || !touchTap(e)) return;
        const box = e.currentTarget.getBoundingClientRect();
        tap.current = { x: e.clientX - box.left, y: e.clientY - box.top };
        setMenuAt(menuPlace(e.currentTarget, tap.current));
      }}
      {...rest}
    >
      {quote && !quoteInBubble && <div className="ac-msg__reply">{quote}</div>}
      {drawn === "compact" && (
        <span className="ac-msg__clock" aria-hidden="true">
          {time}
        </span>
      )}
      {mine ? null : grouped ? (
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
      <div className="ac-msg__body" style={stacked ? { display: "flex", flexDirection: "column" } : undefined}>
        {(!inBubble || mine) && head}
        {aside && grouped && !mine && !inBubble && (
          <span className="ac-msg__aside ac-msg__aside--floating">{aside}</span>
        )}
        <BubbleContext.Provider
          value={
            inBubble || (quote && quoteInBubble)
              ? { head: inBubble && !mine ? head : null, tail: inBubble ? stamp : null, quote: quoteInBubble && quote }
              : null
          }
        >
          {children}
        </BubbleContext.Provider>
        {footed && (
          // The head (hidden) reads the time; here it is for the eye, its details on hover. One per run: its rows
          // are minutes apart at most (they group). The receipt's mark ends this line, so it never adds one. A
          // sending state stands in the same line's box, so the row keeps its size when the time takes its place.
          <div className="ac-msg__own-foot">
            {status ? (
              <span className="ac-msg__own-time ac-msg__status">
                {status.mark ?? (status.icon ? <Icon name={status.icon} size={14} /> : null)}
                {status.label}
              </span>
            ) : (
              <>
                <span className="ac-msg__own-time" aria-hidden="true">
                  {time}
                  {meta && <span className="ac-msg__tip">{meta}</span>}
                </span>
                {aside && <span className="ac-msg__aside">{aside}</span>}
              </>
            )}
          </div>
        )}
        {foot && <div className="ac-msg__foot">{foot}</div>}
      </div>
      {menu &&
        menuAt &&
        // On the page itself: the row's containment (a list's `content-visibility`) would place a fixed box in it.
        createPortal(
          <MenuAt at={menuAt} onClose={() => setMenuAt(null)} follows label={menu.label} align="end">
            {menu.items}
          </MenuAt>,
          document.body,
        )}
    </article>
  );
}

export interface MessageTextProps extends HTMLAttributes<HTMLDivElement> {
  /** False on a second text in a row: in `bubbles` the name opens the first one only. */
  opens?: boolean;
  /** False on a first text with another under it: in `bubbles` the time ends the last one only. */
  closes?: boolean;
}

export function MessageText({ className, opens = true, closes = true, children, ...rest }: MessageTextProps) {
  const bubble = useContext(BubbleContext);
  return (
    <div className={cx("ac-msg__text", className)} {...rest}>
      {opens && bubble?.head}
      {opens && bubble?.quote && <div className="ac-msg__reply">{bubble.quote}</div>}
      {children}
      {closes && bubble?.tail}
    </div>
  );
}

/** "Hoje", "Ontem", a date. */
/** `day`: the day's ISO time, which the list's floating date reads while it scrolls (`data-day`). */
export function DayDivider({ children, day }: { children: ReactNode; day?: string }) {
  return (
    <div className="ac-divider" data-day={day}>
      {children}
    </div>
  );
}
