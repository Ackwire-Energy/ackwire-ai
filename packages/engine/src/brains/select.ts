import type { Agent } from "../agents";
import type { AgentRun } from "../runs";
import type { BrainKind } from "./types";

/**
 * Which brain thinks for this run (ADR 0032 §5). Block 1: always the model
 * brain (no per-agent setting yet).
 *
 * Seam for block 3: read `agent.brain` / `agent.brainModel` (and a mission's
 * override), check the computer brain is available (machine online, protocol,
 * CLI installed and logged in, plan limit) and fall back to "model" when a
 * model credential exists (`agent.brainFallback`), per "Fallback, by what
 * exists". The engine then builds the instance from `EngineDeps.brains[kind]`
 * (Claude Code / Codex factories registered at boot) or the built-in
 * `ModelBrain`.
 */
export function brainFor(_agent: Agent, _run: AgentRun, _mission?: { id: string } | null): BrainKind {
  return "model";
}
