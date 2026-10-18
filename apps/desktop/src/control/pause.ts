import type { RunnerPause } from "@agenteschat/adapters/machine-protocol";

/** The popover's pause choices. */
export type PauseChoice = "1h" | "tomorrow" | "manual";

/** `until` for a choice: an hour from now, tomorrow at 9:00 local time, or null (until resumed). */
export function pauseUntil(choice: PauseChoice, now: Date = new Date()): string | null {
  if (choice === "manual") return null;
  if (choice === "1h") return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  return t.toISOString();
}

/** "+1 hora" on a pause: one more hour from its end (or from now when it already ended). */
export function extendPause(pause: RunnerPause, now: Date = new Date()): string | null {
  if (pause.paused && !pause.until) return null;
  const end = pause.until ? Date.parse(pause.until) : Number.NaN;
  const from = Number.isFinite(end) && end > now.getTime() ? end : now.getTime();
  return new Date(from + 60 * 60 * 1000).toISOString();
}

/**
 * Several organizations, one pause: the one that ends last wins (null = until resumed beats any time).
 * Not paused anywhere → null.
 */
export function combinedPause(pauses: readonly RunnerPause[]): RunnerPause | null {
  const on = pauses.filter((p) => p.paused);
  if (on.length === 0) return null;
  if (on.some((p) => !p.until)) return { paused: true, until: null };
  const last = on.reduce((a, b) => (Date.parse(b.until ?? "") > Date.parse(a.until ?? "") ? b : a));
  return { paused: true, until: last.until ?? null };
}
