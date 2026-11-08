import type { ReactNode } from "react";
import { cx } from "../cx";

/**
 * A list group's heading ("Hoje", "Decididos há pouco"): one line on the list's outer edge, 8 over its rows, an aside
 * (a link, a select) at its end. Groups stand 24 apart in `.ac-groups`.
 */
export function GroupHeading({
  title,
  count,
  aside,
  level = 2,
  id,
  className,
}: {
  title: ReactNode;
  count?: ReactNode;
  aside?: ReactNode;
  level?: 2 | 3;
  id?: string;
  className?: string;
}) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <div className={cx("ac-grouphead", className)}>
      <H className="ac-grouphead__title" id={id}>
        {title}
        {count !== undefined && <span className="ac-grouphead__count">{count}</span>}
      </H>
      {aside && <span className="ac-grouphead__aside">{aside}</span>}
    </div>
  );
}
