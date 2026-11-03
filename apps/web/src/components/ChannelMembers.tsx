import type { Agent, Member } from "@agenteschat/client";
import { agentStateIn, useAiStatus, useRoster } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { picksForMe } from "@agenteschat/client/lib/routing";
import { Avatar, Button, Icon, Popover, useHoverCard } from "@agenteschat/ui";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { StatusLine } from "@/components/Presence";
import { ProfileTrigger } from "@/components/ProfileCard";
import { agentLine, personLine, useAgentPresence, usePersonPresence } from "@/hooks/usePresence";
import { useStreams } from "@/realtime/context";

/** Opening on hover waits a little (a pointer just passing by doesn't open it). */
export const MEMBERS_OPEN_MS = 150;
/**
 * The channel header's members button ("Membros do canal (5)"), whose glass popover lists the people (photo with
 * the presence badge, name, "você", their line or presence) and the agents (the living symbol with its badge, its
 * line or state, role, "responde sem menção"). Each row opens the profile card; the footer opens the details.
 */
export function ChannelMembersButton({
  channelId,
  people,
  agents,
  onDetails,
}: {
  channelId: string;
  people: Member[];
  agents: Agent[];
  onDetails: () => void;
}) {
  const { t } = useTranslation();
  // Hover leaves the focus where it is (the box someone types in), a press or a key brings it in.
  const card = useHoverCard(MEMBERS_OPEN_MS);
  const total = people.length + agents.length;
  if (total === 0) return null;
  return (
    <Popover
      hover={card}
      label={t("channel.membersButton", { count: total })}
      side="bottom"
      align="end"
      className="members-pop"
      trigger={
        <button
          type="button"
          className="ac-btn ac-btn--ghost ac-btn--icon channel__icon"
          aria-label={t("channel.membersButton", { count: total })}
          title={t("channel.membersButton", { count: total })}
        >
          <Icon name="members" />
        </button>
      }
    >
      {card.open && (
        <MembersList
          channelId={channelId}
          people={people}
          agents={agents}
          onDetails={() => {
            card.close();
            onDetails();
          }}
        />
      )}
    </Popover>
  );
}

function MembersList({
  channelId,
  people,
  agents,
  onDetails,
}: {
  channelId: string;
  people: Member[];
  agents: Agent[];
  onDetails: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const roster = useRoster(org.id, channelId);
  const routing = useAiStatus(org.id).data?.routing;
  // "Answers without a mention" only while something reads this person's messages that mention nobody.
  const autoReply = new Set(
    picksForMe(routing) ? (roster.data ?? []).filter((r) => r.type === "agent" && r.autoReply).map((r) => r.id) : [],
  );
  // ↑/↓ move between the rows (each row is a button).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".members-pop__row")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    next?.focus();
    e.preventDefault();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the row buttons
    <div className="members-pop__body" onKeyDown={onKey}>
      {people.length > 0 && (
        <section aria-label={t("channel.membersPeople")}>
          <h2 className="members-pop__title">{t("channel.membersPeople")}</h2>
          {people.map((m) => (
            <PersonRow key={m.userId} member={m} you={m.userId === me.user.id} />
          ))}
        </section>
      )}
      {agents.length > 0 && (
        <section aria-label={t("channel.membersAgents")}>
          <h2 className="members-pop__title">{t("channel.membersAgents")}</h2>
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} channelId={channelId} autoReply={autoReply.has(a.id)} />
          ))}
        </section>
      )}
      <div className="members-pop__foot">
        <Button size="sm" variant="ghost" onClick={onDetails}>
          {t("channel.seeDetails")}
        </Button>
      </div>
    </div>
  );
}

/** A person: the badge, and under the name their line, or how they appear ("Offline · visto há 2 h"). */
function PersonRow({ member: m, you }: { member: Member; you: boolean }) {
  const { t, i18n } = useTranslation();
  const shown = usePersonPresence(m.userId);
  const line = shown?.status ? personLine(shown.status) : null;
  const word = shown ? t(`presence.${shown.presence}`) : null;
  const seen = shown?.presence === "offline" ? shown.person.lastSeenAt : null;
  return (
    <ProfileTrigger
      actor={{ type: "person", id: m.userId }}
      label={t("profile.of", { name: m.name })}
      className="members-pop__row"
    >
      <Avatar
        size="sm"
        name={m.name}
        imageUrl={m.image}
        presence={shown?.presence ?? null}
        presenceLabel={word ?? undefined}
      />
      <span className="members-pop__text">
        <span className="members-pop__name">
          {m.name}
          {you && <span className="members-pop__you"> · {t("channel.you")}</span>}
        </span>
        {line ? (
          <StatusLine emoji={line.emoji} text={line.text} className="members-pop__meta" />
        ) : (
          <span className="members-pop__meta">
            {seen
              ? `${word} · ${t("presence.seen", { when: relativeTime(t, i18n.language, seen) })}`
              : (word ?? `@${m.handle}`)}
          </span>
        )}
      </span>
    </ProfileTrigger>
  );
}

/** An agent: the badge, and under the name its line, or what it does here, or its presence; then its role. */
function AgentRow({ agent, channelId, autoReply }: { agent: Agent; channelId: string; autoReply: boolean }) {
  const { t } = useTranslation();
  const state = useStreams((s) => agentStateIn(s, agent.id, channelId));
  const shown = useAgentPresence(agent.id);
  const word = shown ? t(`presence.${shown.presence}`) : null;
  const line = agentLine(t, shown?.line ?? null);
  // At work in this conversation and saying nothing yet: "pensando"; at rest, how it appears.
  const doing = state !== "idle" || !word ? t(`channel.agentState.${state}`) : word;
  return (
    <ProfileTrigger
      actor={{ type: "agent", id: agent.id }}
      label={t("profile.of", { name: agent.name })}
      className="members-pop__row"
    >
      <AgentAvatar
        agentId={agent.id}
        channelId={channelId}
        size="sm"
        name={agent.name}
        presence={shown?.presence ?? null}
        presenceLabel={word ?? undefined}
      />
      <span className="members-pop__text">
        <span className="members-pop__name">{agent.name}</span>
        {line ? (
          <StatusLine emoji={line.emoji} text={line.text} className="members-pop__meta" />
        ) : (
          // Cut to the popover's width: whole on hover.
          <span className="members-pop__meta" title={agent.role ? `${doing} · ${agent.role}` : undefined}>
            {doing}
            {agent.role ? ` · ${agent.role}` : ""}
          </span>
        )}
      </span>
      {autoReply && (
        <span className="members-pop__chip">
          {t(agent.coordinator ? "channel.coordinatorChip" : "channel.autoReplyChip")}
        </span>
      )}
    </ProfileTrigger>
  );
}
