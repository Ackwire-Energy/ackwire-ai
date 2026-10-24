import { type CodingPlan, planAliases, planModel, planOf } from "@agenteschat/providers/plans";

export * from "@agenteschat/providers/plans";

/** The brain page's model choices for an account on a coding plan: Claude Code's aliases, named after the plan's models. */
export const planModelOptions = (plan: CodingPlan) =>
  planAliases(plan).map((value) => ({ value, label: planModel(plan, value).label }));

/** The plan of an account (its `provider`), or none for the CLI's own sign-in. */
export const accountPlan = (account: { provider: string | null } | null | undefined) => planOf(account?.provider);

/** The plan as the CLI says it (`team`, `max`), as a name ("Team"). */
export const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
