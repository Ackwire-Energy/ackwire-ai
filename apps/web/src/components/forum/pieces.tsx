import type { ForumSeat, ForumStance, ForumStanceKind, ForumTopic } from "@agenteschat/client";
import { useChannels } from "@agenteschat/client";
import { daysBetween, formatShortDate, formatTime } from "@agenteschat/client/lib/format";
import { isEnded, spokenCount, statusShown, trackGroups, turnNow } from "@agenteschat/client/lib/forum";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AgentColor,
  type AgentState,
  Avatar,
  Chip,
  type Expression,
  type ForumTrackItem,
  Icon,
  type IconName,
  RoundTrack,
  type TrackSize,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

/** Names, looks and grammar of the people and agents at a table. */
export function useForumWho() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const agentName = (id: string | null | undefined) => (id ? (dir.agentById.get(id)?.name ?? "") : "");
  const personName = (id: string | null | undefined) => (id ? (dir.memberById.get(id)?.name ?? "") : "");
  const seatName = (s: ForumSeat) => (s.type === "agent" ? agentName(s.id) : personName(s.id));
  const look = (agentId: string) => {
    const l = lookOf(dir.agentById.get(agentId));
    return { color: l?.color, eyes: l?.eyes };
  };
  const colorOf = (agentId: string | null | undefined): AgentColor =>
    (agentId ? lookOf(dir.agentById.get(agentId))?.color : undefined) ?? "sky";
  /** "a Ada" / "o Theo" words for a name (people too: "pedido da Marina"). */
  const g = (name: string) => agentGrammar(t, name);
  return { dir, me: me.user.id, agentName, personName, seatName, look, colorOf, g };
}

/** "hoje, 18:00", "amanhã, 18:00", "sex., 23 out., 18:00". */
export function deadlineLabel(t: TFunction, locale: string, iso: string, now = new Date()) {
  const time = formatTime(locale, iso);
  const days = -daysBetween(iso, now);
  if (days === 0) return t("forum.deadlineToday", { time });
  if (days === 1) return t("forum.deadlineTomorrow", { time });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(iso)).replace(/\.$/, "");
  return `${weekday}, ${formatShortDate(locale, iso)}, ${time}`;
}

const STATUS_ICON: Record<ReturnType<typeof statusShown>, IconName> = {
  open: "message",
  stalled: "pause",
  reopened: "repeat",
  done: "check",
  canceled: "block",
};

/** Em discussão / Parado / Reaberto / Concluído / Cancelado, with an icon (never a dot). */
export function ForumStatusChip({ topic }: { topic: Pick<ForumTopic, "status" | "reopened"> }) {
  const { t } = useTranslation();
  const who = useForumWho();
  const shown = statusShown(topic);
  return (
    <Chip
      icon={STATUS_ICON[shown]}
      tone={shown === "done" ? "done" : "neutral"}
      className={`forum-status forum-status--${shown}`}
      title={
        shown === "reopened" && topic.reopened
          ? t("forum.reopenedBy", { name: who.personName(topic.reopened.byUserId) })
          : undefined
      }
    >
      {t(`forum.status.${shown}`)}
    </Chip>
  );
}

export const STANCE_ICON: Record<ForumStanceKind, IconName> = {
  propose: "bulb",
  agree: "check",
  disagree: "disagree",
  shift: "shift",
  ask: "question",
  reply: "reply",
};

/** "Concorda com Ada", "Pergunta às pessoas"… */
export function useStanceText() {
  const { t } = useTranslation();
  const who = useForumWho();
  return (s: ForumStance | null | undefined) => {
    if (!s) return "";
    const target = s.target;
    if (s.kind === "ask") return target?.type === "people" ? t("forum.stance.askPeople") : t("forum.stance.ask");
    if (s.kind === "propose" || s.kind === "shift") return t(`forum.stance.${s.kind}`);
    const name =
      target?.type === "agent"
        ? who.agentName(target.id) || (target.handle ? `@${target.handle}` : "")
        : target?.type === "person"
          ? who.personName(target.id) || (target.handle ? `@${target.handle}` : "")
          : target?.type === "people"
            ? t("forum.stance.people")
            : "";
    return name ? t(`forum.stance.${s.kind}`, { name }) : t(`forum.stance.${s.kind}Any`);
  };
}

export function StanceChip({ stance }: { stance: ForumStance | null | undefined }) {
  const text = useStanceText();
  if (!stance) return null;
  return (
    <Chip icon={STANCE_ICON[stance.kind]} className="forum-stance">
      {text(stance)}
    </Chip>
  );
}

/** The round track of a topic in the agents' tones; the big one says what each column is and is clickable. */
export function TopicTrack({
  topic,
  size = "mini",
  onPick,
  className,
}: {
  topic: ForumTopic;
  size?: TrackSize;
  onPick?: (item: ForumTrackItem) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const who = useForumWho();
  const stance = useStanceText();
  const groups = trackGroups(topic, who.look);
  const rounds = isEnded(topic)
    ? t("forum.rounds", { count: Math.max(1, topic.round) })
    : t("forum.roundOf", { round: Math.max(1, topic.round), rounds: topic.rounds });
  const label = t("forum.track.label", { count: spokenCount(topic), rounds });
  const posts = "posts" in topic ? (topic as { posts: { id: string; stance: ForumStance | null }[] }).posts : [];
  const describe = (it: ForumTrackItem) => {
    const name = it.agentId ? who.agentName(it.agentId) : who.personName(it.userId);
    const g = who.g(name);
    const me = it.userId === who.me;
    const r = { round: it.round, name, of: g.of };
    switch (it.kind) {
      case "spoke": {
        const s = posts.find((p) => p.id === it.postId)?.stance;
        return s ? t("forum.track.spoke", { ...r, stance: stance(s) }) : t("forum.track.spokeNoStance", r);
      }
      case "person":
        return t("forum.track.person", r);
      case "seat":
        return t("forum.track.seat", r);
      case "passed":
        return t("forum.track.passed", r);
      case "waiting":
        return me ? t("forum.track.waitingMe") : t("forum.track.waiting", r);
      case "seatPending":
        return t("forum.track.seatPending", r);
      case "synthesis":
        return t("forum.track.synthesis", r);
      case "live":
        return it.synthesis ? t("forum.track.synthesisLive", r) : t("forum.track.live", r);
      case "sleep":
        return t("forum.track.sleep", r);
      case "budget":
        return t("forum.track.budget", r);
      case "skipped":
        return t("forum.track.skipped", r);
      default:
        return t("forum.track.pending", r);
    }
  };
  return (
    <RoundTrack
      groups={groups}
      size={size}
      dim={topic.status === "canceled"}
      label={label}
      describe={size === "big" ? describe : undefined}
      onPick={onPick}
      className={className}
    />
  );
}

/** An agent or a person at the table, by seat; `mode` is the agent's living state there. */
export function SeatAvatar({
  seat,
  size = "sm",
  mode = "idle",
  channelId,
}: {
  seat: ForumSeat;
  size?: "xs" | "sm" | "md";
  mode?: "idle" | "run" | "think" | "next" | "sleep" | "done";
  channelId?: string;
}) {
  const who = useForumWho();
  if (seat.type === "person") {
    const m = who.dir.memberById.get(seat.id);
    return <Avatar kind="person" size={size} name={m?.name ?? ""} imageUrl={m?.image} />;
  }
  const state: AgentState =
    mode === "run" ? "writing" : mode === "think" ? "thinking" : mode === "next" ? "waiting" : "idle";
  const expression: Expression | undefined = mode === "sleep" ? "closed" : mode === "done" ? "happy" : undefined;
  return (
    <AgentAvatar
      agentId={seat.id}
      name={who.agentName(seat.id)}
      size={size}
      state={state}
      expression={expression}
      channelId={channelId}
    />
  );
}

/** How a topic came to be: "Issue #142 · pedido da Marina", "#engenharia", "Rotina", "Direto no fórum". */
export function useOrigin() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const channels = useChannels(org.id);
  const channelName = (id: string | null) => (id ? (channels.data?.find((c) => c.id === id)?.name ?? null) : null);
  return (topic: ForumTopic): { icon: IconName | null; agentId: string | null; text: string; short: string } => {
    const o = topic.origin;
    const channel = channelName(o.channelId ?? topic.originChannelId);
    const requester = who.personName(topic.requestedByUserId);
    switch (o.kind) {
      case "issue": {
        const short = t("forum.origin.issue", { number: o.issueNumber ?? "" });
        return {
          icon: "issues",
          agentId: null,
          short,
          text: requester
            ? t("forum.origin.issueBy", { number: o.issueNumber ?? "", name: requester, of: who.g(requester).of })
            : short,
        };
      }
      case "routine":
        return { icon: "routines", agentId: null, short: t("forum.origin.routine"), text: t("forum.origin.routine") };
      case "suggestion": {
        const name = who.agentName(o.agentId);
        const short = channel
          ? t("forum.origin.suggestionIn", { name, channel })
          : t("forum.origin.suggestion", { name });
        return { icon: null, agentId: o.agentId, short, text: short };
      }
      case "agent": {
        const name = who.agentName(o.agentId);
        const short = channel ? t("forum.origin.agent", { name, channel }) : t("forum.origin.agentNoChannel", { name });
        return { icon: null, agentId: o.agentId, short, text: short };
      }
      case "channel":
        return channel
          ? { icon: "channel", agentId: null, short: `#${channel}`, text: `#${channel}` }
          : {
              icon: "channel",
              agentId: null,
              short: t("forum.origin.conversation"),
              text: t("forum.origin.conversation"),
            };
      default:
        return { icon: "message", agentId: null, short: t("forum.origin.direct"), text: t("forum.origin.direct") };
    }
  };
}

/** The origin as a link (to the issue, the conversation, the routines), or plain text. */
export function OriginLink({
  topic,
  className,
  short = false,
  children,
}: {
  topic: ForumTopic;
  className?: string;
  short?: boolean;
  children?: ReactNode;
}) {
  const { org } = useOrg();
  const origin = useOrigin()(topic);
  const who = useForumWho();
  const o = topic.origin;
  const icon = origin.agentId ? (
    <AgentAvatar agentId={origin.agentId} name={who.agentName(origin.agentId)} size="xs" state="idle" />
  ) : origin.icon ? (
    <Icon name={origin.icon} size={14} />
  ) : null;
  const body = (
    <>
      {icon}
      <span>{children ?? (short ? origin.short : origin.text)}</span>
    </>
  );
  const channelId = o.channelId ?? topic.originChannelId;
  if (o.kind === "issue" && o.issueNumber)
    return (
      <Link
        to="/org/$orgId/issues/$number"
        params={{ orgId: org.id, number: String(o.issueNumber) }}
        className={className}
      >
        {body}
      </Link>
    );
  if (channelId)
    return (
      <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId }} className={className}>
        {body}
      </Link>
    );
  if (o.kind === "routine")
    return (
      <Link to="/org/$orgId/routines" params={{ orgId: org.id }} className={className}>
        {body}
      </Link>
    );
  return <span className={className}>{body}</span>;
}

/** What the living avatar of an agent at the table does now. */
export function agentMode(topic: ForumTopic, agentId: string, next: ForumSeat | null) {
  if (isEnded(topic)) return topic.status === "done" && topic.track.synthesis?.agentId === agentId ? "done" : "idle";
  const now = turnNow(topic);
  if (now?.kind === "stalled" && now.agentId === agentId) return "sleep";
  if (now?.kind === "synthesis" && now.agentId === agentId) return "run";
  if (now?.kind === "agent" && now.agentId === agentId) return now.writing ? "run" : "think";
  if (next?.type === "agent" && next.id === agentId) return "next";
  return "idle";
}
