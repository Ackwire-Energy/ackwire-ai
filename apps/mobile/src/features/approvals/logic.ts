import type { Approval } from "@agenteschat/client";

/**
 * A request an agent makes before a sensitive action: how risky it is (high
 * risk takes a hold, never a tap), the facts the sheet lists, and the order
 * of what waits on you.
 */

export type ApprovalAction = "merge" | "deploy" | "rollback" | "publish" | "delete" | "send" | "other";

/** The verb of the action, from the tool and scope the agent asked for (same rule as the web). */
export function approvalAction(a: Pick<Approval, "tool" | "scope">): ApprovalAction {
  const text = `${a.tool} ${a.scope}`.toLowerCase();
  if (text.includes("merge")) return "merge";
  if (text.includes("rollback")) return "rollback";
  if (text.includes("deploy") || text.includes("workflow") || text.includes("actions.run")) return "deploy";
  if (/delete|remove|destroy|drop|purge/.test(text)) return "delete";
  if (/send|email|mail\b|sms/.test(text) && !text.includes("post_message")) return "send";
  if (text.includes("share") || text.includes("publish")) return "publish";
  return "other";
}

/** Production, can't be undone, or leaves the company: approving takes a hold. */
export function approvalRisk(a: Pick<Approval, "tool" | "scope">): "high" | "normal" {
  const action = approvalAction(a);
  return action === "deploy" || action === "rollback" || action === "delete" || action === "send" ? "high" : "normal";
}

/** What the action touches, as plain words (keys under `mobile.approval.trait.*`). */
export function approvalTraits(a: Pick<Approval, "tool" | "scope" | "params">) {
  const action = approvalAction(a);
  const values = Object.values(a.params ?? {})
    .filter((v) => typeof v === "string")
    .join(" ")
    .toLowerCase();
  const traits: ("production" | "irreversible" | "reversible" | "external")[] = [];
  if (action === "deploy" || action === "rollback" || /\bprod(uction)?\b/.test(values)) traits.push("production");
  if (action === "delete" || action === "send") traits.push("irreversible");
  else if (action === "merge" || action === "deploy") traits.push("reversible");
  if (action === "send" || action === "publish") traits.push("external");
  return traits;
}

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
