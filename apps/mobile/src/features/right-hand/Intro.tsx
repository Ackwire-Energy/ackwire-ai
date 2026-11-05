import {
  type Agent,
  keys,
  useAiStatus,
  useApi,
  useChannels,
  useMembers,
  useMessages,
  useSetAgentStyle,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { PRESET_LOOK, PRESETS, type Preset, presetInput } from "@agenteschat/client/lib/onboarding";
import { can } from "@agenteschat/client/lib/permissions";
import { introCards, isRightHand, presetsLeft } from "@agenteschat/client/lib/right-hand";
import { answerAfter, BUSINESS_TYPES } from "@agenteschat/client/lib/team-plan";
import { WAVE_SECONDS } from "@agenteschat/ui/agent/stickers";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { StickerCanvas } from "@/agent/StickerCanvas";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, Icon, type IconName, Text } from "@/ui";
import { fullLook } from "../agents/edit";
import { openConnectAi } from "../ai/NoAiCard";
import { requestComposerText } from "../chat/composer-request";
import { MESSAGE_STICKER } from "../chat/media";
import { useOpenDm } from "../new/useOpenDm";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic, useSurface } from "../shared/parts";
import { AnswerChips, TeamTemplatesSheet, useSendAnswer } from "./TeamCard";

/**
 * The top of the right hand's DM (ADR 0137), drawn by the app and never stored, so it costs nothing and works before
 * any AI is connected: its greeting, then the first card the workspace needs, as on the web. No AI yet: Connect AI.
 * An AI and no agent besides it: how to start (the ready-made agents, describing the need, an import or the form). A
 * team and nobody else here yet: inviting people and the first task, written in that agent's composer. Last, until the
 * person picks, how agents talk to them (ADR 0147). On the
 * person's first visit (`waveFrom`, when its wave started), its waving sticker under the greeting, drawn as a sticker
 * message is and decorative.
 */
export function RightHandIntro({ agent, channelId, waveFrom }: { agent: Agent; channelId: string; waveFrom?: number }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const members = useMembers(orgId);
  const team = dir.agents.filter((a) => !isRightHand(a));
  const first = team[0];
  const teamHandles = team.map((a) => a.handle);
  const cards = introCards({
    noAi: aiStateOf(status.data, agent.id) === "no_ai",
    aiKnown: Boolean(status.data),
    teamHandles,
    createsAgents: can(org, "create_agents"),
    alone: (members.data?.length ?? 0) <= 1,
    askStyle: org?.agentStyle === null,
  });
  return (
    <View style={styles.intro}>
      <View style={styles.head}>
        <AgentFace agentId={agent.id} size={36} />
        <Text variant="body" style={styles.bold}>
          {agent.name}
        </Text>
      </View>
      <View style={styles.text}>
        <Text variant="body" style={styles.bold}>
          {t("rightHand.intro.greeting", agentGrammar(agent.name))}
        </Text>
        <Text variant="body" tone="ink2">
          {t("rightHand.intro.lead")}
        </Text>
        {waveFrom !== undefined ? (
          <View style={styles.sticker} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <StickerCanvas
              look={agentLook(agent)}
              mood="wave"
              size={MESSAGE_STICKER}
              seed={agent.id}
              live
              playFor={WAVE_SECONDS}
              from={waveFrom}
            />
          </View>
        ) : null}
        {cards.includes("connect") && (
          <IntroCard icon="brain" title={t("rightHand.intro.connect.title")} text={t("rightHand.intro.connect.text")}>
            <Button
              variant="primary"
              size="card"
              wide
              label={t("rightHand.intro.connect.action")}
              onPress={() => openConnectAi({ agentId: agent.id })}
            />
          </IntroCard>
        )}
        {cards.includes("start") && (
          <StartCard channelId={channelId} left={presetsLeft(teamHandles)} first={team.length === 0} />
        )}
        {cards.includes("next") && first && <NextCard first={first} />}
        {cards.includes("style") && <StyleCard />}
      </View>
    </View>
  );
}

/**
 * How to start (ADR 0137 §10), as on the web. No agent yet: "O que a Acme faz?" with business types as chips (each tap
 * the person's own message) or a sentence typed, then the other ways in: the templates (a sheet), the ready-made
 * agents, an import or the form. With ready-made agents already made, the tiles of the ones left.
 */
function StartCard({ channelId, left, first }: { channelId: string; left: readonly Preset[]; first: boolean }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const c = useColors();
  const failed = useFailed();
  const channels = useChannels(orgId);
  const messages = useMessages(orgId, channelId).data;
  const send = useSendAnswer(channelId);
  // With ready-made agents already made, their tiles show from the start.
  const [opened, setPresetsOpen] = useState(false);
  const presetsOpen = opened || !first;
  const [templates, setTemplates] = useState(false);
  const general = channels.data?.find((ch) => ch.name === "general");
  const create = useMutation({
    mutationFn: async (presets: readonly Preset[]) => {
      for (const p of presets) {
        const made = await api.agents.create(orgId, presetInput(t, p));
        // In #general, where mentions reach it.
        if (general) await api.chat.addMember(orgId, general.id, { agentId: made.id });
      }
    },
    onError: failed,
    onSettled: () => qc.invalidateQueries({ queryKey: keys.agents(orgId) }),
  });
  const answer = first ? answerAfter(messages, null) : null;
  const other = t("teamPlan.business.other");
  return (
    <IntroCard
      icon="agent"
      title={first ? t("teamPlan.start.question", { org: org?.name ?? "" }) : t("rightHand.intro.start.question")}
      text={first && answer === null ? t("teamPlan.start.orWrite") : first ? t("teamPlan.answered") : undefined}
    >
      {first ? (
        <AnswerChips
          choices={BUSINESS_TYPES.map((b) => t(`teamPlan.business.${b}`))}
          multiple={false}
          answer={answer}
          onSend={(text) => (text === other ? requestComposerText(channelId, "") : send(text))}
        />
      ) : null}
      {presetsOpen ? (
        <>
          <View style={styles.presets}>
            {left.map((p) => {
              const name = t(`onboarding.presets.${p}.name`);
              return (
                <Pressable
                  key={p}
                  disabled={create.isPending}
                  onPress={() => {
                    tapHaptic();
                    create.mutate([p]);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t("rightHand.intro.start.createOne", { name })}
                  style={({ pressed }) => [
                    styles.preset,
                    { borderColor: c.line2 },
                    pressed && { backgroundColor: c.sunken },
                  ]}
                >
                  <AgentAvatar agent={fullLook(PRESET_LOOK[p])} size={28} name={name} live={false} />
                  <View style={styles.fill}>
                    <Text variant="small" style={styles.bold} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text variant="caption" tone="muted" numberOfLines={1}>
                      {t(`onboarding.presets.${p}.role`)}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
          <Button
            variant="secondary"
            size="card"
            wide
            label={t("rightHand.intro.start.team")}
            loading={create.isPending}
            onPress={() => create.mutate(left)}
          />
        </>
      ) : null}
      <Text variant="caption" tone="muted">
        {t("teamPlan.start.footer")}
      </Text>
      <Button
        variant="secondary"
        size="card"
        wide
        label={t("teamPlan.start.templates")}
        onPress={() => setTemplates(true)}
      />
      {presetsOpen ? null : (
        <Button
          variant="ghost"
          size="card"
          wide
          label={t("teamPlan.start.presets")}
          onPress={() => setPresetsOpen(true)}
        />
      )}
      <Button
        variant="ghost"
        size="card"
        wide
        label={t("rightHand.intro.start.import")}
        onPress={() => router.push("/settings/import")}
      />
      <Button
        variant="ghost"
        size="card"
        wide
        label={t("rightHand.intro.start.form")}
        onPress={() => router.push("/new-agent")}
      />
      <TeamTemplatesSheet
        open={templates}
        onClose={() => setTemplates(false)}
        onNone={() => {
          setTemplates(false);
          requestComposerText(channelId, "");
        }}
      />
    </IntroCard>
  );
}

/** The team is here, nobody else yet: invite the people, or the first agent's DM with a first task written in. */
function NextCard({ first }: { first: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const openDm = useOpenDm();
  const preset = PRESETS.find((p) => p === first.handle);
  return (
    <IntroCard icon="members" title={t("rightHand.intro.next.question")}>
      {can(org, "invite_people") ? (
        <Button
          variant="primary"
          size="card"
          wide
          label={t("rightHand.intro.next.invite")}
          onPress={() => router.push("/invite-people")}
        />
      ) : null}
      <Button
        variant="secondary"
        size="card"
        wide
        label={t("rightHand.intro.next.firstTask", agentGrammar(first.name))}
        onPress={() =>
          void openDm(
            { agentId: first.id },
            { compose: true, text: preset ? t(`rightHand.intro.firstTask.${preset}`) : "" },
          )
        }
      />
    </IntroCard>
  );
}

/** "Como prefere que eu fale com você?": two answers, saved for every agent here; gone once the person picks. */
function StyleCard() {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const failed = useFailed();
  const save = useSetAgentStyle(orgId);
  return (
    <IntroCard icon="chat" title={t("rightHand.intro.style.question")} text={t("rightHand.intro.style.text")}>
      <Button
        variant="primary"
        size="card"
        wide
        label={t("rightHand.intro.style.simple")}
        disabled={save.isPending}
        onPress={() => save.mutate("simple", { onError: failed })}
      />
      <Button
        variant="secondary"
        size="card"
        wide
        label={t("rightHand.intro.style.technical")}
        disabled={save.isPending}
        onPress={() => save.mutate("technical", { onError: failed })}
      />
    </IntroCard>
  );
}

function IntroCard({
  icon,
  title,
  text,
  children,
}: {
  icon: IconName;
  title: string;
  text?: string;
  children: ReactNode;
}) {
  const c = useColors();
  const surface = useSurface();
  return (
    <View style={[styles.card, surface]}>
      <View style={styles.head}>
        <Icon name={icon} size={16} color={c.ink2} />
        <Text variant="subhead" style={[styles.bold, styles.fill]}>
          {title}
        </Text>
      </View>
      {text ? (
        <Text variant="small" tone="muted">
          {text}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  text: { gap: 8 },
  bold: { fontWeight: "600" },
  sticker: { width: MESSAGE_STICKER, height: MESSAGE_STICKER, marginTop: 4 },
  fill: { flex: 1, minWidth: 0 },
  card: { marginTop: 6, borderRadius: 16, padding: 14, gap: 10 },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  preset: {
    flexBasis: "47%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 8,
  },
});
