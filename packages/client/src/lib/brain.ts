import type { TFunction } from "i18next";
import type { AgentBrainLine, BrainKind, BrainOption } from "../api/types";
import { isAuto } from "./providers";

/*
 * The engine an agent thinks and works with, as its icon draws it
 * (`BrainPortrait` / `BrainIcon` in packages/ui):
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

/**
 * What thinks for an agent, wherever it is shown (DM header, profile card, the phone's "Pensa com"):
 * "Claude Code · Sonnet no mac", "Codex · GPT-6 Sol", or the API model's label. `mark` is the maker's
 * (`ProviderLogo` id: a plan account's own provider when it has one), null for the API.
 */
export function brainLine(
  t: TFunction,
  brain: AgentBrainLine | null | undefined,
  apiModelLabel: string,
): { text: string; kind: EngineKind; mark: string | null } {
  if (!brain || brain.kind === "model") return { text: apiModelLabel, kind: "agent", mark: null };
  const model = isAuto(brain.model) ? t("brain.auto.label") : (brain.model ?? "");
  const text = brain.computer
    ? t(`brain.line.${brain.kind}`, { model, computer: brain.computer })
    : t(`brain.line.${brain.kind}NoComputer`, { model });
  return { text, kind: engineOfBrain(brain.kind), mark: brain.provider ?? brain.kind };
}
