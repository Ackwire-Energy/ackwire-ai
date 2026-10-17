import type { Agent, Member } from "@agenteschat/client";
import { agentStateIn, usePeople, useRoster } from "@agenteschat/client";
import { Avatar, AvatarStack, Button, Popover } from "@agenteschat/ui";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { ProfileTrigger } from "@/components/ProfileCard";
import { useStreams } from "@/realtime/context";

/** Opening on hover waits a little (a pointer just passing by doesn't open it). */
export const MEMBERS_OPEN_MS = 150;
const MEMBERS_CLOSE_MS = 200;
/** Avatars in the stack before "+N". */
const STACKED = 3;

/**
 * The stacked avatars in the channel header: a button ("Membros do canal (5)")
 * whose glass popover lists the people (photo, name, @handle, presence,
 * "você") and the agents (the living symbol, state, role, "responde sem
 * menção"). Each row opens the profile card; the footer opens the details.
 */
export function ChannelMembersStack({
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
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // Drop a pending hover timer on unmount.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const later = (next: boolean, ms: number) => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(next);
    }, ms);
  };
  const total = people.length + agents.length;
  const all: ({ kind: "person"; m: Member } | { kind: "agent"; a: Agent })[] = [
    ...people.map((m) => ({ kind: "person" as const, m })),
    ...agents.map((a) => ({ kind: "agent" as const, a })),
  ];
  const shown = all.slice(0, STACKED);
  const more = total - shown.length;
  if (total === 0) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        clear();
        setOpen(o);
      }}
      label={t("channel.membersButton", { count: total })}
      side="bottom"
      align="end"
      className="members-pop"
      onContentPointerEnter={clear}
      onContentPointerLeave={() => later(false, MEMBERS_CLOSE_MS)}
      trigger={
        <button
          type="button"
          className="members-stack"
          aria-label={t("channel.membersButton", { count: total })}
          onPointerEnter={(e) => {
            if (e.pointerType !== "touch" && !open) later(true, MEMBERS_OPEN_MS);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "touch") return;
            if (open) later(false, MEMBERS_CLOSE_MS);
            else clear();
          }}
        >
          <AvatarStack aria-hidden="true">
            {shown.map((x) =>
              x.kind === "person" ? (
                <Avatar key={x.m.userId} size="sm" name={x.m.name} imageUrl={x.m.image} />
              ) : (
                <AgentAvatar key={x.a.id} agentId={x.a.id} channelId={channelId} size="sm" name={x.a.name} />
              ),
            )}
          </AvatarStack>
          {more > 0 && <span className="members-stack__more">+{more}</span>}
        </button>
      }
    >
      {open && (
        <MembersList
          channelId={channelId}
          people={people}
          agents={agents}
          onDetails={() => {
            setOpen(false);
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
  const presence = usePeople(org.id);
  const roster = useRoster(org.id, channelId);
  const online = new Set((presence.data ?? []).filter((p) => p.online).map((p) => p.userId));
  const autoReply = new Set((roster.data ?? []).filter((r) => r.type === "agent" && r.autoReply).map((r) => r.id));
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
            <ProfileTrigger
              key={m.userId}
              actor={{ type: "person", id: m.userId }}
              label={t("profile.of", { name: m.name })}
              className="members-pop__row"
            >
              <Avatar size="sm" name={m.name} imageUrl={m.image} presence={online.has(m.userId)} />
              <span className="members-pop__text">
                <span className="members-pop__name">
                  {m.name}
                  {m.userId === me.user.id && <span className="members-pop__you"> · {t("channel.you")}</span>}
                </span>
                <span className="members-pop__meta">@{m.handle}</span>
              </span>
            </ProfileTrigger>
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

function AgentRow({ agent, channelId, autoReply }: { agent: Agent; channelId: string; autoReply: boolean }) {
  const { t } = useTranslation();
  const state = useStreams((s) => agentStateIn(s, agent.id, channelId));
  return (
    <ProfileTrigger
      actor={{ type: "agent", id: agent.id }}
      label={t("profile.of", { name: agent.name })}
      className="members-pop__row"
    >
      <AgentAvatar agentId={agent.id} channelId={channelId} size="sm" name={agent.name} />
      <span className="members-pop__text">
        <span className="members-pop__name">{agent.name}</span>
        <span className="members-pop__meta">
          {t(`channel.agentState.${state}`)}
          {agent.role ? ` · ${agent.role}` : ""}
        </span>
      </span>
      {autoReply && <span className="members-pop__chip">{t("channel.autoReplyChip")}</span>}
    </ProfileTrigger>
  );
}
