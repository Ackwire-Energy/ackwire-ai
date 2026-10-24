import type { Approval } from "../api/types";
import type { Words } from "./routine-view";

/**
 * An approval asked while nobody was watching (ADR 0053 §8), in words: "Pedido pela rotina «X» enquanto
 * ninguém acompanhava", or "Pedido enquanto ninguém acompanhava". Null when a person was there.
 */
export function approvalOriginWords(a: Pick<Approval, "origin">): Words | null {
  const o = a.origin;
  if (!o) return null;
  if (o.kind === "routine" && o.routineName) return { key: "approval.origin.routine", values: { name: o.routineName } };
  return { key: "approval.origin.unattended", values: {} };
}

/** Why the agent asks, trimmed; null when it said nothing. */
export const approvalWhy = (a: Pick<Approval, "why">) => a.why?.trim() || null;
