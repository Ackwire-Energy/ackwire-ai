import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { planTerms } from "@agenteschat/client/lib/plans";
import { InfoHint, Switch } from "@agenteschat/ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";

/**
 * "Responde a todos" (ADR 0059 §5): off, an agent on its owner's plan replies only to them; on, to everyone who may
 * talk to it. Under it, a line saying the plan's terms are a gray area there, what they say behind its ⓘ. A plan's
 * panel and the agent's page draw the same.
 */
export function PlanReplies({
  on,
  onChange,
  all = false,
  brain,
  plan,
  maker,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** For every agent of a plan's panel ("Respondem a todos"). */
  all?: boolean;
  brain: "claude_code" | "codex";
  /** The account's plan as the CLI says it (`max`, `team`…): a seat has its own words. */
  plan?: string | null;
  /** A coding plan's maker, whose own words they are. */
  maker?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const terms = planTerms(t, brain, plan, maker);
  return (
    <div className="plan-replies">
      <label htmlFor={id}>{t(all ? "aiAccounts.share.switchAll" : "aiAccounts.share.switch")}</label>
      <Switch id={id} checked={on} onCheckedChange={onChange} disabled={disabled} aria-describedby={`${id}-terms`} />
      <span className="plan-replies__terms ac-hintline">
        <span>{terms.line}</span>
        <InfoHint name={t("common.about", { label: terms.line })} id={`${id}-terms`}>
          {terms.text}
        </InfoHint>
      </span>
    </div>
  );
}

/** The same place for someone who isn't the plan's owner: whom the agent replies to, and who decides. */
export function PlanRepliesOf({ on, owner, agentName }: { on: boolean; owner: string; agentName: string }) {
  const { t } = useTranslation();
  return (
    <div className="plan-replies">
      <b>{on ? t("aiAccounts.share.switch") : t("aiAccounts.share.switchOther", { name: owner })}</b>
      <span className="plan-replies__terms">
        {t("aiAccounts.share.onOther", { ...agentGrammar(t, agentName), owner })}
      </span>
    </div>
  );
}
