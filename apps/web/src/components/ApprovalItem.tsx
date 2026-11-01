import type { Agent, Approval, Member } from "@agenteschat/client";
import { useDecideApproval } from "@agenteschat/client";
import {
  type ApprovalAction,
  approvalAction,
  approvalRisk,
  approvalTraits,
  approveAlwaysOffered,
} from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalWhy } from "@agenteschat/client/lib/approval-origin";
import {
  approvalSummary,
  approvalTitle,
  approveAlwaysHint,
  decisionOutcome,
} from "@agenteschat/client/lib/approval-words";
import { timeLeft, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { ApprovalCard, Button } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { AgentWho } from "@/components/AgentAvatar";
import { EmailLetter } from "@/components/EmailLetter";
import { RequestDone } from "@/components/RequestCard";
import { CardSky, colorOf, prepareBurst } from "@/components/Sky";
import { TYPED_VALUES } from "@/i18n";
import { useToast } from "@/lib/toast";
import { useOpenAgentPanel } from "./agent-panel-context";
import { useOrg } from "./org-context";

// Its title, what it wants to do, whether it only looks and its values: the phone's own rules too.
export {
  approvalDoing,
  approvalReadsOnly,
  approvalTitle,
  approvalValues,
} from "@agenteschat/client/lib/approval-words";
export { type ApprovalAction, approvalAction, approvalRisk, approvalTraits };

/** "Aprovado por você · agora" / "Recusado por João · ontem 18:02" / "Expirou · ontem". */
export function decisionLabel(
  t: TFunction,
  locale: string,
  approval: Approval,
  meId: string,
  members: Map<string, Member>,
  now = new Date(),
) {
  // No one decided one that ran out: it expired at its deadline.
  const at = approval.decidedAt ?? (approval.status === "expired" ? approval.expiresAt : null);
  const when = at ? whenAt(t, locale, at, now) : t("common.now");
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

/**
 * "Aprovar sempre", where the request offers it: approves this one and the agent's next calls of its kind, with
 * any values. The line under it says what that covers; the toast, where to undo it.
 */
export function ApproveAlways({ approval, agent }: { approval: Approval; agent: Agent | undefined }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const openPanel = useOpenAgentPanel();
  const decide = useDecideApproval(org.id);
  if (!approveAlwaysOffered(approval)) return null;
  const g = agentGrammar(t, agent?.name ?? t("channel.unknownAgent"));
  const kind = approval.approveAlways;
  // In a conversation: the agent's Acesso in the panel beside it; elsewhere, its page.
  const open = () =>
    openPanel
      ? openPanel(approval.agentId, "access")
      : void navigate({
          to: "/org/$orgId/agents/$agentId",
          params: { orgId: org.id, agentId: approval.agentId },
          search: { tab: "access" },
        });
  const always = (el: HTMLElement) => {
    const burst = prepareBurst(el);
    decide.mutate(
      { id: approval.id, decision: "approve", always: true },
      {
        onSuccess: () => {
          burst();
          toast.show(
            t("approval.always.done", { name: g.name }),
            "info",
            { label: t("approval.always.open"), run: open },
            t("approval.always.undoHere", { of: g.of, name: g.name }),
          );
        },
      },
    );
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon="check"
        disabled={decide.isPending}
        loading={decide.isPending}
        onClick={(e) => always(e.currentTarget)}
      >
        {t("approval.always.button")}
      </Button>
      <p className="small muted ap-always" title={kind?.actions.join(", ") || kind?.tool}>
        {approveAlwaysHint(t, approval, g.name)}
      </p>
    </>
  );
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
        onClick={(e) => {
          // Approved: a burst of the agent's pixels from its avatar.
          const burst = prepareBurst(e.currentTarget);
          decide.mutate({ id: approval.id, decision: "approve" }, { onSuccess: burst });
        }}
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

/** The approval card inside the channel: full while waiting, one line once decided. */
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
    // No one decided one that ran out: it expired at its deadline.
    const ended = approval.decidedAt ?? (approval.status === "expired" ? approval.expiresAt : null);
    const summary = approvalSummary(approval, i18n.language);
    return (
      <RequestDone
        done={approval.status === "approved"}
        label={t(
          approval.status === "approved"
            ? "approval.groupDone"
            : approval.status === "expired"
              ? "approval.groupExpired"
              : approval.status === "canceled"
                ? "approval.groupCanceled"
                : "approval.groupRefused",
        )}
        more={
          approval.reason
            ? { label: t("approval.seeDetails"), content: t("approval.reasonLine", { reason: approval.reason }) }
            : undefined
        }
      >
        {decisionOutcome(t, approval, me.user.id, (id) => members.get(id)?.name)}: <b>{approvalTitle(t, approval)}</b>
        {/* What was decided, so several requests for one tool are told apart. */}
        {summary && ` · ${summary}`}
        {ended && ` · ${whenAt(t, i18n.language, ended)}`}
      </RequestDone>
    );
  }
  const left = timeLeft(t, approval.expiresAt);
  const expires = left ? t("approval.expiresDetail", { time: left }) : "";
  const origin = approvalOriginShort(approval);
  const why = approvalWhy(approval);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <ApprovalCard
      status="waiting"
      aria-label={t("approval.group")}
      sky={<CardSky color={colorOf(agent)} />}
      who={
        <Trans
          i18nKey="approval.asks"
          values={{ agent: name }}
          components={{ b: <AgentWho agentId={approval.agentId} name={name} /> }}
          {...TYPED_VALUES}
        />
      }
      statusLabel={approval.canDecide ? t("approval.waitingYou") : waitingFor(t, agent, members)}
      origin={origin ? tt(origin.key, origin.values) : undefined}
      title={approvalTitle(t, approval)}
      action={approval.email ? <EmailLetter email={approval.email} /> : undefined}
      detail={
        approval.email
          ? expires || undefined
          : [approval.connector ? approvalSummary(approval, i18n.language) : approval.detail, expires]
              .filter(Boolean)
              .join(" · ")
      }
      why={
        why ? (
          <Trans i18nKey="approval.said" values={{ name, text: why }} components={{ b: <b /> }} {...TYPED_VALUES} />
        ) : undefined
      }
      actions={approval.canDecide && <Actions approval={approval} />}
    />
  );
}
