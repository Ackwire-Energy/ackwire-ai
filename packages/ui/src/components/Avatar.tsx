import type { HTMLAttributes } from "react";
import { cx } from "../cx";
import { AgentAccessoryLayer, type AgentAppearance, appearanceStyle } from "./AgentLook";

export type AvatarKind = "person" | "agent";

/**
 * The agent symbol's state: `idle` blinks now and then, `thinking` looks
 * around (with a halo), `writing` has dash eyes (with a halo).
 */
export type AgentState = "idle" | "thinking" | "writing";

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  kind?: AvatarKind;
  /** Display name; initials are derived from it unless `initials` is given. */
  name: string;
  initials?: string;
  /** 18 (receipts), 24, 36 (default), 56 or 112px (the customizer preview). */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  imageUrl?: string | null;
  /** Agent is executing: the halo (same as `state="thinking"` unless `state` says otherwise). */
  running?: boolean;
  /** The living agent symbol's state (agents only). */
  state?: AgentState;
  /** The agent's look: color, eyes and an accessory (agents only). */
  appearance?: AgentAppearance;
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

/**
 * People are circles with initials (or a photo) and an optional presence
 * dot. Agents are the living symbol: a rounded square with the cut
 * bottom-left corner and two eyes (see `state`).
 */
export function Avatar({
  kind = "person",
  name,
  initials,
  size = "md",
  imageUrl,
  running,
  state,
  appearance,
  presence,
  labelled,
  className,
  style,
  ...rest
}: AvatarProps) {
  const a11y = labelled ? ({ role: "img", "aria-label": name } as const) : ({ "aria-hidden": true } as const);
  const agent = kind === "agent";
  const mood: AgentState = state ?? (running ? "thinking" : "idle");
  return (
    <span
      className={cx(
        "ac-avatar",
        kind === "agent" && "ac-avatar--agent",
        size !== "md" && `ac-avatar--${size}`,
        agent && mood !== "idle" && "ac-avatar--running",
        agent && mood !== "idle" && `ac-avatar--${mood}`,
        className,
      )}
      {...a11y}
      data-kind={kind}
      data-state={agent ? mood : undefined}
      data-eyes={agent && appearance?.eyes && appearance.eyes !== "round" ? appearance.eyes : undefined}
      style={agent ? { ...appearanceStyle(appearance), ...style } : style}
      {...rest}
    >
      {agent ? (
        <>
          <span className="ac-avatar__eye ac-avatar__eye--l" />
          <span className="ac-avatar__eye ac-avatar__eye--r" />
          <AgentAccessoryLayer accessory={appearance?.accessory} />
        </>
      ) : imageUrl ? (
        <img src={imageUrl} alt="" />
      ) : (
        (initials ?? initialsOf(name))
      )}
      {presence && <span className="ac-avatar__presence" />}
    </span>
  );
}

/** Overlapping avatars (channel header, invitation). */
export function AvatarStack({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ac-avatar-stack", className)} {...rest} />;
}
