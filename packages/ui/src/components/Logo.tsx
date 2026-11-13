import type { CSSProperties } from "react";
import { BRAND_NAME, PIXEL_MARK_VIEWBOX, pixelMarkRuns } from "../brand/ackwire";
import { cx } from "../cx";

/** The pixel "A" never changes: its runs are computed once. */
const RUNS = pixelMarkRuns();

/**
 * The Ackwire "A" in the app's pixel style: the monogram's three arched bands, in the theme's Ackwire green, or in
 * the ink in the mono logo. A square mark: the favicon, the app icon and a workspace without a logo of its own wear it.
 */
export function LogoMark({ size, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      viewBox={PIXEL_MARK_VIEWBOX}
      shapeRendering="crispEdges"
      className={cx("ac-logo__mark", className)}
      style={size ? { width: size, height: size } : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g className="ac-logo__body">
        {RUNS.map((r) => (
          <rect key={`${r.x}:${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
        ))}
      </g>
    </svg>
  );
}

export interface LogoProps {
  /** `main` (app) or `expanded` (the same lockup: kept so callers that ask for it still work). */
  variant?: "main" | "expanded";
  mono?: boolean;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** "Ackwire AI" logo: the pixel "A" + "Ackwire" in the ink and "AI" in the accent, as the brand's lockup. */
export function Logo({ mono, size = 24, className, style }: LogoProps) {
  return (
    <span
      className={cx("ac-logo", mono && "ac-logo--mono", className)}
      style={{ fontSize: size, ...style }}
      role="img"
      aria-label={BRAND_NAME}
    >
      <LogoMark />
      <span className="ac-logo__word" aria-hidden="true">
        <span>Ackwire</span>
        <span className="ac-logo__ai">AI</span>
      </span>
    </span>
  );
}
