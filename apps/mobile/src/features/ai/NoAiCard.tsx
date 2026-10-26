import { type Message, useAiStatus, useApi } from "@agenteschat/client";
import { aiStateOf, noAiCardOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text, useTheme } from "@/ui";
import { useDirectory, useMeId } from "../shared/hooks";

type Answer = "pending" | "answering" | "still_missing";

/** Opens "Conectar uma IA"; with `from`, that message is answered once a key is saved. */
export const openConnectAi = (from?: string, provider?: string) => {
  const query = [
    from ? `from=${encodeURIComponent(from)}` : "",
    provider ? `provider=${encodeURIComponent(provider)}` : "",
  ]
    .filter(Boolean)
    .join("&");
  router.push((query ? `/connect-ai?${query}` : "/connect-ai") as never);
};

/**
 * The web's no-AI card under an agent's "não tenho uma IA" reply (`meta.noAi`): Conectar opens the key sheet,
 * and once the agent has an AI, Responder agora has it answer what it couldn't (who asked, its owner or an admin).
 */
export function NoAiCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const status = useAiStatus(orgId);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const meId = useMeId();
  const card = noAiCardOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const state = aiStateOf(status.data, card.agentId);
  const ready = state !== undefined && state !== "no_ai" && answer !== "still_missing";
  const mayAnswer =
    card.forUserId === meId || (meId !== null && agent?.ownerUserId === meId) || can(org?.role, "manage_agents");
  const answering = answer === "answering";
  const title = answering
    ? t("noAi.card.answering", { name })
    : ready
      ? t("noAi.card.connected", { name })
      : answer === "still_missing"
        ? t("noAi.card.stillMissing", { name })
        : t("noAi.agent", { name });
  const answerNow = async () => {
    setAnswer("pending");
    try {
      await api.chat.answerNow(orgId, m.id);
      setAnswer("answering");
    } catch (error) {
      const code = (error as { code?: string }).code;
      setAnswer(code === "ai.still_missing" ? "still_missing" : null);
    }
  };
  return (
    <View style={[styles.card, { backgroundColor: colors.sunken }]}>
      <View style={styles.top}>
        <Icon name={ready || answering ? "check" : "bolt"} size={16} color={colors.ink2} />
        <Text variant="subhead" style={styles.title}>
          {title}
        </Text>
      </View>
      {!ready && !answer && card.forUserId === meId ? (
        <Text variant="small" tone="muted">
          {t("noAi.card.line", { name })}
        </Text>
      ) : null}
      {answering ? null : ready || answer === "pending" ? (
        mayAnswer ? (
          <Button
            variant="primary"
            size="sm"
            label={t("noAi.card.answerNow")}
            disabled={answer === "pending"}
            onPress={() => void answerNow()}
          />
        ) : null
      ) : (
        <Button
          variant="secondary"
          size="sm"
          label={t("noAi.action")}
          onPress={() => openConnectAi(m.id, card.provider)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "flex-start" },
  top: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
});
