import { type AgentAppearance, type AgentState, cx } from "@agenteschat/ui";
import type { CSSProperties } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";

type Size = "xs" | "sm" | "md" | "lg" | "xl";

/** The living agent symbol at any size (`px` sets a custom size through `--s`). */
export function LpAvatar({
  look,
  state,
  size,
  px,
  className,
  style,
  name = "",
}: {
  look?: AgentAppearance;
  state?: AgentState;
  size?: Size;
  px?: number | string;
  className?: string;
  style?: CSSProperties;
  name?: string;
}) {
  const sized =
    px === undefined ? style : ({ ...style, "--s": typeof px === "number" ? `${px}px` : px } as CSSProperties);
  // Joy shows the engine's happy expression; a pixel size picks the nearest avatar size.
  const joy = className?.split(" ").includes("lp-joy") && state !== "writing";
  const near = typeof px === "number" ? (px >= 96 ? "xl" : px >= 48 ? "lg" : px >= 30 ? "md" : "sm") : undefined;
  return (
    <AgentAvatar
      name={name}
      size={size ?? near}
      state={state}
      appearance={look ?? {}}
      expression={joy ? "happy" : undefined}
      className={cx("lp-av", px !== undefined && "lp-av--px", className)}
      style={sized}
    />
  );
}
