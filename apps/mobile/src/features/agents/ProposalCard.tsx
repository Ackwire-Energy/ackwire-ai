import { type Message, useDenyAgentProposal } from "@agenteschat/client";
import { agentProposalOf, proposalStatus, suggestedAiText } from "@agenteschat/client/lib/action-cards";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, Icon, Text, useTheme } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useDirectory } from "../shared/hooks";
import { fullLook } from "./edit";

/**
 * The web's card for an agent's proposal of a new agent (ADR 0080): the draft at a glance, Revisar opens
 * "Criar agente" filled in with it and Recusar says no, for who may create agents while it is open; then
 * what was decided, and the new agent's page once created.
 */
export function ProposalCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const deny = useDenyAgentProposal(orgId);
  const failed = useFailed();
  const card = agentProposalOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  const decides = status === "open" && can(org?.role, "manage_agents");
  const proposer = (m.author.id && dir.agentById.get(m.author.id)?.name) || t("channel.unknownAgent");
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
      <Text variant="footnote" tone="muted">
        {suggestedAiText(t, draft.ai)}
      </Text>
      {why ? (
        <Text variant="footnote" tone="ink2">
          {why}
        </Text>
      ) : null}
      {decides ? (
        <View style={styles.acts}>
          <Button
            variant="primary"
            size="sm"
            label={t("actionCard.agentProposal.review")}
            onPress={() => router.push(`/new-agent?proposal=${encodeURIComponent(m.id)}` as never)}
          />
          <Button
            variant="secondary"
            size="sm"
            label={t("approval.refuse")}
            disabled={deny.isPending}
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

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "stretch" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  acts: { flexDirection: "row", alignItems: "center", gap: 8 },
});
