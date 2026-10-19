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
  ThreadInfo,
} from "@agenteschat/client";
import {
  agentStateOfRun,
  browserHandoffOf,
  consultsIn,
  isQuiet,
  keys,
  type LiveRun,
  MESSAGES_PAGE,
  narrationOf,
  runsInChannel,
  type StreamsState,
  sendHelpers,
  typingIn,
  useAddChannelMember,
  useApproval,
  useApprovals,
  useChannelMembers,
  useChannels,
  useChannelThreads,
  useCreateMission,
  useCreateThread,
  useJoinChannel,
  useMessages,
  useMissionControl,
  useModels,
  usePostMessage,
  useRoster,
  usesBrowser,
  useThreadInfo,
  useThreadMessages,
  useThreadMission,
  useThreads,
  useUpdateChannel,
  useWikiTree,
} from "@agenteschat/client";
import { activityText, activityVerb, barEntries, isWriting, toolActivity } from "@agenteschat/client/lib/activity";
import { artifactRefs } from "@agenteschat/client/lib/artifacts";
import { audienceNotice, canTalk } from "@agenteschat/client/lib/audience";
import {
  entersWithMotion,
  greetingSuggestions,
  messageUsage,
  nearBottom,
  usageLine,
} from "@agenteschat/client/lib/chat";
import { consultationsOf } from "@agenteschat/client/lib/consultations";
import { clearDraft, peekDraft } from "@agenteschat/client/lib/drafts";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { fileIcon, fitsUpload, formatBytes, MAX_UPLOAD_MB, previewKind } from "@agenteschat/client/lib/files";
import { dayLabel, formatFullDate, formatTime, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { issueTakenOf, issueWorkOf } from "@agenteschat/client/lib/issues";
import { serverBody } from "@agenteschat/client/lib/message-body";
import {
  isOpenMission,
  missionCommandOf,
  missionLinkOf,
  missionPlanChangeOf,
  missionPlanOf,
  missionReportOf,
  missionSuggestionOf,
  parseMissionCommand,
  taskNoticeOf,
} from "@agenteschat/client/lib/missions";
import { brainUnavailableOf, isOfflineNotice } from "@agenteschat/client/lib/outages";
import { can } from "@agenteschat/client/lib/permissions";
import { localMeta, quoteExcerpt, replyOf } from "@agenteschat/client/lib/reply";
import { isReminderMessage, reminderBody, routineOfMessage, viaRoutineOf } from "@agenteschat/client/lib/routines";
import {
  contextMarks,
  hiddenByThreads,
  rangeCandidates,
  suggestRange,
  threadStartOf,
} from "@agenteschat/client/lib/threads";
import { buildTimeline, mergeTimeline, type TimelineItem, threadRootsToLoad } from "@agenteschat/client/lib/timeline";
import { splitCanceled } from "@agenteschat/client/lib/work";
import {
  Avatar,
  Button,
  Composer,
  type ComposerCommand,
  ComposerFile,
  type ComposerFormatLabels,
  cx,
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
import { tokenizeBody } from "@/chat/body";
import { MessageBody } from "@/chat/MessageBody";
import { readingLanding } from "@/chat/reading";
import { AgentActionReceipts } from "@/components/AgentActions";
import { ActorAvatar, AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { InlineApproval } from "@/components/ApprovalItem";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { objectUrls } from "@/components/artifacts/FileView";
import { BrowserHandoffCard } from "@/components/browser/BrowserHandoffCard";
import { BrowserWatchCard } from "@/components/browser/BrowserWatchCard";
import { ChannelMembersStack } from "@/components/ChannelMembers";
import { InlineProposal, MemoryChangeCard, QuestionCard, SecretCard } from "@/components/ChatCards";
import { ConsultationCard } from "@/components/ConsultationCard";
import { CorrectionAsk } from "@/components/CorrectionAsk";
import { type ChannelActions, ChannelActionsContext, useChannelActions } from "@/components/channel-actions";
import { ForumMessageCard, ForumSuggestionCard, forumSuggestionOf, forumTopicOfMessage } from "@/components/Forum";
import { IssueTakenLine, IssueWorkCard } from "@/components/IssueWork";
import { LiveCodeToggle, LiveWorkList } from "@/components/LiveCode";
import { ErrorState, LoadingConversation } from "@/components/Loading";
import { WaitingCard } from "@/components/MachineOutages";
import { MemberPickerRows, memberOf, type PickKey, useMemberRows } from "@/components/MemberPicker";
import { MemoryMarks } from "@/components/MemoryMark";
import { MessageFeedback } from "@/components/MessageFeedback";
import { MessageMoreMenu, PersonMessageActions, QuoteReplyButton } from "@/components/MessageMore";
import { MessageReceipts } from "@/components/MessageReceipts";
import { MessageWork } from "@/components/MessageWork";
import { MissionPanelProvider } from "@/components/missions/MissionBits";
import {
  AutoApprovedLine,
  groupAutoApproved,
  MissionDecisionCard,
  MissionDeliveryCard,
  MissionEphemeral,
  MissionLinkCard,
  MissionPlanCard,
  MissionPlanChangeLine,
  MissionReportExtras,
  MissionReviewCard,
  MissionStartLink,
  MissionSuggestionBar,
  TaskNoticeLine,
} from "@/components/missions/MissionCards";
import { MissionCommandCard } from "@/components/missions/MissionCommandCard";
import { NewMissionDialog } from "@/components/missions/MissionDialogs";
import { NavToggle } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { ProfileTrigger } from "@/components/ProfileCard";
import { MessageReactions, useEmojiLabels } from "@/components/Reactions";
import { ActivitySky, ChannelWelcome, colorOf } from "@/components/Sky";
import { askToStop, isStoppable, StopButton, useStopRun } from "@/components/StopRun";
import { RangeBar, RangeRows, useRangeAdjust } from "@/components/threads/RangeSelect";
import { useThreadFlows } from "@/components/threads/ThreadBits";
import {
  ArchivedThreadsNote,
  ChannelThreadsButton,
  ChannelThreadsContext,
  type ChannelThreadsView,
  ClosedThreadLine,
  ThreadStartLine,
  useChannelThreadsView,
} from "@/components/threads/ThreadLines";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { ConsultClock, WorkingStack, WorkingWords } from "@/components/WorkingLine";
import { useDirectory } from "@/hooks/useDirectory";
import { useMentionSearch } from "@/hooks/useMentionSearch";
import { usePrefersReducedMotion, useRevealedText } from "@/hooks/useRevealedText";
import { reportPainted } from "@/lib/perf";
import { useToast } from "@/lib/toast";
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
  /** Above the messages (a thread's origin and context block). */
  top?: ReactNode;
  /** The composer's label and placeholder ("Responder na thread"). */
  composerLabel?: string;
  /** In place of the composer (an archived thread's read-only note). */
  composerReplacement?: ReactNode;
  /** Under the composer (a mission someone only reads: "para pedir algo, peça para participar"). */
  composerNote?: ReactNode;
}

const sameRuns = (a: LiveRun[], b: LiveRun[]) => a.length === b.length && a.every((r, i) => r === b[i]);
const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((r, i) => r === b[i]);

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
  size: number;
  /** An image's local thumbnail (an object URL, revoked when the file leaves the composer). */
  preview?: string;
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
  adjustThreadId,
  thread,
}: {
  channelId: string;
  chrome?: ChannelChrome;
  /** "Ajustar trecho": the selection of this thread's range, in place of the timeline. */
  adjustThreadId?: string;
  /** Thread view: this thread's conversation (root and replies), with replies going to it. */
  thread?: ThreadInfo;
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
  return (
    // "Arquivos", "Ver plano", "Ver no arquivo": any mission card here opens the same files panel.
    <MissionPanelProvider>
      <ChannelView
        key={`${channel.id}:${thread?.id ?? ""}:${adjustThreadId ?? ""}`}
        channel={channel}
        chrome={chrome}
        focusMessageId={focusMessageId}
        adjustThreadId={adjustThreadId}
        thread={thread}
      />
    </MissionPanelProvider>
  );
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
  adjustThreadId,
  thread,
}: {
  channel: Channel;
  chrome?: ChannelChrome;
  focusMessageId?: string;
  adjustThreadId?: string;
  thread?: ThreadInfo;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const isMember = channel.isMember;
  const members = useChannelMembers(org.id, channel.id, isMember);
  const channelMessages = useMessages(org.id, channel.id, isMember);
  // Thread view: the thread's root and replies (the channel's page still holds my unsent replies).
  const threadMessages = useThreadMessages(org.id, thread && isMember ? channel.id : undefined, thread?.id ?? "");
  const messages = thread ? threadMessages : channelMessages;
  const roots = useMemo(() => threadRootsToLoad(channelMessages.data ?? []), [channelMessages.data]);
  const threads = useThreads(org.id, channel.id, isMember && !thread ? roots : []);
  // The channel's threads: closed lines, context marks, markers (not in a thread view or while adjusting).
  const listsThreads = isMember && !thread;
  const openThreads = useChannelThreads(org.id, channel.id, "all", listsThreads);
  const archivedThreads = useChannelThreads(org.id, channel.id, "archived", listsThreads);
  const threadList = useMemo(
    () => [...(openThreads.data?.threads ?? []), ...(archivedThreads.data?.threads ?? [])],
    [openThreads.data, archivedThreads.data],
  );
  // Live runs shown here: a thread view shows its own; the channel hides those of threads it draws as
  // one line (closed) or a marker (made from a range): their replies don't land in the channel.
  const hiddenRunThreads = useMemo(
    () =>
      new Set([
        ...threadList.filter((x) => x.state !== "open").map((x) => x.id),
        ...(channelMessages.data ?? []).filter((m) => threadStartOf(m.meta) || m.meta?.missionStart).map((m) => m.id),
      ]),
    [threadList, channelMessages.data],
  );
  const runVisible = useRef<(r: { threadId: string }) => boolean>(() => true);
  runVisible.current = thread ? (r) => r.threadId === thread.id : (r) => !hiddenRunThreads.has(r.threadId);
  const scopedRuns = (s: StreamsState) => runsInChannel(s, channel.id).filter((r) => runVisible.current(r));
  const live = useLiveStore();
  const status = useConnectionStatus();
  const join = useJoinChannel(org.id, channel.id);
  const sendTyping = useTypingSender(channel.id);
  // ⌘K "Pedir a um agente" leaves the text for this DM's composer.
  const draftKey = chrome?.dmAgentId ? `agent:${chrome.dmAgentId}` : null;
  const [draft, setDraft] = useState(() => (draftKey ? (peekDraft(draftKey) ?? "") : ""));
  // Esc (composer empty, nothing open): asks to stop the most recent run here that I may stop
  // (the confirmation; Esc twice within 1.5 s stops directly).
  const { canStop: mayStop } = useStopRun();
  const draftRef = useRef("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || draftRef.current.trim()) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      const target = scopedRuns(live.get().streams)
        .filter((r) => isStoppable(r) && !r.stopping && mayStop(r))
        .at(-1);
      if (!target) return;
      e.preventDefault();
      askToStop(target.runId, isWriting(target) ? "row" : "bar", true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // "Responder em thread": the next message goes to that thread.
  const [replyTo, setReplyTo] = useState<MessageType | null>(null);
  // "Responder": the next message quotes this one (`meta.replyTo`), in the same conversation.
  const [quote, setQuote] = useState<MessageType | null>(null);
  // "Mudar algo" on a mission's plan: the next message goes to its executor ("Respondendo: Plano").
  const [missionReply, setMissionReply] = useState<{ missionId: string; label: string } | null>(null);
  // `/summary` and `/plan`: a card only I see, under the conversation.
  const [ephemeral, setEphemeral] = useState<{ kind: "summary" | "plan"; missionId: string } | null>(null);
  // `/mission` with several agents and none named: "Nova missão" with the goal filled in.
  const [missionDraft, setMissionDraft] = useState<string | null>(null);
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

  const toast = useToast();
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
    // A thread archived meanwhile (`thread.archived`): say so in the person's language.
    onFailed: (error) => {
      if (errorCode(error)?.startsWith("thread.")) toast.show(errorText(t, error), "error");
    },
  });
  const { send, retry } = sendHelpers(post);

  // Reading the channel marks it read (unread counts in the DM list).
  const api = useApi();
  const lastId = channelMessages.data?.at(-1)?.id;
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
    // A thread view loads its whole conversation at once.
    if (thread || olderState !== "idle" || !messages.data) return;
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

  // The channel's threads as the timeline draws them (none in a thread view).
  const threadsView = useMemo<ChannelThreadsView | null>(() => {
    if (thread) return null;
    return {
      byId: new Map(threadList.filter((x) => x.state !== "archived").map((x) => [x.id, x])),
      marks: contextMarks(threadList, [...older, ...(channelMessages.data ?? [])], channel.id),
    };
  }, [thread, threadList, older, channelMessages.data, channel.id]);
  const timeline = useMemo(() => {
    if (thread) {
      // The thread's conversation. One made from a range: not its root (the channel's marker) nor the
      // moved messages (written before the root; the context block lists them).
      const mine = (channelMessages.data ?? []).filter((m) => m.local && m.threadId === thread.id);
      const list = mergeTimeline(threadMessages.data ?? [], [mine]).filter(
        (m) => !thread.context || m.local || (m.id !== thread.id && m.createdAt > thread.createdAt),
      );
      return buildTimeline(list, [], []);
    }
    const merged = mergeTimeline(
      [...older, ...(channelMessages.data ?? [])],
      threads.map((q) => q.data),
    );
    const hidden = hiddenByThreads(threadList, merged);
    const items = buildTimeline(
      merged.filter((m) => !hidden(m)),
      [],
      [],
    );
    // A marker or a closed line is not a message: nothing groups under it.
    const special = (m: MessageType) =>
      Boolean(threadStartOf(m.meta)) || threadsView?.byId.get(m.id)?.state === "closed";
    return ungroupAfter(items, special);
  }, [thread, older, channelMessages.data, threadMessages.data, threads, threadList, threadsView]);

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
  // Scrolling up always lets go at once: no waiting to leave the "near bottom" band or for a glide to end.
  const letGo = () => {
    stick.current = false;
    autoScrollUntil.current = 0;
  };
  // Long answers open at their start (RefinoUI "Nova leitura"): agent rows (`data-read-id`, the run's
  // id, shared by the live row and its final message) that already landed, and whether one is held
  // with its first line at the top ("Fim da resposta" shows until the person reaches the end).
  const landed = useRef(new Set<string>());
  // When the first page arrived (rows before that, and right after, are the conversation opening).
  const readyAt = useRef(0);
  if (messages.isSuccess && !readyAt.current) readyAt.current = Date.now();
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);
  const setHold = (on: boolean) => {
    holdingRef.current = on;
    setHolding(on);
  };
  /** The newest row, when it is an agent's answer. */
  const newestAnswer = () => {
    const rows = scroller.current?.querySelectorAll<HTMLElement>(".ac-msg");
    const last = rows?.[rows.length - 1];
    return last?.dataset.readId ? last : null;
  };
  /** The person saw the end of the conversation: its newest answer never jumps back to its start. */
  const markRead = () => {
    const id = newestAnswer()?.dataset.readId;
    if (id) landed.current.add(id);
  };
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const [unseen, setUnseen] = useState(false);
  const openedAt = useRef(Date.now());
  /**
   * At the bottom: follow it, unless the newest row is an agent's answer taller than the list. That
   * one lands once with its first line at the top (and a brief highlight); then nothing pulls the list.
   */
  const follow = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    const row = newestAnswer();
    const id = row?.dataset.readId;
    // Rows there while the conversation opens were already read: it opens at the end.
    const opening = !readyAt.current || Date.now() - readyAt.current < 1500;
    if (row && id && opening) landed.current.add(id);
    else if (row && id && !landed.current.has(id)) {
      const box = el.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const land = readingLanding({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        rowTop: rect.top - box.top + el.scrollTop,
        rowHeight: rect.height,
      });
      if (land.held) {
        landed.current.add(id);
        stick.current = false;
        setHold(true);
        setUnseen(false);
        if (smooth && !reducedMotionRef.current && typeof el.scrollTo === "function") {
          autoScrollUntil.current = Date.now() + 600;
          el.scrollTo({ top: land.top, behavior: "smooth" });
        } else el.scrollTop = land.top;
        if (!reducedMotionRef.current) {
          row.classList.add("ac-msg--fresh");
          setTimeout(() => row.classList.remove("ac-msg--fresh"), HIGHLIGHT_MS);
        }
        return;
      }
    }
    if (smooth && !reducedMotionRef.current && typeof el.scrollTo === "function") {
      autoScrollUntil.current = Date.now() + 600;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else el.scrollTop = el.scrollHeight;
    setUnseen(false);
  };
  const followRef = useRef(follow);
  followRef.current = follow;
  // Pinned to the bottom: anything that grows later (images, cards, the skeleton turning into
  // messages, fonts) keeps the latest message in view until the person scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list only exists for members; re-attach when it appears
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const pin = () => {
      if (stick.current && Date.now() >= autoScrollUntil.current) followRef.current();
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
  const runCount = useStreams((s) => scopedRuns(s).length);
  const streamSize = useStreams((s) => scopedRuns(s).reduce((n, r) => n + r.text.length, 0));
  const lastKey = timeline.at(-1)?.key;
  const previousLastKey = useRef(lastKey);
  /** The person asked for the end ("Novas mensagens", "Fim da resposta", a correction sent). */
  const toBottom = (smooth = false) => {
    markRead();
    const el = scroller.current;
    if (el) {
      if (smooth && !reducedMotion && typeof el.scrollTo === "function") {
        autoScrollUntil.current = Date.now() + 600;
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else el.scrollTop = el.scrollHeight;
    }
    stick.current = true;
    setHold(false);
    setUnseen(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever rows or streaming text grow
  useLayoutEffect(() => {
    // A new row glides down; streaming text follows instantly (no fighting smooth scrolls each frame).
    // Not while the channel is still loading (first page, thread replies): that lands at once.
    const newRow = previousLastKey.current !== lastKey;
    const settled = previousLastKey.current !== undefined && Date.now() - openedAt.current > 1500;
    previousLastKey.current = lastKey;
    if (stick.current) follow(newRow && settled);
    // Holding a long answer at its start: "Fim da resposta" already leads to what comes after it.
    else if ((newRow || runCount > 0) && !holdingRef.current) setUnseen(true);
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
    pillAgents.length > 0 || replyTo || missionReply ? (
      <>
        {missionReply && (
          <span className="ac-composer__pill composer-reply">
            <Icon name="message" size={14} />
            {t("missions.reply.pill", { label: missionReply.label })}
            <button
              type="button"
              className="composer-reply__close"
              aria-label={t("missions.reply.cancel")}
              onClick={() => setMissionReply(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </span>
        )}
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
  // Mission commands (English, like the server's): `/mission` anywhere with an agent; the rest in a mission's thread.
  const threadMission = useThreadMission(org.id, thread?.id);
  const homeMission = threadMission.data && isOpenMission(threadMission.data) ? threadMission.data : null;
  if (commandAgent && !homeMission) {
    commands.push({
      key: "mission",
      label: "/mission",
      description: t("missions.commands.mission"),
      leading: <Icon name="flag" size={16} />,
      insert: "/mission ",
    });
  }
  if (homeMission) {
    const run = (text: string) => () => void runCommand(text);
    const can = homeMission.canAct;
    commands.push(
      ...[
        { key: "summary" as const, icon: "layers" as const, show: true },
        { key: "plan" as const, icon: "document" as const, show: true },
        { key: "pause" as const, icon: "pause" as const, show: can && homeMission.status === "active" },
        { key: "resume" as const, icon: "play" as const, show: can && homeMission.status === "paused" },
        { key: "stop" as const, icon: "stop" as const, show: can && homeMission.status !== "proposed" },
      ]
        .filter((c) => c.show)
        .map((c) => ({
          key: c.key,
          label: `/${c.key}`,
          description: t(`missions.commands.${c.key}`),
          leading: <Icon name={c.icon} size={16} />,
          ...(c.key === "stop" ? { insert: "/stop" } : { insert: "", onPick: run(`/${c.key}`) }),
        })),
    );
  }
  const createMission = useCreateMission(org.id);
  const missionControl = useMissionControl(org.id);
  /** `/mission`, `/stop`, `/pause`, `/resume`, `/summary`, `/plan`: nothing is posted. True when handled. */
  async function runCommand(text: string): Promise<boolean> {
    const cmd = parseMissionCommand(text);
    if (!cmd) return false;
    setDraft("");
    if (cmd.command === "mission") {
      const named = mentioned(cmd.arg)[0];
      const agentId = named ?? dmAgent?.id ?? (channelAgents.length === 1 ? channelAgents[0]?.id : undefined);
      if (!agentId) {
        setMissionDraft(cmd.arg);
        return true;
      }
      createMission.mutate(
        { agentId, goal: cmd.arg, ...(thread ? { threadId: thread.id } : { channelId: channel.id }) },
        {
          onSuccess: (mission) => {
            toast.show(t("missions.new.created", { name: dir.agentById.get(agentId)?.name ?? "" }));
            if (mission.threadId !== thread?.id) {
              void navigateTo({
                to: "/org/$orgId/threads/$threadId",
                params: { orgId: org.id, threadId: mission.threadId },
              });
            }
          },
          onError: (error) => toast.show(errorText(t, error), "error"),
        },
      );
      return true;
    }
    const mission = threadMission.data;
    if (!mission) {
      toast.show(t("missions.commands.noMission"), "error");
      return true;
    }
    if (cmd.command === "summary" || cmd.command === "plan") {
      setEphemeral({ kind: cmd.command, missionId: mission.id });
      return true;
    }
    const action = cmd.command;
    missionControl.mutate(
      { missionId: mission.id, action },
      {
        onSuccess: (out) =>
          toast.show(
            action === "stop"
              ? t("missions.toast.stopped", { count: out.canceledTasks ?? 0 })
              : t(`missions.toast.${action}`),
          ),
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
    return true;
  }

  // Any new page of data (first load, refetch, cache → server) re-pins while at the bottom,
  // without waiting for observers (some environments have none).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the data changes
  useLayoutEffect(() => {
    if (stick.current && Date.now() >= autoScrollUntil.current) follow();
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
  const [files, setFiles] = useState<PendingFile[]>([]);
  // Thumbnails are object URLs: freed when a file leaves the composer and when the page goes.
  const previews = useRef(new Set<string>());
  const dropFiles = (keep: (f: PendingFile) => boolean) => {
    for (const f of files) {
      if (keep(f) || !f.preview) continue;
      objectUrls.revoke(f.preview);
      previews.current.delete(f.preview);
    }
    setFiles((prev) => prev.filter(keep));
  };
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) objectUrls.revoke(url);
      urls.clear();
    };
  }, []);
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
      const preview = previewKind(file.type) === "image" ? (objectUrls.create(file) ?? undefined) : undefined;
      if (preview) previews.current.add(preview);
      setFiles((prev) => [
        ...prev,
        { key, name: file.name, icon: fileIcon(file.name, file.type), size: file.size, preview, status: "uploading" },
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
    if (attached.length === 0 && parseMissionCommand(text)) {
      void runCommand(text);
      return;
    }
    if (missionReply && text) {
      const target = missionReply;
      setDraft("");
      setMissionReply(null);
      api.missions
        .message(org.id, target.missionId, text)
        .then((out) => toast.show(out.delivered ? t("missions.reply.sent") : t("missions.reply.queued")))
        .catch((error) => {
          setDraft(text);
          toast.show(errorText(t, error), "error");
        });
      return;
    }
    toBottom(true);
    setDraft("");
    const meta = localMeta(quote, quote ? dir.authorName(quote.author) : "", attached);
    send(text, thread ? thread.id : replyTo ? (replyTo.threadId ?? replyTo.id) : null, meta);
    setReplyTo(null);
    setQuote(null);
    dropFiles(() => false);
  };
  // Live rows sit by time: right after the message that started them (never at the bottom glued
  // to a later reply). `liveKey` only changes when runs start or end.
  const liveKey = useStreams((s) =>
    scopedRuns(s)
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

  const createThread = useCreateThread(org.id);
  const flows = useThreadFlows();
  function createThreadFrom(message: MessageType) {
    const range = suggestRange([...older, ...(channelMessages.data ?? [])], message.id);
    if (!range || createThread.isPending) return;
    createThread.mutate(
      { channelId: channel.id, firstMessageId: range.firstId, lastMessageId: range.lastId },
      { onSuccess: flows.created, onError: (error) => toast.show(errorText(t, error), "error") },
    );
  }

  // "Ajustar trecho": the channel's messages that can be in the range (and the moved ones, back in
  // their place), with the selection band in place of the timeline and its bar in place of the composer.
  const adjustInfo = useThreadInfo(org.id, adjustThreadId);
  const adjusting = adjustInfo.data;
  const movedMessages = useThreadMessages(
    org.id,
    adjusting?.context?.moved ? adjusting.channelId : undefined,
    adjusting?.id ?? "",
  );
  const adjustList = useMemo(() => {
    if (!adjusting) return [];
    const moved = adjusting.context?.moved
      ? (movedMessages.data ?? []).filter((m) => m.id !== adjusting.id && m.createdAt < adjusting.createdAt)
      : [];
    return rangeCandidates(
      mergeTimeline([...older, ...(channelMessages.data ?? [])], [moved.map((m) => ({ ...m, threadId: null }))]),
    );
  }, [adjusting, movedMessages.data, older, channelMessages.data]);
  const adjust = useRangeAdjust({
    thread: adjusting,
    list: adjustList,
    channelName: channel.name,
    onDone: () => {},
  });
  // The range starts further back than what is loaded: page back to it (like `?m=`).
  const adjustFirst = adjusting?.context?.firstMessageId;
  const adjustFound = adjustList.some((m) => m.id === adjustFirst);
  // biome-ignore lint/correctness/useExhaustiveDependencies: steps while older pages arrive
  useEffect(() => {
    if (!adjustFirst || adjustFound || !messages.isSuccess || olderState !== "idle") return;
    loadOlder();
  }, [adjustFirst, adjustFound, messages.isSuccess, olderState, older.length]);
  // Esc leaves the selection (back to the thread).
  useEffect(() => {
    if (!adjusting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      adjust.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
      if (stick.current && Date.now() >= autoScrollUntil.current) follow();
    },
    channelAgents,
    // In a thread view everything already goes to the thread.
    replyInThread: thread
      ? undefined
      : (message) => {
          setReplyTo(message);
          composer.current?.focus();
        },
    quoteReply: (message) => {
      setQuote(message);
      composer.current?.focus();
    },
    requestCorrection: (message, text) => {
      const handle = message.author.type === "agent" ? dir.agentById.get(message.author.id ?? "")?.handle : undefined;
      toBottom(true);
      send(
        handle ? `@${handle} ${text}` : text,
        thread ? thread.id : (message.threadId ?? null),
        localMeta(message, dir.authorName(message.author), []),
      );
    },
    jumpTo,
    // "Criar thread a partir daqui": the suggested range becomes a thread's context (not in a thread view).
    createThreadFrom: thread || adjustThreadId ? undefined : createThreadFrom,
    replyToMission: (missionId, label) => {
      setMissionReply({ missionId, label });
      setReplyTo(null);
      composer.current?.focus();
    },
  };

  // A DM with an agent: the agent's chip sits in the composer's toolbar row.
  const agentDm = Boolean(chrome?.dmAgentId) && !thread;
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
      <ChannelThreadsContext.Provider value={threadsView}>
        {/* A DM with an agent reads as one centered column; channels, threads and DMs between people
            are a left-aligned team chat (telas/RefinoUI.html, "Conversa: Nova leitura"). */}
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
              {isMember && <ChannelThreadsButton channelId={channel.id} channelName={channel.name} />}
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
                onWheel={(e) => {
                  markGesture();
                  if (e.deltaY < 0) letGo();
                }}
                onTouchMove={markGesture}
                onPointerDown={markGesture}
                onKeyDown={markGesture}
                onScroll={(e) => {
                  const previousTop = lastScrollTop.current;
                  lastScrollTop.current = e.currentTarget.scrollTop;
                  // Only the person scrolling unpins (or loads older pages); layout changes never do.
                  const byPerson = Date.now() - lastGesture.current < GESTURE_MS;
                  if (byPerson && e.currentTarget.scrollTop < 240) loadOlder();
                  if (byPerson && previousTop !== null && e.currentTarget.scrollTop < previousTop) {
                    letGo();
                    return;
                  }
                  const near = nearBottom(e.currentTarget);
                  if (!near && (!byPerson || Date.now() < autoScrollUntil.current)) return;
                  // Pinned again only when the person comes back down, not by layout.
                  const movedDown = previousTop !== null && e.currentTarget.scrollTop > previousTop;
                  if (near && !stick.current && !(byPerson && movedDown)) return;
                  stick.current = near;
                  if (near) setUnseen(false);
                  // The person reached the end by themselves: the answer was read, the hold is over.
                  if (near && byPerson) {
                    markRead();
                    if (holdingRef.current) setHold(false);
                  }
                }}
              >
                {/* Pushes short channels down, next to the composer. */}
                <div className="channel__spacer" aria-hidden="true" />
                {chrome?.top}
                {messages.isLoading && <LoadingConversation />}
                {messages.isError && !messages.data && (
                  <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
                )}
                {messages.isSuccess && timeline.length === 0 && streamSize === 0 && !thread && !adjusting && (
                  <div className="channel__empty">
                    <EmptyState
                      icon="message"
                      // A DM with an agent: the light sky, like the other empty screens about agents.
                      sky={Boolean(chrome?.dmAgentId)}
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
                {adjustThreadId ? (
                  <RangeRows
                    adjust={adjust}
                    scroller={scroller}
                    renderMessage={(m) => (
                      <TimelineMessage message={m} grouped={false} entering={false} modelLabels={NO_LABELS} />
                    )}
                  />
                ) : (
                  <>
                    <Timeline items={timeline} ready={messages.isSuccess} anchors={anchors} />
                    {!thread && (
                      <ArchivedThreadsNote channelId={channel.id} count={archivedThreads.data?.threads.length ?? 0} />
                    )}
                  </>
                )}
                {ephemeral && (
                  <MissionEphemeral
                    kind={ephemeral.kind}
                    missionId={ephemeral.missionId}
                    onClose={() => setEphemeral(null)}
                  />
                )}
                <LiveMemoryCards channelId={channel.id} />
                <LiveNotices channelId={channel.id} />
                {unanchored.map((runId) => (
                  <LiveRunSlot key={runId} runId={runId} />
                ))}
              </section>
              {holding && (
                <div className="channel__pill">
                  <Button size="sm" className="ac-new-messages" onClick={() => toBottom(true)}>
                    <Icon name="chevronDown" size={16} />
                    {t("channel.endOfReply")}
                  </Button>
                </div>
              )}
              {unseen && !holding && (
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
                <ActivityBar channelId={channel.id} visible={runVisible} />
                {adjustThreadId ? (
                  <RangeBar adjust={adjust} />
                ) : chrome?.composerReplacement ? (
                  chrome.composerReplacement
                ) : (
                  <>
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
                                preview={f.preview}
                                detail={formatBytes(i18n.language, f.size)}
                                status={f.status}
                                statusLabel={
                                  f.status === "uploading"
                                    ? t("channel.uploading")
                                    : f.status === "failed"
                                      ? t("channel.uploadFailed")
                                      : undefined
                                }
                                removeLabel={t("channel.removeFile", { name: f.name })}
                                onRemove={() => dropFiles((x) => x.key !== f.key)}
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
                        chrome?.composerLabel ??
                        (chrome?.composerTarget
                          ? t("channel.composerDm", { name: chrome.composerTarget })
                          : t("channel.composerLabel", { channel: channel.name }))
                      }
                      placeholder={
                        // DMs name the person or agent ("Mensagem para Theo"); channels keep "#nome".
                        chrome?.composerLabel ??
                        (chrome?.composerTarget
                          ? t("channel.composerDm", { name: chrome.composerTarget })
                          : t("channel.composerPlaceholder", { channel: channel.name }))
                      }
                      sendLabel={t("channel.send")}
                      sendText={t("channel.send")}
                      attachLabel={t("channel.attach")}
                      pills={composerPills}
                      inlinePills={agentDm}
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
                      commands={commands.length > 0 ? { listLabel: t("composer.commands"), list: commands } : undefined}
                      mentions={{
                        search: mentionSearch,
                        listLabel: t("mentions.list"),
                        onPick: (item) => {
                          if (item.note && item.key.startsWith("agent:")) setOffer(item.key.slice(6));
                        },
                      }}
                    />
                    {offer && (
                      <AddToChannelOffer channelId={channel.id} agentId={offer} onDone={() => setOffer(null)} />
                    )}
                    {chrome?.composerNote && !chrome.locked && (
                      <p className="ac-composer__hint">{chrome.composerNote}</p>
                    )}
                    {chrome?.locked && <p className="ac-composer__hint">{chrome.locked}</p>}
                  </>
                )}
              </div>
            </>
          )}

          {!chrome?.header && <ChannelDetails open={detailsOpen} onOpenChange={setDetailsOpen} channel={channel} />}
          {missionDraft !== null && (
            <NewMissionDialog
              open
              onOpenChange={(o) => !o && setMissionDraft(null)}
              initialGoal={missionDraft}
              initialChannelId={chrome?.dmAgentId ? undefined : channel.id}
              initialAgentId={channelAgents[0]?.id}
            />
          )}
        </main>
      </ChannelThreadsContext.Provider>
    </ChannelActionsContext.Provider>
  );
}

/** Rows right after a thread marker or a closed thread's line keep their own header. */
function ungroupAfter(items: TimelineItem[], special: (m: MessageType) => boolean): TimelineItem[] {
  let after = false;
  return items.map((item) => {
    if (item.kind !== "message") {
      after = false;
      return item;
    }
    const out = after && item.grouped ? { ...item, grouped: false } : item;
    after = special(item.message);
    return out;
  });
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
  const threadsView = useChannelThreadsView();
  // Threads a mission link card already points to (the agent's reply): their start marker stays out.
  const linked = useMemo(
    () =>
      new Set(
        items.flatMap((i) => {
          const link = i.kind === "message" ? missionLinkOf(i.message.meta) : null;
          return link ? [link.threadId] : [];
        }),
      ),
    [items],
  );
  // Commands allowed without a card, a minute apart: one line for the run of them.
  const autoApproved = useMemo(
    () => groupAutoApproved(items.flatMap((i) => (i.kind === "message" ? [i.message] : []))),
    [items],
  );
  let afterLive = false;
  /** A closed thread is one line; the root of a thread made from a range is its marker (or stub). */
  const threadRow = (key: string, m: MessageType) => {
    // A mission's automatic lines (the plan changed, the computer went offline, a task ended): not a voice.
    if (missionPlanChangeOf(m.meta)) return <MissionPlanChangeLine key={key} message={m} />;
    if (taskNoticeOf(m.meta)) return <TaskNoticeLine key={key} message={m} />;
    // An agent took an issue made from this conversation: one quiet line with its link.
    if (issueTakenOf(m.meta)) return <IssueTakenLine key={key} message={m} />;
    if (autoApproved.hidden.has(m.id)) return <Fragment key={key} />;
    const autoGroup = autoApproved.groups.get(m.id);
    if (autoGroup) return <AutoApprovedLine key={key} messages={autoGroup} />;
    if (!threadsView) return null;
    const info = threadsView.byId.get(m.id);
    if (info?.state === "closed") return <ClosedThreadLine key={key} thread={info} />;
    const start = threadStartOf(m.meta);
    if (start && !start.moved && linked.has(m.id)) return <Fragment key={key} />;
    // A thread that has a mission (also ones proposed before the link card existed): the same mission card.
    if (start && info?.mission) {
      return (
        <div key={key} className="mi-linkrow" data-message-id={m.id}>
          <MissionLinkCard link={{ missionId: info.mission.id, threadId: m.id }} />
        </div>
      );
    }
    return start ? <ThreadStartLine key={key} message={m} start={start} thread={info} /> : null;
  };
  return (
    <>
      {items.map((item) => {
        const live = anchors.get(item.key);
        const row =
          item.kind === "day" ? (
            <DayDivider key={item.key}>{dayLabel(t, i18n.language, item.iso)}</DayDivider>
          ) : item.kind === "message" ? (
            (threadRow(item.key, item.message) ?? (
              <TimelineMessage
                key={item.key}
                message={item.message}
                // Right after a live row, always a full header (never "grouped" under it).
                grouped={item.grouped && !afterLive}
                entering={initial !== null && entersWithMotion(item.key, item.message.createdAt, initial, mountedAt)}
                modelLabels={modelLabels}
                contextMark={threadsView?.marks.has(item.message.id)}
                replyContext={item.context}
              />
            ))
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
/** Model names for the rows of "Ajustar trecho" (no usage line is shown there). */
const NO_LABELS = new Map<string, string>();

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
      data-read-id={run.runId}
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
          {!canceled && <BrowserWatchCard run={run} name={name} />}
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
function ActivityBar({
  channelId,
  visible,
}: {
  channelId: string;
  /** Which runs belong here (a thread view shows only its own). */
  visible?: { current: (r: { threadId: string }) => boolean };
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [now, setNow] = useState(() => Date.now());
  const runs = useStreams((s) => runsInChannel(s, channelId).filter((r) => visible?.current(r) ?? true), sameRuns);
  // An agent asking another one: "Dev está perguntando ao Infra… 0:12" (its run pauses meanwhile).
  const consults = useLive(
    (s) => consultsIn(s.consults, channelId, now).filter((c) => visible?.current(c) ?? true),
    sameList,
  );
  const typing = useLive((s) => s.typing[channelId]);
  const ids = typingIn({ [channelId]: typing ?? {} }, channelId, now, me.user.id);
  const ticking = Boolean(typing) || consults.length > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const entries = barEntries(
    runs,
    ids,
    (id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent"),
    (id) => dir.memberById.get(id)?.name,
    consults,
  );
  const text = activityText(t, entries);
  const active = entries.length > 0;
  // The strip behind the bar (and the orbit) take the color of the first agent at work.
  const firstAgent = entries.find((e) => e.type === "agent");
  const skyAgent = firstAgent;
  const { canStop, stop } = useStopRun();
  // "Parar" in the bar for the runs not writing yet that I may stop.
  const barStoppable = runs.filter((r) => !isWriting(r) && isStoppable(r) && canStop(r));
  // A live row with newer messages below it: "Theo ainda trabalhando" jumps back to it.
  const behindIds = useRowsBehind(runs);
  const behind = runs.filter((r) => behindIds.includes(r.runId));
  // Agents running code (not writing yet): "Ver código" with the live code and output.
  const coding = runs.filter((r) => !isWriting(r) && r.code);
  // An agent working in its browser: the bar says so, and a click opens its browser live (watching).
  const browsing = runs.find((r) => !isWriting(r) && usesBrowser(r));
  const navigate = useNavigate();
  const openBrowser = browsing
    ? () =>
        void navigate({
          to: "/org/$orgId/browser/$agentId",
          params: { orgId: org.id, agentId: browsing.agentId },
          search: { watch: 1 },
        })
    : undefined;
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the "No navegador" button inside is the keyboard way; the pill is a bigger target */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: same */}
      <div
        className="ac-typing"
        aria-live="polite"
        data-active={active}
        data-browser={active && openBrowser ? true : undefined}
        onClick={
          openBrowser
            ? (e) => {
                // Its own buttons (Parar) keep their job.
                if ((e.target as HTMLElement).closest("button, [role=dialog]")) return;
                openBrowser();
              }
            : undefined
        }
      >
        {active && (
          <>
            {skyAgent && <ActivitySky color={colorOf(dir.agentById.get(skyAgent.id))} />}
            {/* Agents at work: the pixel orbit in the first one's color (people only typing: the dots). */}
            {firstAgent && <AgentSpinner agentId={firstAgent.id} size={14} />}
            <WorkingStack entries={entries} />
            {/* Keyed by the words: a new activity fades in. Names in ink. */}
            <span key={text} className="ac-typing__text">
              <WorkingWords entries={entries} />
            </span>
            <ConsultClock entries={entries} now={now} />
            {openBrowser && (
              <Button
                size="sm"
                variant="ghost"
                icon="globe"
                className="ac-typing__browser"
                title={t("browser.watch.open")}
                onClick={openBrowser}
              >
                {t("browser.watch.title")}
              </Button>
            )}
            {!firstAgent && (
              <span className="ac-typing__dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            )}
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
export const TimelineMessage = memo(function TimelineMessage({
  message: m,
  grouped,
  entering,
  modelLabels,
  contextMark,
  replyContext,
}: {
  message: MessageType;
  grouped: boolean;
  entering: boolean;
  modelLabels: Map<string, string>;
  /** Part of a thread's context (still in the channel): the quiet mark in the gutter. */
  contextMark?: boolean;
  /** Shown away from the message it answers: that message, quoted above (`buildTimeline`). */
  replyContext?: ReplyRef;
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
  // An agent's answer to a routine (`meta.viaRoutine`): the routine's call is hidden, so a small tag says so.
  const viaRoutine = viaRoutineOf(m.meta);
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
  // A text the server wrote (`meta.bodyCode`, a deploy's notice) is shown in the person's language.
  const stopped = useMemo(() => splitCanceled(serverBody(t, m.body, m.meta), m.meta), [t, m.body, m.meta]);
  const body = reminderBody(stopped.body, m.meta);
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
  // A plain reminder: the agent's own message, with a small "Reminder" label.
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
  // The agent needs a person in its browser (ADR 0040): the request card.
  const browserHandoff = m.author.type === "agent" ? browserHandoffOf(meta) : null;
  // Files an agent made, or a person attached.
  const artifacts = artifactRefs(meta);
  // "Responder": the message this one quotes.
  const quoted = useMemo(() => replyOf(m.meta) ?? replyContext ?? null, [m.meta, replyContext]);
  // An agent opened a forum topic from here: the topic card with "Ver discussão".
  const forumTopicId = m.author.type === "agent" ? forumTopicOfMessage(meta) : null;
  // A mission's cards (ADR 0029): the plan, a decision, a review; a report says where it ran.
  const missionPlan = m.author.type === "agent" ? missionPlanOf(meta) : null;
  const missionDecision = m.author.type === "agent" && meta.missionDecision ? m : null;
  const missionReview = m.author.type === "agent" && meta.missionReview ? m : null;
  // The mission's end: what was delivered, what to check, Concluir missão / Pedir ajustes.
  const missionDelivery = m.author.type === "agent" && meta.missionDelivery ? m : null;
  // The executor asks to run a command off its allow list: the command card (Aprovar / Recusar / Aprovar sempre).
  const missionCommand = m.author.type === "agent" ? missionCommandOf(meta) : null;
  const missionReport = m.author.type === "agent" ? missionReportOf(meta) : null;
  const missionSuggestion = m.author.type === "person" ? missionSuggestionOf(meta) : null;
  // A mission proposed from here whose thread lives elsewhere: its link card under the reply.
  const missionLink = m.author.type === "agent" ? missionLinkOf(meta) : null;
  const missionCard = Boolean(missionPlan || missionDecision || missionReview || missionDelivery || missionCommand);
  // The root of a mission in the channel: its work lives in its thread.
  const missionStart = !m.threadId && Boolean(meta.missionStart) && actions?.replyInThread !== undefined;
  // An agent suggests a topic ("Vale um fórum?"): only a person opens it.
  const forumSuggestion = m.author.type === "agent" ? forumSuggestionOf(meta) : null;
  // It asked other agents before answering (`meta.consulted`): one card per agent, on top of the reply.
  const consulted = useMemo(() => (m.author.type === "agent" ? consultationsOf(m.meta) : []), [m.author.type, m.meta]);
  // Nobody called it: it joined the conversation on its own (`meta.joined`).
  const joined = m.author.type === "agent" && meta.joined === true;
  const joinedTip = joined
    ? (() => {
        const g = agentGrammar(t, name);
        return t("chat.joined.tip", { name, article: g.article, Pronoun: capitalize(g.pronoun) });
      })()
    : null;
  // The root of an issue's work thread (the person asked the agent to implement it): the issue card, no text.
  const issueWork = issueWorkOf(meta);
  // "O Claude Code não está disponível agora": its computer is offline; one card that waits, then says it's back.
  const brainNotice = m.author.type === "agent" ? brainUnavailableOf(meta) : null;
  const waitNotice = brainNotice && isOfflineNotice(brainNotice) ? brainNotice : null;
  const card =
    approvalId ||
    waitNotice ||
    proposalId ||
    memoryUpdates.length > 0 ||
    question ||
    secretRequest ||
    missionCard ||
    forumSuggestion ||
    issueWork;
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
      // An agent's answer: lands at its start when long (same id as its live row, so only once).
      data-read-id={m.author.type === "agent" && !m.local ? (m.agentRunId ?? m.id) : undefined}
      grouped={grouped}
      entering={entering && !replacesLive}
      className={cx(m.local && `ac-msg--local ac-msg--${m.local}`, contextMark && "msg--context")}
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
              // A person's 👍/👎 on this message plays a face on it (`applyReactions`).
              <AgentAvatar agentId={agent.id} name={name} state="idle" reactionKey={m.id} />
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
            {viaRoutine && (
              <Link to="/org/$orgId/routines" params={{ orgId: org.id }} className="msg-reminder msg-reminder--link">
                <Icon name="routines" size={14} />
                {t("channel.viaRoutine", { name: viaRoutine.name })}
              </Link>
            )}
          </>
        ) : (
          name
        )
      }
      time={<time dateTime={m.createdAt}>{formatTime(i18n.language, m.createdAt)}</time>}
      meta={m.local ? undefined : details}
      note={joinedTip ? { label: t("chat.joined.label"), tip: joinedTip } : undefined}
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
      {m.author.id &&
        consulted.map((c) => <ConsultationCard key={c.consultationId} consultation={c} askerId={m.author.id ?? ""} />)}
      {(!routine || routineOpen) &&
        !missionCard &&
        !forumSuggestion &&
        !issueWork &&
        !waitNotice &&
        (body.trim() || (!card && !canceledNote && artifacts.length === 0)) && (
          <MessageText>
            <MessageBody
              body={body}
              resolveMention={dir.mentionName}
              renderMention={renderMention}
              wikiLink={wikiLink}
            />
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
      {m.author.type === "agent" && !m.local && <AgentActionReceipts message={m} />}
      {approvalId && <MessageApproval approvalId={approvalId} agent={agent} members={dir.memberById} />}
      {proposalId && <InlineProposal proposalId={proposalId} />}
      {agent &&
        memoryUpdates.map((u) => <MemoryChangeCard key={`${u.action}-${u.itemId}`} update={u} agentId={agent.id} />)}
      {waitNotice && <WaitingCard notice={waitNotice} agentId={m.author.id ?? null} />}
      {question && <QuestionCard question={question} />}
      {secretRequest && <SecretCard request={secretRequest} />}
      {browserHandoff && <BrowserHandoffCard handoff={browserHandoff} />}
      {m.author.type === "agent" && m.agentRunId && !card && !m.local && (
        <MessageWork runId={m.agentRunId} meta={m.meta} agentName={agent?.name ?? name} />
      )}
      {forumTopicId && !forumSuggestion && <ForumMessageCard topicId={forumTopicId} />}
      {forumSuggestion && <ForumSuggestionCard message={m} suggestion={forumSuggestion} />}
      {missionPlan && <MissionPlanCard plan={missionPlan} />}
      {missionDecision && <MissionDecisionCard message={missionDecision} />}
      {missionReview && <MissionReviewCard message={missionReview} />}
      {missionDelivery && <MissionDeliveryCard message={missionDelivery} />}
      {missionCommand && <MissionCommandCard command={missionCommand} />}
      {missionReport && <MissionReportExtras report={missionReport} message={m} />}
      {missionSuggestion && <MissionSuggestionBar message={m} suggestion={missionSuggestion} />}
      {missionStart && <MissionStartLink message={m} />}
      {missionLink && <MissionLinkCard link={missionLink} />}
      {issueWork && (
        <IssueWorkCard work={issueWork} authorId={m.author.type === "person" ? (m.author.id ?? null) : null} />
      )}
      {artifacts.length > 0 && (
        <div className="artifact-cards">
          {artifacts.map((r) => (
            <ArtifactCard key={`${r.id}@${r.version}`} artifact={r} />
          ))}
        </div>
      )}
      {/* Everyone's reactions (👍/👎 on an agent's reply are its feedback, in the same pills). */}
      {!m.local && (
        <MessageReactions
          messageId={m.id}
          initial={m.reactions}
          feedback={feedback}
          extra={m.memories?.length ? <MemoryMarks message={m} /> : undefined}
        />
      )}
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
      {feedback && <CorrectionAsk message={m} agentName={agent?.name ?? t("channel.unknownAgent")} />}
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
