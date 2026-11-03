import { type Agent, type Message, useAddChannelMember, useChannels, useUpdateAgent } from "@agenteschat/client";
import { audienceWith, canEditAudience, modeOf } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { type ReachEntry, reachKey, reachOf, reachOpens } from "@agenteschat/client/lib/reach";
import { Icon } from "@agenteschat/ui";
import { Trans, useTranslation } from "react-i18next";
import { ConsultPairRow, useConsultById } from "@/components/ConsultGroup";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./agent-actions.css";

/**
 * Under an agent's message, every agent it @named that its mention didn't wake (`meta.reach`), so nothing is silent:
 * one outside the conversation got it by direct message (the two agents' pair row, opening their conversation; who
 * manages channels may add it), or wasn't forwarded from a private one, one it couldn't call says why, and the agent's owner
 * can let that person talk to it. The team actions' rows (agent-actions.css).
 */
export function ReachLines({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channel = useChannels(org.id).data?.find((c) => c.id === message.channelId);
  const list = reachOf(message.meta);
  if (message.author.type !== "agent" || list.length === 0) return null;
  // A DM isn't in the channel list: "in this conversation", and nobody can be added to it.
  const place = channel ? t("reach.inChannel", { name: channel.name }) : t("reach.inHere");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ag-rcs ag-rcs--stack" role="group" aria-label={t("reach.group")}>
      {list.map((e) => (
        <ReachRow
          key={e.agentId}
          entry={e}
          authorId={message.author.id ?? ""}
          channelId={message.channelId}
          place={place}
          addable={!!channel}
        />
      ))}
    </div>
  );
}

function ReachRow({
  entry: e,
  authorId,
  channelId,
  place,
  addable,
}: {
  entry: ReachEntry;
  /** The agent whose message @named it. */
  authorId: string;
  channelId: string;
  place: string;
  addable: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const add = useAddChannelMember(org.id);
  const agent = dir.agentById.get(e.agentId);
  const g = agentGrammar(agent?.name ?? `@${e.handle}`);
  const values = { ...g, place };
  const handed = Boolean(e.consultationId);
  const talk = useConsultById(reachOpens(e) ? e.consultationId : undefined);
  const detail = [
    !handed && e.outside ? t("reach.outside", { place }) : null,
    e.routine ? t("reach.routine", { name: e.routine.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const addButton = ((handed && e.reason === "not_in_channel") || e.private) &&
    addable &&
    can(org, "manage_channels") && (
      <button
        type="button"
        className="ag-rc__btn"
        disabled={add.isPending || add.isSuccess}
        onClick={() =>
          add.mutate(
            { channelId, member: { agentId: e.agentId } },
            { onSuccess: () => toast.show(t("reach.added", { name: g.name })) },
          )
        }
      >
        {t("reach.add")}
      </button>
    );
  // Handed to it by direct message: the two agents talking, as the pair row that opens their conversation.
  if (talk)
    return (
      <div className="ag-rc--talk">
        <ConsultPairRow askerId={authorId} items={[talk]} />
        {addButton}
      </div>
    );
  return (
    <div className="ag-rc">
      <span className="ag-rc__ic" aria-hidden="true">
        <Icon name={handed ? "agent" : "info"} size={14} />
      </span>
      <span className="ag-rc__tx">
        <span className="ag-rc__sentence">
          <Trans i18nKey={reachKey(e) as "reach.handed"} values={values} components={{ b: <b /> }} />
        </span>
        {detail && <span className="ag-rc__by">{detail}</span>}
      </span>
      {addButton}
      {!handed && agent && e.userId && <AllowTalkButton agent={agent} userId={e.userId} className="ag-rc__btn" />}
    </div>
  );
}

/**
 * "Deixar Ana falar com ele": lets `userId` talk to the agent, for its owner and who manages agents, when its
 * audience keeps them out (a routine's creator it couldn't reach). Nothing otherwise.
 */
export function AllowTalkButton({ agent, userId, className }: { agent: Agent; userId: string; className?: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const person = dir.memberById.get(userId)?.name;
  const audience = audienceWith(agent, userId);
  if (!person || !audience || modeOf(agent) === "everyone" || !canEditAudience(org, agent, me.user.id)) return null;
  const g = agentGrammar(agent.name);
  return (
    <button
      type="button"
      className={className}
      disabled={update.isPending || update.isSuccess}
      onClick={(ev) => {
        ev.stopPropagation();
        update.mutate({ audience }, { onSuccess: () => toast.show(t("reach.allowed", { person, name: g.name })) });
      }}
    >
      {t("reach.allow", { person, context: g.context })}
    </button>
  );
}
