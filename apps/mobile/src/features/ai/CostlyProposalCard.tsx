import { type CostlyDecision, type Message, useApi } from "@agenteschat/client";
import { costlyProposalOf, mayDecideCostly, mayRememberCostly } from "@agenteschat/client/lib/action-cards";
import { can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, LineIcon, Text, useTheme } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";

/**
 * The web's card of costly work nobody asked for (ADR 0131 §3) in place of its text: what the agent wants to run, and
 * Pode fazer, Sempre, Agora não or Nunca for this kind, for the person it is for, the agent's owner or an admin; then
 * who decided what.
 */
export function CostlyProposalCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  const card = costlyProposalOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const ownerOf = (id: string) => dir.agentById.get(id)?.ownerUserId;
  const may = mayDecideCostly(card, meId ?? "", ownerOf, can(org, "manage_agents"));
  const remembers = mayRememberCostly(card, meId ?? "", ownerOf, can(org, "manage_agents"));
  const decide = async (decision: CostlyDecision) => {
    setPending(true);
    try {
      await api.agents.decideCostly(orgId, card.signalId, decision);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
    }
  };
  const decided = card.state !== "open";
  const by = card.decidedByUserId;
  const who = by === meId ? t("costlyCard.you") : (dir.memberById.get(by ?? "")?.name ?? t("channel.unknownPerson"));
  return (
    <View style={[styles.card, { backgroundColor: colors.sunken }]}>
      <View style={styles.row}>
        <LineIcon name={decided ? "check" : "shield"} variant="subhead" size={16} color={colors.ink2} />
        <Text variant="subhead" style={styles.title}>
          {t(`chat.body.autonomy_proposal.${card.cost}`)}
        </Text>
      </View>
      {card.what ? (
        <Text variant="footnote" tone="faint">
          {card.what}
        </Text>
      ) : null}
      {decided ? (
        <Text variant="footnote" tone="faint">
          {t(`costlyCard.decided.${card.state === "open" ? "go" : card.state}`, { name: who })}
        </Text>
      ) : may ? (
        <View style={styles.acts}>
          <Button
            variant="primary"
            size="sm"
            label={t("costlyCard.go")}
            disabled={pending}
            onPress={() => void decide("go")}
          />
          {remembers ? (
            <Button
              size="sm"
              variant="secondary"
              label={t("costlyCard.always")}
              disabled={pending}
              onPress={() => void decide("always")}
            />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            label={t("costlyCard.notNow")}
            disabled={pending}
            onPress={() => void decide("not_now")}
          />
          {remembers ? (
            <Button
              size="sm"
              variant="ghost"
              label={t("costlyCard.never")}
              disabled={pending}
              onPress={() => void decide("never")}
            />
          ) : null}
        </View>
      ) : (
        <Text variant="footnote" tone="faint">
          {t("costlyCard.waiting")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 12, gap: 8, alignItems: "flex-start" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
