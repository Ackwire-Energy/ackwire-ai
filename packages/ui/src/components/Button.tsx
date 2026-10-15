import { Slot } from "radix-ui";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { Spinner } from "./Skeleton";

export type ButtonVariant = "default" | "primary" | "agent" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` at most once per area; `agent` only to ask an agent for
   * something ("Pedir à Ada": cut corner + agent icon); `danger` to refuse or
   * delete; `ghost` in toolbars.
   */
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Leading icon. With `iconOnly`, the only content (then `aria-label` is required). */
  icon?: IconName;
  iconOnly?: boolean;
  block?: boolean;
  /** An async action is running: inline spinner, same width, not clickable (`aria-busy`). */
  loading?: boolean;
  /** Render the child element (e.g. a router link) with the button styles. */
  asChild?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "default",
    size = "md",
    icon,
    iconOnly,
    block,
    asChild,
    loading,
    className,
    children,
    type = "button",
    disabled,
    ...rest
  },
  ref,
) {
  const classes = cx(
    "ac-btn",
    variant !== "default" && `ac-btn--${variant}`,
    size === "sm" && "ac-btn--sm",
    iconOnly && "ac-btn--icon",
    block && "ac-btn--block",
    loading && "ac-btn--loading",
    className,
  );
  const leading = variant === "agent" && !icon ? "agent" : icon;
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} aria-disabled={disabled || undefined} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {/* The label stays (invisible) while loading, so the width never changes. */}
      {leading && <Icon name={leading} />}
      {!iconOnly && children}
      {loading && <Spinner className="ac-btn__spinner" size={size === "sm" ? 14 : 16} />}
    </button>
  );
});
