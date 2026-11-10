import { type HTMLAttributes, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx";
import { hoverless, hoverPointer, movesByKeys, trackInput } from "../device";
import { placeTip } from "../floating";

/** How long a mouse or a pen rests on a message's time before its details open. */
export const TIP_OPEN_MS = 250;

export interface TipProps extends HTMLAttributes<HTMLSpanElement> {
  /** What it says. Nothing: it never opens. */
  tip: ReactNode;
  /** The tip's look: `ac-msg__tip`, `ac-msg__note-tip ac-glass`. */
  look: string;
  /** Which of its edges lines up with the element's: its start, its middle or its end. */
  align?: "start" | "center" | "end";
  /** How long a resting mouse or pen waits before it opens. The keys' focus and a tap open it at once. */
  delay?: number;
  /** Shown whatever the pointer does, while true (a row of mine with the keys' focus in it). */
  open?: boolean;
}

/**
 * Words about the element they hang from (a message's time: its date, model and tokens) on the floating layer: in
 * <body>, fixed to the window at `--z-floating`, so no list, pane or dialog that scrolls or clips cuts them, no bar of
 * the row covers them, and `placeTip` keeps them `EDGE_ROOM` inside the window. A mouse or a pen resting on the element
 * opens them, the keys' focus or a tap at once (a touch screen has no hover); leaving it, its blur, a scroll, a resize
 * or Escape closes them. One held open stays closed after Escape until its element is left or `open` changes, so it
 * can be dismissed without moving the pointer or the focus (WCAG 1.4.13). For the eye only: screen readers get the
 * words from the element (`aria-describedby`).
 */
export function Tip({
  tip,
  look,
  align = "start",
  delay = TIP_OPEN_MS,
  open: held = false,
  children,
  ...rest
}: TipProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const shown = Boolean(tip) && (open || held) && !dismissed;
  useEffect(() => trackInput(), []);
  useEffect(() => () => clearTimeout(wait.current), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a held tip Escape closed shows again when `open` changes
  useEffect(() => setDismissed(false), [held]);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      clearTimeout(wait.current);
      setOpen(false);
      setDismissed(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown]);
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const el = bubble.current;
      const at = anchor.current?.getBoundingClientRect();
      if (!el || !at) return;
      // Its layout size: the entrance's transform would measure it smaller.
      const to = placeTip(at, { width: el.offsetWidth, height: el.offsetHeight }, align, window.innerWidth);
      el.style.left = `${to.left}px`;
      el.style.top = `${to.top}px`;
    };
    place();
    // One the pointer or the focus opened goes as its element moves; one held open goes with it.
    const moved = held ? place : () => setOpen(false);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [shown, held, align]);
  const close = () => {
    clearTimeout(wait.current);
    setOpen(false);
    setDismissed(false);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only show its tip, the element does nothing
    <span
      ref={anchor}
      {...rest}
      onPointerEnter={(e) => {
        rest.onPointerEnter?.(e);
        if (!hoverPointer(e.pointerType)) return;
        clearTimeout(wait.current);
        wait.current = setTimeout(() => setOpen(true), delay);
      }}
      onPointerLeave={(e) => {
        rest.onPointerLeave?.(e);
        // A finger leaves as its tap ends: the tip the tap's focus opened stays until the focus goes.
        if (hoverPointer(e.pointerType)) close();
      }}
      onFocus={(e) => {
        rest.onFocus?.(e);
        if (movesByKeys() || hoverless()) setOpen(true);
      }}
      onBlur={(e) => {
        rest.onBlur?.(e);
        close();
      }}
    >
      {children}
      {shown &&
        createPortal(
          <span ref={bubble} className={cx("ac-tip", look)} aria-hidden="true">
            {tip}
          </span>,
          document.body,
        )}
    </span>
  );
}
