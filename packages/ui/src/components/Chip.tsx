import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export type ChipTone = "neutral" | "waiting" | "done";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Required: state is said with an icon and a word, never a colored dot. */
  icon: IconName;
  /** `waiting` (attention) only for what waits on a person. */
  tone?: ChipTone;
  children: ReactNode;
}

export function Chip({ icon, tone = "neutral", className, children, ...rest }: ChipProps) {
  return (
    <span className={cx("ac-chip", tone !== "neutral" && `ac-chip--${tone}`, className)} {...rest}>
      <Icon name={icon} />
      {children}
    </span>
  );
}

/** Small attention text with an icon (e.g. "pede aprovação"); no background. */
export function AttentionNote({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("ac-note-attention", className)} {...rest}>
      <Icon name="waiting" />
      {children}
    </span>
  );
}

/** Counter badge, e.g. pending approvals in the sidebar. */
export function CountBadge({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("ac-count", className)} {...rest} />;
}
