import type { Message } from "@agenteschat/client";
import { useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { mayContinueUsage, type UsagePauseCard, usagePauseText } from "@agenteschat/client/lib/usage-pause";
import { Button, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * Long work paused near its plan's or budget's limit (ADR 0118), in place of its text: when it picks up by itself,
 * and Continuar agora for the person behind the work, the agent's owner and admins. Anyone else sees the button
 * greyed with who may press it.
 */
export function UsagePauseCardView({ message, card }: { message: Message; card: UsagePauseCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const { title, line } = usagePauseText(t, i18n.language, card, name);
  const may = mayContinueUsage(card, me.user.id, agent?.ownerUserId, can(org, "manage_agents"));
  const by = card.continuedByUserId;
  const time = card.continuedAt ? clockAt(i18n.language, card.continuedAt) : "";
  const go = async () => {
    setPending(true);
    try {
      await api.chat.answerNow(org.id, message.id);
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setPending(false);
    }
  };
  const done = card.state !== "paused";
  return (
    <div className="waitcard" data-done={done || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={done ? "check" : "pause"} size={16} />
        <span>{title}</span>
      </span>
      {card.state === "continued" && by ? (
        <span className="small muted">
          {by === me.user.id
            ? t("stretchCard.continuedByYou", { time })
            : t("stretchCard.continued", { name: dir.memberById.get(by)?.name ?? t("channel.unknownPerson"), time })}
        </span>
      ) : card.state === "resumed" ? (
        <span className="small muted">{t("usageCard.resumed", { agent: name })}</span>
      ) : (
        <>
          <span className="small muted">{line}</span>
          <span className="waitcard__acts">
            <Button
              size="sm"
              variant="primary"
              loading={pending}
              disabled={!may}
              title={
                may ? t(card.source === "budget" ? "usageCard.hintBudget" : "usageCard.hint") : t("usageCard.forbidden")
              }
              onClick={go}
            >
              {t("usageCard.continue")}
            </Button>
            {!may && <span className="small muted">{t("usageCard.forbidden")}</span>}
          </span>
        </>
      )}
    </div>
  );
}
