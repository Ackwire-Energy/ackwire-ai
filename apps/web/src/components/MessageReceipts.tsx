import { Avatar, Icon, type IconName, Popover } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import type { Message } from "@/api/types";
import { useDirectory } from "@/hooks/useDirectory";
import { joinNames } from "@/lib/format";
import { useLive } from "@/realtime/context";
import { type ReceiptPhase, type ReceiptView, receiptView } from "@/realtime/receipts";
import { CallAgentMenu, useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";

/** Which icon the receipt shows: one check (seen), two (answered), clock (answering/waiting), alert (failed). */
export function receiptIcon(view: ReceiptView): IconName {
  const kind = view.status?.kind;
  if (kind === "failed") return "alert";
  if (kind === "claimed" || kind === "waiting") return "waiting";
  if (kind === "handled") return "checks";
  return "check";
}

/**
 * Under a person's message: a small muted check (our icons). Clicking or
 * focusing it opens a popover with each agent and its status. Words only for
 * what you can act on ("Nenhum agente vai responder", a failure).
 */
export function MessageReceipts({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const receipt = useLive((s) => s.receipts[message.id]);
  const view = receiptView(receipt);
  if (view.seen.length === 0) return null;

  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const names = (ids: string[]) => joinNames(ids.map(name), t("newAgent.and"));
  const status = view.status;
  const statusText =
    status === null
      ? ""
      : status.kind === "nobody"
        ? t("receipts.nobody")
        : t(`receipts.${status.kind}`, { count: status.agents.length, names: names(status.agents) });
  const label = [t("receipts.seenBy", { names: names(view.seen) }), statusText].filter(Boolean).join("; ");
  const phases = new Map<string, ReceiptPhase>(receipt?.agents ?? []);

  return (
    <div className="ac-receipt">
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
            <Avatar kind="agent" size="xs" name={name(id)} initials={dir.agentInitials(id)} />
            <span>{name(id)}</span>
            <span className="ac-popover__row-status">{t(`receipts.status.${phases.get(id) ?? "seen"}`)}</span>
          </div>
        ))}
      </Popover>
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
    </div>
  );
}
