import {
  type CodingPlan,
  claudeCodeModel,
  type PlanModel,
  planModel,
  planModelValue,
  planOf,
} from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";
import type { AgentBrain } from "../api/types";
import { isAuto } from "./providers";

export * from "@agenteschat/providers/plans";

export interface BrainModelChoice extends Pick<PlanModel, "label" | "tag" | "needs" | "maker"> {
  value: string;
}

/**
 * A computer brain's model choices (web and phone): every model of the account's coding plan, each by its alias
 * where it has one (`planModelValue`), else the brain's own (`models`, Claude's aliases or Codex's).
 */
export const brainModelChoices = (
  plan: CodingPlan | undefined,
  models: readonly { value: string; label: string }[],
): BrainModelChoice[] =>
  plan
    ? plan.claudeCode.models.map((m) => ({
        value: planModelValue(m),
        label: m.label,
        ...(m.tag ? { tag: m.tag } : {}),
        ...(m.needs ? { needs: m.needs } : {}),
        ...(m.maker ? { maker: m.maker } : {}),
      }))
    : models.map(({ value, label }) => ({ value, label }));

/**
 * The choice a stored model shows as: on a plan, the model it runs there (an alias the plan leaves out or another
 * plan's model: `sonnet`'s); on Claude, another plan's model as Sonnet; `auto` and Codex's as stored.
 */
export function brainModelChoice(kind: string, plan: CodingPlan | undefined, value: string): string {
  if (kind !== "claude_code" || isAuto(value)) return value;
  return plan ? planModelValue(planModel(plan, value)) : claudeCodeModel(undefined, value);
}

/** The plan of an account (its `provider`), or none for the CLI's own sign-in. */
export const accountPlan = (account: { provider: string | null } | null | undefined) => planOf(account?.provider);

/** The plan of the account an agent thinks with, which names its models. */
export const brainPlan = (view: Pick<AgentBrain, "account" | "accounts">) =>
  accountPlan(view.accounts.find((a) => a.id === view.account));

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
