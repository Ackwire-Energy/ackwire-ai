import type { DecidedBy, Message } from "@agenteschat/client";
import { type ReceiptPhase, type ReceiptView, receiptView } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { planLabel, planMark } from "@agenteschat/client/lib/no-ai";
import { Icon, type IconName, InfoHint, Popover, ProviderLogo } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useConnectAi } from "@/components/ConnectAi";
import { HelpLink } from "@/components/HelpLink";
import { useDirectory } from "@/hooks/useDirectory";
import { useModelLabel } from "@/hooks/useModelLabel";
import { useLive } from "@/realtime/context";
import { CallAgentMenu, useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";

/** Which icon the receipt shows: one check (seen), two (answered), clock (answering/waiting), alert (failed). */
export function receiptIcon(view: ReceiptView): IconName {
  const kind = view.status?.kind;
  if (kind === "failed" || kind === "no_ai") return "alert";
  if (kind === "claimed" || kind === "waiting" || kind === "asking") return "waiting";
  if (kind === "handled") return "checks";
  return "check";
}

/** A rule's line leads with what it follows: the reply, the one person with the agent, the talk. */
const RULE_ICON: Record<Extract<DecidedBy, { step: "rule" }>["rule"], IconName> = {
  reply: "reply",
  only_agent: "person",
  follow_up: "thread",
};

/**
 * Under a person's message: a small muted check (our icons). Clicking or
 * focusing it opens a popover with each agent and its status, and who picked
 * them. Words only for what you can act on ("Nenhum agente vai responder", a
 * failure, no AI connected), and while the author's own plan picks.
 */
export function MessageReceipts({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const connect = useConnectAi();
  const modelLabel = useModelLabel();
  const receipt = useLive((s) => s.receipts[message.id]);
  const view = receiptView(receipt);
  const status = view.status;
  if (view.picking) {
    return (
      <div className="ac-receipt">
        <span className="ac-receipt__clock">
          <Icon name="waiting" />
        </span>
        <span>{t("receipts.picking")} ·</span>
        <CallAgentMenu />
      </div>
    );
  }
  if (view.seen.length === 0 && status?.kind !== "no_ai" && status?.kind !== "platform_cap") return null;

  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const names = (ids: string[]) => joinNames(ids.map(name), t("newAgent.and"));
  const mentionNeeded = status?.kind === "nobody" && status.mentionNeeded === true;
  const statusText =
    status === null
      ? ""
      : status.kind === "nobody"
        ? t(mentionNeeded ? "receipts.mentionNeeded" : "receipts.nobody")
        : status.kind === "no_ai"
          ? t("noAi.receipt")
          : status.kind === "platform_cap"
            ? t("receipts.platformCap")
            : t(`receipts.${status.kind}`, { count: status.agents.length, names: names(status.agents) });
  const label = [view.seen.length > 0 && t("receipts.seenBy", { names: names(view.seen) }), statusText]
    .filter(Boolean)
    .join("; ");
  const phases = new Map<string, ReceiptPhase>(receipt?.agents ?? []);
  const phaseText = (id: string) => {
    const phase = phases.get(id) ?? "seen";
    if (phase === "no_ai") return t("noAi.chip");
    return view.referenced.includes(id) && phase === "seen"
      ? t("receipts.status.referenced")
      : t(`receipts.status.${phase}`);
  };
  // Who picked, once an agent was picked: a decision for nobody keeps its line under the message.
  const picked =
    status && status.kind !== "nobody" && status.kind !== "no_ai" && status.kind !== "platform_cap"
      ? status.agents
      : [];
  const decider = (by: DecidedBy): { lead: ReactNode; text: string } | null => {
    if (by.step === "jev") return { lead: <ProviderLogo id="typesafe" size="xs" />, text: t("receipts.by.jev") };
    if (by.step === "model") {
      const model = modelLabel(by.model);
      return model
        ? { lead: <ProviderLogo id={by.provider} size="xs" />, text: t("receipts.by.model", { model }) }
        : null;
    }
    if (by.step === "plan") {
      const brand = planLabel(t, by.brand);
      const person = dir.memberById.get(by.ownerId)?.name ?? t("channel.unknownPerson");
      return {
        lead: <ProviderLogo id={planMark(by.brand)} size="xs" />,
        text:
          by.ownerId === me.user.id
            ? t("receipts.by.planYours", { brand })
            : t("receipts.by.planOf", { brand, person }),
      };
    }
    const agent = picked[0];
    return agent
      ? {
          lead: <Icon name={RULE_ICON[by.rule]} size={14} />,
          text: t(`receipts.by.${by.rule}`, agentGrammar(t, name(agent))),
        }
      : null;
  };
  const by = view.decidedBy && picked.length > 0 ? decider(view.decidedBy) : null;

  return (
    <div className="ac-receipt">
      {view.seen.length > 0 && (
        <Popover
          label={t("receipts.popoverTitle")}
          trigger={
            <button
              type="button"
              className="ac-receipt__check"
              aria-label={label}
              data-state-kind={status?.kind ?? "seen"}
            >
              <Icon name={receiptIcon(view)} />
            </button>
          }
        >
          <div className="ac-popover__title">{t("receipts.popoverTitle")}</div>
          {view.seen.map((id) => (
            <div key={id} className="ac-popover__row">
              <AgentAvatar agentId={id} size="xs" name={name(id)} />
              <span>{name(id)}</span>
              <span className="ac-popover__row-status">{phaseText(id)}</span>
            </div>
          ))}
          {by && (
            <div className="who-by ac-iconline">
              {by.lead}
              <span>{by.text}</span>
            </div>
          )}
          {mentionNeeded && (
            <div className="who-by">
              <HelpLink slug="who-answers">{t("routing.how")}</HelpLink>
            </div>
          )}
        </Popover>
      )}
      {status?.kind === "failed" && actions && (
        <>
          <span>{t("receipts.failedShort")} ·</span>
          <button type="button" className="ac-receipt__action" onClick={() => actions.resend(message.body)}>
            {t("receipts.retry")}
          </button>
        </>
      )}
      {status?.kind === "nobody" &&
        (mentionNeeded ? (
          <>
            <span className="ac-hintline">
              <span>{t("receipts.mentionNeeded")}</span>
              <InfoHint name={t("common.about", { label: t("routing.title") })}>
                {t("receipts.mentionNeededHint")}
              </InfoHint>
            </span>
            <span>·</span>
            <CallAgentMenu />
          </>
        ) : (
          <>
            <span>{t("receipts.nobody")} ·</span>
            <CallAgentMenu />
          </>
        ))}
      {status?.kind === "platform_cap" && <span>{t("receipts.platformCap")}</span>}
      {status?.kind === "no_ai" && (
        <>
          <span>
            {t("noAi.receipt")}
            {connect && " ·"}
          </span>
          {connect && (
            <button
              type="button"
              className="ac-receipt__action"
              onClick={() =>
                connect.open({
                  intent: receipt?.noAi?.intent,
                  provider: receipt?.noAi?.provider,
                  agentId: status.agents.length === 1 ? status.agents[0] : undefined,
                  from: message.id,
                })
              }
            >
              {t("noAi.action")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
