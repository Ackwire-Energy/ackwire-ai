import type { DmTarget } from "@agenteschat/client";
import { keys, useModels } from "@agenteschat/client";
import { audienceNotice, canTalk } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { greetingSuggestions } from "@agenteschat/client/lib/chat";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { apiProviderOf, isAuto } from "@agenteschat/client/lib/providers";
import { isRightHand, rightHandSeenKey } from "@agenteschat/client/lib/right-hand";
import { Avatar, BrainIcon, ProviderLogo } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AudienceChip } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useAgentPanelShown, useOpenAgentPanel } from "@/components/agent-panel-context";
import { ComputerButton } from "@/components/computer/ComputerDialog";
import { ErrorState } from "@/components/Loading";
import { NavToggle } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { ProfileTrigger } from "@/components/ProfileCard";
import { LetMeTalkButton } from "@/components/ReachLines";
import { RightHandIntro } from "@/components/RightHandIntro";
import { HeaderSearch } from "@/components/search/HeaderSearch";
import { AgentTasksPill } from "@/components/tasks/AgentTasksPanel";
import { useDirectory } from "@/hooks/useDirectory";
import { rightHandSeen } from "@/lib/storage";
import { ChannelPage, ChannelSkeleton } from "./ChannelPage";

/** A direct message with an agent or a person: the channel layout with its own header and empty state. */
export function DmPage({ target, focusMessageId }: { target: DmTarget; focusMessageId?: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const models = useModels();
  const kind = "agentId" in target ? "agent" : "person";
  const id = "agentId" in target ? target.agentId : target.userId;
  const dm = useQuery({
    queryKey: ["org", org.id, "dm", kind, id],
    queryFn: async () => {
      const res = await api.dms.open(org.id, target);
      // A DM opened for the first time is in the DM list before its header shows: its search holds to it.
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.channels(org.id) }),
        qc.invalidateQueries({ queryKey: keys.dms(org.id) }),
      ]);
      return res;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const agent = "agentId" in target ? dir.agentById.get(target.agentId) : undefined;
  const person = "userId" in target ? dir.memberById.get(target.userId) : undefined;
  const name = agent?.name ?? person?.name ?? "";
  const rightHand = isRightHand(agent);
  // Its DM is open, from its row or any other way in: its row's "Novo" goes.
  useEffect(() => {
    if (rightHand) rightHandSeen.mark(rightHandSeenKey(me.user.id, org.id));
  }, [rightHand, me.user.id, org.id]);

  if (dm.isError) {
    return (
      <main className="shell__main">
        <div className="page page--mid">
          <ErrorState error={dm.error} onRetry={() => void dm.refetch()} />
        </div>
      </main>
    );
  }
  if (!dm.data || dir.loading) return <ChannelSkeleton dm={kind} />;

  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const model = !agent
    ? ""
    : isAuto(agent.model)
      ? t("brain.auto.label")
      : (models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model);
  // Who thinks: on a plan, the model by the plan that pays for it ("Sonnet pelo plano do Claude"), else the API model.
  const thinks = agent
    ? brainLine(t, agent.brain, model, { owner: owner?.name.split(" ")[0], agents: dir.agents })
    : null;
  // The API's maker when it thinks through a key.
  const thinksMark = thinks?.mark ?? (agent ? apiProviderOf(agent.model, models.data?.models ?? []) : undefined);
  const role = agent ? agent.role || `@${agent.handle}` : "";
  // The right hand (ADR 0137) says what it is and whose permissions it acts with, never an owner.
  const header = ({ onSearch }: { onSearch: () => void }) => (
    <header className="channel__header">
      <NavToggle />
      <DmWho agentId={agent?.id} userId={person?.userId} label={t("profile.of", { name })}>
        {agent ? <AgentAvatar agentId={agent.id} name={agent.name} /> : <Avatar name={name} imageUrl={person?.image} />}
        <div className="dm-who__text">
          <h1 className={agent || person ? "channel__title ac-captop" : "channel__title"}>
            {name}
            {agent && <AudienceChip agent={agent} />}
          </h1>
          {agent && (
            <span className="channel__topic" data-right-hand={rightHand || undefined}>
              {rightHand
                ? `${t("rightHand.label")} · ${t("rightHand.actsAsYou")}`
                : owner
                  ? t("dm.subtitle", { role, owner: owner.name })
                  : t("dm.subtitleNoOwner", { role })}
              {thinks?.text && (
                <>
                  {" · "}
                  <span className="channel__brain ac-iconline">
                    {thinksMark ? (
                      <ProviderLogo id={thinksMark} size="xs" />
                    ) : (
                      <BrainIcon kind={thinks.kind} size={14} />
                    )}
                    {thinks.text}
                  </span>
                </>
              )}
            </span>
          )}
          {person && <span className="channel__topic">{person.email}</span>}
        </div>
      </DmWho>
      {/* Its tasks (ADR 0128), while it has any: they open in the side panel. */}
      {agent && <AgentTasksPill />}
      {agent && !rightHand && <ComputerButton agent={agent} />}
      {/* Search stays the last on the right, as in a channel: the same field, held to this DM. */}
      <HeaderSearch channelId={dm.data.channelId} onOpen={onSearch} dm />
    </header>
  );
  return (
    <ChannelPage
      channelId={dm.data.channelId}
      focusMessageId={focusMessageId}
      fallback={{
        id: dm.data.channelId,
        name,
        topic: "",
        visibility: "private",
        isMember: true,
        createdAt: "",
      }}
      chrome={{
        header,
        composerTarget: name,
        ...(rightHand && agent
          ? {
              composerLabel: `${t("channel.composerDm", { name })} · ${t("rightHand.composerHint")}`,
              intro: <RightHandIntro agent={agent} channelId={dm.data.channelId} />,
            }
          : {}),
        dmAgentId: agent?.id,
        dmPersonId: person?.userId,
        locked:
          agent && !canTalk(agent)
            ? audienceNotice(t, agent, (uid) => dir.memberById.get(uid)?.name, dir.roleName)
            : undefined,
        lockedAction: agent ? <LetMeTalkButton agent={agent} /> : undefined,
        emptyText: agent ? t("dm.emptyAgent", agentGrammar(agent.name)) : undefined,
        emptyTitle: agent ? t("chat.sayHiAgent", agentGrammar(agent.name)) : t("chat.sayHiPerson", { name }),
        suggestions: agent ? greetingSuggestions(t, agent.role) : [],
      }}
    />
  );
}

/**
 * Who the DM is with, as one button: an agent's page in the panel beside the conversation, a person's profile card
 * (as their name in a message opens). The button lies over the face and lines so the name stays the page's heading.
 */
function DmWho({
  agentId,
  userId,
  label,
  children,
}: {
  agentId?: string;
  userId?: string;
  label: string;
  children: ReactNode;
}) {
  const openPanel = useOpenAgentPanel();
  const shown = useAgentPanelShown();
  return (
    <div className="dm-who">
      {children}
      {agentId ? (
        <button
          type="button"
          className="profile-trigger dm-who__hit"
          aria-label={label}
          aria-expanded={shown === agentId}
          onClick={() => openPanel?.(agentId)}
        />
      ) : userId ? (
        <ProfileTrigger actor={{ type: "person", id: userId }} label={label} className="dm-who__hit">
          {null}
        </ProfileTrigger>
      ) : null}
    </div>
  );
}
