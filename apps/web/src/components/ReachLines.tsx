import { type Message, useAddChannelMember, useUpdateAgent } from "@agenteschat/client";
import { audienceOf, canEditAudience, modeOf } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { type ReachEntry, reachByAccess, reachOf } from "@agenteschat/client/lib/reach";
import { Icon } from "@agenteschat/ui";
import { Trans, useTranslation } from "react-i18next";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./agent-actions.css";

/**
 * Under an agent's message, every agent it @named that its mention didn't wake (`meta.reach`), so nothing is silent:
 * one outside the conversation got it by direct message (Ver opens the two agents' conversation; who manages
 * channels may add it), one it couldn't call says why, and the agent's owner can let that person talk to it. The
 * team actions' rows (agent-actions.css).
 */
export function ReachLines({ message, channelName }: { message: Message; channelName: string }) {
  const { t } = useTranslation();
  const list = reachOf(message.meta);
  if (message.author.type !== "agent" || list.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ag-rcs ag-rcs--stack" role="group" aria-label={t("reach.group")}>
      {list.map((e) => (
        <ReachRow key={e.agentId} entry={e} channelId={message.channelId} place={`#${channelName}`} />
      ))}
    </div>
  );
}

function ReachRow({ entry: e, channelId, place }: { entry: ReachEntry; channelId: string; place: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const toast = useToast();
  const add = useAddChannelMember(org.id);
  const update = useUpdateAgent(org.id, e.agentId);
  const agent = dir.agentById.get(e.agentId);
  const g = agentGrammar(t, agent?.name ?? `@${e.handle}`);
  const values = { ...g, place };
  const handed = Boolean(e.consultationId);
  const key = handed ? "reach.handed" : reachByAccess(e) ? "reach.routineRead" : "reach.blocked";
  const person = e.userId ? dir.memberById.get(e.userId)?.name : undefined;
  const mayAllow =
    !handed &&
    !!agent &&
    !!e.userId &&
    !!person &&
    modeOf(agent) !== "everyone" &&
    canEditAudience(org, agent, me.user.id);
  const detail = [
    !handed && e.outside ? t("reach.outside", { place }) : null,
    e.routine ? t("reach.routine", { name: e.routine.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="ag-rc">
      <span className="ag-rc__ic" aria-hidden="true">
        <Icon name={handed ? "agent" : "info"} size={14} />
      </span>
      <span className="ag-rc__tx">
        <span className="ag-rc__sentence">
          <Trans i18nKey={key as "reach.handed"} values={values} components={{ b: <b /> }} />
        </span>
        {detail && <span className="ag-rc__by">{detail}</span>}
      </span>
      {handed && actions?.openConsultation && (
        <button
          type="button"
          className="ag-rc__btn"
          onClick={() => e.consultationId && actions.openConsultation?.(e.consultationId)}
        >
          {t("reach.see")}
        </button>
      )}
      {handed && can(org, "manage_channels") && (
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
      )}
      {mayAllow && agent && e.userId && (
        <button
          type="button"
          className="ag-rc__btn"
          disabled={update.isPending || update.isSuccess}
          onClick={() => {
            const a = audienceOf(agent);
            const userIds = [...new Set([...(a.mode === "people" ? a.userIds : []), e.userId as string])];
            update.mutate(
              { audience: { mode: "people", userIds } },
              { onSuccess: () => toast.show(t("reach.allowed", { person, name: g.name })) },
            );
          }}
        >
          {t("reach.allow", { person, pronoun: g.pronoun })}
        </button>
      )}
    </div>
  );
}
