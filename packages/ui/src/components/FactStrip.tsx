import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export type FactTone = "neutral" | "waiting" | "done";

export interface Fact {
  key: string;
  /** An icon name, or a node in its place (a connector's logo). */
  icon: IconName | ReactNode;
  label: ReactNode;
  value: ReactNode;
  /** `waiting` (attention) for what calls for care, `done` for a result. */
  tone?: FactTone;
  /** The whole value, on hover, when it is cut. */
  title?: string;
}

/**
 * A row of short facts, each an icon, a small label and a one-line value, split by hairlines ("Where ·
 * Effect · Undo · Deadline"). Values never wrap: what doesn't fit ends in an ellipsis, whole in its title.
 */
export function FactStrip({ facts, className, ...rest }: { facts: Fact[] } & HTMLAttributes<HTMLDListElement>) {
  return (
    <dl className={cx("ac-facts", className)} {...rest}>
      {facts.map((f) => (
        <div key={f.key} className={cx("ac-facts__item", f.tone && f.tone !== "neutral" && `ac-facts__item--${f.tone}`)}>
          <span className="ac-facts__icon" aria-hidden="true">
            {typeof f.icon === "string" ? <Icon name={f.icon as IconName} size={16} /> : f.icon}
          </span>
          <dt className="ac-facts__label">{f.label}</dt>
          <dd className="ac-facts__value" title={f.title}>
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
