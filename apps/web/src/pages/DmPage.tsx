import type { DmTarget } from "@agenteschat/client";
import { keys, useModels } from "@agenteschat/client";
import { audienceNotice, canTalk } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { greetingSuggestions } from "@agenteschat/client/lib/chat";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isAuto } from "@agenteschat/client/lib/providers";
import { Avatar, BrainIcon, Button, ProviderLogo } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AudienceChip } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { ComputerButton } from "@/components/computer/ComputerDialog";
import { ErrorState } from "@/components/Loading";
import { NavToggle } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { ChannelPage, ChannelSkeleton } from "./ChannelPage";

/** A direct message with an agent or a person: the channel layout with its own header and empty state. */
export function DmPage({ target }: { target: DmTarget }) {
  const { t } = useTranslation();
  const { org } = useOrg();
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
      await qc.invalidateQueries({ queryKey: keys.channels(org.id) });
      return res;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const agent = "agentId" in target ? dir.agentById.get(target.agentId) : undefined;
  const person = "userId" in target ? dir.memberById.get(target.userId) : undefined;
  const name = agent?.name ?? person?.name ?? "";

  if (dm.isError) {
    return (
      <main className="shell__main">
        <div className="page page--mid">
          <ErrorState error={dm.error} onRetry={() => void dm.refetch()} />
        </div>
      </main>
    );
  }
  if (!dm.data || dir.loading) return <ChannelSkeleton />;

  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const model = !agent
    ? ""
    : isAuto(agent.model)
      ? t("brain.auto.label")
      : (models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model);
  // Who thinks: a computer brain ("Claude Code · Sonnet no mac") instead of the API model.
  const thinks = agent ? brainLine(t, agent.brain, model, owner?.name.split(" ")[0]) : null;
  const role = agent ? agent.role || `@${agent.handle}` : "";
  const header = (
    <header className="channel__header">
      <NavToggle />
      {agent ? <AgentAvatar agentId={agent.id} name={agent.name} /> : <Avatar name={name} imageUrl={person?.image} />}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <h1 className="channel__title">
          {name}
          {agent && <AudienceChip agent={agent} />}
        </h1>
        {agent && (
          <span className="channel__topic">
            {owner ? t("dm.subtitle", { role, owner: owner.name }) : t("dm.subtitleNoOwner", { role })}
            {thinks?.text && (
              <>
                {" · "}
                <span className="channel__brain ac-iconline">
                  {thinks.mark ? (
                    <ProviderLogo id={thinks.mark} size="xs" />
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
      {agent && <ComputerButton agent={agent} />}
      {agent && <ProfileButton agentId={agent.id} />}
    </header>
  );
  return (
    <ChannelPage
      channelId={dm.data.channelId}
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
        dmAgentId: agent?.id,
        dmPersonId: person?.userId,
        locked: agent && !canTalk(agent) ? audienceNotice(t, agent, (uid) => dir.memberById.get(uid)?.name) : undefined,
        emptyText: agent ? t("dm.emptyAgent", agentGrammar(t, agent.name)) : undefined,
        emptyTitle: agent ? t("chat.sayHiAgent", agentGrammar(t, agent.name)) : t("chat.sayHiPerson", { name }),
        suggestions: agent ? greetingSuggestions(t, agent.role) : [],
      }}
    />
  );
}

/** "Ver perfil": the agent's page in the panel beside the conversation (the conversation's own panel). */
function ProfileButton({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const openPanel = useOpenAgentPanel();
  return (
    <Button size="sm" onClick={() => openPanel?.(agentId)}>
      {t("dm.profile")}
    </Button>
  );
}
