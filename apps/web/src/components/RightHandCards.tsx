import type { AppNotification, CardDelegate, Message, Proposal } from "@agenteschat/client";
import {
  keys,
  useAgentActions,
  useAgentProposal,
  useAskProposal,
  useCardProposals,
  useChannels,
  useDecideProposal,
  useMembers,
  useModelLabel,
  useRoles,
  useSendDm,
} from "@agenteschat/client";
import type { SettingsProposalCard } from "@agenteschat/client/lib/action-cards";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime, lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { decidersOf, onlyKey, sentToText, settingLineText } from "@agenteschat/client/lib/proposals";
import { Button, Icon } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AgentProposalCardView } from "@/components/ActionCard";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { RequestCard, RequestDone } from "@/components/RequestCard";
import { DelegateNote, DelegateUndo, useDelegateLine } from "@/components/RightHandDelegate";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * The right hand's card of a teammate's settings (ADR 0137): a request per row (one agent, one decider), each applied
 * as whoever clicks.
 */
export function SettingsProposalCardView({ message, card }: { message: Message; card: SettingsProposalCard }) {
  const { org } = useOrg();
  const rows = useCardProposals(org.id, card.proposalIds);
  return (
    <>
      {rows.map((p, i) => (
        <SettingsRow key={p.id} p={p} message={message} delegate={card.delegate} first={i === 0} />
      ))}
    </>
  );
}

/**
 * One row: "Propõe uma mudança", the agent in the well, "Modelo: Haiku → Sonnet" a line each, and the decision.
 * Who may decide it gets Aplicar and Descartar (Recusar in the inbox); the person who asked and can't, Pedir a um
 * admin, then whom it went to. Decided, one line with who did it, and Desfazer on its receipt while it lasts.
 */
function SettingsRow({
  p,
  message,
  delegate,
  first = true,
}: {
  p: Proposal;
  message?: Message;
  /** The right hand looked at the card for the person it is for (ADR 0139): one decision, Desfazer on the first row. */
  delegate?: CardDelegate | null;
  first?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const modelLabel = useModelLabel();
  const members = useMembers(org.id).data ?? [];
  const channels = useChannels(org.id).data ?? [];
  const roles = useRoles(org.id).data?.roles ?? [];
  const decide = useDecideProposal(org.id);
  const ask = useAskProposal(org.id);
  const redo = useSendDm(org.id);
  const actions = useAgentActions(org.id, message?.channelId ?? "");
  const toast = useToast();
  const qc = useQueryClient();
  const agent = dir.anyAgent(p.agentId);
  const proposer = dir.anyAgent(p.proposedByAgentId ?? p.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const lines = (p.settings ?? []).map((l) =>
    settingLineText(t, i18n.language, l, {
      model: (id) => modelLabel(id) ?? id,
      person: (id) => dir.memberById.get(id)?.name,
      channel: (id) => channels.find((c) => c.id === id)?.name,
      role: dir.roleName,
    }),
  );
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const mine = p.requestedBy?.userId === me.user.id;
  const label = t("proposals.titleSettings", g);
  const delegated = useDelegateLine(delegate);
  const byRightHand = delegated && (delegate?.state === "approved" || delegate?.state === "undone");

  if (p.status !== "pending") {
    const receipt = message?.actions?.find((a) => a.id === p.undoActionId);
    const byMe = p.decidedBy?.userId === me.user.id;
    const who = byRightHand
      ? delegated
      : p.status === "accepted"
        ? byMe
          ? t("rightHand.card.appliedByYou")
          : t("rightHand.card.appliedBy", { name: p.decidedBy?.name ?? "" })
        : byMe
          ? t("rightHand.card.declinedByYou")
          : t("rightHand.card.declinedBy", { name: p.decidedBy?.name ?? "" });
    const undoable =
      receipt && !receipt.undoneAt && receipt.undoableUntil && Date.parse(receipt.undoableUntil) > Date.now();
    return (
      <RequestDone
        done={p.status === "accepted" && !receipt?.undoneAt && delegate?.state !== "undone"}
        label={label}
        more={
          byRightHand && delegate?.reason
            ? { label: t("rightHandApprovals.card.why"), content: <p>{delegate.reason}</p> }
            : undefined
        }
        action={
          byRightHand
            ? first && <DelegateUndo d={delegate} />
            : undoable && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={actions.undo.isPending}
                  onClick={() =>
                    actions.undo.mutate(receipt.id, {
                      onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org.id) }),
                      onError: failed,
                    })
                  }
                >
                  {t("rightHand.card.undo")}
                </Button>
              )
        }
      >
        {who}: <b>{[name, ...lines.map((l) => `${lowerFirst(l.field, i18n.language)} ${l.to}`)].join(" · ")}</b>
        {p.decidedAt && ` · ${formatTime(i18n.language, p.decidedAt)}`}
        {receipt?.undoneAt && ` · ${t("rightHand.card.undone")}`}
      </RequestDone>
    );
  }

  const asked = p.askedAt
    ? sentToText(t, i18n.language, decidersOf(p, members, roles, agent?.ownerUserId), p.askedAt)
    : null;
  const state = p.stale
    ? t("rightHand.card.stale")
    : p.canDecide
      ? undefined
      : p.askedAt
        ? t("proposals.waitingAdmin")
        : mine
          ? t(onlyKey(p), g)
          : t("proposals.waitingAdmin");
  const decision = p.stale ? (
    mine &&
    proposer && (
      <Button
        size="sm"
        variant="primary"
        icon="refresh"
        loading={redo.isPending}
        onClick={() =>
          redo.mutate({ agentId: proposer.id, body: t("rightHand.card.redoMessage", g) }, { onError: failed })
        }
      >
        {t("rightHand.card.redo")}
      </Button>
    )
  ) : p.canDecide ? (
    <>
      <Button
        size="sm"
        variant="primary"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "accept"}
        onClick={() => decide.mutate({ id: p.id, decision: "accept" }, { onError: failed })}
      >
        {t("rightHand.card.apply")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => decide.mutate({ id: p.id, decision: "refuse" }, { onError: failed })}
      >
        {t(mine ? "rightHand.card.dismiss" : "rightHand.card.decline")}
      </Button>
    </>
  ) : asked ? (
    <span className="rq__sent ac-iconline">
      <Icon name="arrowUp" size={14} />
      <span>{asked}</span>
    </span>
  ) : (
    mine && (
      <Button
        size="sm"
        variant="primary"
        icon="arrowUp"
        loading={ask.isPending}
        onClick={() => ask.mutate(p.id, { onError: failed })}
      >
        {t("rightHand.card.askAdmin")}
      </Button>
    )
  );
  return (
    <RequestCard
      id={p.id}
      kind="proposal"
      agent={proposer}
      label={label}
      mine={p.canDecide && !p.stale}
      waitingFor={state}
      lead={p.stale ? t("rightHand.card.staleHelp", g) : p.why}
      object={{
        logo: <AgentAvatar agentId={p.agentId} name={name} size="md" />,
        title: t("rightHand.card.settings", { name }),
        detail: [agent?.handle ? `@${agent.handle}` : null, agent?.role].filter(Boolean).join(" · "),
      }}
      body={
        (delegated || lines.length > 0) && (
          <>
            {first && <DelegateNote d={delegate} />}
            {lines.length > 0 && (
              <dl className="rq__settings">
                {lines.map((l) => (
                  <div key={`${l.field}:${l.to}`} className="rq__setting">
                    <dt>{l.field}</dt>
                    <dd>
                      <s>{l.from}</s>
                      <Icon name="arrowRight" size={14} label={t("rightHand.card.to")} />
                      <b>{l.to}</b>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )
      }
      actions={decision || undefined}
      what={label}
    />
  );
}

/**
 * "Pedir a um admin" in the inbox of whoever may decide it (`change_request`): the same card, theirs to decide (a new
 * agent's, created as them from here).
 */
export function ChangeRequestCard({ n }: { n: AppNotification }) {
  const { org } = useOrg();
  const proposalId = n.source.proposalId;
  const rows = useCardProposals(org.id, proposalId ? [proposalId] : []);
  const agentCard = useAgentProposal(org.id, proposalId ? null : (n.source.messageId ?? null)).data;
  const [p] = rows;
  if (p) return <SettingsRow p={p} />;
  if (!agentCard) return null;
  return (
    <AgentProposalCardView
      messageId={agentCard.messageId}
      proposerId={agentCard.proposedByAgentId}
      sentAt={n.createdAt}
      card={agentCard}
    />
  );
}
