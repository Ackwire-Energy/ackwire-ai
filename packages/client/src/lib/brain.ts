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
 * "Claude Code · Sonnet", "GLM-5.3 pelo Claude Code", "Codex · GPT-6 Sol", the brain alone when nobody chose its model
 * ("Claude Code"), or the API model's label. Its computer only where it tells two apart, when the organization's
 * `agents` think on more than one ("Claude Code · Sonnet no mac"; a computer's name reaches only its owner and
 * admins). Whoever doesn't see its computer also reads whose plan it is (`owner`). `mark` is the maker's
 * (`ProviderLogo` id: a plan account's own provider when it has one), null for the API.
 */
export function brainLine(
  t: TFunction,
  brain: AgentBrainLine | null | undefined,
  apiModelLabel: string,
  {
    owner,
    agents = [],
  }: { owner?: string | null; agents?: readonly { brain?: Pick<AgentBrainLine, "computer"> | null }[] } = {},
): { text: string; kind: EngineKind; mark: string | null } {
  if (!brain || brain.kind === "model") return { text: apiModelLabel, kind: "agent", mark: null };
  const line = brain.provider && brain.kind === "claude_code" ? "plan" : brain.kind;
  const named =
    brain.model && !isAuto(brain.model)
      ? t(`brain.line.${line}`, { model: brain.model })
      : t(`brain.card.${brain.kind}`);
  const computers = new Set(agents.flatMap((a) => (a.brain?.computer ? [a.brain.computer] : [])));
  const text =
    brain.computer && computers.size > 1 ? t("brain.line.on", { line: named, computer: brain.computer }) : named;
  return {
    text: !brain.computer && owner ? t("brain.line.ofOwner", { line: text, owner }) : text,
    kind: engineOfBrain(brain.kind),
    mark: brain.provider ?? brain.kind,
  };
}
