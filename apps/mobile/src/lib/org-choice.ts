import type { OrgSummary } from "@agenteschat/client";
import { settingUp } from "@agenteschat/client/lib/guards";
import type { ServerProblem } from "@agenteschat/client/lib/server";

/**
 * The workspaces the app opens (pure): not one this person is still setting up, which only the first run opens (it
 * resumes it), so with none left the first run shows.
 */
export const openOrgs = <O extends OrgSummary>(orgs: readonly O[]) => orgs.filter((o) => !settingUp(o));

/**
 * Whether a tapped push about `orgId` opens its screen (pure): not for a workspace its owner is still setting up,
 * which the app doesn't open (switching to it would land on the current one's screen instead).
 */
export const pushOpens = (orgs: readonly OrgSummary[], orgId: string) =>
  !orgs.some((o) => o.id === orgId && settingUp(o));

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
 * The chosen organization when it is suspended (ADR 0056 §8): why, when the workspace is told, whether it is on
 * agentes.chat Cloud (how to contest it), and the person's other organizations to go to; null while it isn't (pure).
 */
export function suspendedOf<
  O extends { id: string; standing?: { state: string; reason: string | null; cloud?: boolean } },
>(orgs: readonly O[], orgId: string | null): { reason: string | null; cloud: boolean; others: O[] } | null {
  const org = orgs.find((o) => o.id === orgId);
  if (org?.standing?.state !== "suspended") return null;
  return {
    reason: org.standing.reason,
    cloud: org.standing.cloud === true,
    others: orgs.filter((o) => o.id !== org.id && o.standing?.state !== "suspended"),
  };
}

/** How long the account may load before the app asks the server itself whether it is there. */
export const SERVER_STUCK_MS = 10_000;

/**
 * Why the app can't open its server, or null while it can (pure). `unreachable`: the account failed to load with
 * nothing cached; `stuck`: it is still loading after `SERVER_STUCK_MS`; `check`: what `GET /api/instance` said,
 * once asked. A failed load is always shown (as "unreachable" when the server itself answers); a slow one only
 * once the server is known to be out of reach.
 */
export function serverDownOf(
  unreachable: boolean,
  stuck: boolean,
  check: { ok: true } | { ok: false; problem: ServerProblem } | null,
): ServerProblem | null {
  if (check && !check.ok && (unreachable || stuck)) return check.problem;
  return unreachable ? "unreachable" : null;
}
