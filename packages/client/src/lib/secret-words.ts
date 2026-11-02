import type { TFunction } from "i18next";
import type { SecretRequest } from "../api/types";

/**
 * How a closed secret request ended, as the line that takes its card's place says it, the same on the web and the
 * phone: "Entregue por você", "Recusado", "Expirou", "Cancelado", "Não precisa mais". The secret's name goes with it, never its value.
 */
export function secretOutcome(
  t: TFunction,
  r: Pick<SecretRequest, "status" | "withdrawn">,
  mine: boolean,
  person: string,
): string {
  if (r.withdrawn) return t("secret.outcomeWithdrawn");
  if (r.status === "delivered") return mine ? t("secret.outcomeByYou") : t("secret.outcomeBy", { person });
  if (r.status === "declined") return t("approvals.status.refused");
  return t(r.status === "canceled" ? "approvals.status.canceled" : "approvals.status.expired");
}

/** When a closed secret request ended: its delivery, or its deadline when it ran out. */
export const secretEndedAt = (r: Pick<SecretRequest, "status" | "deliveredAt" | "expiresAt">) =>
  r.status === "delivered" ? r.deliveredAt : r.status === "canceled" || r.status === "declined" ? null : r.expiresAt;
