import type { CSSProperties, HTMLAttributes } from "react";
import { eyeShapes } from "../agent/engine.js";
import { cx } from "../cx";
import { ditherCells, ditherUrl } from "../sky/dither";
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

/** Rendered size of each avatar size (accessories simplify when small). */
const SIZE_PX: Record<NonNullable<AvatarProps["size"]>, number> = { xs: 18, sm: 24, md: 36, lg: 56, xl: 112 };

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

/** The body's dithered texture in the agent's color, with a grid that fits the size. */
function ditherStyle(a: AgentAppearance | undefined, px: number): CSSProperties {
  return { "--av-dither": `url("${ditherUrl(a?.color ?? "sky", ditherCells(px))}")` } as CSSProperties;
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
      data-accessory={
        agent && appearance?.accessory && appearance.accessory !== "none" ? appearance.accessory : undefined
      }
      data-eyes={agent && appearance?.eyes && appearance.eyes !== "round" ? appearance.eyes : undefined}
      style={agent ? { ...appearanceStyle(appearance), ...ditherStyle(appearance, SIZE_PX[size]), ...style } : style}
      {...rest}
    >
      {agent ? (
        <>
          {/* The eyes and what sits on them (glasses) look around together; the blink is the eyes' own. */}
          <span className="ac-avatar__face">
            {eyeShapes(appearance?.eyes, { writing: mood === "writing" }).map((e, i) => (
              <span
                key={i === 0 ? "l" : "r"}
                className={cx(
                  "ac-avatar__eye",
                  i === 0 ? "ac-avatar__eye--l" : "ac-avatar__eye--r",
                  e.kind !== "pill" && `ac-avatar__eye--${e.kind}`,
                )}
                style={{ left: pct(e.x), top: pct(e.y), width: pct(e.w), height: pct(e.h) }}
              />
            ))}
            <AgentAccessoryLayer accessory={appearance?.accessory} px={SIZE_PX[size]} layer="face" />
          </span>
          <AgentAccessoryLayer accessory={appearance?.accessory} px={SIZE_PX[size]} layer="head" />
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
