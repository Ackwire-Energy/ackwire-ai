import type { HTMLAttributes } from "react";
import { cx } from "../cx";

/** A keyboard hint: "⌘", "↵", "esc". Decorative next to a label that already says the action. */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx("ac-kbd", className)} {...rest} />;
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere. */
export const modKey = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
