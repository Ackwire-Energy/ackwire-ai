import { Popover as RPopover } from "radix-ui";
import type { PointerEventHandler, ReactNode } from "react";
import { cx } from "../cx";

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
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
