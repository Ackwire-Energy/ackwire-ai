import { ApprovalCard, Avatar, Button } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { useDecideApproval } from "@/api/queries";
import type { Agent, Approval, Channel } from "@/api/types";
import { relativeTime, timeLeft, whenAt } from "@/lib/format";
import { useOrg } from "./org-context";

/** "Aprovado por você · agora" / "Recusado por João · ontem 18:02". */
export function useDecisionLabel() {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  return (approval: Approval, now = new Date()) => {
    const when = approval.decidedAt ? whenAt(t, i18n.language, approval.decidedAt, now) : t("common.now");
    const mine = approval.decidedBy?.userId === me.user.id;
    const name = approval.decidedBy?.name ?? "";
    if (approval.status === "approved")
      return mine ? t("approval.approvedByYou", { when }) : t("approval.approvedBy", { name, when });
    return mine ? t("approval.refusedByYou", { when }) : t("approval.refusedBy", { name, when });
  };
}

/** The approval card inside the channel (telas/Main): full while waiting, one line once decided. */
export function InlineApproval({ approval, agent }: { approval: Approval; agent: Agent | undefined }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  const decisionLabel = useDecisionLabel();
  const name = agent?.name ?? t("channel.unknownAgent");

  if (approval.status !== "pending") {
    return (
      <ApprovalCard
        compact
        status={approval.status}
        aria-label={approval.status === "approved" ? t("approval.groupDone") : t("approval.groupRefused")}
        who={
          <Trans
            i18nKey="approval.doneWho"
            values={{ agent: name, title: approval.title.charAt(0).toLowerCase() + approval.title.slice(1) }}
            components={{ b: <b /> }}
          />
        }
        statusLabel={decisionLabel(approval)}
      />
    );
  }
  const left = timeLeft(t, approval.expiresAt);
  return (
    <ApprovalCard
      status="waiting"
      aria-label={t("approval.group")}
      who={<Trans i18nKey="approval.asks" values={{ agent: name }} components={{ b: <b /> }} />}
      statusLabel={t("approval.waitingYou")}
      title={approval.title}
      detail={`${approval.detail}${left ? ` · ${t("approval.expiresDetail", { time: left })}` : ""}`}
      actions={
        <>
          <Button
            variant="primary"
            size="sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: approval.id, decision: "approved" })}
          >
            {t(`approval.approve.${approval.action}`)}
          </Button>
          <Button
            size="sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: approval.id, decision: "refused" })}
          >
            {t("approval.refuse")}
          </Button>
          {approval.diffUrl && (
            <Button asChild variant="ghost" size="sm">
              <a href={approval.diffUrl} target="_blank" rel="noreferrer">
                {t("approval.viewDiff")}
              </a>
            </Button>
          )}
        </>
      }
    />
  );
}

/** The card on the Aprovações page (telas/Aprovacoes): avatar, channel link and time in the head. */
export function ApprovalListItem({
  approval,
  agent,
  channel,
}: {
  approval: Approval;
  agent: Agent | undefined;
  channel: Channel | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  const decisionLabel = useDecisionLabel();
  const name = agent?.name ?? t("channel.unknownAgent");
  const when = relativeTime(t, i18n.language, approval.createdAt);
  const left = timeLeft(t, approval.expiresAt);
  const pending = approval.status === "pending";
  const channelLink = channel ? (
    <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: channel.id }} />
  ) : (
    <span />
  );
  return (
    <ApprovalCard
      as="article"
      wide
      aria-label={approval.title}
      status={approval.status === "pending" ? "waiting" : approval.status}
      avatar={<Avatar kind="agent" size="sm" name={name} />}
      who={
        channel ? (
          <Trans
            i18nKey="approvals.who"
            values={{ agent: name, channel: channel.name, when }}
            components={{ b: <b />, link: channelLink }}
          />
        ) : (
          <Trans i18nKey="approvals.whoNoChannel" values={{ agent: name, when }} components={{ b: <b /> }} />
        )
      }
      statusLabel={
        pending ? (left ? t("approval.expiresIn", { time: left }) : t("approval.expired")) : decisionLabel(approval)
      }
      title={approval.title}
      detail={approval.detail}
      actions={
        pending && (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: approval.id, decision: "approved" })}
            >
              {t(`approval.approve.${approval.action}`)}
            </Button>
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: approval.id, decision: "refused" })}
            >
              {t("approval.refuse")}
            </Button>
            {channel && (
              <Button asChild variant="ghost" size="sm">
                <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: channel.id }}>
                  {t("approval.viewInChannel")}
                </Link>
              </Button>
            )}
          </>
        )
      }
    />
  );
}
