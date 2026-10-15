import { ApprovalCard, Avatar, Button } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { useDecideApproval } from "@/api/queries";
import type { Agent, Approval, Channel, Member } from "@/api/types";
import { relativeTime, timeLeft, whenAt } from "@/lib/format";
import { useOrg } from "./org-context";

export type ApprovalAction = "merge" | "deploy" | "rollback" | "publish" | "other";

/** The verb of the primary button ("Aprovar merge"), from the tool and scope the agent asked for. */
export function approvalAction(approval: Pick<Approval, "tool" | "scope">): ApprovalAction {
  const text = `${approval.tool} ${approval.scope}`.toLowerCase();
  if (text.includes("merge")) return "merge";
  if (text.includes("rollback")) return "rollback";
  if (text.includes("deploy") || text.includes("workflow") || text.includes("actions.run")) return "deploy";
  if (text.includes("share") || text.includes("publish")) return "publish";
  return "other";
}

/** "Aprovado por você · agora" / "Recusado por João · ontem 18:02" / "Expirou · ontem". */
export function decisionLabel(
  t: TFunction,
  locale: string,
  approval: Approval,
  meId: string,
  members: Map<string, Member>,
  now = new Date(),
) {
  const when = approval.decidedAt ? whenAt(t, locale, approval.decidedAt, now) : t("common.now");
  if (approval.status === "expired") return t("approval.expiredChip", { when });
  const mine = approval.decidedByUserId === meId;
  const name = members.get(approval.decidedByUserId ?? "")?.name ?? "";
  if (approval.status === "approved")
    return mine ? t("approval.approvedByYou", { when }) : t("approval.approvedBy", { name, when });
  return mine ? t("approval.refusedByYou", { when }) : t("approval.refusedBy", { name, when });
}

/** Chip of a pending approval you can't decide: who it waits for. */
function waitingFor(t: TFunction, agent: Agent | undefined, members: Map<string, Member>) {
  const owner = agent?.ownerUserId ? members.get(agent.ownerUserId) : undefined;
  return owner ? t("approval.waitingFor", { name: owner.name }) : t("approval.waitingAdmin");
}

function Actions({ approval, secondary }: { approval: Approval; secondary?: React.ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "approve"}
        onClick={() => decide.mutate({ id: approval.id, decision: "approve" })}
      >
        {t(`approval.approve.${approvalAction(approval)}`)}
      </Button>
      <Button
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => decide.mutate({ id: approval.id, decision: "refuse" })}
      >
        {t("approval.refuse")}
      </Button>
      {secondary}
    </>
  );
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The approval card inside the channel (telas/Main): full while waiting, one line once decided. */
export function InlineApproval({
  approval,
  agent,
  members,
}: {
  approval: Approval;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const name = agent?.name ?? t("channel.unknownAgent");

  if (approval.status !== "pending") {
    return (
      <ApprovalCard
        compact
        status={approval.status === "approved" ? "approved" : "refused"}
        aria-label={approval.status === "approved" ? t("approval.groupDone") : t("approval.groupRefused")}
        who={
          <Trans
            i18nKey="approval.doneWho"
            values={{ agent: name, title: lowerFirst(approval.title) }}
            components={{ b: <b /> }}
          />
        }
        statusLabel={decisionLabel(t, i18n.language, approval, me.user.id, members)}
        detail={approval.reason ? t("approval.reasonLine", { reason: approval.reason }) : undefined}
      />
    );
  }
  const left = timeLeft(t, approval.expiresAt);
  return (
    <ApprovalCard
      status="waiting"
      aria-label={t("approval.group")}
      who={<Trans i18nKey="approval.asks" values={{ agent: name }} components={{ b: <b /> }} />}
      statusLabel={approval.canDecide ? t("approval.waitingYou") : waitingFor(t, agent, members)}
      title={approval.title}
      detail={`${approval.detail}${left ? ` · ${t("approval.expiresDetail", { time: left })}` : ""}`}
      actions={approval.canDecide && <Actions approval={approval} />}
    />
  );
}

/** The card on the Aprovações page (telas/Aprovacoes): avatar, channel link and time in the head. */
export function ApprovalListItem({
  approval,
  agent,
  channel,
  members,
  initials,
}: {
  approval: Approval;
  agent: Agent | undefined;
  channel: Channel | undefined;
  members: Map<string, Member>;
  initials?: string;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const name = agent?.name ?? t("channel.unknownAgent");
  const when = relativeTime(t, i18n.language, approval.createdAt);
  const left = timeLeft(t, approval.expiresAt);
  const pending = approval.status === "pending";
  return (
    <ApprovalCard
      as="article"
      wide
      aria-label={approval.title}
      status={pending ? "waiting" : approval.status === "approved" ? "approved" : "refused"}
      avatar={<Avatar kind="agent" size="sm" name={name} initials={initials} />}
      who={
        channel ? (
          <Trans
            i18nKey="approvals.who"
            values={{ agent: name, channel: channel.name, when }}
            components={{
              b: <b />,
              link: <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: channel.id }} />,
            }}
          />
        ) : (
          <Trans i18nKey="approvals.whoNoChannel" values={{ agent: name, when }} components={{ b: <b /> }} />
        )
      }
      statusLabel={
        pending
          ? approval.canDecide
            ? left
              ? t("approval.expiresIn", { time: left })
              : t("approval.expired")
            : waitingFor(t, agent, members)
          : decisionLabel(t, i18n.language, approval, me.user.id, members)
      }
      title={approval.title}
      detail={
        approval.reason
          ? `${approval.detail} · ${t("approval.reasonLine", { reason: approval.reason })}`
          : approval.detail
      }
      actions={
        pending &&
        (approval.canDecide ? (
          <Actions
            approval={approval}
            secondary={
              channel && (
                <Button asChild variant="ghost" size="sm">
                  <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: channel.id }}>
                    {t("approval.viewInChannel")}
                  </Link>
                </Button>
              )
            }
          />
        ) : (
          channel && (
            <Button asChild variant="ghost" size="sm">
              <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: channel.id }}>
                {t("approval.viewInChannel")}
              </Link>
            </Button>
          )
        ))
      }
    />
  );
}
