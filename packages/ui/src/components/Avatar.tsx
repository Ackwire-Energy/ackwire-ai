import type { HTMLAttributes } from "react";
import { cx } from "../cx";

export type AvatarKind = "person" | "agent";

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  kind?: AvatarKind;
  /** Display name; initials are derived from it unless `initials` is given. */
  name: string;
  initials?: string;
  /** 18 (receipts), 24, 36 (default) or 56px. */
  size?: "xs" | "sm" | "md" | "lg";
  imageUrl?: string | null;
  /** Agent is executing: draws the `agent` ring. */
  running?: boolean;
  /** Online (person) / available (agent) dot. */
  presence?: boolean;
  /** Set when no visible name is next to the avatar: exposes `name` to screen readers. */
  labelled?: boolean;
}

/** 1–2 letters: "Ada" → "A", "Atlas" → "At" when asked; "Marina Souza" → "MS". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.[0] ?? "?").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

/** People are circles; agents are rounded squares with the cut bottom-left corner. */
export function Avatar({
  kind = "person",
  name,
  initials,
  size = "md",
  imageUrl,
  running,
  presence,
  labelled,
  className,
  ...rest
}: AvatarProps) {
  const a11y = labelled ? ({ role: "img", "aria-label": name } as const) : ({ "aria-hidden": true } as const);
  return (
    <span
      className={cx(
        "ac-avatar",
        kind === "agent" && "ac-avatar--agent",
        size !== "md" && `ac-avatar--${size}`,
        running && kind === "agent" && "ac-avatar--running",
        className,
      )}
      {...a11y}
      data-kind={kind}
      {...rest}
    >
      {imageUrl ? <img src={imageUrl} alt="" /> : (initials ?? initialsOf(name))}
      {presence && <span className="ac-avatar__presence" />}
    </span>
  );
}

/** Overlapping avatars (channel header, invitation). */
export function AvatarStack({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ac-avatar-stack", className)} {...rest} />;
}
