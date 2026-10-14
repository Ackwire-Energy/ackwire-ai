import type { CSSProperties } from "react";
import { cx } from "../cx";

/** The agent mark: `agent` square with the cut corner and two `on-agent` eyes. */
export function LogoMark({ size, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cx("ac-logo__mark", className)}
      style={size ? { width: size, height: size } : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path
        className="ac-logo__body"
        d="M10 2h12a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H3.5A1.5 1.5 0 0 1 2 28.5V10a8 8 0 0 1 8-8z"
      />
      <path
        className="ac-logo__eyes"
        d="M11.2 12.5a1.3 1.3 0 0 1 2.6 0v5a1.3 1.3 0 0 1-2.6 0zM18.2 12.5a1.3 1.3 0 0 1 2.6 0v5a1.3 1.3 0 0 1-2.6 0z"
      />
    </svg>
  );
}

export interface LogoProps {
  /** `main` (app) or `expanded` (+ "chat" bubble, where the domain matters). */
  variant?: "main" | "expanded";
  /** One-color version. */
  mono?: boolean;
  /** Font size in px; the mark scales with it. Below 18px use `LogoMark` alone. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** "agentes" logo: mark + wordmark in Onest 700. Accessible name "agentes" (or "agentes.chat" expanded). */
export function Logo({ variant = "main", mono, size = 24, className, style }: LogoProps) {
  const expanded = variant === "expanded";
  return (
    <span
      className={cx("ac-logo", mono && "ac-logo--mono", className)}
      style={{ fontSize: size, ...style }}
      role="img"
      aria-label={expanded ? "agentes.chat" : "agentes"}
    >
      <LogoMark />
      {expanded ? (
        <span className="ac-logo__word" aria-hidden="true">
          <span>agentes</span>
          <span className="ac-logo__chat">chat</span>
        </span>
      ) : (
        <span aria-hidden="true">agentes</span>
      )}
    </span>
  );
}
