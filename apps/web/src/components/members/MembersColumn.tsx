import type { Agent, Channel, Member } from "@agenteschat/client";
import { agentStateIn, useAiStatus, useRoles, useRoster } from "@agenteschat/client";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { relativeTime } from "@agenteschat/client/lib/format";
import { memberGroups } from "@agenteschat/client/lib/member-groups";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { picksForMe } from "@agenteschat/client/lib/routing";
import { Avatar, Button, Icon, matchesWords, RoleMark, SearchField } from "@agenteschat/ui";
import { type KeyboardEvent, type TouchEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ChannelPinsButton } from "@/components/ChannelPins";
import { useOrg } from "@/components/org-context";
import { StatusLine } from "@/components/Presence";
import { ProfileTrigger } from "@/components/ProfileCard";
import { unshownRow } from "@/components/Sidebar";
import { AgentTrail, colorOf } from "@/components/Sky";
import { ChannelThreadsButton } from "@/components/threads/ThreadLines";
import { useDirectory } from "@/hooks/useDirectory";
import { useModalSheet } from "@/hooks/useModalSheet";
import { agentLine, personLine, useAgentPresence, usePersonPresence, usePresences } from "@/hooks/usePresence";
import { useStreams } from "@/realtime/context";
import "./members.css";

/** Offline rows drawn before "Mostrar mais". */
const OFFLINE_CAP = 100;
/** Swipes shorter than this (px) don't close the sheet. */
const SWIPE = 48;

interface Lists {
  channelId: string;
  people: Member[];
  agents: Agent[];
  /** Who manages the channel: "Adicionar pessoa ou agente" at the bottom, the channel details' add flow. */
  onAdd?: () => void;
  /** The search the lists were filtered by, which the right hand must match too to be shown. */
  matches?: (name: string, handle: string) => boolean;
}

/** The channel's members on the right, as Discord's: grouped by the owner, hoisted roles, agents, online, offline. */
export function MembersColumn({ channel, ...lists }: Omit<Lists, "channelId"> & { channel: Channel }) {
  const { t } = useTranslation();
  return (
    <aside className="members-side" aria-label={t("members.column.label", { channel: channel.name })}>
      <MembersList channelId={channel.id} {...lists} />
    </aside>
  );
}

/**
 * On a phone, the members slide in from the right over the channel, with the header's buttons a phone has no room
 * for (threads, pins, the channel's settings) and a field that finds people and agents by name or handle.
 */
export function MembersSheet({
  channel,
  isMember,
  onDetails,
  onClose,
  ...lists
}: Omit<Lists, "channelId"> & { channel: Channel; isMember: boolean; onDetails: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [find, setFind] = useState("");
  const touch = useRef<number | null>(null);
  const sheet = useRef<HTMLElement>(null);
  useModalSheet(sheet, ".members-sheet__scrim");
  const settings = t("shell.sidebarMenu.channelSettings");
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const over = document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]');
      if (Array.from(over).some((el) => el !== sheet.current)) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const q = find.trim();
  const matches = (name: string, handle: string) => !q || matchesWords(`${name} ${handle}`, q);
  return (
    <>
      <button
        type="button"
        className="members-sheet__scrim"
        tabIndex={-1}
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <aside
        ref={sheet}
        className="members-sheet"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("members.column.label", { channel: channel.name })}
        onTouchStart={(e: TouchEvent) => {
          touch.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e: TouchEvent) => {
          const from = touch.current;
          touch.current = null;
          const to = e.changedTouches[0]?.clientX;
          if (from !== null && to !== undefined && to - from > SWIPE) onClose();
        }}
      >
        <header className="members-sheet__head">
          <span className="members-sheet__title">
            <Icon name="channel" size={18} />
            <span>{channel.name}</span>
          </span>
          <span className="members-sheet__acts">
            {isMember && <ChannelThreadsButton channelId={channel.id} channelName={channel.name} />}
            {isMember && <ChannelPinsButton channelId={channel.id} channelName={channel.name} />}
            <button
              type="button"
              className="ac-btn ac-btn--ghost ac-btn--icon channel__icon"
              aria-label={settings}
              title={settings}
              onClick={onDetails}
            >
              <Icon name="cog" />
            </button>
            <Button size="sm" variant="ghost" iconOnly icon="close" aria-label={t("common.close")} onClick={onClose} />
          </span>
        </header>
        <div className="members-sheet__find">
          <SearchField
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onClear={() => setFind("")}
            clearLabel={t("searchPage.header.clear")}
            placeholder={t("members.column.find")}
            aria-label={t("members.column.find")}
          />
        </div>
        <div className="members-sheet__list">
          <MembersList
            channelId={channel.id}
            people={lists.people.filter((m) => matches(m.name, m.handle))}
            agents={lists.agents.filter((a) => matches(a.name, a.handle))}
            matches={matches}
            {...(lists.onAdd ? { onAdd: lists.onAdd } : {})}
          />
        </div>
      </aside>
    </>
  );
}

function MembersList({ channelId, people, agents: members, onAdd, matches }: Lists) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  // The right hand (ADR 0137) is in no channel, yet an @mention reaches it anywhere: it leads the agents.
  const rightHand = useDirectory(org.id).agents.find(isRightHand);
  const agents =
    rightHand &&
    rightHand.canTalk !== false &&
    !members.some(isRightHand) &&
    (!matches || matches(rightHand.name, rightHand.handle))
      ? [rightHand, ...members]
      : members;
  const presences = usePresences();
  const roles = useRoles(org.id).data?.roles ?? [];
  const roster = useRoster(org.id, channelId);
  const routing = useAiStatus(org.id).data?.routing;
  const busyKey = useStreams((s) =>
    agents
      .filter((a) => agentStateIn(s, a.id) !== "idle")
      .map((a) => a.id)
      .join(" "),
  );
  const [allOffline, setAllOffline] = useState(false);
  const busy = new Set(busyKey.split(" "));
  // "Answers without a mention" only while something reads this person's messages that mention nobody.
  const autoReply = new Set(
    picksForMe(routing) ? (roster.data ?? []).filter((r) => r.type === "agent" && r.autoReply).map((r) => r.id) : [],
  );
  const groups = memberGroups({
    people,
    agents,
    roles,
    presenceOf: (id) => presences.get(id),
    busy: (id) => busy.has(id),
  });
  // ↑/↓ move between the rows (each row is a button).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".members-side__row")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    e.preventDefault();
  };
  const name = (key: string) =>
    key === "owner"
      ? t("roles.owner")
      : key === "agents"
        ? t("channel.membersAgents")
        : t(key === "online" ? "presence.online" : "presence.offline");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the row buttons
    <div className="members-side__groups" onKeyDown={onKey}>
      <p className="members-side__caption">{t("channelMembers.caption")}</p>
      {groups.map((g) => {
        const label = g.role?.name ?? name(g.key);
        // ponytail: every row is in the DOM (offline capped at 100); virtualize if a channel reaches thousands.
        const rows = g.key === "offline" && !allOffline ? g.rows.slice(0, OFFLINE_CAP) : g.rows;
        return (
          <section key={g.key} className="members-side__group" aria-label={label}>
            <h2 className="members-side__head">
              {g.key === "owner" && <RoleMark color="violet" icon="audienceOwner" size={16} />}
              {g.role && <RoleMark color={g.role.color} icon={g.role.icon} size={16} />}
              {t("members.column.group", { name: label, count: g.rows.length })}
            </h2>
            {/* A row that fails to draw is one quiet row: the rest of the list and the channel stay. */}
            {rows.map((r) =>
              r.kind === "person" ? (
                <ErrorBoundary key={r.person.userId} resetKey={r.person} fallback={unshownRow}>
                  <PersonRow member={r.person} you={r.person.userId === me.user.id} />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary key={r.agent.id} resetKey={r.agent} fallback={unshownRow}>
                  <AgentRow
                    agent={r.agent}
                    channelId={channelId}
                    busy={busy.has(r.agent.id)}
                    autoReply={autoReply.has(r.agent.id)}
                  />
                </ErrorBoundary>
              ),
            )}
            {rows.length < g.rows.length && (
              <Button size="sm" variant="ghost" className="members-side__more" onClick={() => setAllOffline(true)}>
                {t("members.column.more", { count: g.rows.length - rows.length })}
              </Button>
            )}
          </section>
        );
      })}
      {onAdd && (
        <button type="button" className="members-side__add" onClick={onAdd}>
          <span className="member-row__plus" aria-hidden="true">
            <Icon name="plus" />
          </span>
          {t("channelMembers.addRow")}
        </button>
      )}
    </div>
  );
}

/** A person: their face with the badge, the crown on an owner, and their line (or away/busy when they wrote none). */
function PersonRow({ member: m, you }: { member: Member; you: boolean }) {
  const { t, i18n } = useTranslation();
  const shown = usePersonPresence(m.userId);
  // Yourself hidden: your badge says so, and the row reads offline as everyone else sees it.
  const presence = shown?.presence ?? "offline";
  const looks = presence === "hidden" ? "offline" : presence;
  const line = shown?.status ? personLine(shown.status) : null;
  const word = t(`presence.${presence}`);
  const seen = looks === "offline" ? shown?.person.lastSeenAt : null;
  const owner = t("members.column.ownerTitle");
  const shows = useId();
  return (
    <ProfileTrigger
      actor={{ type: "person", id: m.userId }}
      label={t("profile.of", { name: m.name })}
      describedBy={shows}
      className="members-side__row"
      side="left"
    >
      <span
        id={shows}
        className="members-side__inner"
        data-presence={looks}
        title={seen ? `${word} · ${t("presence.seen", { when: relativeTime(t, i18n.language, seen) })}` : undefined}
      >
        <Avatar size="sm" name={m.name} imageUrl={m.avatarUrl ?? m.image} presence={presence} presenceLabel={word} />
        <span className="members-side__text">
          <span className="members-side__name">
            <span className="members-side__label">{m.name}</span>
            {m.role === "owner" && (
              <span className="members-side__crown" role="img" aria-label={owner} title={owner}>
                <Icon name="crown" size={14} />
              </span>
            )}
            {you && <span className="members-side__you">{t("channel.you")}</span>}
          </span>
          {line ? (
            <StatusLine emoji={line.emoji} text={line.text} className="members-side__line" />
          ) : (
            (presence === "away" || presence === "busy" || presence === "out") && (
              <span className="members-side__line">{word}</span>
            )
          )}
        </span>
      </span>
    </ProfileTrigger>
  );
}

/** An agent: its face, what it is doing (its line, its state here, else its role), the trail while it works. */
function AgentRow({
  agent,
  channelId,
  busy,
  autoReply,
}: {
  agent: Agent;
  channelId: string;
  busy: boolean;
  autoReply: boolean;
}) {
  const { t, i18n } = useTranslation();
  const state = useStreams((s) => agentStateIn(s, agent.id, channelId));
  const shown = useAgentPresence(agent.id);
  const word = shown ? t(`presence.${shown.presence}`) : null;
  const line = agentLine(t, shown?.line ?? null, i18n.language);
  const doing = state !== "idle" ? t(`channel.agentState.${state}`) : null;
  const text =
    line?.text ??
    doing ??
    (isRightHand(agent) ? t("rightHand.callWith", { handle: agent.handle }) : agent.role) ??
    word;
  const shows = useId();
  return (
    <ProfileTrigger
      actor={{ type: "agent", id: agent.id }}
      label={t("profile.of", { name: agent.name })}
      describedBy={shows}
      className="members-side__row"
      side="left"
    >
      <span
        id={shows}
        className="members-side__inner"
        data-presence={shown?.presence}
        data-busy={busy || undefined}
        title={[doing ?? word, agent.role].filter(Boolean).join(" · ") || undefined}
      >
        {busy && <AgentTrail color={colorOf(agent)} />}
        <AgentAvatar
          agentId={agent.id}
          channelId={channelId}
          size="sm"
          name={agent.name}
          presence={shown?.presence ?? null}
          presenceLabel={word ?? undefined}
        />
        <span className="members-side__text">
          <span className="members-side__name">
            <span className="members-side__label">{agent.name}</span>
            {autoReply && <span className="members-side__chip">{t("channel.autoReplyChip")}</span>}
          </span>
          {text &&
            (line ? (
              <StatusLine
                emoji={line.emoji}
                icon={line.icon}
                text={line.text}
                className="members-side__line members-side__work"
              />
            ) : (
              <span className={busy ? "members-side__line members-side__work" : "members-side__line"}>{text}</span>
            ))}
        </span>
      </span>
    </ProfileTrigger>
  );
}
