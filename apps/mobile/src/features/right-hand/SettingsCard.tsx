import {
  type AppNotification,
  type CardDelegate,
  keys,
  type Message,
  type Proposal,
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
import { actionCardOf } from "@agenteschat/client/lib/action-cards";
import { delegateLine } from "@agenteschat/client/lib/approval-words";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  decidersOf,
  onlyKey,
  proposalWhy,
  removalOf,
  sentToText,
  settingLineText,
} from "@agenteschat/client/lib/proposals";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, LineIcon, Text } from "@/ui";
import { openAgentDelete } from "../agents/DeleteAgentScreen";
import { AgentProposalView } from "../agents/ProposalCard";
import { DelegateUndo } from "../agents/RightHandDelegate";
import { AskButtons, AskCard, AskDone, AskFoot } from "../chat/asks";
import { markName } from "../chat/logic";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";

/**
 * The right hand's card of a teammate's settings (ADR 0137), as on the web: a request per row (one agent, one
 * decider), each applied as whoever taps.
 */
export function SettingsProposals({ message: m }: { message: Message }) {
  const { orgId } = useOrg();
  const card = actionCardOf(m.meta);
  const ids = card?.kind === "settings_proposal" ? card.proposalIds : [];
  const rows = useCardProposals(orgId, ids);
  if (m.author.type !== "agent") return null;
  return (
    <>
      {rows.map((p, i) => (
        <SettingsRow
          key={p.id}
          p={p}
          message={m}
          delegate={card?.kind === "settings_proposal" ? card.delegate : null}
          first={i === 0}
        />
      ))}
    </>
  );
}

/**
 * "Pedir a um admin" in the inbox of whoever may decide it (`change_request`): the same card, theirs to decide (a new
 * agent's, created as them from here).
 */
export function ChangeRequestCard({ n }: { n: AppNotification }) {
  const { orgId } = useOrg();
  const proposalId = n.source.proposalId;
  const [p] = useCardProposals(orgId, proposalId ? [proposalId] : []);
  const agentCard = useAgentProposal(orgId, proposalId ? null : (n.source.messageId ?? null)).data;
  if (p) return <SettingsRow p={p} />;
  if (!agentCard) return null;
  return (
    <AgentProposalView
      messageId={agentCard.messageId}
      proposerId={agentCard.proposedByAgentId}
      sentAt={n.createdAt}
      card={agentCard}
    />
  );
}

/** A row with no card around it (Propostas de melhoria). */
export const ChangeRequestRow = ({ p }: { p: Proposal }) => <SettingsRow p={p} />;

/**
 * One row: the agent in the well, "Modelo: Haiku → Sonnet" a line each, and the decision. Who may decide it gets
 * Aplicar and Descartar (Recusar in the inbox); the person who asked and can't, Pedir a um admin, then whom it went
 * to; out of date, Refazer. Decided, one line with who did it, and Desfazer on its receipt while it lasts.
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
  const { orgId } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const qc = useQueryClient();
  const failed = useFailed();
  const modelLabel = useModelLabel();
  const members = useMembers(orgId).data ?? [];
  const channels = useChannels(orgId).data ?? [];
  const roles = useRoles(orgId).data?.roles ?? [];
  const decide = useDecideProposal(orgId);
  const ask = useAskProposal(orgId);
  const redo = useSendDm(orgId);
  const actions = useAgentActions(orgId, message?.channelId ?? "");
  const agent = dir.anyAgent(p.agentId);
  const proposer = p.proposedByAgentId ?? p.agentId;
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const lines = (p.settings ?? []).map((l) =>
    settingLineText(t, i18n.language, l, {
      model: (id) => modelLabel(id) ?? id,
      person: (id) => dir.memberById.get(id)?.name,
      channel: (id) => channels.find((ch) => ch.id === id)?.name,
      role: (id) => roles.find((r) => r.id === id)?.name,
    }),
  );
  const mine = p.requestedBy?.userId === meId;
  const delegated = delegate
    ? delegateLine(
        t,
        delegate,
        meId ?? null,
        (id) => dir.memberById.get(id)?.name,
        dir.anyAgent(delegate.agentId)?.name ?? "",
      )
    : null;
  const byRightHand = delegated && (delegate?.state === "approved" || delegate?.state === "undone");

  if (p.status !== "pending") {
    const receipt = message?.actions?.find((a) => a.id === p.undoActionId);
    const byMe = p.decidedBy?.userId === meId;
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
    const words = [
      `${who}: ${markName(name)}`,
      ...lines.map((l) => `${lowerFirst(l.field, i18n.language)} ${l.to}`),
      ...(receipt?.undoneAt ? [t("rightHand.card.undone")] : []),
    ].join(" · ");
    return (
      <View style={styles.done}>
        <View style={styles.fill}>
          <AskDone
            done={p.status === "accepted" && !receipt?.undoneAt && delegate?.state !== "undone"}
            words={words}
            more={
              byRightHand && delegate?.reason
                ? {
                    label: t("rightHandApprovals.card.why"),
                    content: (
                      <Text variant="footnote" tone="ink2">
                        {delegate.reason}
                      </Text>
                    ),
                  }
                : undefined
            }
          />
        </View>
        {byRightHand ? (
          first ? (
            <DelegateUndo d={delegate} />
          ) : null
        ) : undoable ? (
          <Button
            variant="ghost"
            size="sm"
            label={t("rightHand.card.undo")}
            loading={actions.undo.isPending}
            onPress={() =>
              actions.undo.mutate(receipt.id, {
                onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(orgId) }),
                onError: failed,
              })
            }
          />
        ) : null}
      </View>
    );
  }

  const asked = p.askedAt
    ? sentToText(t, i18n.language, decidersOf(p, members, roles, agent?.ownerUserId), p.askedAt)
    : null;
  const state = p.stale
    ? t("rightHand.card.stale")
    : p.canDecide
      ? "you"
      : p.askedAt || !mine
        ? t("proposals.waitingAdmin")
        : t(onlyKey(p), g);
  const decision = p.stale ? (
    mine ? (
      <Button
        variant="primary"
        size="card"
        wide
        label={t("rightHand.card.redo")}
        loading={redo.isPending}
        onPress={() =>
          redo.mutate({ agentId: proposer, body: t("rightHand.card.redoMessage", g) }, { onError: failed })
        }
      />
    ) : null
  ) : p.canDecide ? (
    <AskButtons
      primary={
        <Button
          variant="primary"
          size="card"
          wide
          label={t("rightHand.card.apply")}
          disabled={decide.isPending}
          onPress={() =>
            p.agentId && removalOf([p]) === "delete"
              ? openAgentDelete(p.agentId, p.id)
              : decide.mutate({ id: p.id, decision: "accept" }, { onError: failed })
          }
        />
      }
      secondary={
        <Button
          variant="secondary"
          size="card"
          wide
          label={t(mine ? "rightHand.card.dismiss" : "rightHand.card.decline")}
          disabled={decide.isPending}
          onPress={() => decide.mutate({ id: p.id, decision: "refuse" }, { onError: failed })}
        />
      }
    />
  ) : asked ? (
    <View style={styles.sent}>
      <LineIcon name="send" size={15} color={c.muted} variant="small" />
      <Text variant="small" tone="muted" style={styles.fill}>
        {asked}
      </Text>
    </View>
  ) : mine ? (
    <Button
      variant="primary"
      size="card"
      wide
      icon="send"
      label={t("rightHand.card.askAdmin")}
      loading={ask.isPending}
      onPress={() => ask.mutate(p.id, { onError: failed })}
    />
  ) : null;
  return (
    <AskCard
      id={p.id}
      kind="proposal"
      agentId={proposer}
      waitsFor={state}
      lead={(p.stale ? t("rightHand.card.staleHelp", g) : proposalWhy(t, p)) || t("proposals.titleSettings", g)}
      well={{
        tile: <AgentFace agentId={p.agentId} size={20} live={false} />,
        title: t("rightHand.card.settings", { name }),
        detail: [agent?.handle ? `@${agent.handle}` : null, agent?.role].filter(Boolean).join(" · "),
      }}
      body={
        lines.length > 0 ? (
          <View style={styles.lines}>
            {first && delegated ? (
              <Text variant="footnote" tone="muted">
                {delegated}
              </Text>
            ) : null}
            {lines.map((l) => (
              <View
                key={`${l.field}:${l.to}`}
                style={styles.line}
                accessible
                accessibilityLabel={`${l.field}: ${l.from} ${t("rightHand.card.to")} ${l.to}`}
              >
                <Text variant="footnote" tone="muted" style={styles.field}>
                  {l.field}
                </Text>
                <Text variant="footnote" tone="faint" style={styles.from}>
                  {l.from}
                </Text>
                <Icon name="right" size={12} color={c.faint} />
                <Text variant="footnote" tone="ink" style={styles.to}>
                  {l.to}
                </Text>
              </View>
            ))}
          </View>
        ) : undefined
      }
      foot={decision ? <AskFoot>{decision}</AskFoot> : undefined}
    />
  );
}

const styles = StyleSheet.create({
  // From the top: the decided line opens 8 under it and is 20 tall, so a 36 button's middle is that line's; centered,
  // it sat 4 above the line, and beside the line's opened details it drifted down.
  done: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  // The icon on the first line when whom it went to wraps.
  sent: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  lines: { gap: 6 },
  line: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  field: { fontWeight: "500", minWidth: 96 },
  from: { textDecorationLine: "line-through" },
  to: { fontWeight: "600" },
});
