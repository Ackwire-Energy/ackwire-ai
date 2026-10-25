import type { CSSProperties } from "react";
import { markOf, PROVIDER_MARKS } from "../brand/marks";
import { cx } from "../cx";

export interface ProviderLogoProps {
  /** A provider, plan, brain or mission executor id (`anthropic`, `zai`, `claude_code`…). */
  id: string;
  /** `xs`: the bare mark beside text; `sm`: a 30 px tile beside menu options; `tile`: 48 px, for list rows. */
  size?: "xs" | "sm" | "tile";
  /** Can't be used now (not installed, signed out, computer offline): gray and dim. */
  off?: boolean;
  /** Accessible name. Without it the logo is decorative: the text next to it names the provider. */
  label?: string;
  className?: string;
}

/**
 * A provider's official mark (`brand/marks.ts`) on a tile tinted with its color; one-color marks follow the
 * theme. An id without a mark shows its initial on a neutral tile.
 */
export function ProviderLogo({ id, size = "tile", off = false, label, className }: ProviderLogoProps) {
  const key = markOf(id);
  const mark = key ? PROVIDER_MARKS[key] : null;
  const color = mark?.color;
  return (
    <span
      className={cx("ac-brand", `ac-brand--${size}`, !color && "ac-brand--mono", off && "ac-brand--off", className)}
      style={color ? ({ "--brand": color } as CSSProperties) : undefined}
      data-mark={key ?? undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {mark ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d={mark.path} />
        </svg>
      ) : (
        <span className="ac-brand__initial">{id.trim().charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}
