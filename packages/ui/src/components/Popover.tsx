import { Popover as RPopover } from "radix-ui";
import type { PointerEventHandler, ReactNode } from "react";
import { cx } from "../cx";

/** Contents that opened without taking the focus: closing gives none back. */
const keptFocus = new WeakSet<EventTarget>();

/**
 * Small popover (Radix Popover: opens from its trigger with Enter/Space or a
 * click, Esc closes, focus returns). Same surface as our menus. Controlled
 * with `open`/`onOpenChange` (e.g. hover cards).
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
  onContentPointerEnter,
  onContentPointerLeave,
  moveFocus = true,
}: {
  /** A focusable element (a button with an accessible name). */
  trigger: ReactNode;
  children: ReactNode;
  /** Accessible name of the popover. */
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onContentPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onContentPointerLeave?: PointerEventHandler<HTMLDivElement>;
  /**
   * As it opens (default true): focus goes to its first control, and back to the trigger when it closes. False for
   * a card that opens under a resting pointer: whatever had focus (the box someone types in) keeps it.
   */
  moveFocus?: boolean;
}) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          className={cx("ac-menu ac-popover", className)}
          side={side}
          align={align}
          sideOffset={6}
          aria-label={label}
          role="dialog"
          onPointerEnter={onContentPointerEnter}
          onPointerLeave={onContentPointerLeave}
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
