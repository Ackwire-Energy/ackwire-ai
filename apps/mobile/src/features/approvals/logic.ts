import type { Approval } from "@agenteschat/client";

/**
 * A request an agent makes before a sensitive action: how risky it is (high
 * risk takes a hold, never a tap), the facts the sheet lists, and the order
 * of what waits on you.
 */

// The verb, the risk and the chips are the web's own rules (`@agenteschat/client/lib/approval-kind`).
export {
  type ApprovalAction,
  type ApprovalTrait,
  approvalAction,
  approvalRisk,
  approvalTraits,
} from "@agenteschat/client/lib/approval-kind";

/** The exact values the action runs with: top-level text, numbers and yes/no (at most `max`). */
export function approvalFacts(params: Record<string, unknown> | undefined, max = 6): [string, string][] {
  return Object.entries(params ?? {})
    .filter(
      (e): e is [string, string | number | boolean] =>
        (typeof e[1] === "string" && e[1].trim() !== "") || typeof e[1] === "number" || typeof e[1] === "boolean",
    )
    .slice(0, max)
    .map(([k, v]) => [humanKey(k), String(v)]);
}

/** `pull_number` → "Pull number". */
export function humanKey(key: string) {
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Waiting on you: pending ones you may decide, the one closest to expiring first. */
export function waitingApprovals(list: Approval[], now = Date.now()): Approval[] {
  return list
    .filter((a) => a.status === "pending" && a.canDecide && new Date(a.expiresAt).getTime() > now)
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

/**
 * The details table of a request: where it goes
 * (`via`: the connector and its account) first, then the exact values it runs with. Only what the
 * request carries; nothing is made up. `label: null` is the "Por onde" row (its label is translated).
 */
export function approvalTable(
  a: Pick<Approval, "params" | "connector" | "connectorAccount">,
  max = 3,
  connectorName: (id: string) => string = (id) => id,
): { label: string | null; value: string }[] {
  const via = a.connector ? [connectorName(a.connector), a.connectorAccount].filter(Boolean).join(" · ") : "";
  const rows: { label: string | null; value: string }[] = via ? [{ label: null, value: via }] : [];
  for (const [label, value] of approvalFacts(a.params, max)) rows.push({ label, value });
  return rows.slice(0, max);
}

/** What the agent said right before asking: its `why`, else the last turn of the trail. */
export function approvalSaid(a: Pick<Approval, "why" | "trail">): string | null {
  const why = a.why?.trim();
  if (why) return why;
  const last = a.trail?.at(-1)?.text.trim();
  return last || null;
}
