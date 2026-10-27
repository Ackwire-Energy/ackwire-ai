import type { Message } from "@agenteschat/client";
import { type ReceiptPhase, type ReceiptView, receiptView } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { Icon, type IconName, Popover } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useConnectAi } from "@/components/ConnectAi";
import { useDirectory } from "@/hooks/useDirectory";
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

/**
 * Under a person's message: a small muted check (our icons). Clicking or
 * focusing it opens a popover with each agent and its status. Words only for
 * what you can act on ("Nenhum agente vai responder", a failure, no AI connected).
 */
export function MessageReceipts({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const connect = useConnectAi();
  const receipt = useLive((s) => s.receipts[message.id]);
  const view = receiptView(receipt);
  const status = view.status;
  if (view.seen.length === 0 && status?.kind !== "no_ai" && status?.kind !== "platform_cap") return null;

  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const names = (ids: string[]) => joinNames(ids.map(name), t("newAgent.and"));
  const statusText =
    status === null
      ? ""
      : status.kind === "nobody"
        ? t("receipts.nobody")
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
      {status?.kind === "nobody" && (
        <>
          <span>{t("receipts.nobody")} ·</span>
          <CallAgentMenu />
        </>
      )}
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
