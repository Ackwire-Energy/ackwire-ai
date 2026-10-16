import { type HTMLAttributes, useLayoutEffect, useRef } from "react";
import type { Expression } from "../agent/engine.js";
import { addLiveAgent, drawLive, type LiveAgent } from "../agent/live";
import { cx } from "../cx";
import { type AgentAppearance, appearanceStyle } from "./AgentLook";

export type AvatarKind = "person" | "agent";

/**
 * The agent symbol's state: `idle` blinks now and then, `thinking` looks
 * around (with a halo), `writing` has dash eyes (with a halo), `waiting`
 * looks up at you (waiting on a person's decision, no halo).
 */
export type AgentState = "idle" | "thinking" | "writing" | "waiting";

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
  /** A held expression (agents only), e.g. "happy" for a moment of joy. */
  expression?: Expression;
}

/** A steady number per name, so agents next to each other move out of step. */
const seedOf = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 100;
};

/**
 * The agent itself, drawn by the agent engine on a canvas a bit larger than
 * the box (accessories reach past the body), in the shared live loop.
 */
function AgentBody({
  appearance,
  state,
  expression,
  name,
}: {
  appearance: AgentAppearance | undefined;
  state: AgentState;
  expression: Expression | undefined;
  name: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const look = useRef<ReturnType<LiveAgent["look"]>>({ state, seed: 0 });
  look.current = {
    color: appearance?.color,
    eyes: appearance?.eyes,
    accessory: appearance?.accessory && appearance.accessory !== "none" ? appearance.accessory : undefined,
    state,
    expression,
    seed: seedOf(name),
  };
  const live = useRef<LiveAgent | null>(null);
  useLayoutEffect(() => {
    // The box is the canvas's parent: a parent's ref is not attached yet when a child's layout effect runs.
    const el = canvas.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    live.current = { canvas: el, box: host, look: () => look.current };
    const stop = addLiveAgent(live.current);
    return () => {
      live.current = null;
      stop();
    };
  }, []);
  // The loop stands still with reduced motion: a new look (or face) is drawn at once.
  const { color, eyes, accessory } = look.current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw when what is drawn changes
  useLayoutEffect(() => {
    if (live.current) drawLive(live.current, typeof performance === "object" ? performance.now() / 1000 : 0);
  }, [color, eyes, accessory, state, expression]);
  return <canvas className="ac-avatar__canvas" ref={canvas} />;
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
 * dot. Agents are the living symbol from the agent engine: the dithered body
 * with the cut corner, white eyes and a pixel accessory, turning its head,
 * blinking and now and then making a face (see `state` and `expression`).
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
  expression,
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
        agent && mood !== "idle" && mood !== "waiting" && "ac-avatar--running",
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
      style={agent ? { ...appearanceStyle(appearance), ...style } : style}
      {...rest}
    >
      {agent ? (
        <AgentBody appearance={appearance} state={mood} expression={expression} name={name} />
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
