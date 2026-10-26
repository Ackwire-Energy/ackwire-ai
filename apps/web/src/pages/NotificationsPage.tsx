import type { Agent, AppNotification, NotificationActor, NotificationFilter } from "@agenteschat/client";
import {
  dropNotification,
  useApproval,
  useChannels,
  useForumAction,
  useForumTopic,
  useIssueActivity,
  useNotificationAction,
  useNotificationCount,
  useNotificationReply,
  useNotifications,
  useThreadMessages,
} from "@agenteschat/client";
import { approvalOriginWords, approvalWhy } from "@agenteschat/client/lib/approval-origin";
import { WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { daysBetween, formatShortDate, formatTime, joinNames, timeLeft } from "@agenteschat/client/lib/format";
import { agentGrammar, isFeminineName } from "@agenteschat/client/lib/grammar";
import {
  allItems,
  channelOf,
  groupByDay,
  isExpandable,
  MENTION_RE,
  NOTIFICATION_FILTERS,
  openTarget,
  replyTarget,
  snoozeTimes,
  sortWaiting,
  stepCells,
  workspaceHeadline,
} from "@agenteschat/client/lib/notifications";
import { routineNotificationWords, type Words } from "@agenteschat/client/lib/routine-view";
import {
  Avatar,
  Button,
  Chip,
  ComputerIcon,
  cx,
  ExpiryFuse,
  Icon,
  type IconName,
  Kbd,
  Mention,
  Menu,
  MenuHeading,
  MenuItem,
  modKey,
  PlanStrip,
  prefersReducedMotion,
  Segmented,
  SkyGlow,
  Spinner,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { approvalDoing, approvalReadsOnly, approvalValues } from "@/components/ApprovalItem";
import { requestBrowserCard } from "@/components/browser/open";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { colorOf, prepareBurst } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useLiveStore } from "@/realtime/context";
import { ApproveButton, ConnectorMark, RefuseBox } from "./ApprovalsPage";
import "./notifications.css";

const TTL_MS = 24 * 3_600_000;
/** An agent stopped this long on my answer is late (the chip turns to attention). */
const LATE_MS = 20 * 60_000;
/** An approval this close to expiring is urgent. */
const URGENT_MS = 3 * 3_600_000;
/** The exit: slide out, then fold the space (approvals use the same timing). */
const LEAVE_MS = 450;

type Dir = ReturnType<typeof useDirectory>;
type SnoozeChoice = "hour" | "tomorrow" | "nextWeek";

/** "agora", "há 25 min", "há 2 h", "ontem 18:02", "sex 14:20", "12 out". */
function whenText(t: TFunction, locale: string, iso: string, now = new Date()) {
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < 60_000) return t("common.now");
  if (diff < 3_600_000) return t("format.minutesAgo", { count: Math.floor(diff / 60_000) });
  const days = daysBetween(iso, now);
  if (days <= 0) return t("format.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (days === 1) return t("format.yesterdayAt", { time: formatTime(locale, iso) });
  if (days < 7)
    return `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(iso))} ${formatTime(locale, iso)}`;
  return formatShortDate(locale, iso);
}

/** "25 min", "2 h" (how long something has waited). */
function durationText(t: TFunction, ms: number) {
  if (ms < 3_600_000) return t("format.inMinutes", { count: Math.max(1, Math.floor(ms / 60_000)) });
  if (ms < 2 * 86_400_000) return t("format.inHours", { count: Math.floor(ms / 3_600_000) });
  return t("format.inDays", { count: Math.floor(ms / 86_400_000) });
}

/** Words from the client's rules (a key and its values) in the person's language; `otherwise` for an unknown key. */
function sayWords(t: TFunction, w: Words, otherwise = "") {
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return tt(w.key, { ...w.values, defaultValue: w.fallback ? tt(w.fallback) : otherwise });
}

const nameOf = (t: TFunction, dir: Dir, a: NotificationActor | undefined) =>
  !a
    ? ""
    : a.type === "agent"
      ? (dir.agentById.get(a.id)?.name ?? t("channel.unknownAgent"))
      : (dir.memberById.get(a.id)?.name ?? t("channel.unknownPerson"));

/** "Ana", "Ana e Bruno", "Ana, Bruno e mais 2". */
function namesText(t: TFunction, names: string[], max = 2) {
  if (names.length <= max) return joinNames(names, t("notifications.and"));
  return t("notifications.namesMore", { names: names.slice(0, max).join(", "), count: names.length - max });
}

/** A face for an actor: agents are the living symbol, people their photo or initials. */
function Face({
  actor,
  dir,
  className,
  size = "md",
  state,
}: {
  actor: NotificationActor | undefined;
  dir: Dir;
  className?: string;
  size?: "sm" | "md";
  state?: "idle" | "waiting" | "writing";
}) {
  const { t } = useTranslation();
  if (!actor) return null;
  const name = nameOf(t, dir, actor);
  if (actor.type === "agent")
    return <AgentAvatar agentId={actor.id} name={name} size={size} state={state} className={className} labelled />;
  return (
    <ActorAvatar actor={{ type: "person", id: actor.id }} name={name} size={size} className={className} labelled />
  );
}

/**
 * Nobody to show, the workspace itself telling (its computer, its standing): what it is about, as an icon. Someone
 * asking to join isn't a member yet: their initials.
 */
function SystemFace({ n, className = "nt-av28" }: { n: AppNotification; className?: string }) {
  if (n.kind === "join_request") return <Avatar name={n.latest.title ?? ""} size="sm" className={className} />;
  if (n.kind === "computer_ready")
    return (
      <span className="nt-sys" aria-hidden="true">
        <ComputerIcon kind={WORKSPACE_COMPUTER_KIND} size={16} />
      </span>
    );
  if (n.kind !== "org_standing") return null;
  const status = n.latest.statusTo;
  return (
    <span className="nt-sys" aria-hidden="true">
      <Icon name={status === "active" ? "check" : status === "suspended" ? "block" : "pause"} size={16} />
    </span>
  );
}

/** A snippet with @mentions: mine highlighted, others in bold. */
function Snippet({ text, mine }: { text: string; mine: string | null }) {
  const parts = text.split(MENTION_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          mine && p.slice(1).toLowerCase() === mine.toLowerCase() ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces of one text
            <Mention key={i}>{p}</Mention>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces of one text
            <b key={i}>{p}</b>
          )
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces of one text
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** Where it happened, as a chip. */
function SourceChip({ n, channelName }: { n: AppNotification; channelName: (id: string) => string }) {
  const { t } = useTranslation();
  const s = n.source;
  const channel = channelOf(n);
  let icon: IconName = "channel";
  let label = "";
  if (n.kind === "approval") [icon, label] = ["shield", t("notifications.source.approval")];
  else if (n.kind === "join_request") [icon, label] = ["members", t("notifications.source.members")];
  else if (
    n.kind === "machine_connected" ||
    n.kind === "computer_ready" ||
    (n.kind === "browser_handoff" && s.screen === "desktop")
  )
    [icon, label] = ["computer", t("notifications.source.machine")];
  else if (n.kind === "browser_handoff") [icon, label] = ["globe", t("notifications.source.browser")];
  else if (s.topicId) [icon, label] = ["message", t("notifications.source.forum")];
  else if (s.issueNumber != null)
    [icon, label] = ["issues", t("notifications.source.issue", { number: s.issueNumber })];
  else if (n.kind === "mission_finished" || n.kind === "mission_stopped")
    [icon, label] = ["flag", t("notifications.source.mission")];
  else if (n.kind.startsWith("routine_")) [icon, label] = ["routines", t("notifications.source.routine")];
  else if (n.kind === "dm" || s.dmId) [icon, label] = ["person", t("notifications.source.dm")];
  else if (s.threadId) {
    const name = channel ? channelName(channel) : "";
    [icon, label] = [
      "thread",
      name ? t("notifications.source.thread", { channel: name }) : t("notifications.source.threadOnly"),
    ];
  } else if (channel) [icon, label] = ["channel", t("notifications.source.channel", { name: channelName(channel) })];
  if (!label) return null;
  return <Chip icon={icon}>{label}</Chip>;
}

type WhatKey =
  | "mention"
  | "mentionIn"
  | "mentionComment"
  | "replied"
  | "repliedThread"
  | "dm"
  | "question"
  | "issueAssigned"
  | "issueComment"
  | "issueStatus"
  | "issueDone"
  | "forumTurn"
  | "forumSynthesis"
  | "approval"
  | "missionFinished"
  | "missionStopped"
  | "routineFinished"
  | "routineFailed"
  | "routinePaused"
  | "routineStalled"
  | "machineConnected"
  | "machineConnectedAny"
  | "browserHandoff"
  | "desktopHandoff"
  | "joinRequest"
  | "joinRequestMany"
  | "reaction";

/** The line on top of a row: who did what, where. */
function Headline({ n, dir, channelName }: { n: AppNotification; dir: Dir; channelName: (id: string) => string }) {
  const { t } = useTranslation();
  const name = nameOf(t, dir, n.actors[0]);
  const names = namesText(
    t,
    n.actors.map((a) => nameOf(t, dir, a)),
  );
  const count = n.actors.length;
  // A thread without a title is labelled with its channel: show it as "#canal".
  const channel = channelOf(n);
  const label =
    n.source.label && channel && n.source.label === channelName(channel) ? `#${n.source.label}` : n.source.label;
  const k = (key: WhatKey, values: Record<string, unknown>) => (
    <Trans i18nKey={`notifications.what.${key}`} values={values} components={{ b: <b /> }} />
  );
  const own = workspaceHeadline(n);
  if (own) return t(own);
  switch (n.kind) {
    case "mention":
      if (n.source.issueId) return k("mentionComment", { name });
      return n.source.threadId && label ? k("mentionIn", { name, label }) : k("mention", { name });
    case "thread_reply":
      return label ? k("replied", { names, label, count }) : k("repliedThread", { names, count });
    case "dm":
      return k("dm", { name });
    case "agent_question":
      return k("question", { name });
    case "issue_assigned":
      return k("issueAssigned", { name });
    case "issue_comment":
      return k("issueComment", { names, count });
    case "issue_status":
      return n.latest.statusTo === "done" ? k("issueDone", { name }) : k("issueStatus", { name });
    case "forum_turn":
      return k("forumTurn", { name });
    case "forum_synthesis":
      return k("forumSynthesis", { name });
    case "approval":
      return k("approval", { name });
    case "mission_finished":
      return k("missionFinished", { name });
    case "mission_stopped":
      return k("missionStopped", { name });
    case "routine_finished":
      return k("routineFinished", { name });
    case "routine_failed":
      return k("routineFailed", { name });
    case "routine_paused":
      return k("routinePaused", { name });
    case "routine_stalled":
      return k("routineStalled", { name });
    case "machine_connected":
      return n.source.label
        ? k("machineConnected", { name, label: n.source.label })
        : k("machineConnectedAny", { name });
    case "browser_handoff":
      return k(n.source.screen === "desktop" ? "desktopHandoff" : "browserHandoff", { name });
    case "join_request":
      // Merged while unread: the newest name, "and others" for the rest of the burst.
      return k(n.count > 1 ? "joinRequestMany" : "joinRequest", { name: n.latest.title ?? "" });
    case "reaction":
      return k("reaction", { names, count });
  }
}

/** Issue statuses in the app's words (the raw value when unknown). */
const ISSUE_STATUSES = ["todo", "in_progress", "in_review", "done", "canceled"] as const;
function statusName(t: TFunction, value: string | undefined) {
  if (!value) return "";
  const known = ISSUE_STATUSES.find((s) => s === value);
  return known ? t(`issues.status.${known}`) : value;
}

/** The composer's placeholder: who or where the answer goes. */
function placeholderFor(t: TFunction, n: AppNotification, dir: Dir, channelName: (id: string) => string) {
  const target = replyTarget(n);
  if (!target) return t("notifications.composer.reply");
  if (target.kind === "forum") return t("notifications.composer.forum");
  if (target.kind === "issue")
    return n.source.issueNumber != null
      ? t("notifications.composer.issue", { number: n.source.issueNumber })
      : t("notifications.composer.issueNoNumber");
  if (target.kind === "question" || n.kind === "dm") {
    const name = nameOf(t, dir, n.actors[0]);
    return t("notifications.composer.replyTo", { to: agentGrammar(t, name).to, name });
  }
  if (target.threadId) return t("notifications.composer.thread");
  const channel = channelName(target.channelId);
  return channel ? t("notifications.composer.channel", { channel }) : t("notifications.composer.reply");
}

/** The mini composer, opened in place (⌘↵ sends, esc closes). */
function Composer({
  id,
  placeholder,
  draft,
  sending,
  onDraft,
  onSend,
  onCancel,
}: {
  id: string;
  placeholder: string;
  draft: string;
  sending: boolean;
  onDraft: (text: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  // Grows with the text up to 180px.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure when the text changes
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(180, ta.scrollHeight)}px`;
  }, [draft]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicks inside the composer stay out of the row
    <div className="nt-cmp" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <textarea
        id={`nt-ta-${id}`}
        ref={ref}
        rows={2}
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="nt-cmp__row">
        <span className="nt-cmp__hint">
          <Kbd>{modKey()}</Kbd>
          <Kbd>↵</Kbd> {t("notifications.composer.sends")} · <Kbd>{t("notifications.composer.escKey")}</Kbd>{" "}
          {t("notifications.composer.closes")}
        </span>
        <span className="nt-grow" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("notifications.composer.cancel")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="arrowUp"
          loading={sending}
          disabled={sending || !draft.trim()}
          onClick={onSend}
        >
          {t("notifications.composer.send")}
        </Button>
      </div>
    </div>
  );
}

/** "Lembrar depois": in 1 hour, tomorrow at 9, next week (local time). */
function SnoozeMenu({ trigger, onPick }: { trigger: ReactNode; onPick: (choice: SnoozeChoice) => void }) {
  const { t, i18n } = useTranslation();
  const times = snoozeTimes();
  const day = (d: Date) => new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d);
  return (
    <Menu trigger={trigger} align="end" label={t("notifications.snooze")}>
      <MenuHeading>{t("notifications.snoozeMenu.heading")}</MenuHeading>
      <MenuItem icon="clock" hint={formatTime(i18n.language, times.hour.toISOString())} onSelect={() => onPick("hour")}>
        {t("notifications.snoozeMenu.hour")}
      </MenuItem>
      <MenuItem icon="calendar" hint={day(times.tomorrow)} onSelect={() => onPick("tomorrow")}>
        {t("notifications.snoozeMenu.tomorrow")}
      </MenuItem>
      <MenuItem
        icon="calendar"
        hint={`${day(times.nextWeek)} ${formatTime(i18n.language, times.nextWeek.toISOString())}`}
        onSelect={() => onPick("nextWeek")}
      >
        {t("notifications.snoozeMenu.nextWeek")}
      </MenuItem>
    </Menu>
  );
}

/** The replies of a grouped thread item (from the thread itself). */
function ThreadReplies({ n, dir, mine }: { n: AppNotification; dir: Dir; mine: string | null }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const thread = useThreadMessages(org.id, channelOf(n) ?? undefined, n.source.threadId ?? "");
  if (thread.isPending) return <LoadingCards count={1} className="nt-reps" />;
  // Replies with words (cards like an approval or a question have none of their own).
  const replies = (thread.data ?? [])
    .filter((m) => m.id !== n.source.threadId && !m.local && m.body.trim())
    .slice(-n.count);
  return (
    <div className="nt-reps">
      {replies.map((m) => {
        const actor: NotificationActor = { type: m.author.type === "agent" ? "agent" : "user", id: m.author.id ?? "" };
        return (
          <div key={m.id} className="nt-rep">
            <Face actor={actor} dir={dir} size="sm" className="nt-av22" />
            <div>
              <div className="nt-rep__head">
                <b>{dir.authorName(m.author)}</b>
                <small>{whenText(t, i18n.language, m.createdAt)}</small>
              </div>
              <p>
                <Snippet text={m.body} mine={mine} />
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The comments of a grouped issue item (from the issue's activity). */
function IssueComments({ n, dir, mine }: { n: AppNotification; dir: Dir; mine: string | null }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const activity = useIssueActivity(org.id, n.source.issueId);
  if (activity.isPending) return <LoadingCards count={1} className="nt-reps" />;
  const comments = (activity.data ?? []).filter((a) => a.kind === "comment").slice(-n.count);
  return (
    <div className="nt-reps">
      {comments.map((c) => {
        const actor: NotificationActor = { type: c.author.type === "agent" ? "agent" : "user", id: c.author.id };
        return (
          <div key={c.id} className="nt-rep">
            <Face actor={actor} dir={dir} size="sm" className="nt-av22" />
            <div>
              <div className="nt-rep__head">
                <b>{nameOf(t, dir, actor)}</b>
                <small>{whenText(t, i18n.language, c.createdAt)}</small>
              </div>
              <p>
                <Snippet text={c.text} mine={mine} />
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface RowHandlers {
  onSelect: (n: AppNotification) => void;
  onReply: (n: AppNotification) => void;
  onDone: (n: AppNotification) => void;
  onSnooze: (n: AppNotification, choice: SnoozeChoice) => void;
  onOpen: (n: AppNotification) => void;
  onToggle: (n: AppNotification) => void;
  onSend: (n: AppNotification, text: string, choice?: boolean) => void;
  onCancel: () => void;
  onDraft: (n: AppNotification, text: string) => void;
}

interface RowState {
  cur: boolean;
  open: boolean;
  replying: boolean;
  sending: boolean;
  draft: string;
  replied?: string;
  fresh: boolean;
  pulse: boolean;
  leaving: boolean;
}

/** The inline actions: a small floating bar on desktop (hover / focus), a row on phones (tap). */
function RowActions({ n, h }: { n: AppNotification; h: RowHandlers }) {
  const { t } = useTranslation();
  const act = (key: string, icon: IconName, label: string, tip: string, short: string, run?: () => void) => (
    <button
      type="button"
      className="nt-nb"
      data-act={key}
      data-tip={tip}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        run?.();
      }}
    >
      <Icon name={icon} size={16} />
      <span className="nt-nb__label">{short}</span>
    </button>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a small toolbar of actions
    <div className="nt-acts" role="group" aria-label={t("notifications.actions")}>
      {replyTarget(n) &&
        act("reply", "reply", t("notifications.reply"), t("notifications.replyTip"), t("notifications.reply"), () =>
          h.onReply(n),
        )}
      {act("done", "check", t("notifications.done"), t("notifications.doneTip"), t("notifications.done"), () =>
        h.onDone(n),
      )}
      <SnoozeMenu
        onPick={(c) => h.onSnooze(n, c)}
        trigger={act(
          "snooze",
          "clock",
          t("notifications.snooze"),
          t("notifications.snooze"),
          t("notifications.snoozeShort"),
        )}
      />
      {act("open", "external", t("notifications.open"), t("notifications.openTip"), t("notifications.open"), () =>
        h.onOpen(n),
      )}
    </div>
  );
}

/** One item in a day group. */
function Row({
  n,
  s,
  h,
  dir,
  mine,
  channelName,
}: {
  n: AppNotification;
  s: RowState;
  h: RowHandlers;
  dir: Dir;
  mine: string | null;
  channelName: (id: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const unread = n.readAt === null;
  const first = n.actors[0];
  const name = nameOf(t, dir, first);
  const own = workspaceHeadline(n);
  const label = own ? t(own) : name;
  const reaction = n.kind === "reaction";
  const group = n.actors.length > 1;
  const other = n.actors.find((a, i) => i > 0 && (a.id !== first?.id || a.type !== first?.type));
  const face = reaction ? (
    <span className="nt-emo" aria-hidden="true">
      {(n.latest.emojis ?? []).slice(-2).map((e) => (
        <span key={e}>{e}</span>
      ))}
    </span>
  ) : group ? (
    <span className="nt-stk">
      <Face actor={first} dir={dir} size="sm" className="nt-av22" />
      <Face actor={other} dir={dir} size="sm" className="nt-av17" />
    </span>
  ) : first ? (
    <Face actor={first} dir={dir} className="nt-av28" />
  ) : (
    <SystemFace n={n} />
  );
  const l = n.latest;
  // Asked while nobody watched (ADR 0053 §8): who asked leads an approval's line, its why follows.
  const origin = n.kind === "approval" ? approvalOriginWords({ origin: l.origin }) : null;
  const lead =
    n.source.issueNumber != null && l.title && (n.kind === "issue_assigned" || n.kind === "issue_status")
      ? `#${n.source.issueNumber} ${l.title}`
      : (n.kind === "mission_finished" ||
            n.kind === "mission_stopped" ||
            n.kind.startsWith("routine_") ||
            n.kind === "forum_synthesis") &&
          n.source.label
        ? n.source.label
        : origin
          ? sayWords(t, origin)
          : null;
  const speaker = n.count > 1 && (n.kind === "thread_reply" || n.kind === "issue_comment") ? name : null;
  const expandable = isExpandable(n);
  const steps = l.steps && l.steps.total > 0 ? l.steps : null;
  const failed = n.kind === "mission_stopped" || n.kind === "routine_failed" || l.steps?.failedAt != null;
  // A routine's trouble says why in the person's language (`latest.reason`): a pause its reason, a failed
  // run what went wrong (never the server's English).
  const why = routineNotificationWords(n);
  const text = why ? sayWords(t, why, l.text ?? "") : l.text;
  const stopStep = steps ? (steps.failedAt ?? steps.done + 1) : 0;
  const stepWords = steps
    ? failed
      ? t("notifications.stoppedAt", { step: Math.min(stopStep, steps.total), total: steps.total })
      : t("notifications.steps", { done: steps.done, total: steps.total })
    : "";
  const agentColor = first?.type === "agent" ? colorOf(dir.agentById.get(first.id)) : undefined;
  const channel = channelOf(n);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of the inbox, not a fieldset
    <div
      className={cx(
        "nt-item",
        reaction && "nt-item--rx",
        unread && "is-unread",
        s.cur && "is-cur",
        s.replying && "is-replying",
        s.fresh && "is-new",
        s.pulse && "is-pulse",
        s.leaving && "is-leaving",
      )}
      role="group"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable item (J/K, E, R, Enter) with its own actions inside
      tabIndex={0}
      data-n={n.id}
      aria-label={unread ? t("notifications.unreadItem", { name: label }) : label}
      onClick={(e) => {
        if ((e.target as Element).closest("button, a, textarea, input, .nt-cmp")) return;
        h.onSelect(n);
      }}
      onKeyDown={() => {}}
    >
      <span className="nt-who">{face}</span>
      <div className="nt-c">
        <div className="nt-l1">
          <span className="nt-what">
            <Headline n={n} dir={dir} channelName={channelName} />
          </span>
          {!reaction && (
            <span className="nt-tags">
              <SourceChip n={n} channelName={channelName} />
              {n.kind === "issue_status" && (l.statusFrom || l.statusTo) && (
                <Chip icon="arrowRight" className="nt-chip-ink">
                  {t("notifications.status", { from: statusName(t, l.statusFrom), to: statusName(t, l.statusTo) })}
                </Chip>
              )}
            </span>
          )}
          <span className="nt-tm">{whenText(t, i18n.language, n.updatedAt)}</span>
        </div>
        {reaction ? (
          <>
            {l.quote && (
              <div className="nt-quote">
                <span>{t("notifications.quote", { text: l.quote })}</span>
              </div>
            )}
            <div className="nt-replied nt-replied--quiet">
              <span>
                {[
                  t("notifications.reactions", { count: Math.max(n.count, n.actors.length) }),
                  channel && channelName(channel)
                    ? t("notifications.source.channel", { name: channelName(channel) })
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          </>
        ) : (
          <>
            {(text || lead) && (
              <p className="nt-snip">
                {lead && <b>{t("notifications.lead", { text: lead })} </b>}
                {speaker && <b>{t("notifications.speaker", { name: speaker })} </b>}
                {text && <Snippet text={text} mine={mine} />}
              </p>
            )}
            {steps && (
              <div className="nt-steprow">
                <PlanStrip
                  cells={stepCells({ ...steps, failedAt: failed ? stopStep : undefined })}
                  color={agentColor}
                  label={stepWords}
                />
                <Chip
                  icon={failed ? "alert" : "check"}
                  className={cx("nt-chip-ink", failed ? "nt-chip-warn" : "nt-chip-ok")}
                >
                  {stepWords}
                </Chip>
              </div>
            )}
            {expandable && (
              <>
                <button
                  type="button"
                  className="nt-more"
                  aria-expanded={s.open}
                  onClick={(e) => {
                    e.stopPropagation();
                    h.onToggle(n);
                  }}
                >
                  <Icon name="chevronDown" size={14} />
                  {s.open
                    ? t("notifications.hide")
                    : n.kind === "issue_comment"
                      ? t("notifications.showComments", { count: n.count })
                      : t("notifications.showReplies", { count: n.count })}
                </button>
                {s.open &&
                  (n.kind === "issue_comment" ? (
                    <IssueComments n={n} dir={dir} mine={mine} />
                  ) : (
                    <ThreadReplies n={n} dir={dir} mine={mine} />
                  ))}
              </>
            )}
            {s.replied && (
              <div className="nt-replied">
                <Icon name="check" size={14} />
                <span>{t("notifications.youReplied", { text: s.replied })}</span>
              </div>
            )}
            {s.replying && (
              <Composer
                id={n.id}
                placeholder={placeholderFor(t, n, dir, channelName)}
                draft={s.draft}
                sending={s.sending}
                onDraft={(text) => h.onDraft(n, text)}
                onSend={() => h.onSend(n, s.draft)}
                onCancel={h.onCancel}
              />
            )}
          </>
        )}
      </div>
      <RowActions n={n} h={h} />
    </div>
  );
}

/** The seats at the table this round: who spoke, me (my turn), who comes later. */
function Seats({ topicId, dir }: { topicId: string; dir: Dir }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const topic = useForumTopic(org.id, topicId);
  const data = topic.data;
  if (!data) return null;
  const entries = data.track.rounds.find((r) => r.round === data.round)?.entries ?? [];
  const lastTurn = [...data.posts].reverse().find((p) => p.kind === "turn" || p.kind === "seat");
  return (
    <>
      {entries.length > 0 && (
        <div className="nt-seats">
          {entries.map((e) => {
            const mine = e.seat.type === "person" && e.seat.id === me.user.id;
            const actor: NotificationActor = { type: e.seat.type === "agent" ? "agent" : "user", id: e.seat.id };
            return (
              <span key={`${e.seat.type}:${e.seat.id}`} className={cx("nt-seat", mine && "nt-seat--me")}>
                <Face actor={actor} dir={dir} size="sm" className="nt-av20" />
                <b>{mine ? t("notifications.wait.seatYou") : nameOf(t, dir, actor)}</b>
                {mine && e.status === "waiting" ? (
                  t("notifications.wait.seatYours")
                ) : e.status === "spoke" ? (
                  <>
                    <Icon name="check" size={14} className="nt-ok" />
                    {t("notifications.wait.seatSpoke")}
                  </>
                ) : e.status === "passed" || e.status === "skipped" || e.status === "skipped_budget" ? (
                  t("notifications.wait.seatPassed")
                ) : (
                  t("notifications.wait.seatLater")
                )}
              </span>
            );
          })}
        </div>
      )}
      {lastTurn && (
        <div className="nt-quote">
          <span>
            <b>
              {t("notifications.speaker", {
                name: nameOf(t, dir, {
                  type: lastTurn.author.type === "agent" ? "agent" : "user",
                  id: lastTurn.author.id,
                }),
              })}
            </b>{" "}
            {lastTurn.body}
          </span>
        </div>
      )}
    </>
  );
}

/** The topic's deadline chip ("A rodada espera 1 h 50 min"), when it has one. */
function RoundWaits({ topicId }: { topicId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const topic = useForumTopic(org.id, topicId);
  const left = topic.data?.deadline ? timeLeft(t, topic.data.deadline) : null;
  if (!left) return null;
  return <Chip icon="clock">{t("notifications.wait.roundWaits", { time: left })}</Chip>;
}

/**
 * An approval in one sentence (AprovacaoConector B): "Ada quer ver stack trace do evento", then the
 * connector's logo (its name in a tooltip), "Só lê", its values in words and the agent's why behind "Por quê?".
 */
function ApprovalSay({
  approvalId,
  name,
  why,
  mine,
  fallback,
}: {
  approvalId: string;
  name: string;
  /** The notification's text (the why), for an approval that doesn't carry its own. */
  why?: string;
  mine: string | null;
  fallback: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const approval = useApproval(org.id, approvalId);
  const [open, setOpen] = useState(false);
  const a = approval.data;
  if (!a) return <h3>{fallback}</h3>;
  const reason = approvalWhy(a) ?? why;
  const values = approvalValues(a, { max: 3 }).map(([label, value]) => `${label}: ${value}`);
  return (
    <>
      <p className="nt-say">
        <Trans
          i18nKey="notifications.wait.wants"
          values={{ name, action: approvalDoing(t, a) }}
          components={{ b: <b /> }}
        />
      </p>
      {(a.connector || a.email || approvalReadsOnly(a) || values.length > 0 || reason) && (
        <div className="nt-facts">
          {(a.connector || a.email) && <ConnectorMark approval={a} />}
          {approvalReadsOnly(a) && <Chip icon="eye">{t("approvals.readsOnly")}</Chip>}
          {values.map((v) => (
            <Chip key={v}>{v}</Chip>
          ))}
          {reason && (
            <button
              type="button"
              className="nt-why-btn"
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((o) => !o);
              }}
            >
              {open ? t("notifications.wait.hideWhy") : t("notifications.wait.why")}
            </button>
          )}
        </div>
      )}
      {open && reason && (
        <p className="nt-why">
          <Snippet text={reason} mine={mine} />
        </p>
      )}
    </>
  );
}

/** Aprovar / Recusar right on the card (a hold for high risk, a reason on refusal); others open Aprovações. */
function ApprovalActs({
  approvalId,
  agent,
  onOpen,
  tail,
}: {
  approvalId: string;
  agent?: Agent;
  onOpen: () => void;
  tail: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const approval = useApproval(org.id, approvalId);
  const [refusing, setRefusing] = useState(false);
  const a = approval.data;
  if (a?.canDecide && a.status === "pending") {
    if (refusing) return <RefuseBox approval={a} agent={agent} onCancel={() => setRefusing(false)} />;
    return (
      <div className="nt-wacts">
        <ApproveButton approval={a} />
        <Button
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setRefusing(true);
          }}
        >
          {t("approval.refuse")}
        </Button>
        <span className="nt-grow" />
        {tail}
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {t("notifications.wait.openApprovals")}
        </Button>
      </div>
    );
  }
  return (
    <div className="nt-wacts">
      <Button
        variant="primary"
        size="sm"
        icon="shield"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        {t("notifications.wait.decide")}
      </Button>
      <span className="nt-grow" />
      {tail}
    </div>
  );
}

/** A card in "Esperando você": an agent's question, my turn at the table, an approval. */
function WaitCard({
  n,
  s,
  h,
  dir,
  mine,
  resolving,
  onPass,
  passing,
  channelName,
}: {
  n: AppNotification;
  s: RowState;
  h: RowHandlers;
  dir: Dir;
  mine: string | null;
  resolving: boolean;
  onPass: (n: AppNotification, el: HTMLElement) => void;
  passing: boolean;
  channelName: (id: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const first = n.actors[0];
  const name = nameOf(t, dir, first);
  const g = agentGrammar(t, name);
  const feminine = isFeminineName(name);
  const l = n.latest;
  const unread = n.readAt === null;
  const waitedMs = Date.now() - new Date(n.createdAt).getTime();
  const agent = first?.type === "agent" ? dir.agentById.get(first.id) : undefined;
  const tail = (
    <>
      <SnoozeMenu
        onPick={(c) => h.onSnooze(n, c)}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="clock"
            aria-label={t("notifications.snooze")}
            title={t("notifications.snooze")}
          />
        }
      />
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon="check"
        aria-label={t("notifications.done")}
        title={t("notifications.doneTip")}
        onClick={(e) => {
          e.stopPropagation();
          h.onDone(n);
        }}
      />
    </>
  );
  let meta: ReactNode;
  let head: ReactNode;
  let body: ReactNode;
  if (n.kind === "agent_question") {
    meta = (
      <>
        <b>{name}</b>
        <span>{t("notifications.wait.asks")}</span>
        <SourceChip n={n} channelName={channelName} />
        <span>{whenText(t, i18n.language, n.createdAt)}</span>
        <span className="nt-grow" />
        <Chip icon="waiting" tone={waitedMs >= LATE_MS ? "waiting" : "neutral"}>
          {t(feminine ? "notifications.wait.stoppedForF" : "notifications.wait.stoppedForM", {
            time: durationText(t, waitedMs),
          })}
        </Chip>
      </>
    );
    const title = l.title ?? l.text ?? "";
    head = (
      <>
        <h3>{title}</h3>
        {l.title && l.text && (
          <p className="nt-ctx">
            <Snippet text={l.text} mine={mine} />
          </p>
        )}
      </>
    );
    body = resolving ? (
      <div className="nt-resolved">
        <Spinner size={14} />
        {t("notifications.wait.resolved", { The: g.The, name })}
      </div>
    ) : s.replying ? (
      <Composer
        id={n.id}
        placeholder={placeholderFor(t, n, dir, channelName)}
        draft={s.draft}
        sending={s.sending}
        onDraft={(text) => h.onDraft(n, text)}
        onSend={() => h.onSend(n, s.draft, (l.suggestions ?? []).includes(s.draft.trim()))}
        onCancel={h.onCancel}
      />
    ) : (
      <>
        {(l.suggestions?.length ?? 0) > 0 && (
          <div className="nt-sug">
            {l.suggestions?.map((sug) => (
              <button
                key={sug}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  h.onDraft(n, sug);
                  h.onReply(n);
                }}
              >
                {sug}
              </button>
            ))}
          </div>
        )}
        <div className="nt-wacts">
          <Button
            variant="primary"
            size="sm"
            icon="reply"
            onClick={(e) => {
              e.stopPropagation();
              h.onReply(n);
            }}
          >
            {t("notifications.reply")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              h.onOpen(n);
            }}
          >
            {t("notifications.wait.openThread")}
          </Button>
          <span className="nt-grow" />
          {tail}
        </div>
      </>
    );
  } else if (n.kind === "forum_turn") {
    meta = (
      <>
        <b>{name}</b>
        <span>{t("notifications.wait.table")}</span>
        <SourceChip n={n} channelName={channelName} />
        <span>{whenText(t, i18n.language, n.createdAt)}</span>
        <span className="nt-grow" />
        {n.source.topicId && <RoundWaits topicId={n.source.topicId} />}
      </>
    );
    head = (
      <>
        <h3>{l.title ?? n.source.label ?? l.text ?? ""}</h3>
        <p className="nt-ctx">
          {l.round && l.rounds
            ? t("notifications.wait.yourTurn", { round: l.round, rounds: l.rounds })
            : t("notifications.wait.yourTurnNoRound")}
        </p>
      </>
    );
    body = resolving ? (
      <div className="nt-resolved">
        <Spinner size={14} />
        {t("notifications.wait.resolvedForum")}
      </div>
    ) : (
      <>
        {n.source.topicId ? <Seats topicId={n.source.topicId} dir={dir} /> : null}
        {s.replying ? (
          <Composer
            id={n.id}
            placeholder={placeholderFor(t, n, dir, channelName)}
            draft={s.draft}
            sending={s.sending}
            onDraft={(text) => h.onDraft(n, text)}
            onSend={() => h.onSend(n, s.draft)}
            onCancel={h.onCancel}
          />
        ) : (
          <div className="nt-wacts">
            <Button
              variant="primary"
              size="sm"
              icon="message"
              onClick={(e) => {
                e.stopPropagation();
                h.onReply(n);
              }}
            >
              {t("notifications.wait.speak")}
            </Button>
            <Button
              size="sm"
              icon="arrowRight"
              loading={passing}
              disabled={passing}
              onClick={(e) => {
                e.stopPropagation();
                onPass(n, e.currentTarget);
              }}
            >
              {t("notifications.wait.pass")}
            </Button>
            <span className="nt-grow" />
            {tail}
          </div>
        )}
      </>
    );
  } else {
    const leftMs = l.expiresAt ? new Date(l.expiresAt).getTime() - Date.now() : null;
    const left = l.expiresAt ? timeLeft(t, l.expiresAt) : null;
    // An approval says who asked while nobody watched, then the agent's why (ADR 0053 §8).
    const origin = n.kind === "approval" ? approvalOriginWords({ origin: l.origin }) : null;
    const why = n.kind === "approval" && l.title ? l.text : undefined;
    // An approval (AprovacaoConector B): the sentence says who and what; decided right here.
    const approvalId = n.kind === "approval" ? n.source.approvalId : undefined;
    const leftChip = left && leftMs !== null && (
      <Chip icon="clock" tone={leftMs <= URGENT_MS ? "waiting" : "neutral"}>
        {leftMs <= URGENT_MS ? t("approvals.leftUrgent", { time: left }) : t("approvals.left", { time: left })}
      </Chip>
    );
    const open = () => h.onOpen(n);
    if (approvalId) {
      meta = (
        <>
          <span>{whenText(t, i18n.language, n.createdAt)}</span>
          {origin && (
            <span className="nt-origin">
              <Icon name="routines" size={14} />
              {sayWords(t, origin)}
            </span>
          )}
          <span className="nt-grow" />
          {leftChip}
        </>
      );
      head = (
        <ApprovalSay approvalId={approvalId} name={name} why={why} mine={mine} fallback={l.title ?? l.text ?? ""} />
      );
      body = <ApprovalActs approvalId={approvalId} agent={agent} onOpen={open} tail={tail} />;
    } else {
      meta = (
        <>
          <span>
            <Headline n={n} dir={dir} channelName={channelName} />
          </span>
          <SourceChip n={n} channelName={channelName} />
          <span>{whenText(t, i18n.language, n.createdAt)}</span>
          <span className="nt-grow" />
          {leftChip}
        </>
      );
      // A request to join: the line above says who; it is answered in Members.
      head = n.kind === "join_request" ? null : <h3>{l.title ?? l.text ?? ""}</h3>;
      body = (
        <div className="nt-wacts">
          <Button
            variant="primary"
            size="sm"
            icon="external"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
          >
            {t("notifications.open")}
          </Button>
          <span className="nt-grow" />
          {tail}
        </div>
      );
    }
  }
  return (
    <article
      className={cx("nt-wi", unread && "is-unread", s.cur && "is-cur", s.fresh && "is-new", s.leaving && "is-leaving")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable item (J/K, E, R, Enter) with its own actions inside
      tabIndex={0}
      data-n={n.id}
      data-wait=""
      data-burst=""
      aria-label={[name, l.title ?? l.text].filter(Boolean).join(": ")}
      onClick={(e) => {
        if ((e.target as Element).closest("button, a, textarea, input, .nt-cmp")) return;
        h.onSelect(n);
      }}
      onKeyDown={() => {}}
    >
      <span className="nt-face">
        {first ? (
          <Face actor={first} dir={dir} state={resolving ? "writing" : "waiting"} className="nt-av40" />
        ) : (
          <SystemFace n={n} className="nt-av40" />
        )}
      </span>
      <div className="nt-meta">{meta}</div>
      <div>{head}</div>
      <div className="nt-body">{body}</div>
      {n.kind === "approval" && l.expiresAt && (
        <ExpiryFuse left={Math.max(0, new Date(l.expiresAt).getTime() - Date.now()) / TTL_MS} color={colorOf(agent)} />
      )}
    </article>
  );
}

/** An item's row or card on screen. */
const element = (id: string) => document.querySelector<HTMLElement>(`[data-n="${CSS.escape(id)}"]`);

/** `setTimeout` that is cleared when the component unmounts (a late state update after leaving the page). */
function useLater() {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  return useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      fn();
    }, ms);
    timers.current.add(timer);
  }, []);
}

/** Items that just arrived (or came back) glow in; merged ones pulse. Nothing on the first load. */
function useArrivals(items: AppNotification[], filter: NotificationFilter, ready: boolean) {
  const prev = useRef<Map<string, string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [pulse, setPulse] = useState<Set<string>>(new Set());
  const later = useLater();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts over
  useEffect(() => {
    prev.current = null;
  }, [filter]);
  useEffect(() => {
    if (!ready) return;
    const now = new Map(items.map((n) => [n.id, n.updatedAt]));
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    const added = items.filter((n) => !before.has(n.id)).map((n) => n.id);
    const bumped = items.filter((n) => before.has(n.id) && before.get(n.id) !== n.updatedAt).map((n) => n.id);
    if (added.length) {
      setFresh((s) => new Set([...s, ...added]));
      later(() => setFresh((s) => new Set([...s].filter((id) => !added.includes(id)))), 2400);
    }
    if (bumped.length) {
      setPulse((s) => new Set([...s, ...bumped]));
      later(() => setPulse((s) => new Set([...s].filter((id) => !bumped.includes(id)))), 800);
    }
  }, [items, ready, later]);
  return { fresh, pulse };
}

/** Notificações: what waits on me on top, the rest by day, grouped by conversation. */
export function NotificationsPage() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const live = useLiveStore();
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const list = useNotifications(org.id, filter);
  const badge = useNotificationCount(org.id);
  const action = useNotificationAction(org.id);
  const reply = useNotificationReply(org.id);
  const forum = useForumAction(org.id);
  const [cur, setCur] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [replied, setReplied] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [passing, setPassing] = useState<string | null>(null);
  const later = useLater();

  const items = allItems(list.data);
  const counts = list.data?.pages[0]?.counts;
  const { fresh, pulse } = useArrivals(items, filter, list.isSuccess && !list.isPlaceholderData);
  const mine = dir.memberById.get(me.user.id)?.handle ?? null;
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  const waiting = sortWaiting(items.filter((n) => n.waiting));
  const rest = items.filter((n) => !n.waiting);
  const days = groupByDay(rest);
  const unreadTotal = counts?.unread ?? badge.data?.unread ?? 0;
  const waitingTotal = counts?.waiting ?? 0;
  const nothing = list.isSuccess && (counts?.all ?? 0) === 0 && items.length === 0;

  // The tab says how many are unread.
  useEffect(() => {
    const previous = document.title;
    document.title = unreadTotal ? t("notifications.docTitleUnread", { count: unreadTotal }) : t("notifications.title");
    return () => {
      document.title = previous;
    };
  }, [unreadTotal, t]);

  const markRead = (n: AppNotification) => {
    if (n.readAt === null) action.mutate({ type: "read", item: n, read: true });
  };

  /** Slide out, fold the space, then change the lists (the next item takes the cursor). */
  const leave = (n: AppNotification, then: () => void) => {
    if (replying === n.id) setReplying(null);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-n]")];
    const i = rows.findIndex((r) => r.dataset.n === n.id);
    const next = rows[i + 1]?.dataset.n ?? rows[i - 1]?.dataset.n ?? null;
    const finish = () => {
      then();
      setLeaving((s) => {
        const copy = new Set(s);
        copy.delete(n.id);
        return copy;
      });
      if (cur === n.id || cur === null) {
        setCur(next);
        if (next) requestAnimationFrame(() => element(next)?.focus({ preventScroll: true }));
      }
    };
    const el = element(n.id);
    if (!el || prefersReducedMotion()) return finish();
    el.style.height = `${el.offsetHeight}px`;
    setLeaving((s) => new Set(s).add(n.id));
    // Inline (React doesn't own these rows' style): fold the space so the list closes up.
    later(() => {
      el.style.transition = "height .26s var(--out), padding .26s var(--out), border-color .26s";
      el.style.overflow = "hidden";
      el.style.borderTopColor = "transparent";
      el.style.height = "0px";
      el.style.paddingTop = "0px";
      el.style.paddingBottom = "0px";
    }, 180);
    later(finish, LEAVE_MS);
  };

  const done = (n: AppNotification) => {
    const name = nameOf(t, dir, n.actors[0]);
    leave(n, () => action.mutate({ type: "done", item: n, done: true }));
    toast.show(
      t("notifications.toast.done"),
      "info",
      { label: t("notifications.toast.undo"), run: () => action.mutate({ type: "done", item: n, done: false }) },
      n.kind === "agent_question"
        ? t("notifications.toast.doneQuestion", { name })
        : n.kind === "approval"
          ? t("notifications.toast.doneApproval")
          : t("notifications.toast.doneOther"),
    );
  };

  const snooze = (n: AppNotification, choice: SnoozeChoice) => {
    const until = snoozeTimes()[choice].toISOString();
    leave(n, () => action.mutate({ type: "snooze", item: n, until }));
    const title =
      choice === "hour"
        ? t("notifications.snoozeMenu.toastHour")
        : choice === "tomorrow"
          ? t("notifications.snoozeMenu.toastTomorrow")
          : t("notifications.snoozeMenu.toastNextWeek");
    toast.show(
      title,
      "info",
      { label: t("notifications.toast.undo"), run: () => action.mutate({ type: "snooze", item: n, until: null }) },
      n.latest.title ?? n.latest.text ?? n.latest.quote ?? "",
    );
  };

  const openItem = (n: AppNotification) => {
    markRead(n);
    const target = openTarget(n);
    if (!target) return;
    // An agent asked for help in its browser: its card opens there, in control (no page of its own).
    if (n.kind === "browser_handoff" && n.source.handoffId) requestBrowserCard({ handoffId: n.source.handoffId });
    const orgId = org.id;
    switch (target.to) {
      case "/org/$orgId/threads/$threadId":
        return void navigate({ to: target.to, params: { orgId, ...target.params } });
      case "/org/$orgId/c/$channelId":
        return void navigate({ to: target.to, params: { orgId, ...target.params }, search: target.search ?? {} });
      case "/org/$orgId/dm/agent/$agentId":
        return void navigate({ to: target.to, params: { orgId, ...target.params } });
      case "/org/$orgId/dm/person/$userId":
        return void navigate({ to: target.to, params: { orgId, ...target.params } });
      case "/org/$orgId/issues/$number":
        return void navigate({ to: target.to, params: { orgId, ...target.params } });
      case "/org/$orgId/forum/$topicId":
        return void navigate({ to: target.to, params: { orgId, ...target.params } });
      case "/org/$orgId/threads":
        return void navigate({ to: target.to, params: { orgId }, search: target.search });
      case "/org/$orgId/settings/computers/$machineId":
        return void navigate({ to: target.to, params: { orgId, ...target.params } });
      case "/org/$orgId/settings/$section":
        return void navigate({ to: target.to, params: { orgId, ...target.params }, search: {} });
      case "/org/$orgId/routines":
        // A routine's trouble opens it in Rotinas, its state and fix in view.
        return void navigate({ to: target.to, params: { orgId }, search: target.search ?? {} });
      default:
        return void navigate({ to: target.to, params: { orgId } });
    }
  };

  const startReply = (n: AppNotification) => {
    if (!replyTarget(n)) {
      if (n.kind === "approval")
        toast.show(t("notifications.toast.decideThere"), "info", undefined, t("notifications.toast.decideThereDetail"));
      return;
    }
    setReplying(n.id);
    setCur(n.id);
    markRead(n);
  };

  const cancelReply = () => {
    const id = replying;
    setReplying(null);
    if (id) requestAnimationFrame(() => element(id)?.focus({ preventScroll: true }));
  };

  /** An agent got unblocked: its pixels burst, a line says so, then the card leaves. */
  const resolve = (n: AppNotification) => {
    setResolving(n.id);
    const face = element(n.id)?.querySelector<HTMLElement>(".ac-avatar");
    if (face) prepareBurst(face)();
    later(() => {
      leave(n, () => dropNotification(qc, org.id, n.id));
      setResolving(null);
    }, 1700);
  };

  const send = (n: AppNotification, text: string, choice?: boolean) => {
    const target = replyTarget(n);
    const body = text.trim();
    if (!target || !body) return;
    setSending(n.id);
    reply.mutate(
      { target, text: body, choice },
      {
        onSuccess: (res) => {
          setReplying(null);
          setDrafts((d) => {
            const { [n.id]: _, ...others } = d;
            return others;
          });
          markRead(n);
          const name = nameOf(t, dir, n.actors[0]);
          if (res.kind === "question") {
            live.answered({ ...res.question, answer: res.question.answer ?? body });
            toast.show(t("notifications.toast.answered", { name }), "info", undefined, body);
            resolve(n);
          } else if (res.kind === "forum") {
            toast.show(t("notifications.toast.spoke"), "info", undefined, body);
            resolve(n);
          } else {
            setReplied((r) => ({ ...r, [n.id]: body }));
            toast.show(
              t("notifications.toast.sent"),
              "info",
              { label: t("notifications.toast.see"), run: () => openItem(n) },
              body,
            );
          }
        },
        onSettled: () => setSending(null),
      },
    );
  };

  const pass = (n: AppNotification) => {
    if (!n.source.topicId) return;
    setPassing(n.id);
    forum.mutate(
      { type: "pass", topicId: n.source.topicId },
      {
        onSuccess: () => {
          leave(n, () => dropNotification(qc, org.id, n.id));
          toast.show(t("notifications.toast.passed"), "info", undefined, t("notifications.toast.passedDetail"));
        },
        onSettled: () => setPassing(null),
      },
    );
  };

  const readAll = () => {
    const count = counts?.unread ?? 0;
    if (!count) return;
    action.mutate(
      { type: "readAll", filter },
      {
        onSuccess: (res) =>
          toast.show(
            t("notifications.toast.readAll", { count: res.ids.length || count }),
            "info",
            {
              label: t("notifications.toast.undo"),
              run: () => action.mutate({ type: "unreadMany", ids: res.ids }),
            },
            t("notifications.toast.readAllDetail"),
          ),
      },
    );
  };

  const toggle = (n: AppNotification) => {
    setOpen((s) => {
      const copy = new Set(s);
      if (copy.has(n.id)) copy.delete(n.id);
      else copy.add(n.id);
      return copy;
    });
    setCur(n.id);
    markRead(n);
  };

  const select = (n: AppNotification) => {
    setCur(n.id);
    markRead(n);
    // A grouped item opens its replies on the first tap.
    if (isExpandable(n) && !open.has(n.id) && !n.waiting) toggle(n);
  };

  const handlers: RowHandlers = {
    onSelect: select,
    onReply: startReply,
    onDone: done,
    onSnooze: snooze,
    onOpen: openItem,
    onToggle: toggle,
    onSend: send,
    onCancel: cancelReply,
    onDraft: (n, text) => setDrafts((d) => ({ ...d, [n.id]: text })),
  };

  // J/K (and arrows) move, E done, R reply, Enter opens, Escape closes the composer.
  const keyState = useRef({ items, cur, replying, handlers });
  keyState.current = { items, cur, replying, handlers };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const { items: all, cur: current, replying: open, handlers: h } = keyState.current;
      const target = e.target instanceof Element ? e.target : null;
      if (e.key === "Escape" && open) {
        h.onCancel();
        return;
      }
      if (target?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (target?.closest("button") && (e.key === "Enter" || e.key === " ")) return;
      const rows = [...document.querySelectorAll<HTMLElement>(".nt [data-n]")];
      const here = target?.closest<HTMLElement>("[data-n]") ?? (current ? element(current) : null);
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k" || ((e.key === "ArrowDown" || e.key === "ArrowUp") && here)) {
        e.preventDefault();
        const i = here ? rows.indexOf(here) : -1;
        const down = key === "j" || e.key === "ArrowDown";
        const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (down ? 1 : -1)))];
        if (next?.dataset.n) {
          setCur(next.dataset.n);
          next.focus({ preventScroll: true });
          next.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
        }
        return;
      }
      const n = all.find((x) => x.id === here?.dataset.n);
      if (!n) return;
      if (key === "e") {
        e.preventDefault();
        h.onDone(n);
      } else if (key === "r") {
        e.preventDefault();
        h.onReply(n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        h.onOpen(n);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stateOf = (n: AppNotification): RowState => ({
    cur: cur === n.id,
    open: open.has(n.id),
    replying: replying === n.id,
    sending: sending === n.id,
    draft: drafts[n.id] ?? "",
    replied: replied[n.id],
    fresh: fresh.has(n.id),
    pulse: pulse.has(n.id),
    leaving: leaving.has(n.id),
  });

  const waiters = [
    ...new Map(waiting.flatMap((n) => (n.actors[0]?.type === "agent" ? [[n.actors[0].id, n.actors[0]]] : []))).values(),
  ];
  const waiterNames = waiters.map((a) => nameOf(t, dir, a));
  const summary = nothing
    ? t("notifications.summaryNothing")
    : [
        waitingTotal ? t("notifications.summaryWaiting", { count: waitingTotal }) : "",
        unreadTotal ? t("notifications.summaryUnread", { count: unreadTotal }) : t("notifications.summaryAllRead"),
      ]
        .filter(Boolean)
        .join(" · ");
  const calmAgent = dir.agents[0];

  return (
    <div className="page page--list nt">
      <header className="list-head">
        <div>
          <h1>{t("notifications.title")}</h1>
          {list.isSuccess && <p className="list-head__sub">{summary}</p>}
        </div>
        <div className="list-head__acts">
          <Menu
            align="end"
            label={t("notifications.keys.title")}
            trigger={
              <Button size="sm" variant="ghost" className="nt-keys-btn">
                {t("notifications.keys.title")}
              </Button>
            }
          >
            <MenuHeading>{t("notifications.keys.title")}</MenuHeading>
            <MenuItem hint="J · K" onSelect={() => {}}>
              {t("notifications.keys.move")}
            </MenuItem>
            <MenuItem hint="E" onSelect={() => {}}>
              {t("notifications.keys.done")}
            </MenuItem>
            <MenuItem hint="R" onSelect={() => {}}>
              {t("notifications.keys.reply")}
            </MenuItem>
            <MenuItem hint="↵" onSelect={() => {}}>
              {t("notifications.keys.open")}
            </MenuItem>
          </Menu>
          <Button size="sm" disabled={!counts?.unread || action.isPending} onClick={readAll}>
            {t("notifications.readAll")}
          </Button>
        </div>
      </header>

      <div className="nt-tb">
        <div className="nt-segwrap">
          <Segmented
            label={t("notifications.filters")}
            value={filter}
            onValueChange={(f) => {
              setFilter(f);
              setCur(null);
            }}
            options={NOTIFICATION_FILTERS.map((f) => ({
              value: f,
              label: t(`notifications.filter.${f}`),
              hint: counts?.[f] ? counts[f] : undefined,
            }))}
          />
        </div>
      </div>

      {list.isPending && <LoadingCards count={3} />}
      {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}

      {nothing && filter === "all" && (
        <div className="nt-calm">
          <div className="nt-calm__glow">
            <SkyGlow color={colorOf(calmAgent)} />
          </div>
          <b>{t("notifications.calmTitle")}</b>
          <p>{t("notifications.calmText")}</p>
        </div>
      )}

      {list.isSuccess && items.length === 0 && !(nothing && filter === "all") && (
        <div className="nt-nores">
          {filter === "waiting" && calmAgent ? (
            <AgentAvatar agentId={calmAgent.id} name={calmAgent.name} size="sm" expression="happy" />
          ) : (
            <Icon name="check" />
          )}
          <span>
            {filter === "waiting"
              ? t("notifications.noneWaiting")
              : filter === "unread"
                ? t("notifications.noneUnread")
                : t("notifications.noneHere")}
          </span>
        </div>
      )}

      {waiting.length > 0 && (
        <section className="nt-wait" aria-label={t("notifications.wait.title")}>
          <div className="nt-wh">
            {waiters.length > 0 && (
              <span className="nt-faces">
                {waiters.map((a) => (
                  <Face key={a.id} actor={a} dir={dir} size="sm" state="waiting" className="nt-av30" />
                ))}
              </span>
            )}
            <div className="nt-wh__t">
              <h2>
                {t("notifications.wait.title")}
                <span className="nt-n ac-num">{waiting.length}</span>
              </h2>
              {waiters.length > 0 && (
                <small>
                  {waiters.length > 1
                    ? t("notifications.wait.stuckMany", { names: namesText(t, waiterNames, 3) })
                    : t(
                        isFeminineName(waiterNames[0] ?? "")
                          ? "notifications.wait.stuckF"
                          : "notifications.wait.stuckM",
                        { names: waiterNames[0] },
                      )}
                </small>
              )}
            </div>
          </div>
          {waiting.map((n) => (
            <WaitCard
              key={n.id}
              n={n}
              s={stateOf(n)}
              h={handlers}
              dir={dir}
              mine={mine}
              resolving={resolving === n.id}
              onPass={pass}
              passing={passing === n.id}
              channelName={channelName}
            />
          ))}
        </section>
      )}

      {days.map(([day, rows]) => {
        const unread = rows.filter((n) => n.readAt === null).length;
        return (
          <section key={day} className="nt-day" aria-label={t(`notifications.day.${day}`)}>
            <div className="list-group-head">
              <h2>{t(`notifications.day.${day}`)}</h2>
              <span className="list-group-head__count">
                {unread ? t("notifications.dayUnread", { count: unread }) : rows.length}
              </span>
            </div>
            <div className="list-card nt-list">
              {rows.map((n) => (
                <Row key={n.id} n={n} s={stateOf(n)} h={handlers} dir={dir} mine={mine} channelName={channelName} />
              ))}
            </div>
          </section>
        );
      })}

      {list.hasNextPage && (
        <div className="nt-more-pages">
          <Button variant="ghost" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t("notifications.more")}
          </Button>
        </div>
      )}

      {filter === "all" && items.length > 0 && (
        <div className="nt-foot">
          <Icon name="check" size={14} />
          {t("notifications.foot")}
        </div>
      )}
    </div>
  );
}
