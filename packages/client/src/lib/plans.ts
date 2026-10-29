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
 * Under "Responde a todos" on a plan (ADR 0059 §5): a line saying the plan's terms are a gray area there, and for its
 * ⓘ what they say, in a coding plan's maker's words (`maker`), a seat's, else a personal plan's. Web and phone.
 */
export function planTerms(t: TFunction, brain: "claude_code" | "codex", plan?: string | null, maker?: string) {
  if (maker) return { line: t("aiAccounts.share.terms.linePlan"), text: t("aiAccounts.share.terms.other", { maker }) };
  const provider = t(`aiAccounts.connect.${brain}`);
  const seat = SEATS.has(plan?.toLowerCase() ?? "");
  return {
    line: t("aiAccounts.share.terms.line", { provider }),
    text: t(seat ? "aiAccounts.share.terms.seat" : "aiAccounts.share.terms.own", { provider }),
  };
}
