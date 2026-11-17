import type { CSSProperties } from "react";
import { cx } from "../cx";
import { ditherTones } from "../sky/dither";
import type { AgentColor } from "./AgentLook";

/** A color's dot as one flat tone: the middle of the five its dither is drawn in. */
export const dotTone = (color: string) => ditherTones(color as AgentColor)[2];

/**
 * A small dot in one of the agents' colors, in an icon's box so it lines up where an icon would (a task's project on
 * its card, in a menu row, on a filter chip). No color: a hollow ring ("Sem projeto"). Decorative: its name is always
 * beside it. The box follows its place (`--dot-box`, 14 by default), the dot is 8 (`--dot-size`).
 */
export function ColorDot({ color, className }: { color?: string | null; className?: string }) {
  return (
    <span
      className={cx("ac-colordot", className)}
      data-none={color ? undefined : ""}
      style={color ? ({ "--dot": dotTone(color) } as CSSProperties) : undefined}
      aria-hidden="true"
    />
  );
}
