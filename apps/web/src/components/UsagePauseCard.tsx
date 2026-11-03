import type { Message } from "@agenteschat/client";
import { useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  mayContinueUsage,
  type UsagePauseCard,
  type UsageWait,
  usagePauseText,
} from "@agenteschat/client/lib/usage-pause";
import { Button, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { SeeUsageQueue } from "@/components/UsageQueue";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * "Don't run it" on what waits for a plan's or budget's limit: cancels the run (`cancelRun`), so nothing runs when the
 * limit is back. For the person behind it, the agent's owner and admins; anyone else sees it greyed.
 */
function useDontRun(runId: string | null) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = async () => {
    if (!runId) return;
    setPending(true);
    try {
      await api.agents.cancelRun(org.id, runId);
      toast.show(t("usageCard.canceled"));
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setPending(false);
    }
  };
  return { run, pending };
}

function DontRunButton({ runId, may, count = 1 }: { runId: string | null; may: boolean; count?: number }) {
  const { t } = useTranslation();
  const dontRun = useDontRun(runId);
  if (!runId) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="stop"
      loading={dontRun.pending}
      disabled={!may}
      title={t(may ? "usageCard.dontRunHint" : "usageCard.dontRunForbidden")}
      onClick={dontRun.run}
    >
      {count > 1 ? t("usageCard.dontRunThese", { count }) : t("usageCard.dontRun")}
    </Button>
  );
}

/**
 * Under an agent's "I'll answer when the plan resets": "Don't run it" ("Não rodar estas 3" for the later turns it
 * speaks for), while the run still waits, and "Ver fila": everything else it picks up when the limit is back.
 */
export function UsageWaitCancel({ message, wait }: { message: Message; wait: UsageWait }) {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const owner = dir.agentById.get(message.author.id ?? "")?.ownerUserId;
  const may = mayContinueUsage(wait, me.user.id, owner, can(org, "manage_agents"));
  return (
    <span className="waitcard__acts">
      <DontRunButton runId={wait.runId} may={may} count={wait.count} />
      {message.author.id && <SeeUsageQueue agentId={message.author.id} />}
    </span>
  );
}

/**
 * Long work paused near its plan's or budget's limit (ADR 0118), in place of its text: when it picks up by itself,
 * and Continuar agora or "Don't run it" for the person behind the work, the agent's owner and admins. Anyone else
 * sees the buttons greyed with who may press them.
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
      ) : card.state === "resumed" || card.state === "ended" || card.state === "canceled" ? (
        <span className="small muted">{t(`usageCard.${card.state}`, { agent: name })}</span>
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
            <DontRunButton runId={card.runId} may={may} />
            {!may && <span className="small muted">{t("usageCard.forbidden")}</span>}
          </span>
        </>
      )}
    </div>
  );
}
