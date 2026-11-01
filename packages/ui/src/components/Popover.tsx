import { Popover as RPopover } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "../cx";
import type { HoverCard } from "../hooks/useHoverCard";

/** Contents that opened without taking the focus: closing gives none back. */
const keptFocus = new WeakSet<EventTarget>();

/**
 * Small popover (Radix Popover: opens from its trigger with Enter/Space or a
 * click, Esc closes, focus returns). Same surface as our menus. Controlled
 * with `open`/`onOpenChange`, or by `hover` for a card that also opens when the
 * pointer rests on its trigger (`useHoverCard`).
 */
export function Popover({
  trigger,
  children,
  label,
  side = "top",
  align = "start",
  className,
  open,
  onOpenChange,
  hover,
  moveFocus = hover?.open !== "hover",
}: {
  /** A focusable element (a button with an accessible name). */
  trigger: ReactNode;
  children: ReactNode;
  /** Accessible name of the popover. */
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  /** By default, `hover` says: open however it opened. */
  open?: boolean;
  /** With `hover`, called after it. */
  onOpenChange?: (open: boolean) => void;
  hover?: HoverCard;
  /**
   * As it opens: focus goes to its first control, and back to the trigger when it closes. False for a card that
   * opens under a resting pointer (the default when `hover` opened it): whatever had focus (the box someone types
   * in) keeps it.
   */
  moveFocus?: boolean;
}) {
  return (
    <RPopover.Root
      open={open ?? (hover && hover.open !== false)}
      onOpenChange={(o) => {
        hover?.onOpenChange(o);
        onOpenChange?.(o);
      }}
    >
      <RPopover.Trigger asChild {...hover?.trigger}>
        {trigger}
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          className={cx("ac-menu ac-popover", className)}
          side={side}
          align={align}
          sideOffset={6}
          aria-label={label}
          role="dialog"
          {...hover?.content}
          onOpenAutoFocus={(e) => {
            if (moveFocus || !e.currentTarget) return;
            e.preventDefault();
            keptFocus.add(e.currentTarget);
          }}
          // Each opening's own content: by the time one closes, `moveFocus` may already say how the next one opens.
          onCloseAutoFocus={(e) => {
            if (e.currentTarget && keptFocus.has(e.currentTarget)) e.preventDefault();
          }}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
