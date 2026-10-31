import type { TFunction } from "i18next";
import type { AgentBrainLine, BrainKind, BrainOption } from "../api/types";
import { type PlanChoice, planLabel, planOfAccount } from "./no-ai";
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
 * What thinks on a plan, in one sentence wherever it's said: the model by the plan that pays for it ("Sonnet pelo
 * plano do Claude", "DeepSeek V4.1 Flash pelo OpenCode Go"), never the program it runs in or the computer; with
 * `owner`, whose plan it is.
 */
export function thinksWith(t: TFunction, plan: PlanChoice, model: string, owner?: string | null): string {
  const line = plan === "claude" || plan === "chatgpt" ? plan : "coding";
  return owner
    ? t(`brain.line.${line}Of`, { model, plan: planLabel(t, plan), owner })
    : t(`brain.line.${line}`, { model, plan: planLabel(t, plan) });
}

/**
 * What thinks for an agent, wherever it is shown (DM header, profile card, the phone's "Pensa com"): on a plan its
 * model by that plan (`thinksWith`), else the API model's label. Whoever doesn't see its computer (not its owner nor
 * an admin) also reads whose plan it is (`owner`). `mark` is the maker's (`ProviderLogo` id: a plan account's own
 * provider when it has one), null for the API.
 */
export function brainLine(
  t: TFunction,
  brain: AgentBrainLine | null | undefined,
  apiModelLabel: string,
  owner?: string | null,
): { text: string; kind: EngineKind; mark: string | null } {
  if (!brain || brain.kind === "model") return { text: apiModelLabel, kind: "agent", mark: null };
  const model = isAuto(brain.model) ? t("brain.auto.label") : (brain.model ?? "");
  const plan = planOfAccount({ kind: brain.kind, provider: brain.provider ?? null });
  return {
    text: thinksWith(t, plan, model, brain.computer ? null : owner),
    kind: engineOfBrain(brain.kind),
    mark: brain.provider ?? brain.kind,
  };
}
