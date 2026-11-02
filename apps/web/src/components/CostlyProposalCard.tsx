import type { CostlyDecision, Message } from "@agenteschat/client";
import { useApi } from "@agenteschat/client";
import { type CostlyProposalCard, mayDecideCostly } from "@agenteschat/client/lib/action-cards";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * An agent asks before costly work nobody asked for directly (ADR 0131 §3): what it wants to run, and Pode fazer,
 * Agora não, Sempre or Nunca for this kind, for the person it is for, the agent's owner or who manages agents. Then one
 * line says who decided what.
 */
export function CostlyProposalCardView({ message, card }: { message: Message; card: CostlyProposalCard }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const toast = useToast();
  const [pending, setPending] = useState<CostlyDecision | null>(null);
  const may = mayDecideCostly(card, me.user.id, (id) => dir.agentById.get(id)?.ownerUserId, can(org, "manage_agents"));
  const decide = async (decision: CostlyDecision) => {
    setPending(decision);
    try {
      await api.agents.decideCostly(org.id, card.signalId, decision);
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setPending(null);
    }
  };
  const decided = card.state !== "open";
  const by = card.decidedByUserId;
  const who =
    by === me.user.id ? t("costlyCard.you") : (dir.memberById.get(by ?? "")?.name ?? t("channel.unknownPerson"));
  return (
    <div className="waitcard" data-done={decided || undefined} data-message={message.id}>
      <span className="waitcard__top ac-iconline">
        <Icon name={decided ? "check" : "shield"} size={16} />
        <span>{t(`chat.body.autonomy_proposal.${card.cost}`)}</span>
      </span>
      {card.what && <code className="small">{card.what}</code>}
      {decided ? (
        <span className="small muted">
          {t(`costlyCard.decided.${card.state === "open" ? "go" : card.state}`, { name: who })}
        </span>
      ) : may ? (
        <span className="waitcard__acts">
          <Button size="sm" variant="primary" loading={pending === "go"} onClick={() => decide("go")}>
            {t("costlyCard.go")}
          </Button>
          <Button size="sm" loading={pending === "always"} onClick={() => decide("always")}>
            {t("costlyCard.always")}
          </Button>
          <Button size="sm" variant="ghost" loading={pending === "not_now"} onClick={() => decide("not_now")}>
            {t("costlyCard.notNow")}
          </Button>
          <Button size="sm" variant="ghost" loading={pending === "never"} onClick={() => decide("never")}>
            {t("costlyCard.never")}
          </Button>
        </span>
      ) : (
        <span className="small muted">{t("costlyCard.waiting")}</span>
      )}
    </div>
  );
}
