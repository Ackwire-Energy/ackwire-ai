import {
  Avatar,
  Button,
  Composer,
  type ComposerCommand,
  ComposerFile,
  type ComposerFormatLabels,
  DayDivider,
  Dialog,
  DialogFooter,
  DialogSearchList,
  EmptyState,
  Field,
  FORMAT_KINDS,
  type FormatKind,
  Icon,
  type IconName,
  Input,
  Mention,
  Message,
  MessageText,
  Skeleton,
  SkeletonGroup,
  SkeletonMessage,
  Spinner,
  Switch,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Fragment, memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import {
  MESSAGES_PAGE,
  sendHelpers,
  useAddChannelMember,
  useApproval,
  useApprovals,
  useChannelMembers,
  useChannels,
  useJoinChannel,
  useMessages,
  useModels,
  usePostMessage,
  useRoster,
  useThreads,
  useUpdateChannel,
  useWikiTree,
} from "@/api/queries";
import type {
  Agent,
  AgentQuestion,
  Approval,
  ArtifactRef,
  Channel,
  Member,
  MemoryUpdate,
  Message as MessageType,
  ReplyRef,
  SecretRequest,
} from "@/api/types";
import { tokenizeBody } from "@/chat/body";
import { MessageBody } from "@/chat/MessageBody";
import { buildTimeline, mergeTimeline, threadRootsToLoad } from "@/chat/timeline";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { InlineApproval } from "@/components/ApprovalItem";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { ChannelMembersStack } from "@/components/ChannelMembers";
import { InlineProposal, MemoryChangeCard, QuestionCard, SecretCard } from "@/components/ChatCards";
import { type ChannelActions, ChannelActionsContext, useChannelActions } from "@/components/channel-actions";
import { ForumMessageCard, forumTopicOfMessage } from "@/components/Forum";
import { LiveCodeToggle, LiveWorkList } from "@/components/LiveCode";
import { ErrorState, LoadingConversation } from "@/components/Loading";
import { MemberPickerRows, memberOf, type PickKey, useMemberRows } from "@/components/MemberPicker";
import { MessageFeedback } from "@/components/MessageFeedback";
import { MessageMoreMenu, PersonMessageActions, QuoteReplyButton } from "@/components/MessageMore";
import { MessageReceipts } from "@/components/MessageReceipts";
import { MessageWork } from "@/components/MessageWork";
import { NavToggle } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { ProfileTrigger } from "@/components/ProfileCard";
import { MessageReactions, useEmojiLabels } from "@/components/Reactions";
import { ActivitySky, ChannelWelcome, colorOf } from "@/components/Sky";
import { askToStop, isStoppable, StopButton, useStopRun } from "@/components/StopRun";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { useDirectory } from "@/hooks/useDirectory";
import { useMentionSearch } from "@/hooks/useMentionSearch";
import { usePrefersReducedMotion, useRevealedText } from "@/hooks/useRevealedText";
import { activityText, activityVerb, barEntries, isWriting, toolActivity } from "@/lib/activity";
import { artifactRefs } from "@/lib/artifacts";
import { audienceNotice, canTalk } from "@/lib/audience";
import { entersWithMotion, greetingSuggestions, messageUsage, nearBottom, usageLine } from "@/lib/chat";
import { clearDraft, peekDraft } from "@/lib/drafts";
import { errorText } from "@/lib/errors";
import { fileIcon, fitsUpload, MAX_UPLOAD_MB } from "@/lib/files";
import { dayLabel, formatFullDate, formatTime, joinNames } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { reportPainted } from "@/lib/perf";
import { can } from "@/lib/permissions";
import { localMeta, quoteExcerpt, replyOf } from "@/lib/reply";
import { isReminderMessage, routineOfMessage } from "@/lib/routines";
import { useToast } from "@/lib/toast";
import { splitCanceled } from "@/lib/work";
import {
  reconcileChannelRuns,
  useChannelRealtime,
  useConnectionStatus,
  useDismissRun,
  useLive,
  useLiveStore,
  useStreams,
  useTypingSender,
} from "@/realtime/context";
import { agentStateOfRun, isQuiet, type LiveRun, narrationOf, runsInChannel } from "@/realtime/streams";
import { typingIn } from "@/realtime/typing";

/** Header and empty state of a channel, or of a DM (same layout). */
export interface ChannelChrome {
  header?: ReactNode;
  emptyText?: string;
  /** Composer label/placeholder target, e.g. "Ada" instead of "#eng". */
  composerTarget?: string;
  /** A DM with this agent: it answers every message (optimistic "pensando…" is allowed). */
  dmAgentId?: string;
  /** The agent won't answer me: the composer is off and says why ("O Theo só responde a Walter."). */
  locked?: string;
  /** Empty conversation: "Diga oi para o Theo". */
  emptyTitle?: string;
  /** Empty conversation: first messages to pick (they go to the composer). */
  suggestions?: string[];
}

const sameRuns = (a: LiveRun[], b: LiveRun[]) => a.length === b.length && a.every((r, i) => r === b[i]);

/** `?m=`: how many older pages to look through for the message, and how long it stays highlighted. */
const FOCUS_MAX_PAGES = 10;
const HIGHLIGHT_MS = 2400;
/** A scroll within this long after a wheel/touch/key/pointer counts as the person's. */
const GESTURE_MS = 1500;
/** Older messages per scroll-up page. */
const OLDER_PAGE = 50;
/** Per channel, for this session: older pages already loaded, channels with no more, and scroll positions. */
const olderPages = new Map<string, MessageType[]>();
const olderDone = new Set<string>();
const scrollPositions = new Map<string, number>();
/** Same limit as the server (`MAX_MESSAGE_ATTACHMENTS`). */
const MAX_ATTACHMENTS = 10;

/** A file picked for the next message: uploading, uploaded (with its Drive ref) or failed. */
interface PendingFile {
  key: string;
  name: string;
  icon: IconName;
  status: "uploading" | "done" | "failed";
  ref?: ArtifactRef;
}

/** Scrolls to a message on screen and gives it the soft highlight; false when it isn't there. */
function highlightMessage(scroller: HTMLElement | null, messageId: string) {
  const el = scroller?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!el) return false;
  el.scrollIntoView?.({ block: "center" });
  // A soft plate that fades (CSS; static with reduced motion).
  el.classList.add("ac-msg--focus");
  setTimeout(() => el.classList.remove("ac-msg--focus"), HIGHLIGHT_MS);
  return true;
}

/** "Respondendo a Ana" above the text: the quoted line and a cancel (Esc does it too). */
function QuoteBar({ name, excerpt, onCancel }: { name: string; excerpt: string; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="composer-quote">
      <Icon name="reply" size={16} />
      <span className="composer-quote__text">
        <span className="composer-quote__who">{t("channel.replyingTo", { name })}</span>
        <span className="composer-quote__excerpt">{excerpt}</span>
      </span>
      <button type="button" className="composer-reply__close" aria-label={t("channel.cancelQuote")} onClick={onCancel}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** The quote above a reply: who and one line; opens the original. */
function QuotedMessage({ reply }: { reply: ReplyRef }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  // The directory's current name; the one saved with the quote when they are gone.
  const known =
    reply.author.type === "agent"
      ? dir.agentById.get(reply.author.id ?? "")?.name
      : dir.memberById.get(reply.author.id ?? "")?.name;
  const name = known || reply.authorName || dir.authorName(reply.author);
  return (
    <button
      type="button"
      className="msg-quote"
      aria-label={t("channel.quoteOf", { name, excerpt: reply.excerpt })}
      onClick={() => actions?.jumpTo?.(reply.messageId)}
    >
      <span className="msg-quote__who" aria-hidden="true">
        {name}
      </span>
      <span className="msg-quote__excerpt" aria-hidden="true">
        {reply.excerpt}
      </span>
    </button>
  );
}

/** telas/Main.dc.html — a channel with real-time messages, streaming agent replies and inline approvals. */
export function ChannelPage({
  channelId,
  chrome,
  fallback,
  focusMessageId,
}: {
  channelId: string;
  chrome?: ChannelChrome;
  /** Open at this message (a copied link): load around it, scroll to it and highlight it. */
  focusMessageId?: string;
  /** DMs may not be in the channel list: the page still works with this. */
  fallback?: Channel;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const channel = channels.data?.find((c) => c.id === channelId) ?? fallback;

  if (channels.isPending && !fallback) return <ChannelSkeleton />;
  if (!channel) {
    return (
      <main className="shell__main">
        <div className="page page--mid">
          <EmptyState icon="channel">{t("channel.notFound")}</EmptyState>
        </div>
      </main>
    );
  }
  return <ChannelView key={channel.id} channel={channel} chrome={chrome} focusMessageId={focusMessageId} />;
}

/**
 * The whole conversation loading (header, messages, composer) with the real
 * layout, so nothing jumps when it arrives.
 */
export function ChannelSkeleton() {
  const { t } = useTranslation();
  return (
    <main className="shell__main shell__main--chat">
      <SkeletonGroup label={t("common.loadingMessages")} className="channel__skeleton">
        <header className="channel__header">
          <NavToggle />
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 }}>
            <Skeleton width={160} height={16} />
            <Skeleton width={260} height={10} />
          </div>
          <Skeleton width={72} height={28} />
        </header>
        <div className="channel__messages">
          <div className="channel__spacer" aria-hidden="true" />
          <div className="ac-skeleton-conversation">
            <SkeletonMessage lines={2} seed={0} />
            <SkeletonMessage lines={1} grouped seed={1} />
            <SkeletonMessage lines={3} agent seed={2} />
            <SkeletonMessage lines={1} seed={3} />
            <SkeletonMessage lines={2} agent seed={4} />
          </div>
        </div>
        <div className="channel__composer">
          <div className="ac-composer channel__composer-skeleton" aria-hidden="true">
            <Skeleton width="36%" />
          </div>
          <p className="ac-composer__hint">&nbsp;</p>
        </div>
      </SkeletonGroup>
    </main>
  );
}

function ChannelView({
  channel,
  chrome,
  focusMessageId,
}: {
  channel: Channel;
  chrome?: ChannelChrome;
  focusMessageId?: string;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const isMember = channel.isMember;
  const members = useChannelMembers(org.id, channel.id, isMember);
  const messages = useMessages(org.id, channel.id, isMember);
  const roots = useMemo(() => threadRootsToLoad(messages.data ?? []), [messages.data]);
  const threads = useThreads(org.id, channel.id, isMember ? roots : []);
  const live = useLiveStore();
  const status = useConnectionStatus();
  const join = useJoinChannel(org.id, channel.id);
  const sendTyping = useTypingSender(channel.id);
  // ⌘K "Pedir a um agente" leaves the text for this DM's composer.
  const draftKey = chrome?.dmAgentId ? `agent:${chrome.dmAgentId}` : null;
  const [draft, setDraft] = useState(() => (draftKey ? (peekDraft(draftKey) ?? "") : ""));
  // Esc (composer empty, nothing open): asks to stop the most recent run here that I may stop
  // (the confirmation; Esc twice within 1.5 s stops directly).
  const { canStop: mayStop, stop: stopRun } = useStopRun();
  const draftRef = useRef("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || draftRef.current.trim()) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      const target = runsInChannel(live.get().streams, channel.id)
        .filter((r) => isStoppable(r) && !r.stopping && mayStop(r))
        .at(-1);
      if (!target) return;
      e.preventDefault();
      askToStop(target.runId, isWriting(target) ? "row" : "bar", true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // An agent working here: the composer says the message goes into its task.
  const workingRun = useStreams((s) => runsInChannel(s, channel.id).find((r) => isStoppable(r) && !r.stopping));
  // "Responder em thread": the next message goes to that thread.
  const [replyTo, setReplyTo] = useState<MessageType | null>(null);
  // "Responder": the next message quotes this one (`meta.replyTo`), in the same conversation.
  const [quote, setQuote] = useState<MessageType | null>(null);
  draftRef.current = draft;
  useEffect(() => {
    if (draftKey) clearDraft(draftKey);
  }, [draftKey]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // An agent mentioned from outside the channel: offer to add it.
  const [offer, setOffer] = useState<string | null>(null);
  const mentionSearch = useMentionSearch(members.data);
  const composer = useRef<HTMLTextAreaElement>(null);
  const emojiPicker = useEmojiLabels();
  const emojiLabels = useMemo(() => ({ ...emojiPicker, button: t("channel.emoji") }), [emojiPicker, t]);
  const formatLabels: ComposerFormatLabels = useMemo(
    () => ({
      ...(Object.fromEntries(FORMAT_KINDS.map((k) => [k, t(`composer.format.${k}`)])) as Record<FormatKind, string>),
      toolbar: t("composer.format.toolbar"),
      linkText: t("composer.format.linkText"),
    }),
    [t],
  );
  useChannelRealtime(org.id, channel.id, isMember);

  const channelAgents = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.type === "agent")
        .map((m) => dir.agentById.get(m.id))
        .filter((a): a is Agent => Boolean(a)),
    [members.data, dir.agentById],
  );
  const channelPeople = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.type === "person")
        .map((m) => dir.memberById.get(m.id))
        .filter((p): p is Member => Boolean(p)),
    [members.data, dir.memberById],
  );

  /** Agents of this channel the text mentions (instant "pensando…" before the server answers). */
  const mentioned = (body: string) =>
    tokenizeBody(body)
      .flatMap((tok) => (tok.type === "mention" ? [dir.agentByHandle.get(tok.handle.toLowerCase())] : []))
      .filter((a): a is Agent => Boolean(a && canTalk(a) && channelAgents.some((c) => c.id === a.id)))
      .map((a) => a.id);

  const post = usePostMessage(org.id, channel.id, {
    me: { id: me.user.id },
    mentioned,
    // Optimistic "pensando…" only for an explicit @mention or an agent DM. Anything else is the
    // router's call: wait for `message.routed` / `agent.thinking` from the server.
    onOptimistic: (local) => {
      const agents = local.mentionedAgentIds.length
        ? local.mentionedAgentIds
        : chrome?.dmAgentId && !chrome.locked
          ? [chrome.dmAgentId]
          : [];
      if (agents.length > 0) live.expect(channel.id, local.id, agents);
    },
    onSent: (message, local) => live.retarget(local.id, message.id),
  });
  const { send, retry } = sendHelpers(post);

  // Reading the channel marks it read (unread counts in the DM list).
  const api = useApi();
  const lastId = messages.data?.at(-1)?.id;
  useEffect(() => {
    if (isMember && lastId) api.dms.markRead(org.id, channel.id).catch(() => {});
  }, [api, org.id, channel.id, isMember, lastId]);

  // The skeleton was on screen: the real messages fade in (once).
  const hadSkeleton = useRef(messages.isLoading);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (!messages.isSuccess || !hadSkeleton.current) return;
    hadSkeleton.current = false;
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), 400);
    return () => clearTimeout(timer);
  }, [messages.isSuccess]);

  // Person messages loaded over HTTP start their receipts.
  useEffect(() => {
    if (messages.data) live.seed(messages.data);
  }, [messages.data, live]);

  // Older pages, loaded on scroll-up (kept for this session per channel).
  const [older, setOlder] = useState<MessageType[]>(() => olderPages.get(channel.id) ?? []);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "done">(() =>
    olderDone.has(channel.id) ? "done" : "idle",
  );
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const loadOlder = () => {
    if (olderState !== "idle" || !messages.data) return;
    const oldest = older[0] ?? messages.data[0];
    if (!oldest || messages.data.length < MESSAGES_PAGE) {
      setOlderState("done");
      return;
    }
    setOlderState("loading");
    api.chat
      .messages(org.id, channel.id, { before: oldest.createdAt, limit: OLDER_PAGE })
      .then((page) => {
        // Keep what's on screen where it is: remember the distance from the bottom.
        const el = scroller.current;
        if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
        setOlder((prev) => {
          const known = new Set(prev.map((m) => m.id));
          const next = [...page.filter((m) => !known.has(m.id)), ...prev];
          olderPages.set(channel.id, next);
          return next;
        });
        if (page.length < OLDER_PAGE) olderDone.add(channel.id);
        setOlderState(page.length < OLDER_PAGE ? "done" : "idle");
      })
      .catch(() => setOlderState("idle"));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when older rows were prepended
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    el.scrollTop = el.scrollHeight - a.height + a.top;
  }, [older]);

  const timeline = useMemo(
    () =>
      buildTimeline(
        mergeTimeline(
          [...older, ...(messages.data ?? [])],
          threads.map((q) => q.data),
        ),
        [],
        [],
      ),
    [older, messages.data, threads],
  );

  // Newest at the bottom: follow new messages and streaming text while the person is at the
  // bottom; if they scrolled up, offer "Novas mensagens" instead of jumping.
  const scroller = useRef<HTMLElement>(null);
  // Coming back to a channel scrolled up: restore that position (else the bottom).
  const savedScroll = useRef(scrollPositions.get(channel.id));
  // Opened at a message: not pinned to the bottom until the person scrolls down.
  const stick = useRef(savedScroll.current === undefined && !focusMessageId);
  const lastScrollTop = useRef<number | null>(null);
  // A smooth scroll in progress: its intermediate positions don't mean "the person scrolled up".
  const autoScrollUntil = useRef(0);
  // The last wheel/touch/key/pointer on the list: scroll events without one are layout, not the person.
  const lastGesture = useRef(0);
  const markGesture = () => {
    lastGesture.current = Date.now();
  };
  // Pinned to the bottom: anything that grows later (images, cards, the skeleton turning into
  // messages, fonts) keeps the latest message in view until the person scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list only exists for members; re-attach when it appears
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const pin = () => {
      if (stick.current && Date.now() >= autoScrollUntil.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(pin);
    const watch = () => {
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    watch();
    ro.observe(el);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(watch);
    mo?.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, [isMember]);
  const reducedMotion = usePrefersReducedMotion();
  const [unseen, setUnseen] = useState(false);
  const runCount = useStreams((s) => runsInChannel(s, channel.id).length);
  const streamSize = useStreams((s) => runsInChannel(s, channel.id).reduce((n, r) => n + r.text.length, 0));
  const lastKey = timeline.at(-1)?.key;
  const previousLastKey = useRef(lastKey);
  const openedAt = useRef(Date.now());
  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) {
      if (smooth && !reducedMotion && typeof el.scrollTo === "function") {
        autoScrollUntil.current = Date.now() + 600;
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else el.scrollTop = el.scrollHeight;
    }
    stick.current = true;
    setUnseen(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever rows or streaming text grow
  useLayoutEffect(() => {
    // A new row glides down; streaming text follows instantly (no fighting smooth scrolls each frame).
    // Not while the channel is still loading (first page, thread replies): that lands at once.
    const newRow = previousLastKey.current !== lastKey;
    const settled = previousLastKey.current !== undefined && Date.now() - openedAt.current > 1500;
    previousLastKey.current = lastKey;
    if (stick.current) toBottom(newRow && settled);
    else if (newRow || runCount > 0) setUnseen(true);
  }, [lastKey, runCount, streamSize]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the rows are there
  useLayoutEffect(() => {
    const el = scroller.current;
    const saved = savedScroll.current;
    if (!el || saved === undefined || timeline.length === 0) return;
    savedScroll.current = undefined;
    el.scrollTop = saved;
  }, [timeline.length > 0]);
  // Leaving: remember where they were (only when scrolled up).
  useEffect(
    () => () => {
      if (stick.current || lastScrollTop.current === null) scrollPositions.delete(channel.id);
      else scrollPositions.set(channel.id, lastScrollTop.current);
    },
    [channel.id],
  );
  // Dev only: "click → first paint of messages".
  const fromCache = useRef(messages.data !== undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reports once the rows (or an empty channel) are on screen
  useEffect(() => {
    if (timeline.length > 0 || messages.isSuccess) reportPainted(channel.id, channel.name, fromCache.current);
  }, [timeline.length > 0, messages.isSuccess, channel.id, channel.name]);

  // `[[` in the composer links wiki pages.
  const wikiPages = useWikiTree(org.id);
  // Composer context: who it goes to (the DM agent, or the agents @mentioned in the draft).
  const dmAgent = chrome?.dmAgentId ? dir.agentById.get(chrome.dmAgentId) : undefined;
  const draftAgents = useMemo(
    () =>
      [
        ...new Set(
          tokenizeBody(draft).flatMap((tok) =>
            tok.type === "mention" ? [dir.agentByHandle.get(tok.handle.toLowerCase())?.id] : [],
          ),
        ),
      ]
        .map((id) => (id ? dir.agentById.get(id) : undefined))
        .filter((a): a is Agent => Boolean(a)),
    [draft, dir.agentByHandle, dir.agentById],
  );
  const pillAgents = dmAgent ? [dmAgent] : draftAgents;
  const composerPills =
    pillAgents.length > 0 || replyTo ? (
      <>
        {replyTo && (
          <span className="ac-composer__pill composer-reply">
            <Icon name="message" size={14} />
            {t("channel.inThreadOf", { name: dir.authorName(replyTo.author) })}
            <button
              type="button"
              className="composer-reply__close"
              aria-label={t("channel.cancelReply")}
              onClick={() => setReplyTo(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </span>
        )}
        {pillAgents.map((a) => (
          <span key={a.id} className="ac-composer__agent">
            <AgentAvatar agentId={a.id} channelId={channel.id} name={a.name} size="xs" />
            {a.name}
          </span>
        ))}
      </>
    ) : undefined;
  // "/" commands, for the DM agent or the channel's first agent.
  const commandAgent = dmAgent ?? channelAgents[0];
  const navigateTo = useNavigate();
  const commandPrefix = dmAgent || !commandAgent ? "" : `@${commandAgent.handle} `;
  const cg = agentGrammar(t, commandAgent?.name ?? "");
  const commands: ComposerCommand[] = commandAgent
    ? [
        {
          key: "report",
          label: t("composer.report"),
          description: t("composer.reportText", cg),
          leading: <Icon name="document" size={16} />,
          insert: `${commandPrefix}${t("composer.reportInsert")}`,
        },
        {
          key: "routine",
          label: t("composer.routine"),
          description: t("composer.routineText"),
          leading: <Icon name="routines" size={16} />,
          insert: "",
          onPick: () => void navigateTo({ to: "/org/$orgId/routines", params: { orgId: org.id } }),
        },
        {
          key: "pc",
          label: t("composer.pc"),
          description: t("composer.pcText", cg),
          leading: <Icon name="code" size={16} />,
          insert: `${commandPrefix}${t("composer.pcInsert")}`,
        },
      ]
    : [];

  // Any new page of data (first load, refetch, cache → server) re-pins while at the bottom,
  // without waiting for observers (some environments have none).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the data changes
  useLayoutEffect(() => {
    if (stick.current && Date.now() >= autoScrollUntil.current) {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages.dataUpdatedAt, timeline.length]);

  // `?m=` (or a quote clicked): find the message (paging back up to FOCUS_MAX_PAGES), scroll to it,
  // highlight it once.
  const [focusTarget, setFocusTarget] = useState(focusMessageId);
  const [focusDone, setFocusDone] = useState(!focusMessageId);
  const focusPages = useRef(0);
  const found = focusTarget ? timeline.some((i) => i.kind === "message" && i.message.id === focusTarget) : false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: steps while the timeline grows
  useEffect(() => {
    if (focusDone || !focusTarget || !messages.isSuccess) return;
    if (found) {
      setFocusDone(true);
      stick.current = false;
      highlightMessage(scroller.current, focusTarget);
      return;
    }
    if (olderState === "done" || focusPages.current >= FOCUS_MAX_PAGES) {
      // Not here (or too far back): stay at the bottom as usual.
      setFocusDone(true);
      stick.current = true;
      toBottom();
      return;
    }
    if (olderState === "idle") {
      focusPages.current += 1;
      loadOlder();
    }
  }, [found, focusDone, focusTarget, messages.isSuccess, olderState, older.length]);
  /** A quote was clicked: the original on screen, or paged in like `?m=`. */
  const jumpTo = (messageId: string) => {
    if (highlightMessage(scroller.current, messageId)) {
      stick.current = false;
      return;
    }
    focusPages.current = 0;
    setFocusTarget(messageId);
    setFocusDone(false);
  };

  // Files for the next message: uploaded to the Drive (this channel) right away; sending waits for them.
  const toast = useToast();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const addFiles = (list: File[]) => {
    const room = MAX_ATTACHMENTS - files.length;
    if (list.length > room) toast.show(t("channel.tooManyFiles", { max: MAX_ATTACHMENTS }), "error");
    for (const file of list.slice(0, Math.max(0, room))) {
      if (!fitsUpload(file)) {
        toast.show(t("files.tooLarge", { name: file.name, max: MAX_UPLOAD_MB }), "error");
        continue;
      }
      const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const update = (patch: Partial<PendingFile>) =>
        setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
      setFiles((prev) => [
        ...prev,
        { key, name: file.name, icon: fileIcon(file.name, file.type), status: "uploading" },
      ]);
      api.artifacts
        .upload(org.id, file, { channelId: channel.id })
        .then((saved) => update({ status: "done", ref: { id: saved.id, version: saved.version, title: saved.title } }))
        .catch((error) => {
          update({ status: "failed" });
          toast.show(errorText(t, error), "error");
        });
    }
    composer.current?.focus();
  };
  const attached = files.flatMap((f) => (f.status === "done" && f.ref ? [f.ref] : []));
  const uploading = files.some((f) => f.status === "uploading");

  const onSend = (text: string) => {
    if (uploading || (!text && attached.length === 0)) return;
    toBottom(true);
    setDraft("");
    const meta = localMeta(quote, quote ? dir.authorName(quote.author) : "", attached);
    send(text, replyTo ? (replyTo.threadId ?? replyTo.id) : null, meta);
    setReplyTo(null);
    setQuote(null);
    setFiles([]);
  };
  // Live rows sit by time: right after the message that started them (never at the bottom glued
  // to a later reply). `liveKey` only changes when runs start or end.
  const liveKey = useStreams((s) =>
    runsInChannel(s, channel.id)
      .filter(isWriting)
      .map((r) => JSON.stringify([r.runId, r.startedAt ?? 0, r.threadId, r.triggerMessageId ?? null]))
      .join("\n"),
  );
  const { anchors, unanchored } = useMemo(() => liveAnchors(liveKey, timeline), [liveKey, timeline]);
  const emptySuggestions = useMemo(() => {
    if (chrome?.suggestions) return chrome.suggestions;
    const first = channelAgents[0];
    return first ? greetingSuggestions(t, first.role).map((s) => `@${first.handle} ${s}`) : [];
  }, [chrome?.suggestions, channelAgents, t]);

  const actions: ChannelActions = {
    insertMention: (handle) => {
      setDraft((d) => `${d.trim() ? `${d.trim()} ` : ""}@${handle} `);
      composer.current?.focus();
    },
    retry: (local) => {
      stick.current = true;
      retry(local);
    },
    resend: (body) => send(body),
    focusComposer: () => composer.current?.focus(),
    followBottom: () => {
      const el = scroller.current;
      if (el && stick.current && Date.now() >= autoScrollUntil.current) el.scrollTop = el.scrollHeight;
    },
    channelAgents,
    replyInThread: (message) => {
      setReplyTo(message);
      composer.current?.focus();
    },
    quoteReply: (message) => {
      setQuote(message);
      composer.current?.focus();
    },
    jumpTo,
  };

  const agentNames = joinNames(
    channelAgents.map((a) => a.name),
    t("newAgent.and"),
  );
  const subtitle = [
    channel.topic,
    channelAgents.length > 0 ? t("channel.agentsAnswer", { count: channelAgents.length, names: agentNames }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ChannelActionsContext.Provider value={actions}>
      <main className="shell__main shell__main--chat">
        {chrome?.header ?? (
          <header className="channel__header">
            <NavToggle />
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
              <h1 className="channel__title"># {channel.name}</h1>
              {subtitle && <span className="channel__topic">{subtitle}</span>}
            </div>
            <ChannelMembersStack
              channelId={channel.id}
              people={channelPeople}
              agents={channelAgents}
              onDetails={() => setDetailsOpen(true)}
            />
            <Button size="sm" onClick={() => setDetailsOpen(true)}>
              {t("channel.details")}
            </Button>
          </header>
        )}
        {!chrome && isMember && (
          <ChannelWelcome channelId={channel.id} messages={messages.data} agents={channelAgents} />
        )}

        {!isMember ? (
          <div className="channel__empty">
            <EmptyState
              icon="channel"
              title={t("channel.notMemberTitle")}
              actions={
                <Button
                  variant="primary"
                  onClick={() => join.mutate()}
                  disabled={join.isPending}
                  loading={join.isPending}
                >
                  {t("channel.join", { channel: channel.name })}
                </Button>
              }
            >
              {t("channel.notMemberText")}
            </EmptyState>
          </div>
        ) : (
          <>
            {olderState === "loading" && (
              <div className="channel__older" role="status">
                <span className="channel__older-pill">
                  <Spinner size={14} />
                  {t("channel.loadingOlder")}
                </span>
              </div>
            )}
            <section
              ref={scroller}
              className="channel__messages"
              data-fresh={fresh || undefined}
              aria-label={t("channel.messages")}
              aria-live="polite"
              aria-relevant="additions"
              onWheel={markGesture}
              onTouchMove={markGesture}
              onPointerDown={markGesture}
              onKeyDown={markGesture}
              onScroll={(e) => {
                lastScrollTop.current = e.currentTarget.scrollTop;
                // Only the person scrolling unpins (or loads older pages); layout changes never do.
                const byPerson = Date.now() - lastGesture.current < GESTURE_MS;
                if (byPerson && e.currentTarget.scrollTop < 240) loadOlder();
                const near = nearBottom(e.currentTarget);
                if (!near && (!byPerson || Date.now() < autoScrollUntil.current)) return;
                stick.current = near;
                if (near) setUnseen(false);
              }}
            >
              {/* Pushes short channels down, next to the composer. */}
              <div className="channel__spacer" aria-hidden="true" />
              {messages.isLoading && <LoadingConversation />}
              {messages.isError && !messages.data && (
                <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
              )}
              {messages.isSuccess && timeline.length === 0 && streamSize === 0 && (
                <div className="channel__empty">
                  <EmptyState
                    icon="message"
                    title={chrome?.emptyTitle ?? t("chat.sayHiChannel", { channel: channel.name })}
                    actions={
                      emptySuggestions.length > 0 ? (
                        <fieldset className="channel__suggestions">
                          <legend className="ac-visually-hidden">{t("chat.suggestions")}</legend>
                          {emptySuggestions.map((s) => (
                            <Button
                              key={s}
                              size="sm"
                              onClick={() => {
                                setDraft(s);
                                composer.current?.focus();
                              }}
                            >
                              {s}
                            </Button>
                          ))}
                        </fieldset>
                      ) : undefined
                    }
                  >
                    {chrome?.emptyText ?? t("channel.empty")}
                  </EmptyState>
                </div>
              )}
              <Timeline items={timeline} ready={messages.isSuccess} anchors={anchors} />
              <LiveMemoryCards channelId={channel.id} />
              <LiveNotices channelId={channel.id} />
              {unanchored.map((runId) => (
                <LiveRunSlot key={runId} runId={runId} />
              ))}
            </section>
            {unseen && (
              <div className="channel__pill">
                <Button size="sm" className="ac-new-messages" onClick={() => toBottom(true)}>
                  {t("channel.newMessages")}
                  <Icon name="chevronDown" size={16} />
                </Button>
              </div>
            )}
            {status === "reconnecting" && (
              <p className="channel__status" role="status">
                {t("channel.reconnecting")}
              </p>
            )}
            {/* Esc in the box (nothing else open) drops the quote first. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc from the composer's controls bubbles here */}
            <div
              className="channel__composer"
              onKeyDown={(e) => {
                if (e.key !== "Escape" || !quote || e.defaultPrevented) return;
                e.preventDefault();
                setQuote(null);
              }}
            >
              <ActivityBar channelId={channel.id} />
              <Composer
                header={
                  quote ? (
                    <QuoteBar
                      name={dir.authorName(quote.author)}
                      excerpt={quoteExcerpt(quote.body)}
                      onCancel={() => {
                        setQuote(null);
                        composer.current?.focus();
                      }}
                    />
                  ) : undefined
                }
                attachments={
                  files.length > 0
                    ? files.map((f) => (
                        <ComposerFile
                          key={f.key}
                          name={f.name}
                          icon={f.icon}
                          status={f.status}
                          statusLabel={
                            f.status === "uploading"
                              ? t("channel.uploading")
                              : f.status === "failed"
                                ? t("channel.uploadFailed")
                                : undefined
                          }
                          removeLabel={t("channel.removeFile", { name: f.name })}
                          onRemove={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
                        />
                      ))
                    : undefined
                }
                onFiles={chrome?.locked ? undefined : addFiles}
                canSendEmpty={attached.length > 0}
                sendBlocked={uploading}
                format={formatLabels}
                emoji={emojiLabels}
                id={`composer-${channel.id}`}
                textareaRef={composer}
                value={draft}
                onChange={(v) => {
                  setDraft(v);
                  if (v.trim()) sendTyping();
                }}
                onSend={onSend}
                disabled={Boolean(chrome?.locked)}
                label={
                  chrome?.composerTarget
                    ? t("channel.composerDm", { name: chrome.composerTarget })
                    : t("channel.composerLabel", { channel: channel.name })
                }
                placeholder={
                  // DMs name the person or agent ("Mensagem para Theo"); channels keep "#nome".
                  chrome?.composerTarget
                    ? t("channel.composerDm", { name: chrome.composerTarget })
                    : t("channel.composerPlaceholder", { channel: channel.name })
                }
                sendLabel={t("channel.send")}
                sendText={t("channel.send")}
                attachLabel={t("channel.attach")}
                pills={composerPills}
                links={{
                  listLabel: t("wiki.editor.suggest"),
                  search: (q) =>
                    (wikiPages.data ?? [])
                      .filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase()))
                      .slice(0, 8)
                      .map((p) => ({
                        key: `wiki:${p.slug}`,
                        insert: p.title,
                        label: p.title,
                        description: p.folder || undefined,
                        leading: <Icon name="book" size={16} />,
                      })),
                }}
                commands={commandAgent ? { listLabel: t("composer.commands"), list: commands } : undefined}
                mentions={{
                  search: mentionSearch,
                  listLabel: t("mentions.list"),
                  onPick: (item) => {
                    if (item.note && item.key.startsWith("agent:")) setOffer(item.key.slice(6));
                  },
                }}
              />
              {offer && <AddToChannelOffer channelId={channel.id} agentId={offer} onDone={() => setOffer(null)} />}
              {(workingRun || chrome?.locked) && (
                <p className="ac-composer__hint">
                  {workingRun && !chrome?.locked ? (
                    <span className="composer-working">
                      {t("run.working", {
                        name: dir.agentById.get(workingRun.agentId)?.name ?? t("channel.unknownAgent"),
                      })}
                      {mayStop(workingRun) && (
                        <>
                          {" · "}
                          <StopButton run={workingRun} onStop={stopRun} place="composer" />
                        </>
                      )}
                    </span>
                  ) : (
                    chrome?.locked
                  )}
                </p>
              )}
            </div>
          </>
        )}

        {!chrome?.header && <ChannelDetails open={detailsOpen} onOpenChange={setDetailsOpen} channel={channel} />}
      </main>
    </ChannelActionsContext.Provider>
  );
}

/** Persisted rows. Memoized: streaming deltas don't re-render it. */
const Timeline = memo(function Timeline({
  items,
  ready,
  anchors,
}: {
  items: ReturnType<typeof buildTimeline>;
  /** The first page loaded: rows from then on slide in. */
  ready: boolean;
  /** Live runs to show right after a row (by item key). */
  anchors: Map<string, string[]>;
}) {
  const { t, i18n } = useTranslation();
  const models = useModels();
  const modelLabels = useMemo(
    () => new Map((models.data?.models ?? []).map((m) => [m.id, m.label] as const)),
    [models.data],
  );
  const [mountedAt] = useState(() => Date.now());
  // Keys of the first load (idempotent, so a double render in StrictMode agrees).
  const initialKeys = useRef<Set<string> | null>(null);
  if (ready && initialKeys.current === null) initialKeys.current = new Set(items.map((i) => i.key));
  const initial = initialKeys.current;
  let afterLive = false;
  return (
    <>
      {items.map((item) => {
        const live = anchors.get(item.key);
        const row =
          item.kind === "day" ? (
            <DayDivider key={item.key}>{dayLabel(t, i18n.language, item.iso)}</DayDivider>
          ) : item.kind === "message" ? (
            <TimelineMessage
              key={item.key}
              message={item.message}
              // Right after a live row, always a full header (never "grouped" under it).
              grouped={item.grouped && !afterLive}
              entering={initial !== null && entersWithMotion(item.key, item.message.createdAt, initial, mountedAt)}
              modelLabels={modelLabels}
            />
          ) : null;
        afterLive = Boolean(live?.length);
        return live?.length ? (
          <Fragment key={item.key}>
            {row}
            {live.map((runId) => (
              <LiveRunSlot key={runId} runId={runId} />
            ))}
          </Fragment>
        ) : (
          row
        );
      })}
    </>
  );
});

const CLOCK_SLACK_MS = 3000;

/**
 * Where each live run goes: after the message that started it (`triggerMessageId`;
 * without it, the last message of its conversation sent before it started), else at the end.
 */

export function liveAnchors(liveKey: string, items: ReturnType<typeof buildTimeline>) {
  const anchors = new Map<string, string[]>();
  const unanchored: string[] = [];
  if (!liveKey) return { anchors, unanchored };
  for (const line of liveKey.split("\n")) {
    const [runId, started, threadId, trigger] = JSON.parse(line) as [string, number, string, string | null];
    // The server says which message started it: right after that one.
    const exact = trigger ? items.find((i) => i.kind === "message" && i.message.id === trigger) : undefined;
    if (exact) {
      anchors.set(exact.key, [...(anchors.get(exact.key) ?? []), runId]);
      continue;
    }
    // Anchor: the last message of its conversation sent before the run started (a little slack
    // for clock skew); messages that came later stay below the row.
    const startedAt = Number(started) || Number.POSITIVE_INFINITY;
    let key: string | null = null;
    let fallback: string | null = null;
    for (const item of items) {
      if (item.kind !== "message") continue;
      if (item.message.id !== threadId && item.message.threadId !== threadId) continue;
      fallback = item.key;
      if (Date.parse(item.message.createdAt) <= startedAt + CLOCK_SLACK_MS) key = item.key;
    }
    key ??= fallback;
    if (key) anchors.set(key, [...(anchors.get(key) ?? []), runId]);
    else unanchored.push(runId);
  }
  return { anchors, unanchored };
}

/** One live run, subscribed by id (deltas re-render only this row). Never grouped. */
function LiveRunSlot({ runId }: { runId: string }) {
  const run = useStreams((s) => s.runs[runId]);
  if (!run || !isWriting(run)) return null;
  return <LiveRunRow run={run} grouped={false} />;
}

/**
 * "O Theo só responde a Walter.": only I see it (`agent.unavailable`, never
 * stored), right after my message that mentioned the agent.
 */
function LiveNotices({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const notices = useLive((s) => s.notices[channelId]);
  if (!notices?.length) return null;
  return (
    <>
      {notices.map((n) => {
        const agent = dir.agentById.get(n.agentId);
        const known = agent ? audienceNotice(t, agent, (id) => dir.memberById.get(id)?.name) : "";
        return (
          <p key={n.key} className="channel__notice" role="status">
            <Icon name="lock" size={16} />
            <span>{known || n.text}</span>
          </p>
        );
      })}
    </>
  );
}

/** `memory.updated` cards (live, they aren't in the message list). */
function LiveMemoryCards({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const cards = useLive((s) => s.memory[channelId]);
  return (
    <>
      {(cards ?? []).map((c) => {
        const name = dir.agentById.get(c.agentId)?.name ?? t("channel.unknownAgent");
        return (
          <Message
            key={c.key}
            agent
            stacked
            avatar={<AgentAvatar agentId={c.agentId} name={name} state="idle" />}
            author={name}
            time={t("common.now")}
          >
            <MemoryChangeCard update={c.update} agentId={c.agentId} />
          </Message>
        );
      })}
    </>
  );
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

const LiveRunRow = memo(function LiveRunRow({ run, grouped }: { run: LiveRun; grouped: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const dismissRun = useDismissRun();
  const actions = useChannelActions();
  const agent = dir.agentById.get(run.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const failed = run.status === "failed";
  const waiting = run.status === "waiting_approval";
  const canceled = run.status === "canceled";
  const { canStop, stop } = useStopRun();
  const qc = useQueryClient();
  const messageAuthor = (messageId: string) => {
    const m = qc.getQueryData<MessageType[]>(keys.messages(org.id, run.channelId))?.find((x) => x.id === messageId);
    return m ? dir.authorName(m.author) : undefined;
  };
  // Same clock face as the final message ("21:10"), from when the run started.
  const [startedAt] = useState(() => new Date(run.startedAt ?? Date.now()).toISOString());
  // A run with no news for minutes (orphaned by a restart?): say so and offer to check.
  const api = useApi();
  const liveStore = useLiveStore();
  const [, tick] = useState(0);
  useEffect(() => {
    const again = () => tick((n) => n + 1);
    const timer = setInterval(again, 15_000);
    // Back to the tab after a while: check right away.
    window.addEventListener("focus", again);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", again);
    };
  }, []);
  const quiet = !failed && !canceled && isQuiet(run);
  const [checking, setChecking] = useState(false);
  const recheck = () => {
    setChecking(true);
    void reconcileChannelRuns(api, liveStore, org.id, run.channelId, [run.runId])
      .then((dropped) => {
        if (dropped) void qc.invalidateQueries({ queryKey: keys.messages(org.id, run.channelId) });
      })
      .finally(() => setChecking(false));
  };
  const text = useRevealedText(run.text);
  const followBottom = actions?.followBottom;
  useLayoutEffect(() => {
    if (text) followBottom?.();
  }, [text, followBottom]);
  const doing = run.tool ? toolActivity(run.tool, run.connector) : null;
  return (
    <Message
      agent
      grouped={grouped}
      streaming={!failed && !waiting && !canceled}
      avatar={<AgentAvatar agentId={run.agentId} name={name} state={agentStateOfRun(run)} />}
      author={
        failed || canceled ? (
          name
        ) : (
          <span>
            {name} <span className="small muted">· {t("run.inProgress")}</span>
          </span>
        )
      }
      time={<time dateTime={startedAt}>{formatTime(i18n.language, startedAt)}</time>}
      status={waiting ? { icon: "waiting", label: t("channel.waitingApproval") } : undefined}
      data-live={run.status}
      data-run-id={run.runId}
    >
      {!failed && !waiting && !canceled && <span className="ac-visually-hidden">{t("channel.writing")}</span>}
      {failed ? (
        <p className="ac-msg__error" role="alert">
          <Icon name="alert" size={18} />
          <span style={{ flex: 1 }}>
            {run.error
              ? t("channel.runFailed", { agent: name, reason: run.error })
              : t("channel.runFailedNoReason", { agent: name })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="close"
            aria-label={t("common.close")}
            onClick={() => dismissRun(run.runId)}
          />
        </p>
      ) : (
        <>
          {/* What it said and did before this answer: narration and each tool call (code + output). */}
          <LiveWorkList work={run.work ?? []} messageAuthor={messageAuthor} />
          {text && (
            <MessageText>
              <MessageBody body={text} resolveMention={dir.mentionName} />
            </MessageText>
          )}
          {canceled ? (
            <p className="ac-msg__activity run-canceled">
              {run.canceledBy && dir.memberById.get(run.canceledBy)
                ? t("run.canceledBy", { name: dir.memberById.get(run.canceledBy)?.name })
                : t("run.canceled")}
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                aria-label={t("common.close")}
                onClick={() => dismissRun(run.runId)}
              />
            </p>
          ) : (
            <div className="run-status">
              {quiet && (
                <p className="ac-msg__activity run-quiet">
                  {t("run.quiet", {
                    minutes: Math.max(3, Math.floor((Date.now() - (run.lastEventAt ?? run.startedAt ?? 0)) / 60_000)),
                  })}
                  {" · "}
                  <Button variant="ghost" size="sm" loading={checking} onClick={recheck}>
                    {t("run.refresh")}
                  </Button>
                </p>
              )}
              {!quiet &&
                doing &&
                doing.kind !== "thinking" &&
                !(run.work ?? []).some((w) => w.kind === "call" && w.running) && (
                  <p className="ac-msg__activity" aria-live="polite">
                    {capitalize(activityVerb(t, doing))}…
                  </p>
                )}
              {isStoppable(run) && canStop(run) && <StopButton run={run} onStop={stop} place="row" />}
            </div>
          )}
        </>
      )}
    </Message>
  );
});

/** A live row with a message after it in the timeline (checked as the DOM changes). */
function hasNewerMessage(runId: string) {
  let el = document.querySelector(`[data-run-id="${runId}"]`)?.nextElementSibling;
  while (el) {
    if (el.matches(".ac-msg") || el.querySelector(".ac-msg")) return true;
    el = el.nextElementSibling;
  }
  return false;
}

/** Ids of the writing runs whose live row has newer messages below it. */
function useRowsBehind(runs: LiveRun[]) {
  const ids = runs
    .filter((r) => isWriting(r) && r.status !== "failed" && r.status !== "canceled")
    .map((r) => r.runId)
    .join(" ");
  const [behind, setBehind] = useState<string[]>([]);
  useEffect(() => {
    if (!ids) {
      setBehind([]);
      return;
    }
    const check = () => {
      const next = ids.split(" ").filter(hasNewerMessage);
      setBehind((prev) => (prev.join(" ") === next.join(" ") ? prev : next));
    };
    check();
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        check();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ids]);
  return behind;
}

/**
 * The typing bar right above the composer: small avatars + what each one is
 * doing ("Theo está consultando o GitHub · Marina está digitando…") + three
 * dots (still with reduced motion). Agents leave it when their first words
 * arrive in the timeline.
 */
function ActivityBar({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [now, setNow] = useState(() => Date.now());
  const runs = useStreams((s) => runsInChannel(s, channelId), sameRuns);
  const typing = useLive((s) => s.typing[channelId]);
  const ids = typingIn({ [channelId]: typing ?? {} }, channelId, now, me.user.id);
  useEffect(() => {
    if (!typing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [typing]);
  const entries = barEntries(
    runs,
    ids,
    (id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent"),
    (id) => dir.memberById.get(id)?.name,
  );
  const text = activityText(t, entries);
  const active = entries.length > 0;
  // The strip behind the bar takes the color of the first agent at work.
  const skyAgent = entries.find((e) => e.type === "agent");
  const { canStop, stop } = useStopRun();
  // "Parar" in the bar for the runs not writing yet that I may stop.
  const barStoppable = runs.filter((r) => !isWriting(r) && isStoppable(r) && canStop(r));
  // A live row with newer messages below it: "Theo ainda trabalhando" jumps back to it.
  const behindIds = useRowsBehind(runs);
  const behind = runs.filter((r) => behindIds.includes(r.runId));
  // Agents running code (not writing yet): "Ver código" with the live code and output.
  const coding = runs.filter((r) => !isWriting(r) && r.code);
  // What they said last between tool calls ("Theo: Go não está instalado; vou tentar…").
  const said = runs
    .filter((r) => !isWriting(r))
    .flatMap((r) => {
      const last = narrationOf(r).at(-1);
      return last
        ? [{ id: r.runId, name: dir.agentById.get(r.agentId)?.name ?? t("channel.unknownAgent"), text: last }]
        : [];
    });
  return (
    <>
      {coding.map((r) =>
        r.code ? (
          <LiveCodeToggle
            key={r.runId}
            name={dir.agentById.get(r.agentId)?.name ?? t("channel.unknownAgent")}
            code={r.code}
            output={r.output ?? []}
          />
        ) : null,
      )}
      {behind.map((r) => (
        <button
          key={`behind-${r.runId}`}
          type="button"
          className="still-working"
          onClick={() =>
            document
              .querySelector(`[data-run-id="${r.runId}"]`)
              ?.scrollIntoView?.({ block: "center", behavior: "smooth" })
          }
        >
          <Icon name="waiting" size={14} />
          {t("run.stillWorking", { name: dir.agentById.get(r.agentId)?.name ?? t("channel.unknownAgent") })}
        </button>
      ))}
      {said.map((n) => (
        <p key={n.id} className="ac-typing__said">
          <strong>{n.name}:</strong> {n.text}
        </p>
      ))}
      <div className="ac-typing" aria-live="polite" data-active={active}>
        {active && (
          <>
            {skyAgent && <ActivitySky color={colorOf(dir.agentById.get(skyAgent.id))} />}
            <span className="ac-typing__avatars" aria-hidden="true">
              {entries.map((e) =>
                e.type === "agent" ? (
                  <AgentAvatar key={`a:${e.id}`} agentId={e.id} size="xs" name={e.name} state="thinking" />
                ) : (
                  <Avatar key={`p:${e.id}`} size="xs" name={e.name} imageUrl={dir.memberById.get(e.id)?.image} />
                ),
              )}
            </span>
            {/* Keyed by the words: a new activity fades in. */}
            <span key={text} className="ac-typing__text">
              {text}
            </span>
            <span className="ac-typing__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {barStoppable.length > 0 && <span className="ac-typing__sep" aria-hidden="true" />}
            {barStoppable.map((r) => (
              <StopButton key={r.runId} run={r} onStop={stop} place="bar" />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** One persisted row; agent replies get feedback actions, people's messages get receipts. */
const TimelineMessage = memo(function TimelineMessage({
  message: m,
  grouped,
  entering,
  modelLabels,
}: {
  message: MessageType;
  grouped: boolean;
  entering: boolean;
  modelLabels: Map<string, string>;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  // The streamed row it replaces was already on screen: take its place without sliding in again.
  const replacesLive = useStreams((s) => Boolean(m.agentRunId && s.finished[m.agentRunId]));
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const [active, setActive] = useState(false);
  const agent = m.author.type === "agent" ? dir.agentById.get(m.author.id ?? "") : undefined;
  const person = m.author.type === "person" ? dir.memberById.get(m.author.id ?? "") : undefined;
  const name = dir.authorName(m.author);
  // Posted by a routine on its creator's behalf: shown as the routine, never as if the person typed it.
  const routine = routineOfMessage(m.meta);
  // Its text is the instructions it gives the agent: one line ("Chamou @Theo"), the instructions on demand.
  const [routineOpen, setRoutineOpen] = useState(false);
  const routineAgents = useMemo(() => {
    if (!routine) return [];
    const handles = new Set([...m.body.matchAll(/@([\w.-]+)/g)].map((x) => (x[1] ?? "").toLowerCase()));
    return [...handles].flatMap((h) => {
      const a = dir.agentByHandle.get(h);
      return a ? [a] : [];
    });
  }, [routine, m.body, dir.agentByHandle]);
  const wikiLink = useWikiLinkRenderer();
  // `agent.run.steered`: this message went into a running task.
  const steeredAgent = useLive((s) => s.steered[m.id]);
  // A stopped run's message (`meta.canceled`): the text so far, and "Interrompido por Walter" as a note.
  const stopped = useMemo(() => splitCanceled(m.body, m.meta), [m.body, m.meta]);
  const body = stopped.body;
  const stopper = stopped.byUserId ? dir.memberById.get(stopped.byUserId)?.name : undefined;
  const canceledNote = !stopped.canceled
    ? null
    : stopper
      ? t("run.canceledBy", { name: stopper })
      : stopped.byUserId || !stopped.note
        ? t("run.canceled")
        : // Older messages without a person in the meta: the server's line.
          stopped.note;
  const channelName = useChannels(org.id).data?.find((c) => c.id === m.channelId)?.name;
  // A plain reminder: the agent's own message, with a small "Lembrete".
  const reminder = isReminderMessage(m.meta);
  const renderMention = (handle: string, key: string) => {
    const a = dir.agentByHandle.get(handle.toLowerCase());
    const p = a ? undefined : dir.memberByHandle.get(handle.toLowerCase());
    if (!a && !p) return <Mention key={key}>@{handle}</Mention>;
    const actor = a ? { type: "agent" as const, id: a.id } : { type: "person" as const, id: p?.userId ?? "" };
    const shown = a?.name ?? p?.name ?? handle;
    return (
      <ProfileTrigger
        key={key}
        actor={actor}
        label={t("profile.of", { name: shown })}
        className="profile-trigger--mention"
      >
        <Mention>@{shown}</Mention>
      </ProfileTrigger>
    );
  };
  const meta = m.meta ?? {};
  const approvalId = typeof meta.approvalId === "string" ? meta.approvalId : null;
  const proposalId = typeof meta.proposalId === "string" ? meta.proposalId : null;
  const memoryUpdates = Array.isArray(meta.memoryUpdates)
    ? (meta.memoryUpdates as MemoryUpdate[]).filter(isMemoryUpdate)
    : [];
  const question = isQuestion(meta.question) ? meta.question : null;
  const secretRequest = isSecretRequest(meta.secretRequest) ? meta.secretRequest : null;
  // Files an agent made, or a person attached.
  const artifacts = artifactRefs(meta);
  // "Responder": the message this one quotes.
  const quoted = useMemo(() => replyOf(m.meta), [m.meta]);
  // An agent opened a forum topic from here: the topic card with "Ver discussão".
  const forumTopicId = m.author.type === "agent" ? forumTopicOfMessage(meta) : null;
  const card = approvalId || proposalId || memoryUpdates.length > 0 || question || secretRequest;
  const feedback = m.author.type === "agent" && !card && !m.local;
  // People see name, time and text; the date, model and tokens wait behind the time.
  const usage = m.author.type === "agent" ? messageUsage(m) : null;
  const details = [
    formatFullDate(i18n.language, m.createdAt),
    usage ? usageLine(t, i18n.language, usage, { modelLabel: modelLabels.get(usage.model) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Message
      agent={m.author.type === "agent"}
      data-message-id={m.id}
      grouped={grouped}
      entering={entering && !replacesLive}
      className={m.local ? `ac-msg--local ac-msg--${m.local}` : undefined}
      onMouseEnter={feedback ? () => setActive(true) : undefined}
      onFocus={feedback ? () => setActive(true) : undefined}
      avatar={
        routine ? (
          <span
            className="ac-avatar ac-avatar--routine"
            role="img"
            aria-label={t("channel.routineAuthor", { name: routine.name })}
          >
            <Icon name="routines" size={18} />
          </span>
        ) : m.author.id ? (
          <ProfileTrigger actor={{ type: m.author.type, id: m.author.id }} label={t("profile.of", { name })} decorative>
            {agent ? (
              // A saved message: the agent at rest (its live state shows on the live row).
              <AgentAvatar agentId={agent.id} name={name} state="idle" />
            ) : (
              <Avatar kind="person" name={name} imageUrl={person?.image} />
            )}
          </ProfileTrigger>
        ) : m.author.type === "agent" ? (
          <AgentAvatar name={name} />
        ) : (
          <Avatar kind="person" name={name} imageUrl={person?.image} />
        )
      }
      author={
        routine ? (
          <span>
            {t("channel.routineAuthor", { name: routine.name })}{" "}
            <span className="muted small">{t("channel.routineBy", { name })}</span>
          </span>
        ) : m.author.id ? (
          <>
            <ProfileTrigger
              actor={{ type: m.author.type, id: m.author.id }}
              label={t("profile.of", { name })}
              className="profile-trigger--name"
            >
              {name}
            </ProfileTrigger>
            {reminder && (
              <span className="msg-reminder">
                <Icon name="bell" size={14} />
                {t("channel.reminder")}
              </span>
            )}
          </>
        ) : (
          name
        )
      }
      time={<time dateTime={m.createdAt}>{formatTime(i18n.language, m.createdAt)}</time>}
      meta={m.local ? undefined : details}
      status={m.local === "pending" ? { icon: "waiting", label: t("channel.sending") } : undefined}
      aside={m.author.type === "person" && !m.local ? <MessageReceipts message={m} /> : undefined}
      stacked={Boolean(card)}
    >
      {routine && (
        <p className="msg-routine small">
          <span className="muted">
            {routineAgents.length
              ? t("channel.routineCalled", { names: routineAgents.map((a) => `@${a.name}`).join(", ") })
              : t("channel.routineRan")}
          </span>
          <button
            type="button"
            className="ac-link"
            aria-expanded={routineOpen}
            onClick={() => setRoutineOpen((o) => !o)}
            style={inlineButton}
          >
            {routineOpen ? t("channel.routineHide") : t("channel.routineShow")}
          </button>
        </p>
      )}
      {quoted && <QuotedMessage reply={quoted} />}
      {(!routine || routineOpen) && (body.trim() || (!card && !canceledNote && artifacts.length === 0)) && (
        <MessageText>
          <MessageBody body={body} resolveMention={dir.mentionName} renderMention={renderMention} wikiLink={wikiLink} />
        </MessageText>
      )}
      {canceledNote && <p className="ac-msg__activity run-canceled">{canceledNote}</p>}
      {m.local === "failed" && (
        <p className="ac-msg__error" role="alert">
          <Icon name="alert" size={18} />
          <span>{t("channel.notSent")} ·</span>
          <button type="button" className="ac-link" onClick={() => actions?.retry(m)} style={inlineButton}>
            {t("channel.retrySend")}
          </button>
        </p>
      )}
      {approvalId && <MessageApproval approvalId={approvalId} agent={agent} members={dir.memberById} />}
      {proposalId && <InlineProposal proposalId={proposalId} />}
      {agent &&
        memoryUpdates.map((u) => <MemoryChangeCard key={`${u.action}-${u.itemId}`} update={u} agentId={agent.id} />)}
      {question && <QuestionCard question={question} />}
      {secretRequest && <SecretCard request={secretRequest} />}
      {m.author.type === "agent" && m.agentRunId && !card && !m.local && (
        <MessageWork runId={m.agentRunId} meta={m.meta} agentName={agent?.name ?? name} />
      )}
      {forumTopicId && <ForumMessageCard topicId={forumTopicId} />}
      {artifacts.length > 0 && (
        <div className="artifact-cards">
          {artifacts.map((r) => (
            <ArtifactCard key={`${r.id}@${r.version}`} artifact={r} />
          ))}
        </div>
      )}
      {/* Everyone's reactions (👍/👎 on an agent's reply are its feedback, in the same pills). */}
      {!m.local && <MessageReactions messageId={m.id} initial={m.reactions} feedback={feedback} />}
      {feedback && (
        <MessageFeedback
          messageId={m.id}
          agentName={agent?.name ?? t("channel.unknownAgent")}
          active={active}
          initial={m.reactions}
          quick={<QuoteReplyButton message={m} />}
          more={<MessageMoreMenu message={m} channelName={channelName ?? ""} />}
        />
      )}
      {steeredAgent && (
        <p className="msg-steered small muted">
          {t("run.steered", { name: dir.agentById.get(steeredAgent)?.name ?? t("channel.unknownAgent") })}
        </p>
      )}
      {m.author.type === "person" && !m.local && (
        <PersonMessageActions message={m} authorName={name} channelName={channelName ?? ""} />
      )}
    </Message>
  );
});

function isSecretRequest(v: unknown): v is SecretRequest {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.name === "string" && typeof o.requestedForUserId === "string";
}

function isQuestion(v: unknown): v is AgentQuestion {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.text === "string" && typeof o.agentId === "string";
}

function isMemoryUpdate(v: unknown): v is MemoryUpdate {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.action === "string" && typeof o.itemId === "string" && typeof o.text === "string";
}

const inlineButton = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  color: "inherit",
};

/** The card of a message with `meta.approvalId`: from the approvals list, or fetched by id. */
function MessageApproval({
  approvalId,
  agent,
  members,
}: {
  approvalId: string;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const listed: Approval | undefined = approvals.data?.find((a) => a.id === approvalId);
  const one = useApproval(org.id, approvalId, !listed && approvals.isSuccess);
  const approval = listed ?? one.data;
  if (!approval) return null;
  return <InlineApproval approval={approval} agent={agent} members={members} />;
}

/** "Detalhes do canal": topic, and members (people and agents) with "Responde sem menção" per agent. */
function ChannelDetails({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const roster = useRoster(org.id, channel.id, open && channel.isMember);
  const update = useUpdateChannel(org.id, channel.id);
  // The channel's creator may too, but the API doesn't say who created it yet: admins only.
  const editable = can(org.role, "configure");
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState(channel.topic);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (open) setTopic(channel.topic);
  }, [open, channel.topic]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.roster(org.id, channel.id) });
    void qc.invalidateQueries({ queryKey: keys.channelMembers(org.id, channel.id) });
  };
  const remove = useMutation({
    mutationFn: (member: { userId: string } | { agentId: string }) => api.chat.removeMember(org.id, channel.id, member),
    onSuccess: refresh,
  });
  const autoReply = useMutation({
    mutationFn: async ({ agentId, on }: { agentId: string; on: boolean }) => {
      // PUT replaces the agent's channel list: keep the others as they are.
      const current = await api.agents.channels(org.id, agentId);
      const next = current.some((c) => c.id === channel.id)
        ? current.map((c) => ({ channelId: c.id, autoReply: c.id === channel.id ? on : c.autoReply }))
        : [
            ...current.map((c) => ({ channelId: c.id, autoReply: c.autoReply })),
            { channelId: channel.id, autoReply: on },
          ];
      return api.agents.setChannels(org.id, agentId, next);
    },
    onSuccess: refresh,
  });
  const needle = q.trim().toLowerCase();
  const rows = (roster.data ?? [])
    .map((m) => ({
      key: `${m.type}-${m.id}`,
      kind: m.type,
      id: m.id,
      name: m.name,
      sub: m.type === "agent" ? `@${m.handle ?? ""}` : (dir.memberById.get(m.id)?.email ?? ""),
      image: m.type === "person" ? (dir.memberById.get(m.id)?.image ?? null) : null,
      initials: m.type === "agent" ? dir.agentInitials(m.id) : undefined,
      autoReply: m.autoReply,
    }))
    .filter((r) => !needle || `${r.name} ${r.sub}`.toLowerCase().includes(needle));
  const inChannel = new Set((roster.data ?? []).map((m) => `${m.type}:${m.id}` as PickKey));
  return (
    <>
      <Dialog
        open={open && !adding}
        onOpenChange={onOpenChange}
        title={t("channel.detailsTitle", { channel: channel.name })}
        description={editable ? undefined : channel.topic || t("channel.noTopic")}
        closeLabel={t("common.close")}
      >
        {editable && (
          <form
            className="ac-dialog__tools row row--end"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ topic: topic.trim() });
            }}
          >
            <Field label={t("channel.topic")} id={`topic-${channel.id}`} style={{ flex: "1 1 260px" }}>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("channel.topicPlaceholder")}
              />
            </Field>
            <Button type="submit" disabled={update.isPending || topic.trim() === channel.topic}>
              {t("channel.saveTopic")}
            </Button>
          </form>
        )}
        <div className="ac-dialog__tools row" style={{ justifyContent: "space-between" }}>
          <span className="ac-eyebrow">{t("channelMembers.title")}</span>
          {editable && (
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              {t("channelMembers.add")}
            </Button>
          )}
        </div>
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          searchLabel={t("channel.detailsSearch")}
          searchPlaceholder={t("channel.detailsSearch")}
          isEmpty={roster.isSuccess && rows.length === 0}
          emptyText={t("channel.detailsEmpty", { q })}
        >
          {rows.map((r) => (
            <div key={r.key} className="member-row">
              <ActorAvatar actor={{ type: r.kind, id: r.id }} size="sm" name={r.name} />
              <span className="list-col">
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <span className="small muted">{r.sub}</span>
              </span>
              {r.kind === "agent" && (
                <label htmlFor={`auto-${r.id}`} className="member-row__switch small">
                  <Switch
                    id={`auto-${r.id}`}
                    aria-label={t("channelMembers.autoReplyFor", { name: r.name })}
                    checked={Boolean(r.autoReply)}
                    disabled={!editable || autoReply.isPending}
                    onCheckedChange={(on) => autoReply.mutate({ agentId: r.id, on })}
                  />
                  {t("channelMembers.autoReply")}
                </label>
              )}
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="close"
                  aria-label={t("channelMembers.remove", { name: r.name })}
                  disabled={remove.isPending}
                  loading={remove.isPending}
                  onClick={() => remove.mutate(r.kind === "agent" ? { agentId: r.id } : { userId: r.id })}
                />
              )}
            </div>
          ))}
        </DialogSearchList>
        <DialogFooter note={editable ? undefined : t("channelMembers.readOnly")} />
      </Dialog>
      <AddMembersDialog
        open={open && adding}
        onClose={() => setAdding(false)}
        channel={channel}
        exclude={inChannel}
        onAdded={refresh}
      />
    </>
  );
}

/** Adds people and agents to a channel (searchable, our checkboxes). */
function AddMembersDialog({
  open,
  onClose,
  channel,
  exclude,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  channel: Channel;
  exclude: Set<PickKey>;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<PickKey>>(new Set());
  useEffect(() => {
    if (open) {
      setQ("");
      setSelected(new Set());
    }
  }, [open]);
  const rows = useMemberRows(q, exclude);
  const add = useMutation({
    mutationFn: async () => {
      for (const key of selected) await api.chat.addMember(org.id, channel.id, memberOf(key));
    },
    onSuccess: () => {
      onAdded();
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("channelMembers.addTitle", { channel: channel.name })}
      closeLabel={t("common.close")}
    >
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("channelMembers.addSearch")}
        searchPlaceholder={t("channelMembers.addSearch")}
        isEmpty={rows.length === 0}
        emptyText={t("channelMembers.addEmpty", { q })}
      >
        <MemberPickerRows
          rows={rows}
          selected={selected}
          onToggle={(key, on) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (on) next.add(key);
              else next.delete(key);
              return next;
            })
          }
        />
      </DialogSearchList>
      <DialogFooter bar>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={selected.size === 0 || add.isPending}
          loading={add.isPending}
          onClick={() => add.mutate()}
        >
          {t("channelMembers.addConfirm", { count: selected.size })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Link to an agent profile (DM header). */
export function AgentProfileLink({ agentId, label }: { agentId: string; label: string }) {
  const { org } = useOrg();
  return (
    <Button asChild size="sm">
      <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId }}>
        {label}
      </Link>
    </Button>
  );
}

/** After "@" picks an agent that isn't in the channel: add it, or say who can. */
function AddToChannelOffer({ channelId, agentId, onDone }: { channelId: string; agentId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const add = useAddChannelMember(org.id);
  const toast = useToast();
  const name = dir.agentById.get(agentId)?.name ?? t("channel.unknownAgent");
  const admin = can(org.role, "configure");
  return (
    <div className="mention-offer" role="status">
      <span className="small">{t("mentions.offer", { name })}</span>
      {admin ? (
        <Button
          size="sm"
          disabled={add.isPending}
          loading={add.isPending}
          onClick={() =>
            add.mutate(
              { channelId, member: { agentId } },
              {
                onSuccess: () => {
                  toast.show(t("mentions.added", { name }));
                  onDone();
                },
              },
            )
          }
        >
          {t("mentions.add")}
        </Button>
      ) : (
        <span className="small muted">{t("mentions.askAdmin")}</span>
      )}
      <Button size="sm" variant="ghost" onClick={onDone}>
        {t("mentions.dismiss")}
      </Button>
    </div>
  );
}
