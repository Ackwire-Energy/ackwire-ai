import { type CodingPlan, planAliases, planModel, planOf } from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";
import { agentGrammar } from "./grammar";

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
 * What "Atende outras pessoas" on a plan says (ADR 0059 §5), web and phone: the line under the switch, whom the agent
 * answers in that state and on which plan (`agent` null: every agent of a plan's panel), and for the line's ⓘ (named
 * `about`) what the plan's terms say, in a coding plan's maker's words (`coding`), a seat's, else a personal plan's.
 */
export function planReplies(
  t: TFunction,
  {
    on,
    agent,
    brain,
    plan,
    coding,
  }: {
    on: boolean;
    agent: string | null;
    brain: "claude_code" | "codex";
    /** The account's plan as the CLI says it (`max`, `team`…): a seat has its own words. */
    plan?: string | null;
    coding?: CodingPlan;
  },
) {
  const provider = t(`aiAccounts.connect.${brain}`);
  const seat = SEATS.has(plan?.toLowerCase() ?? "");
  const which = coding
    ? t("aiAccounts.share.plan.coding", { label: coding.label })
    : t(seat ? "aiAccounts.share.plan.seat" : "aiAccounts.share.plan.own", { provider });
  return {
    line:
      agent === null
        ? t(on ? "aiAccounts.share.line.onAll" : "aiAccounts.share.line.offAll", { plan: which })
        : t(on ? "aiAccounts.share.line.on" : "aiAccounts.share.line.off", { ...agentGrammar(t, agent), plan: which }),
    about: t("common.about", { label: t("aiAccounts.share.terms.about") }),
    text: coding
      ? t("aiAccounts.share.terms.other", { maker: coding.maker })
      : t(seat ? "aiAccounts.share.terms.seat" : "aiAccounts.share.terms.own", { provider }),
  };
}
