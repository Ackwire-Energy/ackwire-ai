import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type CodingPlan, planReplies } from "@agenteschat/client/lib/plans";
import { InfoHint, Switch } from "@agenteschat/ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";

/**
 * "Atende outras pessoas" (ADR 0059 §5): off, an agent on its owner's plan answers only them; on, everyone who may
 * talk to it. Under it, a line saying which, on which plan, and the plan's terms behind its ⓘ. A plan's panel and
 * the agent's page draw the same.
 */
export function PlanReplies({
  on,
  onChange,
  agent,
  brain,
  plan,
  coding,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** The agent's name, or null for every agent of a plan's panel ("Atendem outras pessoas"). */
  agent: string | null;
  brain: "claude_code" | "codex" | "cursor";
  /** The account's plan as the CLI says it (`max`, `team`…): a seat has its own words. */
  plan?: string | null;
  /** A coding plan, named by the line, its maker's words behind the ⓘ. */
  coding?: CodingPlan;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const says = planReplies(t, { on, agent, brain, plan, coding });
  return (
    <div className="plan-replies">
      <label htmlFor={id}>{t(agent === null ? "aiAccounts.share.switchAll" : "aiAccounts.share.switch")}</label>
      <Switch
        id={id}
        checked={on}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-describedby={`${id}-line ${id}-terms`}
      />
      <span className="plan-replies__terms ac-hintline">
        <span id={`${id}-line`}>{says.line}</span>
        <InfoHint name={says.about} id={`${id}-terms`}>
          {says.text}
        </InfoHint>
      </span>
    </div>
  );
}

/** The same place for someone who isn't the plan's owner: whom the agent answers, and who decides. */
export function PlanRepliesOf({ on, owner, agentName }: { on: boolean; owner: string; agentName: string }) {
  const { t } = useTranslation();
  return (
    <div className="plan-replies">
      <b>{on ? t("aiAccounts.share.switch") : t("aiAccounts.share.switchOther", { owner })}</b>
      <span className="plan-replies__terms">
        {t("aiAccounts.share.onOther", { ...agentGrammar(t, agentName), owner })}
      </span>
    </div>
  );
}
