import { type AgentAppearance, type AgentState, cx } from "@agenteschat/ui";
import type { CSSProperties } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AGENTS, type AgentKey } from "./data";

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

/** One of the sample agents (Lia, Teo, Bia). */
export function SampleAgent({
  agent,
  size,
  px,
  state,
  className,
}: {
  agent: AgentKey;
  size?: Size;
  px?: number;
  state?: AgentState;
  className?: string;
}) {
  return (
    <LpAvatar
      look={AGENTS[agent].look}
      size={size}
      px={px}
      state={state}
      className={className}
      name={AGENTS[agent].name}
    />
  );
}
