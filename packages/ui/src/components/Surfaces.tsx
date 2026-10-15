import { type HTMLAttributes, type ReactNode, useEffect, useState } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

/** Neutral card (`surface-raised` + `line`). State never tints it: use a Chip. */
export function Card({
  padded,
  className,
  as: Tag = "section",
  ...rest
}: HTMLAttributes<HTMLElement> & { padded?: boolean; as?: "section" | "div" | "article" }) {
  return <Tag className={cx("ac-card", padded && "ac-card--padded", className)} {...rest} />;
}

/** How long the first-appearance stagger lasts; rows added later don't animate. */
export const LIST_STAGGER_MS = 400;

/** A bordered list of rows (members, invitations, agents). Rows rise in, staggered, only when it first appears. */
export function List({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), LIST_STAGGER_MS);
    return () => clearTimeout(timer);
  }, []);
  return <div className={cx("ac-list", entering && "ac-list--stagger", className)} {...rest} />;
}

export interface EmptyStateProps {
  icon?: IconName;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Dashed box with a short explanation (and optional icon, title and actions). */
export function EmptyState({ icon, title, children, actions, className }: EmptyStateProps) {
  return (
    <div className={cx("ac-empty", className)}>
      {icon && (
        <span className="ac-empty__icon">
          <Icon name={icon} />
        </span>
      )}
      {title && <p className="ac-empty__title">{title}</p>}
      {children && <p className="ac-empty__text">{children}</p>}
      {actions && <div className="ac-empty__actions">{actions}</div>}
    </div>
  );
}

/** Inline error (or neutral notice) with an icon. */
export function Alert({
  tone = "danger",
  children,
  className,
}: {
  tone?: "danger" | "neutral";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cx("ac-alert", tone === "neutral" && "ac-alert--neutral", className)}
    >
      <Icon name="alert" />
      <span>{children}</span>
    </p>
  );
}

/** Usage meter (budget). The bar is ink, never a status color. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: the native <meter> has a native look we never show
    <div
      className="ac-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div className="ac-meter__bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A selectable card (`aria-pressed`): role presets in onboarding and "Criar agente". */
export function OptionCard({
  pressed,
  onClick,
  agent,
  stacked,
  children,
  className,
}: {
  pressed: boolean;
  onClick: () => void;
  /** Cut corner: the option creates an agent. */
  agent?: boolean;
  stacked?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cx("ac-option", agent && "ac-option--agent", stacked && "ac-option--stacked", className)}
    >
      {children}
    </button>
  );
}

/** Onboarding step bars + "Passo 1 de 4 · Organização". */
export function Steps({ current, total, label }: { current: number; total: number; label: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="ac-steps" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed number of bars
          <span key={i} className="ac-steps__bar" data-done={i < current} />
        ))}
      </div>
      <span className="ac-eyebrow">{label}</span>
    </div>
  );
}
