import type { Agent } from "@agenteschat/client";
import {
  keys,
  useAiStatus,
  useApplyTeamTemplate,
  useChannels,
  useComputerSetup,
  useMembers,
  useMessages,
  useRightHandWave,
  useSetAgentStyle,
} from "@agenteschat/client";
import { setDraftFor } from "@agenteschat/client/lib/drafts";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, noAiCardOf } from "@agenteschat/client/lib/no-ai";
import { PRESET_LOOK, PRESETS, type Preset, presetInput } from "@agenteschat/client/lib/onboarding";
import { can } from "@agenteschat/client/lib/permissions";
import { introCards, isRightHand, offersTeamSetup, presetsLeft } from "@agenteschat/client/lib/right-hand";
import { BUSINESS_TYPES, isTemplateBusiness, startCardAnswer } from "@agenteschat/client/lib/team-plan";
import {
  AgentSticker,
  Button,
  EventPillAction,
  Message,
  MessageText,
  normalizeAppearance,
  WAVE_SECONDS,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { MESSAGE_STICKER } from "@/chat/ChatMedia";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { useConnectAi } from "@/components/ConnectAi";
import { useChannelActions } from "@/components/channel-actions";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { useOrg } from "@/components/org-context";
import { AuthorStatus } from "@/components/Presence";
import { ProfileTrigger } from "@/components/ProfileCard";
import { RequestCard, RequestChoices, RequestKeys, RequestOpen } from "@/components/RequestCard";
import { AnswerChips, TeamTemplatesDialog } from "@/components/TeamPlan";
import { TextAction } from "@/components/UsagePauseCard";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/**
 * The top of the right hand's DM (ADR 0137), drawn by the app and never stored, so it costs nothing and works before
 * any AI is connected: its greeting, then the one card the workspace needs next (`introCards`). No AI yet: a waiting
 * pill with "Connect AI". An AI and no agent besides it: how to start. A team: how agents talk to the person (ADR 0147)
 * until they pick, then, nobody else here yet, inviting people and the first task. With no card left, a line to build
 * the team with it, at any time. On a billing hold it can't answer, so the start card and what's next alone, with no
 * model call behind them. On the person's first visit, its waving sticker under the greeting, drawn as a sticker
 * message is and decorative (the greeting already says hello). Its face and name open the profile card, as on any
 * message.
 */
export function RightHandIntro({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const members = useMembers(org.id);
  const connect = useConnectAi();
  const actions = useChannelActions();
  const wave = useRightHandWave(org.id, agent.id);
  const team = dir.agents.filter((a) => !isRightHand(a));
  const teamHandles = team.map((a) => a.handle);
  const held = usePlanHold() !== null;
  const setup = useComputerSetup(org.id);
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
    askStyle: org.agentStyle === null,
    held,
    noAiCard: useMessages(org.id, channelId).data?.some((m) => noAiCardOf(m.meta)),
  });
  const profile = { actor: { type: "agent", id: agent.id }, label: t("profile.of", { name: agent.name }) } as const;
  return (
    <Message
      agent
      avatar={
        <ProfileTrigger {...profile} decorative>
          <AgentAvatar agentId={agent.id} name={agent.name} presence />
        </ProfileTrigger>
      }
      author={
        <>
          <ProfileTrigger {...profile} className="profile-trigger--name">
            {agent.name}
          </ProfileTrigger>
          <AuthorStatus actor={profile.actor} />
        </>
      }
      time={<time dateTime={agent.createdAt}>{formatTime(i18n.language, agent.createdAt)}</time>}
    >
      <MessageText>
        {/* The wrapper a typed message's Markdown has (MessageBody): without it, a paragraph keeps the browser's margins. */}
        <div className="md md--message">
          <p>
            <b>{t("rightHand.intro.greeting", agentGrammar(agent.name))}</b>
          </p>
          <p>{t(held ? "rightHand.intro.heldLead" : "rightHand.intro.lead")}</p>
        </div>
      </MessageText>
      {wave && (
        <AgentSticker
          appearance={lookOf(agent)}
          mood="wave"
          playFor={WAVE_SECONDS}
          size={MESSAGE_STICKER}
          className="ac-msg-media"
        />
      )}
      {cards.includes("connect") && connect && (
        <RequestOpen
          mine
          action={
            <EventPillAction primary onClick={() => connect.open({ agentId: agent.id })}>
              {t("rightHand.intro.connect.action")}
            </EventPillAction>
          }
          below={<p>{t("rightHand.intro.connect.text")}</p>}
        >
          {t("rightHand.intro.connect.title")}
        </RequestOpen>
      )}
      {cards.includes("start") && (
        <StartCard
          agent={agent}
          left={presetsLeft(teamHandles)}
          first={team.length === 0}
          channelId={channelId}
          held={held}
        />
      )}
      {cards.includes("next") && team[0] && <NextCard agent={agent} first={team[0]} held={held} />}
      {cards.includes("style") && <StyleCard agent={agent} />}
      {offersTeamSetup({ noAi, aiKnown, createsAgents, hasTeam: team.length > 0, cards, held }) && (
        <p className="rh-intro__again small muted">
          {t("rightHand.intro.again.question")}{" "}
          <TextAction onClick={() => actions?.resend(t("rightHand.intro.again.message"))}>
            {t("rightHand.intro.again.action")}
          </TextAction>
        </p>
      )}
    </Message>
  );
}

/**
 * How to start (ADR 0137 §10). With no agent yet: "O que a Acme faz?", business types to tap or a sentence to write
 * (each tap the person's own message, which starts the right hand's interview), and the other ways in under it: the
 * team templates, the ready-made agents or an import. Answered, it reads "respondida" with the pick alone, and those
 * ways in are gone.
 * With ready-made agents already made, the tiles of the ones left, each its own Criar. On a billing hold a tap posts
 * that business's template, with no model call, and "Outra coisa" opens the gallery: writing is what won't work yet.
 */
function StartCard({
  agent,
  left,
  first,
  channelId,
  held,
}: {
  agent: Agent;
  left: readonly Preset[];
  first: boolean;
  channelId: string;
  held: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const actions = useChannelActions();
  const channels = useChannels(org.id);
  const messages = useMessages(org.id, channelId).data;
  // With ready-made agents already made, their tiles show from the start.
  const [opened, setPresetsOpen] = useState(false);
  const presetsOpen = opened || !first;
  const [templates, setTemplates] = useState(false);
  const general = channels.data?.find((c) => c.name === "general");
  const create = useMutation({
    mutationFn: async (presets: readonly Preset[]) => {
      for (const p of presets) {
        const made = await api.agents.create(org.id, presetInput(t, p));
        // In #general, where mentions reach it.
        if (general) await api.chat.addMember(org.id, general.id, { agentId: made.id });
      }
    },
    onError: (e) => toast.show(errorText(t, e), "error"),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.agents(org.id) }),
  });
  const useTemplate = useApplyTeamTemplate(org.id);
  const other = t("teamPlan.business.other");
  const choices = BUSINESS_TYPES.map((b) => t(`teamPlan.business.${b}`));
  const answer = first ? startCardAnswer(messages, choices) : null;
  const tap = (text: string) => {
    const business = BUSINESS_TYPES[choices.indexOf(text)];
    if (!held) return text === other ? actions?.focusComposer() : actions?.resend(text);
    if (!business || !isTemplateBusiness(business)) return setTemplates(true);
    useTemplate.mutate(
      { templateId: business, locale: i18n.language, tap: text },
      { onError: (e) => toast.show(errorText(t, e), "error") },
    );
  };
  const question = first ? t("teamPlan.start.question", { org: org.name }) : t("rightHand.intro.start.question");
  return (
    <>
      <RequestCard
        id={`right-hand-start-${agent.id}`}
        kind="question"
        agent={agent}
        label={question}
        mine={first && answer === null}
        waitingFor={answer !== null ? t("teamPlan.answered") : undefined}
        lead={question}
        what={question}
        locked={create.isPending || useTemplate.isPending}
        body={
          <>
            {first && <AnswerChips choices={choices} multiple={false} answer={answer} onSend={tap} />}
            {first && answer === null && !held && <p className="tp-start__write">{t("teamPlan.start.orWrite")}</p>}
            {presetsOpen && answer === null && (
              <div className="rh-intro__presets">
                {left.map((p) => {
                  const name = t(`onboarding.presets.${p}.name`);
                  return (
                    <button
                      key={p}
                      type="button"
                      className="rh-intro__preset"
                      aria-label={t("rightHand.intro.start.createOne", { name })}
                      disabled={create.isPending}
                      onClick={() => create.mutate([p])}
                    >
                      <AgentAvatar name={name} appearance={normalizeAppearance(PRESET_LOOK[p])} size="sm" />
                      <span className="rh-intro__preset-text">
                        <b className="ac-captop">{name}</b>
                        <small>{t(`onboarding.presets.${p}.role`)}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        }
        actions={
          answer === null && (
            <span className="tp-start__foot">
              <span className="small muted">{t("teamPlan.start.footer")}</span>
              <button type="button" className="ac-link" onClick={() => setTemplates(true)}>
                {t("teamPlan.start.templates")}
              </button>
              {presetsOpen ? (
                <button
                  type="button"
                  className="ac-link"
                  disabled={create.isPending}
                  aria-busy={create.isPending}
                  onClick={() => create.mutate(left)}
                >
                  {t("rightHand.intro.start.team")}
                </button>
              ) : (
                <button type="button" className="ac-link" onClick={() => setPresetsOpen(true)}>
                  {t("teamPlan.start.presets")}
                </button>
              )}
              <button
                type="button"
                className="ac-link"
                onClick={() =>
                  void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "import" } })
                }
              >
                {t("rightHand.intro.start.import")}
              </button>
            </span>
          )
        }
      />
      <TeamTemplatesDialog open={templates} onClose={() => setTemplates(false)} />
    </>
  );
}

/**
 * The team is here, nobody else yet: invite the people, or open the first agent's DM with a first task written. A
 * suggestion, never waiting for the person: alone in a workspace, it stays. On a billing hold the plan comes first:
 * invitations open with it, so offering one would be a second wall.
 */
function NextCard({ agent, first, held }: { agent: Agent; first: Agent; held: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const invite = useInviteDialog();
  const question = t("rightHand.intro.next.question");
  const preset = PRESETS.find((p) => p === first.handle);
  return (
    <RequestCard
      id={`right-hand-next-${agent.id}`}
      kind="question"
      agent={agent}
      label={question}
      mine={false}
      lead={question}
      what={question}
      actions={
        <>
          {held
            ? can(org, "manage_billing") && (
                <BillingLinkButton orgId={org.id} from="hold" size="sm" variant="primary">
                  {t("standing.billing.cta.payment")}
                </BillingLinkButton>
              )
            : invite &&
              can(org, "invite_people") && (
                <Button size="sm" variant="primary" onClick={() => invite.open()}>
                  {t("rightHand.intro.next.invite")}
                </Button>
              )}
          <Button
            size="sm"
            onClick={() => {
              if (preset) setDraftFor(`agent:${first.id}`, t(`rightHand.intro.firstTask.${preset}`));
              void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: first.id } });
            }}
          >
            {t("rightHand.intro.next.firstTask", agentGrammar(first.name))}
          </Button>
        </>
      }
    />
  );
}

const STYLES = ["simple", "technical"] as const;

/** "Como prefere que eu fale com você?": two answers, saved for every agent here; gone once the person picks. */
function StyleCard({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSetAgentStyle(org.id);
  const question = t("rightHand.intro.style.question");
  const pick = (style: "simple" | "technical") =>
    save.mutate(style, { onError: () => toast.show(t("settings.account.activityFailed"), "error") });
  return (
    <RequestCard
      id={`right-hand-style-${agent.id}`}
      kind="question"
      agent={agent}
      label={question}
      mine={false}
      lead={question}
      what={question}
      locked={save.isPending}
      body={
        <>
          <p>{t("rightHand.intro.style.text")}</p>
          <RequestChoices
            choices={STYLES.map((style) => ({
              label: t(`rightHand.intro.style.${style}`),
              busy: save.isPending && save.variables === style,
            }))}
            onPick={(i) => {
              const style = STYLES[i];
              if (style) pick(style);
            }}
            disabled={save.isPending}
          />
        </>
      }
      actions={<RequestKeys count={STYLES.length} />}
    />
  );
}
