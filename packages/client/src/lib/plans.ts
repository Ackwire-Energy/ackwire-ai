import { type CodingPlan, planAliases, planModel, planOf } from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";

export * from "@agenteschat/providers/plans";

/** The brain page's model choices for an account on a coding plan: Claude Code's aliases, named after the plan's models. */
export const planModelOptions = (plan: CodingPlan) =>
  planAliases(plan).map((value) => ({ value, label: planModel(plan, value).label }));

/** The plan of an account (its `provider`), or none for the CLI's own sign-in. */
export const accountPlan = (account: { provider: string | null } | null | undefined) => planOf(account?.provider);

/** The plan as the CLI says it (`team`, `max`), as a name ("Team"). */
export const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

/** Team and enterprise seats are one person's each, not a personal subscription. */
const SEATS = new Set(["team", "enterprise"]);

/**
 * Before an agent answers other people on its owner's plan (ADR 0059 §5), the provider's own words about personal
 * use: a coding plan's maker's (`maker`), a seat's, else the personal plan's. The web's dialog and the phone's alert.
 */
export function sharePlanBody(
  t: TFunction,
  brain: "claude_code" | "codex",
  plan?: string | null,
  maker?: string,
): string {
  if (maker) return t("aiAccounts.share.body.other", { maker });
  return SEATS.has(plan?.toLowerCase() ?? "")
    ? t(`aiAccounts.share.body.seat.${brain}`)
    : t(`aiAccounts.share.body.${brain}`);
}
