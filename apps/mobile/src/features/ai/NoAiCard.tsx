import { type Message, useAiStatus, useApi } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, noAiCardOf, signInAgainPlan } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text, useTheme } from "@/ui";
import { useDirectory, useMeId } from "../shared/hooks";

type Answer = "pending" | "answering" | "still_missing";

/**
 * Opens "Conectar uma IA" (the web's `connect.open`): `from`, the message answered once the agent has an AI;
 * `intent`, the step it asked for; `provider`, the key's maker it named; `agentId`, the agent to connect; `plan`, the
 * plan's page it opens on (Sign in again: the agent's own); `email`, one more login of the account with this email
 * (one other agents use), Claude's hint.
 */
export const openConnectAi = (
  request: { from?: string; intent?: string; provider?: string; agentId?: string; plan?: string; email?: string } = {},
) => {
  const query = Object.entries(request)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
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
  const again = signInAgainPlan(card, agent);
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
        : t(card.signedOut ? "noAi.signedOut" : "noAi.agent", agentGrammar(t, name));
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
          label={t(again ? "agentPage.work.brain.signInAgain" : "noAi.action")}
          onPress={() =>
            openConnectAi({
              from: m.id,
              intent: card.intent,
              provider: card.provider,
              agentId: card.agentId,
              ...(again ? { plan: again } : {}),
            })
          }
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
