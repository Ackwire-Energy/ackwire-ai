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
import { agentGrammar } from "./grammar";
import { isAuto } from "./providers";

export * from "@agenteschat/providers/plans";

export interface BrainModelChoice extends Pick<PlanModel, "label" | "tag" | "needs" | "maker"> {
  value: string;
  /** Cursor: its CLI said the person's plan includes it (the others cost API prices there). */
  inPlan?: boolean;
}

/**
 * A computer brain's model choices (web and phone): every model of the account's coding plan, each by its alias
 * where it has one (`planModelValue`), else the brain's own (`models`, Claude's aliases or Codex's).
 */
export const brainModelChoices = (
  plan: CodingPlan | undefined,
  models: readonly { value: string; label: string; inPlan?: boolean }[],
): BrainModelChoice[] =>
  plan
    ? plan.claudeCode.models.map((m) => ({
        value: planModelValue(m),
        label: m.label,
        ...(m.tag ? { tag: m.tag } : {}),
        ...(m.needs ? { needs: m.needs } : {}),
        ...(m.maker ? { maker: m.maker } : {}),
      }))
    : models.map(({ value, label, inPlan }) => ({ value, label, ...(inPlan ? { inPlan } : {}) }));

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
/**
 * A Cursor account made with its API key instead of a sign-in (ADR 0114): the key step as a coding plan's, the key
 * made in Cursor's dashboard. Not a coding plan: Cursor's CLI thinks with it, never Claude Code.
 */
export const CURSOR_KEY_PLAN: Pick<CodingPlan, "label" | "name" | "maker" | "site" | "keyPattern" | "placeholder"> = {
  label: "Cursor",
  name: "Cursor API key",
  maker: "Cursor",
  site: "https://cursor.com/dashboard?tab=integrations",
  keyPattern: "^[\\x21-\\x7e]{16,512}$",
  placeholder: "key_",
};

/**
 * The key step an account sign-in shows, if any: a coding plan's (its `provider`), or Cursor's API key when chosen
 * under Cursor's sign-in; and the `provider` the sign-in starts with.
 */
export function signInKey(provider: string | undefined, kind: string, cursorKey: boolean) {
  const coding = planOf(provider);
  if (coding) return { plan: coding as typeof CURSOR_KEY_PLAN, provider };
  return kind === "cursor" && cursorKey
    ? { plan: CURSOR_KEY_PLAN, provider: "cursor" }
    : { plan: undefined, provider: undefined };
}

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
    brain: "claude_code" | "codex" | "cursor";
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
