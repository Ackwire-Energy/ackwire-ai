import { type Message, useAiStatus, useApi } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, noAiCardOf, planOfKind, signInAgainPlan } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, LineIcon, Text, useTheme } from "@/ui";
import { useDirectory, useMeId } from "../shared/hooks";

type Answer = "pending" | "answering" | "still_missing";

/**
 * Opens "Conectar uma IA" (the web's `connect.open`): `from`, the message answered once the agent has an AI;
 * `intent`, the step it asked for; `provider`, the key's maker it named; `agentId`, the agent to connect; `plan`, the
 * plan's page it opens on (Sign in again: the agent's own); `email`, one more login of the account with this email
 * (one other agents use), Claude's hint.
 */
export const openConnectAi = (
  request: {
    from?: string;
    intent?: string;
    provider?: string;
    agentId?: string;
    plan?: string;
    email?: string;
    /** "1": from the create-agent step, for the agent being made (a plan signs in for the agents I create). */
    forNew?: string;
  } = {},
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
  // The computer's own sign-in isn't there: Conectar opens on an account of that CLI's plan.
  const plan = card.own ? planOfKind(card.own) : again;
  const state = aiStateOf(status.data, card.agentId);
  const ready = state !== undefined && state !== "no_ai" && answer !== "still_missing";
  const mayAnswer =
    card.forUserId === meId || (meId !== null && agent?.ownerUserId === meId) || can(org, "manage_agents");
  const answering = answer === "answering";
  // The team's right hand on a plan that can't think now (ADR 0137 §7): one plain line, and the way to an API key.
  const planLine = card.planLine && !(card.planLine === "computer_away" && state === "ready") ? card.planLine : null;
  const title = answering
    ? t("noAi.card.answering", { name })
    : planLine
      ? t(`noAi.rightHand.${planLine}`, { name })
      : ready
        ? t("noAi.card.connected", { name })
        : answer === "still_missing"
          ? t("noAi.card.stillMissing", { name })
          : card.own
            ? t(`noAi.notSignedIn.${card.own}`, agentGrammar(name))
            : t(card.signedOut ? "noAi.signedOut" : "noAi.agent", agentGrammar(name));
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
        <LineIcon name={ready || answering ? "check" : "bolt"} variant="subhead" size={16} color={colors.ink2} />
        <Text variant="subhead" style={styles.title}>
          {title}
        </Text>
      </View>
      {answering ? null : planLine ? (
        <Button
          variant="secondary"
          size="sm"
          label={t("noAi.rightHand.useKey")}
          onPress={() => openConnectAi({ from: m.id, intent: "api_key", agentId: card.agentId })}
        />
      ) : ready || answer === "pending" ? (
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
              ...(plan ? { plan } : {}),
            })
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "flex-start" },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
});
