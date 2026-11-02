import { type Message, useApi } from "@agenteschat/client";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { mayContinueUsage, usagePauseCardOf, usagePauseText } from "@agenteschat/client/lib/usage-pause";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text, useTheme } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";

/**
 * The web's card of long work paused near its plan's or budget's limit (ADR 0118), in place of its text: when it
 * picks up by itself, and Continuar agora for the person behind the work, the agent's owner and admins (anyone else
 * sees it greyed, with who may press it).
 */
export function UsagePauseCard({ message: m }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  const card = usagePauseCardOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const { title, line } = usagePauseText(t, i18n.language, card, name);
  const may = mayContinueUsage(card, meId, agent?.ownerUserId, can(org, "manage_agents"));
  const by = card.continuedByUserId;
  const time = card.continuedAt ? clockAt(i18n.language, card.continuedAt) : "";
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
  const done = card.state !== "paused";
  return (
    <View style={[styles.card, { backgroundColor: colors.sunken }]}>
      <View style={styles.row}>
        <Icon name={done ? "check" : "pause"} size={16} color={colors.ink2} />
        <Text variant="subhead" style={styles.title}>
          {title}
        </Text>
      </View>
      {card.state === "continued" && by ? (
        <Text variant="footnote" tone="faint">
          {by === meId
            ? t("stretchCard.continuedByYou", { time })
            : t("stretchCard.continued", { name: dir.memberById.get(by)?.name ?? t("channel.unknownPerson"), time })}
        </Text>
      ) : card.state === "resumed" || card.state === "ended" ? (
        <Text variant="footnote" tone="faint">
          {t(`usageCard.${card.state}`, { agent: name })}
        </Text>
      ) : (
        <>
          <Text variant="footnote" tone="faint">
            {line}
          </Text>
          <Button
            variant="primary"
            size="sm"
            label={t("usageCard.continue")}
            disabled={pending || !may}
            onPress={() => void go()}
          />
          {!may ? (
            <Text variant="footnote" tone="faint">
              {t("usageCard.forbidden")}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "flex-start" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
});
