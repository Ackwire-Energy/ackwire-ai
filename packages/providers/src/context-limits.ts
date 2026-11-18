/**
 * How much context an agent reads (`agents.context_tokens`): pure data, read by the engine and the apps, so it
 * imports nothing. None chosen is the model's own window. A limit past a model's window means that window: the
 * smaller one wins at run time, so changing the model never needs the limit changed.
 */
export const CONTEXT_LIMITS = [200_000, 400_000, 1_000_000] as const;
export type ContextLimit = (typeof CONTEXT_LIMITS)[number];
export const isContextLimit = (v: unknown): v is ContextLimit => (CONTEXT_LIMITS as readonly unknown[]).includes(v);

/**
 * "Automático" on Claude Code and Codex: they summarise here, not at the model's window, since every step of a long
 * run re-reads the whole context. Other programs take no limit, and the model brain has its own cap.
 */
export const autoContextFor = (kind: string | null | undefined): ContextLimit | null =>
  kind === "claude_code" || kind === "codex" ? 200_000 : null;

/** The limits worth offering under a window: one at or past it reads the same as none. */
export const contextLimitsFor = (windowTokens: number): ContextLimit[] =>
  CONTEXT_LIMITS.filter((n) => n <= windowTokens);

/** The window a run reads: the model's, or the agent's limit when smaller. */
export const contextWindowWithin = (windowTokens: number, limit: number | null | undefined) =>
  limit && limit > 0 ? Math.min(windowTokens, limit) : windowTokens;
