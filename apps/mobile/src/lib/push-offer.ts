/**
 * When our notifications sheet opens by itself (pure: no React Native import, so it is unit-tested). It
 * comes before the system's prompt, on Conversas only (never inside a conversation): once when the home has
 * loaded with something on it, and once more at the first request to approve, while the phone hasn't been
 * asked yet. "Agora não" doesn't spend the system's prompt: Você › Avisos turns them on any time.
 */

export type PushPermissionLike = "granted" | "denied" | "undetermined";

/** The moments the sheet may open: the home loaded, or a request to approve waits there. */
export type PushOfferMoment = "home" | "approval";

/** How many times it opens by itself, at most (the home, then the first request to approve). */
export const MAX_PUSH_OFFERS = 2;

/** The offers made so far, from the stored count; a phone the old flow already asked gets none. */
export function pushOffersFrom(raw: string | null, alreadyAsked: boolean): number {
  if (alreadyAsked) return MAX_PUSH_OFFERS;
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_PUSH_OFFERS, n)) : 0;
}

/** Whether the sheet opens at `moment`: the system hasn't been asked, the person didn't turn them off. */
export function pushOfferDue(
  state: { permission: PushPermissionLike | null; turnedOff: boolean; offers: number },
  moment: PushOfferMoment,
): boolean {
  if (state.permission !== "undetermined" || state.turnedOff) return false;
  return state.offers === (moment === "home" ? 0 : 1);
}

/** The three example notifications' senders: the workspace's own agents, else `someone` ("Um agente"). */
export function exampleSenders(names: readonly string[], someone: string): [string, string, string] {
  const own = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const at = (i: number) => own[i] ?? own[0] ?? someone;
  return [at(0), at(1), at(2)];
}
