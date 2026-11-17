import type { Agent, Approval, Member } from "@agenteschat/client";
import { useCancelApproval, useDecideApproval, useDecideApprovals } from "@agenteschat/client";
import {
  type ApprovalAction,
  aheadPhase,
  approvalAction,
  approvalRisk,
  approvalTraits,
  approveAlwaysOffered,
} from "@agenteschat/client/lib/approval-kind";
import {
  alwaysRoutineName,
  approveAlwaysHint,
  approveAlwaysLabel,
  decisionOutcome,
} from "@agenteschat/client/lib/approval-words";
import { nextLabel, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, cx, Icon, Tip } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { OpenDetailsContext } from "@/components/details-link";
import { prepareBurst } from "@/components/Sky";
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
  // Expired at its deadline (one approved ahead, at its time), not when someone decided it.
  const at =
    approval.status !== "expired"
      ? approval.decidedAt
      : aheadPhase(approval) === "lapsed"
        ? approval.runAt
        : approval.expiresAt;
  const when = at ? whenAt(t, locale, at, now) : t("common.now");
  if (approval.status === "expired") return t("approval.expiredChip", { when });
  if (approval.status === "canceled") return t("approval.canceledChip", { when });
  // Decided by someone covering (ADR 0139): "Aprovado por Bruno, cobrindo Ana · agora".
  if (approval.decidedForUserId)
    return `${decisionOutcome(t, approval, meId, (id) => members.get(id)?.name)} · ${when}`;
  const mine = approval.decidedByUserId === meId;
  const name = members.get(approval.decidedByUserId ?? "")?.name ?? "";
  if (approval.status === "approved")
    return mine ? t("approval.approvedByYou", { when }) : t("approval.approvedBy", { name, when });
  return mine ? t("approval.refusedByYou", { when }) : t("approval.refusedBy", { name, when });
}

/**
 * "Aprovar sempre" ("Aprovar sempre leituras" for a SQL tool's reads), where the request offers it: approves this one
 * and the agent's next calls of its kind, and with it `also` (the requests of that kind waiting beside it,
 * `approveAlwaysAlso`). Its tip says exactly what that covers and where to undo it: the row holds only buttons.
 */
export function ApproveAlways({
  approval,
  agent,
  also = [],
}: {
  approval: Approval;
  agent: Agent | undefined;
  also?: string[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const openPanel = useOpenAgentPanel();
  const decide = useDecideApproval(org.id);
  const others = useDecideApprovals(org.id);
  const details = useContext(OpenDetailsContext);
  if (!approveAlwaysOffered(approval)) return null;
  const g = agentGrammar(agent?.name ?? t("channel.unknownAgent"));
  const kind = approval.approveAlways;
  const routine = alwaysRoutineName(t, approval);
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
    // Not `mutate`'s own onSuccess: the decided event can unmount this button before the reply, and that callback
    // would then never send `also`. A failure is shown by the query client's mutation cache.
    decide.mutateAsync({ id: approval.id, decision: "approve", always: true }).then(
      () => {
        burst();
        if (also.length) others.mutate({ ids: also, decision: "approve" });
        if (routine && kind?.routineId) {
          const id = kind.routineId;
          toast.show(
            t("approval.always.doneRoutine", { routine }),
            "info",
            {
              label: t("approval.always.open"),
              run: () =>
                details
                  ? details({ kind: "routine", id })
                  : void navigate({ to: "/org/$orgId/routines", params: { orgId: org.id }, search: { open: id } }),
            },
            t("approval.always.undoRoutine"),
          );
          return;
        }
        toast.show(
          t("approval.always.done", { name: g.name }),
          "info",
          { label: t("approval.always.open"), run: open },
          t("approval.always.undoHere", { context: g.context, name: g.name }),
        );
      },
      () => {},
    );
  };
  return (
    <Tip tip={approveAlwaysHint(t, approval, g.name)} look="ac-hint__bubble ac-glass" align="center" button>
      <Button
        size="sm"
        icon="check"
        disabled={decide.isPending || others.isPending}
        loading={decide.isPending}
        onClick={(e) => always(e.currentTarget)}
      >
        {approveAlwaysLabel(t, approval)}
      </Button>
    </Tip>
  );
}

/** A request for an action prepared ahead: that approving covers a later run, and when (its card, its details). */
export function AheadLine({ approval, className }: { approval: Approval; className: string }) {
  const { t, i18n } = useTranslation();
  if (aheadPhase(approval) !== "asking" || !approval.runAt) return null;
  return (
    <p className={cx(className, "ac-iconline")}>
      <Icon name="calendar" size={16} />
      <span>{t("approval.ahead.line", { when: nextLabel(i18n.language, approval.runAt) })}</span>
    </p>
  );
}

/** Withdraws an action approved ahead before its time (`canCancel`): its card in the chat, its routine's page. */
export function CancelAhead({ id }: { id: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const cancel = useCancelApproval(org.id);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="close"
      disabled={cancel.isPending}
      loading={cancel.isPending}
      onClick={(e) => {
        // Inside a row that opens its details: canceling stays a click of its own.
        e.stopPropagation();
        cancel.mutate(id, { onSuccess: () => toast.show(t("approval.ahead.canceled"), "info") });
      }}
    >
      {t("approval.ahead.cancel")}
    </Button>
  );
}
