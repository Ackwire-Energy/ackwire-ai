import type { CSSProperties } from "react";
import { BRAND_NAME, MONOGRAM_PATH, MONOGRAM_VIEWBOX } from "../brand/ackwire";
import { cx } from "../cx";

/**
 * The Ackwire "A" monogram in the theme's accent (`--agent`), or in the ink in the mono logo. A square mark: the
 * favicon, the app icon and a workspace without a logo of its own wear it.
 */
export function LogoMark({ size, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      viewBox={MONOGRAM_VIEWBOX}
      className={cx("ac-logo__mark", className)}
      style={size ? { width: size, height: size } : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path className="ac-logo__body" d={MONOGRAM_PATH} />
    </svg>
  );
}

export interface LogoProps {
  /** `main` (app) or `expanded` (the same lockup: kept so callers that ask for it still work). */
  variant?: "main" | "expanded";
  /** One-color version. */
  mono?: boolean;
  /** Font size in px; the mark scales with it. Below 18px use `LogoMark` alone. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** "Ackwire AI" logo: the "A" + "Ackwire" in the ink and "AI" in the accent, as the brand's lockup. */
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
