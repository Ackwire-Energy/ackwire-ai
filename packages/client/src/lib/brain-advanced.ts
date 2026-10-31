import type { TFunction } from "i18next";
import type { BrainKind } from "../api/types";
import { type ContextLimit, contextSize } from "./context-limits";
import { lowerFirst } from "./format";

/*
 * "Configuração avançada" of an agent's AI (ADR 0086), the same on the web (a dialog over "Quem pensa") and the
 * phone (a screen from "Pensa com"): how it thinks (effort, context window) and who it answers ("Atende outras
 * pessoas", answering through the API while its computer is away). Its row says only what differs from the defaults.
 */

/** The effort levels the apps offer (a stored `xhigh` shows as high). */
export type EffortLevel = "low" | "medium" | "high" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "max"];

export interface Advanced {
  effort: EffortLevel;
  contextTokens: ContextLimit | null;
  /** "Atende outras pessoas" off. */
  onlyOwner: boolean;
  fallback: boolean;
}

/** A new agent's: medium effort, its model's window, its owner only on a plan (ADR 0059 §5), the API when away. */
export const ADVANCED_DEFAULTS: Advanced = { effort: "medium", contextTokens: null, onlyOwner: true, fallback: true };

/** "Voltar ao padrão": the API brain has only the context limit there, so the rest stays as it is. */
export const advancedDefaults = (kind: BrainKind, now: Advanced): Advanced =>
  kind === "model" ? { ...now, contextTokens: null } : ADVANCED_DEFAULTS;
export const isAdvancedDefault = (kind: BrainKind, now: Advanced) =>
  JSON.stringify(advancedDefaults(kind, now)) === JSON.stringify(now);

/**
 * The row's line: "Tudo no padrão", or only what differs ("Esforço alto · Contexto de 400K"). The effort counts only
 * with a fixed model (an automatic one picks it), and the fallback only where answering through the API is possible.
 */
export function advancedSummary(
  t: TFunction,
  language: string,
  o: { kind: BrainKind; autoModel: boolean; apiKey: boolean; now: Advanced },
): string {
  const computer = o.kind !== "model";
  const { now } = o;
  const parts = [
    computer && !o.autoModel && now.effort !== ADVANCED_DEFAULTS.effort
      ? t("agentPage.work.brain.advanced.effort", {
          level: lowerFirst(t(`agentPage.work.brain.efforts.${now.effort}`), language),
        })
      : null,
    now.contextTokens ? t("agentPage.work.brain.advanced.context", { size: contextSize(now.contextTokens) }) : null,
    computer && !now.onlyOwner ? t("agentPage.work.brain.advanced.sharing") : null,
    computer && o.apiKey && !now.fallback ? t("agentPage.work.brain.advanced.waits") : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : t("agentPage.work.brain.advanced.allDefault");
}

/** Claude's own models (`--model opus|sonnet|haiku`) say what each is for under their names. */
export const isClaudeAlias = (v: string): v is "opus" | "sonnet" | "haiku" =>
  v === "opus" || v === "sonnet" || v === "haiku";

/** An effort as stored, as the apps show it: `xhigh` is high, none (or an automatic one) medium, the default. */
export const effortLevel = (e: string | null | undefined): EffortLevel =>
  e === "xhigh"
    ? "high"
    : (EFFORT_LEVELS as readonly (string | null | undefined)[]).includes(e)
      ? (e as EffortLevel)
      : "medium";
