import type { Agent } from "@agenteschat/client";
import { keys, useAiStatus, useChannels, useMembers } from "@agenteschat/client";
import { setDraftFor } from "@agenteschat/client/lib/drafts";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { PRESET_LOOK, PRESETS, type Preset, presetInput } from "@agenteschat/client/lib/onboarding";
import { can } from "@agenteschat/client/lib/permissions";
import { introCards, isRightHand, presetsLeft } from "@agenteschat/client/lib/right-hand";
import { Button, Icon, Message, MessageText, normalizeAppearance } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useConnectAi } from "@/components/ConnectAi";
import { useChannelActions } from "@/components/channel-actions";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { useOrg } from "@/components/org-context";
import { RequestCard } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * The top of the right hand's DM (ADR 0134), drawn by the app and never stored, so it costs nothing and works before
 * any AI is connected: its greeting, then the first card the workspace needs. No AI yet: Connect AI. An AI and no
 * agent besides it: how to start (the ready-made agents, describing the need, an import or the form). A team and
 * nobody else here yet: inviting people and the first task.
 */
export function RightHandIntro({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const members = useMembers(org.id);
  const connect = useConnectAi();
  const team = dir.agents.filter((a) => !isRightHand(a));
  const teamHandles = team.map((a) => a.handle);
  const cards = introCards({
    noAi: aiStateOf(status.data, agent.id) === "no_ai",
    aiKnown: Boolean(status.data),
    teamHandles,
    createsAgents: can(org, "create_agents"),
    alone: (members.data?.length ?? 0) <= 1,
  });
  return (
    <Message
      agent
      avatar={<AgentAvatar agentId={agent.id} name={agent.name} />}
      author={agent.name}
      time={<time dateTime={agent.createdAt}>{formatTime(i18n.language, agent.createdAt)}</time>}
    >
      <MessageText>
        <p>
          <b>{t("rightHand.intro.greeting", agentGrammar(agent.name))}</b>
        </p>
        <p>{t("rightHand.intro.lead")}</p>
      </MessageText>
      {cards.includes("connect") && connect && (
        <div className="waitcard">
          <span className="waitcard__top ac-iconline">
            <Icon name="plug" size={16} />
            <span>{t("rightHand.intro.connect.title")}</span>
          </span>
          <p>{t("rightHand.intro.connect.text")}</p>
          <span className="waitcard__acts">
            <Button size="sm" variant="primary" onClick={() => connect.open({ agentId: agent.id })}>
              {t("rightHand.intro.connect.action")}
            </Button>
          </span>
        </div>
      )}
      {cards.includes("start") && <StartCard agent={agent} left={presetsLeft(teamHandles)} first={team.length === 0} />}
      {cards.includes("next") && team[0] && <NextCard agent={agent} first={team[0]} />}
    </Message>
  );
}

/**
 * "Como você quer começar?": the ready-made agents not created yet, each its own Criar, or all of them, or another
 * way in. `first`: nothing created yet, so it waits for the person; after that it is a suggestion.
 */
function StartCard({ agent, left, first }: { agent: Agent; left: readonly Preset[]; first: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const actions = useChannelActions();
  const channels = useChannels(org.id);
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
  const question = t("rightHand.intro.start.question");
  return (
    <RequestCard
      id={`right-hand-start-${agent.id}`}
      kind="question"
      agent={agent}
      label={question}
      mine={first}
      lead={question}
      what={question}
      body={
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
                  <b>{name}</b>
                  <small>{t(`onboarding.presets.${p}.role`)}</small>
                </span>
              </button>
            );
          })}
        </div>
      }
      actions={
        <>
          <Button size="sm" variant="primary" loading={create.isPending} onClick={() => create.mutate(left)}>
            {t("rightHand.intro.start.team")}
          </Button>
          <Button size="sm" onClick={() => actions?.focusComposer()}>
            {t("rightHand.intro.start.describe")}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "import" } })
            }
          >
            {t("rightHand.intro.start.import")}
          </Button>
          <Button size="sm" onClick={() => void navigate({ to: "/org/$orgId/agents/new", params: { orgId: org.id } })}>
            {t("rightHand.intro.start.form")}
          </Button>
        </>
      }
    />
  );
}

/**
 * The team is here, nobody else yet: invite the people, or open the first agent's DM with a first task written. A
 * suggestion, never waiting for the person: alone in a workspace, it stays.
 */
function NextCard({ agent, first }: { agent: Agent; first: Agent }) {
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
          {invite && can(org, "invite_people") && (
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
