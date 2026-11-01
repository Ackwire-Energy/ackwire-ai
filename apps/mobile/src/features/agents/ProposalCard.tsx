import {
  type AgentDraft,
  type Message,
  useCatalog,
  useChannels,
  useConnections,
  useCreateProposedAgent,
  useCustomServers,
  useDenyAgentProposal,
} from "@agenteschat/client";
import {
  agentProposalOf,
  type ProposalLine,
  proposalLines,
  proposalStatus,
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
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { useFailed } from "../routines/hooks";
import { proposedRoutineWhen } from "../routines/rule";
import { useDirectory, useMeId } from "../shared/hooks";
import { fullLook } from "./edit";

/**
 * The web's card for an agent's proposal of a new agent (ADR 0081): the draft at a glance and what it gets, a line
 * each (who gives a line the viewer can't). Criar makes it as it is in one tap, Revisar opens "Criar agente" filled
 * in with it, Recusar says no, for who may create agents while it is open; then what was decided, the lines it got
 * and the new agent's page once created.
 */
export function ProposalCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const { colors } = useTheme();
  const create = useCreateProposedAgent(orgId);
  const deny = useDenyAgentProposal(orgId);
  const failed = useFailed();
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
  return (
    <View style={[styles.card, { backgroundColor: colors.sunken }]}>
      <View style={styles.row}>
        <Icon name={status === "created" ? "check" : "agent"} size={16} color={colors.ink2} />
        <Text variant="subhead" style={styles.title}>
          {t("actionCard.agentProposal.title", { agent: proposer })}
        </Text>
      </View>
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
      {decides ? (
        <View style={styles.acts}>
          <Button
            variant="primary"
            size="sm"
            label={t("newAgent.create", { name: draft.name })}
            disabled={busy}
            onPress={() =>
              create.mutate(m.id, {
                // Nothing to think with yet: it is created all the same, and Connect opens for it here.
                onSuccess: ({ agent }) => {
                  if (draft.ai.kind === "none") openConnectAi({ agentId: agent.id });
                },
                onError: failed,
              })
            }
          />
          <Button
            variant="secondary"
            size="sm"
            label={t("actionCard.agentProposal.review")}
            disabled={busy}
            onPress={() => router.push(`/new-agent?proposal=${encodeURIComponent(m.id)}` as never)}
          />
          <Button
            variant="secondary"
            size="sm"
            label={t("approval.refuse")}
            disabled={busy}
            onPress={() => deny.mutate(m.id, { onError: failed })}
          />
        </View>
      ) : (
        <View style={styles.acts}>
          {outcome ? (
            <Text variant="footnote" tone="faint">
              {outcome}
            </Text>
          ) : null}
          {status === "created" && card.agentId ? (
            <Button
              variant="secondary"
              size="sm"
              label={t("newAgent.openProfile")}
              onPress={() => router.push(`/agent/${encodeURIComponent(card.agentId ?? "")}` as never)}
            />
          ) : null}
        </View>
      )}
    </View>
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
      text: routine ? `${routine.name} · ${proposedRoutineWhen(t, i18n.language, routine)}` : l.id,
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
        const who = l.kind === "routine" && l.given === false ? t("actionCard.agentProposal.routineNotMade") : needs(l);
        return (
          <View key={l.key} style={styles.line}>
            <View style={styles.mark}>{l.given ? <Icon name="check" size={14} color={colors.success} /> : icon}</View>
            <Text variant="footnote" tone="ink2" style={styles.fill}>
              {text}
              {who ? <Text style={{ color: colors.attention }}>{` · ${who}`}</Text> : null}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "stretch" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  lines: { gap: 4 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  mark: { width: 16, height: 18, alignItems: "center", justifyContent: "center" },
  acts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
});
