import { type Message, useApi } from "@agenteschat/client";
import { mayContinueStretch, stretchCardOf, stretchCardText } from "@agenteschat/client/lib/action-cards";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, LineIcon, Text, useTheme } from "@/ui";
import { AskDone } from "../chat/asks";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";

/**
 * The web's pause card of a stretch (ADR 0089) in place of its text: the agents did what they may do on their own
 * since a person last acted, and wait. Continuar lets them go on (who asked, the agents' owners or an admin); then the
 * card folds to one quiet line: who did, and when. The phone says the budget share as a percentage only.
 */
export function StretchCard({ message: m }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  const card = stretchCardOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const names = card.agentIds.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent"));
  const continued = card.state === "continued";
  const by = card.continuedByUserId;
  const time = card.continuedAt ? clockAt(i18n.language, card.continuedAt) : "";
  const may = mayContinueStretch(card, meId, (id) => dir.agentById.get(id)?.ownerUserId, can(org, "manage_agents"));
  const go = async () => {
    setPending(true);
    try {
      await api.chat.answerNow(orgId, m.id);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
    }
  };
  if (continued) {
    return (
      <View>
        <AskDone
          done
          words={
            by === meId
              ? t("stretchCard.continuedByYou", { time })
              : t("stretchCard.continued", {
                  name: (by && dir.memberById.get(by)?.name) ?? t("channel.unknownPerson"),
                  time,
                })
          }
        />
      </View>
    );
  }
  return (
    <View style={[styles.card, { backgroundColor: colors.sunken }]}>
      <View style={styles.row}>
        <LineIcon name="pause" variant="subhead" size={16} color={colors.ink2} />
        <Text variant="subhead" style={styles.title}>
          {stretchCardText(t, card, names)}
        </Text>
      </View>
      {may ? (
        <Button variant="primary" size="sm" label={t("run.continueRun")} disabled={pending} onPress={() => void go()} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 12, gap: 8, alignItems: "flex-start" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
});
