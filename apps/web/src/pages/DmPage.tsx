import { Avatar, Button, EmptyState } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useModels } from "@/api/queries";
import type { DmTarget } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { agentGrammar } from "@/lib/grammar";
import { ChannelPage } from "./ChannelPage";

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
          <EmptyState icon="alert">{dm.error instanceof Error ? dm.error.message : t("common.loadFailed")}</EmptyState>
        </div>
      </main>
    );
  }
  if (!dm.data || dir.loading) {
    return (
      <main className="shell__main shell__main--chat" aria-busy="true">
        <p className="channel__status">{t("dm.opening")}</p>
      </main>
    );
  }

  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const model = agent ? (models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model) : "";
  const role = agent ? agent.role || `@${agent.handle}` : "";
  const header = (
    <header className="channel__header">
      {agent ? (
        <Avatar kind="agent" name={agent.name} initials={dir.agentInitials(agent.id)} />
      ) : (
        <Avatar name={name} imageUrl={person?.image} />
      )}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <h1 className="channel__title">{name}</h1>
        {agent && (
          <span className="channel__topic">
            {owner ? t("dm.subtitle", { role, owner: owner.name, model }) : t("dm.subtitleNoOwner", { role, model })}
          </span>
        )}
        {person && <span className="channel__topic">{person.email}</span>}
      </div>
      {agent && (
        <Button asChild size="sm">
          <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
            {t("dm.profile")}
          </Link>
        </Button>
      )}
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
        emptyText: agent ? t("dm.emptyAgent", agentGrammar(t, agent.name)) : t("dm.emptyPerson", { name }),
      }}
    />
  );
}
