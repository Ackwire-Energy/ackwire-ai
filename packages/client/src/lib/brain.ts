import type { BrainKind, BrainOption } from "../api/types";

/*
 * The engine an agent thinks and works with, as its icon draws it
 * (telas/IconesMotor.html; `BrainPortrait` / `BrainIcon` in packages/ui):
 * Claude Code or Codex on a computer, or the agent itself through the API.
 * Same names as the UI's `BrainPortraitKind` and `BrainPortraitState`.
 */
export type EngineKind = "claude_code" | "codex" | "agent";
/** `off`: not installed, not logged in, or the computer is offline. */
export type EngineState = "idle" | "working" | "off";

/** An agent's brain (`agents.brain`: model, claude_code, codex) as its engine; anything else is the agent (API). */
export function engineOfBrain(brain: BrainKind | string | null | undefined): EngineKind {
  return brain === "claude_code" || brain === "codex" ? brain : "agent";
}

/** A mission's executor (claude, codex, agent) as its engine. */
export function engineOfExecutor(executor: string | null | undefined): EngineKind {
  return executor === "claude" ? "claude_code" : executor === "codex" ? "codex" : "agent";
}

/**
 * How a brain option shows: off when it can't run now (not installed, no
 * computer…) or its computer is offline; the API is always there.
 */
export function engineStateOfOption(
  option: Pick<BrainOption, "kind" | "available">,
  computer?: { online: boolean } | null,
): EngineState {
  if (option.kind === "model") return "idle";
  if (!option.available) return "off";
  return computer && !computer.online ? "off" : "idle";
}
