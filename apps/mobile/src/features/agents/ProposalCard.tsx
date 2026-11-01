import { type Message, useDenyAgentProposal } from "@agenteschat/client";
import { agentProposalOf, proposalStatus, suggestedAiText } from "@agenteschat/client/lib/action-cards";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, Text, useTheme } from "@/ui";
import { askEndedAt } from "../chat/ask-store";
import { AskButtons, AskCard, AskDone, AskFoot, ExpiryLine, useAskStore } from "../chat/asks";
import { markName } from "../chat/logic";
import { useFailed } from "../routines/hooks";
import { useDirectory } from "../shared/hooks";
import { fullLook } from "./edit";

/**
 * An agent's proposal of a new agent (ADR 0081): while it is open, the request card (the agent's reason, the
 * draft in the well, the AI it would think with under "Ver a mudança"); Revisar opens "Criar agente" filled
 * in with it and Recusar says no, for who may create agents. Then one line with what was decided; it opens the
 * draft and, once created, the way to the new agent's page.
 */
export function ProposalCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const deny = useDenyAgentProposal(orgId);
  const failed = useFailed();
  const asks = useAskStore();
  const card = agentProposalOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  const decides = status === "open" && can(org, "create_agents");
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
        foot={
          <AskFoot expiry={<ExpiryLine expiresAt={card.expiresAt} />}>
            {decides ? (
              <AskButtons
                primary={
                  <Button
                    variant="primary"
                    size="card"
                    wide
                    label={t("actionCard.agentProposal.review")}
                    onPress={() => router.push(`/new-agent?proposal=${encodeURIComponent(m.id)}` as never)}
                  />
                }
                secondary={
                  <Button
                    variant="secondary"
                    size="card"
                    wide
                    label={t("approval.refuse")}
                    disabled={deny.isPending}
                    onPress={() => deny.mutate(m.id, { onSuccess: () => asks?.settle(m.id), onError: failed })}
                  />
                }
              />
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
            <Text variant="footnote" tone="muted">
              {suggestedAiText(t, draft.ai)}
            </Text>
            {why ? (
              <Text variant="footnote" tone="ink2">
                {why}
              </Text>
            ) : null}
            {status === "created" && card.agentId ? (
              <View style={styles.acts}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={t("newAgent.openProfile")}
                  onPress={() => router.push(`/agent/${encodeURIComponent(card.agentId ?? "")}` as never)}
                />
              </View>
            ) : null}
          </View>
        ),
      }}
    />
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "stretch" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  acts: { flexDirection: "row", alignItems: "center", gap: 8 },
});
