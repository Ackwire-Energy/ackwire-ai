/** Picks the remembered organization if the person still belongs to it, else the first one (pure). */
export function chooseOrg(orgs: readonly { id: string }[], remembered: string | null): string | null {
  if (remembered && orgs.some((o) => o.id === remembered)) return remembered;
  return orgs[0]?.id ?? null;
}

/**
 * Whether the first run (signed in, no workspace yet) is mounted (pure). An invitation's screen goes in front of it:
 * one already mounted stays, hidden, so its answers and the workspace it made survive the visit; one not yet mounted
 * waits for that screen to close, since its first field takes the keyboard as it mounts.
 */
export const firstRunMounted = (wasMounted: boolean, firstRun: boolean, onInvite: boolean) =>
  firstRun && (wasMounted || !onInvite);

/**
 * The chosen organization when it is suspended (ADR 0056 §8): why, when the workspace is told, and the person's
 * other organizations to go to; null while it isn't (pure).
 */
export function suspendedOf<O extends { id: string; standing?: { state: string; reason: string | null } }>(
  orgs: readonly O[],
  orgId: string | null,
): { reason: string | null; others: O[] } | null {
  const org = orgs.find((o) => o.id === orgId);
  if (org?.standing?.state !== "suspended") return null;
  return {
    reason: org.standing.reason,
    others: orgs.filter((o) => o.id !== org.id && o.standing?.state !== "suspended"),
  };
}
