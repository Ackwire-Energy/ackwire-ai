import {
  type Agent,
  keys,
  useAiStatus,
  useApi,
  useApplyTeamTemplate,
  useChannels,
  useComputerSetup,
  useMembers,
  useMessages,
  useSetAgentStyle,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, noAiCardOf } from "@agenteschat/client/lib/no-ai";
import { PRESET_LOOK, PRESETS, type Preset, presetInput } from "@agenteschat/client/lib/onboarding";
import { can } from "@agenteschat/client/lib/permissions";
import { introCards, isRightHand, offersTeamSetup, presetsLeft } from "@agenteschat/client/lib/right-hand";
import { BUSINESS_TYPES, isTemplateBusiness, startCardAnswer } from "@agenteschat/client/lib/team-plan";
import { WAVE_SECONDS } from "@agenteschat/ui/agent/stickers";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { StickerCanvas } from "@/agent/StickerCanvas";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, Icon, type IconName, LineIcon, Locked, Text } from "@/ui";
import { fullLook } from "../agents/edit";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { requestComposerText } from "../chat/composer-request";
import { MESSAGE_STICKER } from "../chat/media";
import { useOpenDm } from "../new/useOpenDm";
import { useFailed } from "../routines/hooks";
import { AgentFace, OpensAgent } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic, useSurface } from "../shared/parts";
import { AnswerChips, TeamTemplatesSheet, useSendAnswer } from "./TeamCard";

/**
 * The top of the right hand's DM (ADR 0137), drawn by the app and never stored, so it costs nothing and works before
 * any AI is connected: its greeting, then the first card the workspace needs, as on the web. No AI yet: Connect AI.
 * An AI and no agent besides it: how to start (the ready-made agents, describing the need, an import or the form). A
 * team and nobody else here yet: inviting people and the first task, written in that agent's composer. Last, until the
 * person picks, how agents talk to them (ADR 0147). Once the start card has stopped asking, a line to build the team
 * with it, at any time. On a billing hold it can't answer, so the start card and what's next alone, with no model call
 * behind them. On the person's first visit (`waveFrom`, when its wave started), its waving sticker under the
 * greeting, drawn as a sticker message is and decorative.
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
  const held = usePlanHold(orgId, org) !== null;
  const setup = useComputerSetup(orgId);
  // A hold is known with the edition: until then no card, so Connect doesn't flash before the start card.
  const noAi = aiStateOf(status.data, agent.id) === "no_ai";
  const aiKnown = Boolean(status.data) && !setup.isPending;
  const createsAgents = can(org, "create_agents");
  const cards = introCards({
    noAi: noAi && aiKnown,
    aiKnown,
    teamHandles,
    createsAgents,
    alone: (members.data?.length ?? 0) <= 1,
    askStyle: org?.agentStyle === null,
    held,
    noAiCard: useMessages(orgId, channelId).data?.some((m) => noAiCardOf(m.meta)),
  });
  const send = useSendAnswer(channelId);
  return (
    <View style={styles.intro}>
      <View style={styles.head}>
        <OpensAgent agentId={agent.id}>
          <AgentFace agentId={agent.id} size={36} />
        </OpensAgent>
        <Text variant="body" style={[styles.bold, styles.shrink]}>
          {agent.name}
        </Text>
      </View>
      <View style={styles.text}>
        <Text variant="body" style={styles.bold}>
          {t("rightHand.intro.greeting", agentGrammar(agent.name))}
        </Text>
        <Text variant="body" tone="ink2">
          {t(held ? "rightHand.intro.heldLead" : "rightHand.intro.lead")}
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
          <StartCard channelId={channelId} left={presetsLeft(teamHandles)} first={team.length === 0} held={held} />
        )}
        {cards.includes("next") && first && <NextCard first={first} held={held} />}
        {cards.includes("style") && <StyleCard />}
        {offersTeamSetup({ noAi, aiKnown, createsAgents, hasTeam: team.length > 0, cards, held }) ? (
          <View>
            <Text variant="small" tone="muted">
              {t("rightHand.intro.again.question")}
            </Text>
            <Button
              variant="text"
              size="sm"
              label={t("rightHand.intro.again.action")}
              onPress={() => send(t("rightHand.intro.again.message"))}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * How to start (ADR 0137 §10), as on the web. No agent yet: "O que a Acme faz?" with business types as chips (each tap
 * the person's own message) or a sentence typed, then the other ways in: the templates (a sheet), the ready-made
 * agents, an import or the form. With ready-made agents already made, the tiles of the ones left. On a billing hold a
 * tap posts that business's template, with no model call, and "Outra coisa" opens the templates.
 */
function StartCard({
  channelId,
  left,
  first,
  held,
}: {
  channelId: string;
  left: readonly Preset[];
  first: boolean;
  held: boolean;
}) {
  const { t, i18n } = useTranslation();
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
  const useTemplate = useApplyTeamTemplate(orgId);
  const other = t("teamPlan.business.other");
  const choices = BUSINESS_TYPES.map((b) => t(`teamPlan.business.${b}`));
  const answer = first ? startCardAnswer(messages, choices) : null;
  const tap = (text: string) => {
    const business = BUSINESS_TYPES[choices.indexOf(text)];
    if (!held) return text === other ? requestComposerText(channelId, "") : send(text);
    if (!business || !isTemplateBusiness(business)) return setTemplates(true);
    useTemplate.mutate({ templateId: business, locale: i18n.language, tap: text }, { onError: failed });
  };
  return (
    <IntroCard
      icon="agent"
      title={first ? t("teamPlan.start.question", { org: org?.name ?? "" }) : t("rightHand.intro.start.question")}
      text={
        first && answer === null
          ? held
            ? undefined
            : t("teamPlan.start.orWrite")
          : first
            ? t("teamPlan.answered")
            : undefined
      }
    >
      {first ? (
        <Locked when={useTemplate.isPending}>
          <AnswerChips choices={choices} multiple={false} answer={answer} onSend={tap} />
        </Locked>
      ) : null}
      {presetsOpen && answer === null ? (
        <>
          {/* Flat rows on the card, divided by hairlines: a tap makes that agent (its "+" says so). */}
          <Locked when={create.isPending}>
            {left.map((p, i) => {
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
                    i > 0 && [styles.divided, { borderTopColor: c.line2 }],
                    pressed && styles.pressed,
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
                  <Icon name="plus" size={15} color={c.faint} />
                </Pressable>
              );
            })}
          </Locked>
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
      {answer === null ? (
        <>
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
        </>
      ) : null}
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
function NextCard({ first, held }: { first: Agent; held: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const openDm = useOpenDm();
  const preset = PRESETS.find((p) => p === first.handle);
  return (
    <IntroCard icon="members" title={t("rightHand.intro.next.question")}>
      {can(org, "invite_people") && !held ? (
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
      <View style={styles.cardHead}>
        <LineIcon name={icon} size={15} color={c.ink2} variant="subhead" />
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
  // A long name wraps beside the face instead of running past the screen's edge.
  shrink: { flexShrink: 1 },
  card: { marginTop: 6, borderRadius: 20, padding: 14, gap: 10 },
  // A question that wraps keeps its icon on its first line.
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  // A ready-made agent to make: at least 44 points to tap.
  preset: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingVertical: 8 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  pressed: { opacity: 0.6 },
});
