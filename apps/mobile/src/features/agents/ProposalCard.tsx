import {
  type AgentDraft,
  type Message,
  useCatalog,
  useChannels,
  useConnections,
  useCreateProposedAgent,
  useCreateProposedRoutine,
  useCustomServers,
  useDenyAgentProposal,
} from "@agenteschat/client";
import {
  agentProposalOf,
  type ProposalLine,
  proposalLines,
  proposalStatus,
  routineLeft,
  suggestedAiText,
} from "@agenteschat/client/lib/action-cards";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, Icon, Text, useTheme } from "@/ui";
import { openConnectAi } from "../ai/NoAiCard";
import { askEndedAt } from "../chat/ask-store";
import { AskButtons, AskCard, AskDone, AskFoot, ExpiryLine, useAskStore } from "../chat/asks";
import { markName } from "../chat/logic";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { useFailed } from "../routines/hooks";
import { proposedRoutineWhen } from "../routines/rule";
import { useDirectory, useMeId } from "../shared/hooks";
import { fullLook } from "./edit";

/**
 * An agent's proposal of a new agent (ADR 0081): while it is open, the request card (the agent's reason, the draft
 * in the well, the AI it would think with under "Ver a mudança", what it gets a line each with who gives a line the
 * viewer can't). Criar makes it as it is in one tap, Revisar opens "Criar agente" filled in with it, Recusar says no,
 * for who may create agents. Then one line with what was decided; it opens the draft, the lines it got and, once
 * created, the way to the new agent's page.
 */
export function ProposalCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const { colors } = useTheme();
  const create = useCreateProposedAgent(orgId);
  const makeRoutine = useCreateProposedRoutine(orgId);
  const deny = useDenyAgentProposal(orgId);
  const failed = useFailed();
  const asks = useAskStore();
  const card = agentProposalOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  const decides = status === "open" && can(org, "create_agents");
  const proposer = (m.author.id && dir.agentById.get(m.author.id)?.name) || t("channel.unknownAgent");
  const lines = proposalLines(card, { userId: meId ?? "", admin: can(org, "manage_agents") });
  const outcome =
    status === "created"
      ? t("actionCard.agentProposal.created")
      : status === "denied"
        ? t("proposals.refused")
        : status === "expired"
          ? t("approval.expired")
          : decides
            ? null
            : t("proposals.waitingAdmin");
  const busy = create.isPending || deny.isPending;
  if (status === "open") {
    return (
      <AskCard
        id={m.id}
        kind="agent"
        agentId={m.author.id ?? ""}
        waitsFor={decides ? "you" : null}
        lead={why || t("actionCard.agentProposal.title", { agent: proposer })}
        well={{
          tile: <AgentAvatar agent={fullLook(draft.appearance)} size={32} name={draft.name} live={false} />,
          title: draft.name,
          detail: [`@${draft.handle}`, draft.role].filter(Boolean).join(" · "),
          more: {
            label: t("ask.seeChange"),
            content: (
              <Text variant="footnote" tone="muted">
                {suggestedAiText(t, draft.ai)}
              </Text>
            ),
          },
        }}
        body={lines.length > 0 ? <Lines lines={lines} draft={draft} /> : undefined}
        foot={
          <AskFoot expiry={<ExpiryLine expiresAt={card.expiresAt} />}>
            {decides ? (
              <>
                <AskButtons
                  primary={
                    <Button
                      variant="primary"
                      size="card"
                      wide
                      label={t("newAgent.create", { name: draft.name })}
                      disabled={busy}
                      onPress={() =>
                        create.mutate(
                          { messageId: m.id },
                          {
                            onSuccess: ({ agent, ai }) => {
                              asks?.settle(m.id);
                              // Nothing to think with yet (the tapper's accounts decide, not the suggestion): it is
                              // created all the same, and Connect opens for it here.
                              if (ai === "none") openConnectAi({ agentId: agent.id });
                            },
                            onError: failed,
                          },
                        )
                      }
                    />
                  }
                  secondary={
                    <Button
                      variant="secondary"
                      size="card"
                      wide
                      label={t("actionCard.agentProposal.review")}
                      disabled={busy}
                      onPress={() => router.push(`/new-agent?proposal=${encodeURIComponent(m.id)}` as never)}
                    />
                  }
                />
                <Button
                  variant="ghost"
                  size="card"
                  wide
                  label={t("approval.refuse")}
                  disabled={busy}
                  onPress={() => deny.mutate(m.id, { onSuccess: () => asks?.settle(m.id), onError: failed })}
                />
              </>
            ) : (
              <Text variant="small" tone="muted">
                {outcome}
              </Text>
            )}
          </AskFoot>
        }
      />
    );
  }
  return (
    <AskDone
      done={status === "created"}
      words={`${outcome}: ${markName(draft.name)}`}
      at={askEndedAt({ ...card, status })}
      more={{
        label: t("ask.seeChange"),
        content: (
          <View style={[styles.card, { backgroundColor: colors.sunken }]}>
            <View style={styles.row}>
              <AgentAvatar agent={fullLook(draft.appearance)} size={40} name={draft.name} live={false} />
              <View style={styles.fill}>
                <Text variant="body" style={styles.bold}>
                  {draft.name}
                </Text>
                <Text variant="footnote" tone="muted">
                  {[`@${draft.handle}`, draft.role].filter(Boolean).join(" · ")}
                </Text>
              </View>
            </View>
            {why ? (
              <Text variant="footnote" tone="ink2">
                {why}
              </Text>
            ) : null}
            {lines.length > 0 ? <Lines lines={lines} draft={draft} /> : null}
            <Text variant="footnote" tone="muted">
              {suggestedAiText(t, draft.ai)}
            </Text>
            {status === "created" && (card.agentId || routineLeft(card)) ? (
              <View style={styles.acts}>
                {card.agentId ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("newAgent.openProfile")}
                    onPress={() => router.push(`/agent/${encodeURIComponent(card.agentId ?? "")}` as never)}
                  />
                ) : null}
                {routineLeft(card) && (card.decidedByUserId === meId || can(org, "manage_routines")) ? (
                  // Not made with it (the agent wasn't where it reports yet): made from here once it is.
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("newAgent.routineKeep", { name: draft.routine?.name })}
                    disabled={makeRoutine.isPending}
                    onPress={() => makeRoutine.mutate(m.id, { onError: failed })}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        ),
      }}
    />
  );
}

/** What the proposed agent gets, a line each; a line the viewer can't give says who does, one it got takes a check. */
function Lines({ lines, draft }: { lines: ProposalLine[]; draft: AgentDraft }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const channels = useChannels(orgId);
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const catalog = useCatalog();
  const apps = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []);
  const says = (level: "read" | "write" | undefined, name: string) =>
    t(level === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", { name });
  const shown = (l: ProposalLine): { icon: ReactNode; text: string } => {
    if (l.kind === "channel") {
      const name = channels.data?.find((c) => c.id === l.id)?.name;
      return {
        icon: <Icon name="hash" size={14} color={colors.muted} />,
        text: name ?? t("actionCard.agentProposal.aChannel"),
      };
    }
    if (l.kind === "app") {
      const item = apps.find((a) => a.id === l.id);
      const name = item ? itemName(t, item) : t("actionCard.agentProposal.anApp");
      return {
        icon: <ConnectorIcon def={item?.def ?? null} image={item?.image} label={name} size={16} />,
        text: says(l.level, name),
      };
    }
    if (l.kind === "mail") {
      const box = draft.mail?.find((b) => b.accountId === l.id);
      return { icon: <Icon name="mail" size={14} color={colors.muted} />, text: says(l.level, box?.address ?? "") };
    }
    const routine = draft.routine;
    return {
      icon: <Icon name="clock" size={14} color={colors.muted} />,
      text: routine ? [routine.name, proposedRoutineWhen(t, i18n.language, routine)].join(" · ") : l.id,
    };
  };
  const needs = (l: ProposalLine) =>
    !l.needs
      ? null
      : l.needs.who === "admin"
        ? t("actionCard.agentProposal.needsAdmin")
        : t("actionCard.agentProposal.needsPerson", {
            name: dir.memberById.get(l.needs.userId)?.name ?? t("actionCard.agentProposal.itsOwner"),
          });
  return (
    <View style={styles.lines} accessibilityLabel={t("actionCard.agentProposal.lines", { name: draft.name })}>
      {lines.map((l) => {
        const { icon, text } = shown(l);
        const who = [
          l.kind === "routine" && l.given === false ? t("actionCard.agentProposal.routineNotMade") : null,
          needs(l),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <View key={l.key} style={styles.line}>
            <View style={styles.mark}>{l.given ? <Icon name="check" size={14} color={colors.success} /> : icon}</View>
            <View style={styles.fill}>
              <Text variant="footnote" tone="ink2">
                {text}
                {who ? <Text style={{ color: colors.attention }}>{` · ${who}`}</Text> : null}
              </Text>
              {l.kind === "routine" && draft.routine ? (
                <Text variant="footnote" tone="muted" numberOfLines={2}>
                  {draft.routine.prompt}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "stretch" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  lines: { gap: 4 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  mark: { width: 16, height: 18, alignItems: "center", justifyContent: "center" },
  acts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
});
