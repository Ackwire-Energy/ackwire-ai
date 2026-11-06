import { type Message, useAiStatus, useApi } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  aiStateOf,
  mayConnectAi,
  noAiCardOf,
  noAiLineKey,
  planLineFix,
  planLinePasses,
  planOfKind,
  signInAgainPlan,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { EventPillAction, EventPillText, Text } from "@/ui";
import { AskDone, AskWaiting } from "../chat/asks";
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
 * The web's no-AI request under an agent's "I have no AI" reply (`meta.noAi`), as a waiting pill: Connect (tinted, for
 * who may connect) opens the key sheet; anyone else reads who can. Once the agent has an AI, a decided request's pill
 * with "Answer now" has it answer what it couldn't (who asked, its owner or an admin).
 */
export function NoAiCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
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
  const planLine = card.planLine && !(planLinePasses(card.planLine) && state === "ready") ? card.planLine : null;
  const mayConnect = mayConnectAi(agent, meId, org);
  const fix = planLine ? planLineFix(planLine, agent, meId, org) : null;
  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  const locked = (
    <EventPillText>
      <Text variant="footnote" tone="muted">
        {!planLine && owner ? t("noAi.locked", { name, owner }) : t("noAi.lockedAdmins")}
      </Text>
    </EventPillText>
  );
  const title = answering
    ? t("noAi.card.answering", { name })
    : planLine
      ? t(`noAi.rightHand.${planLine}`, { name, model: card.model })
      : ready
        ? t("noAi.card.connected", { name })
        : answer === "still_missing"
          ? t("noAi.card.stillMissing", { name })
          : t(noAiLineKey(card), agentGrammar(name));
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
  // Its agent has an AI now (or is answering): a decided request, one pill with "Answer now" in it.
  if (answering || (!planLine && (ready || answer === "pending")))
    return (
      <AskDone
        done
        words={title}
        actions={
          !answering && mayAnswer ? (
            <EventPillAction
              key="answer"
              label={t("noAi.card.answerNow")}
              loading={answer === "pending"}
              onPress={() => void answerNow()}
            />
          ) : null
        }
      />
    );
  // Still waiting for an AI: the waiting pill, Connect (or the plan's fix) tinted for who may press it.
  const action = planLine ? (
    fix ? (
      <EventPillAction
        key="connect"
        primary
        label={t(fix === "connectMine" ? "rightHand.settings.connectMine" : "noAi.rightHand.useKey")}
        onPress={() =>
          openConnectAi({
            from: m.id,
            agentId: card.agentId,
            ...(fix === "connectMine" ? {} : { intent: "api_key" }),
          })
        }
      />
    ) : null
  ) : mayConnect ? (
    <EventPillAction
      key="connect"
      primary
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
  ) : null;
  return (
    <AskWaiting forMe={action !== null} mark="bolt" words={title} actions={action} below={action ? null : locked} />
  );
}
