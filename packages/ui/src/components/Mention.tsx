import type { HTMLAttributes } from "react";
import { cx } from "../cx";

/** A neutral @mention, the same for people and agents. */
export function Mention({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("ac-mention", className)} {...rest} />;
}
