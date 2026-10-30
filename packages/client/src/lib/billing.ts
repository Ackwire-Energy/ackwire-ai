import type { OrgStanding } from "../api/types";

/** Mirror of the server's billing holds (`packages/engine/src/standing.ts`, ADR 0079). */
export const BILLING_HOLDS = ["payment", "unpaid", "ended"] as const;
export type BillingHold = (typeof BILLING_HOLDS)[number];

/**
 * The billing hold a workspace is on, or null: a hold whose told reason is one of the codes, which the apps say in
 * the person's words, never as it comes.
 */
export const billingHoldOf = (
  standing: Pick<OrgStanding, "state" | "reason"> | null | undefined,
): BillingHold | null =>
  standing?.state === "hold" ? (BILLING_HOLDS.find((code) => code === standing.reason) ?? null) : null;

/**
 * Back from a paid Checkout, the billing service adds `?paid=1` to the return path (ADR 0079): until the hold lifts,
 * the apps say the payment arrived. The router reads `1` as a number, and the onboarding forwards it as `true`.
 */
export const isPaidReturn = (search: Record<string, unknown>) => search.paid === 1 || search.paid === true;
