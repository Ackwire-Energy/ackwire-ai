import type {
  Agent,
  AgentQuestion,
  Approval,
  ArtifactRef,
  Channel,
  HeldPlace,
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
  browserTrailOf,
  type ConnectionStatus,
  consultsIn,
  heldRowsIn,
  inMainTimeline,
  isBrowserTool,
  isQuiet,
  keys,
  type LiveRun,
  MESSAGES_PAGE,
  OPEN_THREAD,
  runsInChannel,
  type SteerState,
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
  useDmReads,
  useHeldPlaces,
  useJoinChannel,
  useMarkChannelRead,
  useMessages,
  useMissionControl,
  useModels,
  usePostMessage,
  useRoster,
  useSteerState,
  usesBrowser,
  useThreadInfo,
  useThreadMessages,
  useThreadMission,
  useUpdateChannel,
  useWikiTree,
} from "@agenteschat/client";
import { activityVerb, barEntries, isWriting, toolActivity } from "@agenteschat/client/lib/activity";
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
  missionSetupOf,
  missionSuggestionOf,
  parseMissionCommand,
  taskNoticeOf,
} from "@agenteschat/client/lib/missions";
import { isTalkerReply, noticeOf, routineReportText } from "@agenteschat/client/lib/notices";
import { brainUnavailableOf, isOfflineNotice } from "@agenteschat/client/lib/outages";
import { can } from "@agenteschat/client/lib/permissions";
import { localMeta, replyOf } from "@agenteschat/client/lib/reply";
import { isReminderMessage, reminderBody, routineReplyOf } from "@agenteschat/client/lib/routines";
import { seenMessageId } from "@agenteschat/client/lib/seen";
import { contextMarks, hiddenByThreads, rangeCandidates, threadStartOf } from "@agenteschat/client/lib/threads";
import { buildTimeline, groupsWith, mergeTimeline, type TimelineItem } from "@agenteschat/client/lib/timeline";
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
  FORMAT_KINDS,
  type FormatKind,
  Icon,
  type IconName,
  Kbd,
  Mention,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
  Message,
  MessageText,
  PixelSpinner,
  PixelStop,
  Skeleton,
  SkeletonGroup,
  SkeletonMessage,
  Spinner,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { tokenizeBody } from "@/chat/body";
import { MessageBody } from "@/chat/MessageBody";
import { browserOffline, failedOffline, outbox, useQueued } from "@/chat/outbox";
import { readingLanding } from "@/chat/reading";
import {
  blockRowByRun,
  drawsBehind,
  elapsedParts,
  nextSlots,
  openerDelayMs,
  openerOf,
  type RunSlot,
  SLOT_HOLD_MS,
  sameSlots,
  saysNothingYet,
} from "@/chat/run-slots";
import { dividerIsFar, firstNewKey, pillParts, unseenOf } from "@/chat/unseen";
import { AgentActionReceipts } from "@/components/AgentActions";
import { ActorAvatar, AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { AgentPanel } from "@/components/AgentPanel";
import { InlineApproval } from "@/components/ApprovalItem";
import { AgentPanelContext, useOpenAgentPanel } from "@/components/agent-panel-context";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { objectUrls } from "@/components/artifacts/FileView";
import { HeldBrowserCard, RunBrowserCard, useHeldTakeover } from "@/components/browser/BrowserCard";
import { BrowserHandoffCard } from "@/components/browser/BrowserHandoffCard";
import { BrowserTrailCard } from "@/components/browser/BrowserTrailCard";
import { requestBrowserCard } from "@/components/browser/open";
import { ChannelMembersStack } from "@/components/ChannelMembers";
import { InlineProposal, MemoryChangeCard, QuestionCard, SecretCard } from "@/components/ChatCards";
import { NoticeLine, RoutineReport, RoutineTag } from "@/components/ChatNotices";
import { ConsultationCard } from "@/components/ConsultationCard";
import { CorrectionAsk } from "@/components/CorrectionAsk";
import { type ChannelActions, ChannelActionsContext, useChannelActions } from "@/components/channel-actions";
import { ForumMessageCard, ForumSuggestionCard, forumSuggestionOf, forumTopicOfMessage } from "@/components/Forum";
import { IssueTakenLine, IssueWorkCard } from "@/components/IssueWork";
import { LiveCodeToggle, LiveWorkList, type SteerNote } from "@/components/LiveCode";
import { ErrorState, LoadingConversation } from "@/components/Loading";
import { WaitingCard } from "@/components/MachineOutages";
import { MemberPickerRows, memberOf, type PickKey, useMemberRows } from "@/components/MemberPicker";
import { MemoryMarks } from "@/components/MemoryMark";
import { MessageFeedback } from "@/components/MessageFeedback";
import { MessageMoreMenu, PersonMessageActions, ReplyButton, useMessageMenu } from "@/components/MessageMore";
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
  MissionSetupCard,
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
import { isStoppable, StopButton, useContinueRun, useStopRun, useWasContinued } from "@/components/StopRun";
import { RangeBar, RangeRows, useRangeAdjust } from "@/components/threads/RangeSelect";
import {
  ArchivedThreadsNote,
  ChannelThreadsButton,
  ChannelThreadsContext,
  type ChannelThreadsView,
  ClosedThreadLine,
  ThreadReplyLine,
  ThreadStartLine,
  useChannelThreadsView,
} from "@/components/threads/ThreadLines";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { BarPhrase, ConsultClock, WorkingStack } from "@/components/WorkingLine";
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
import { ThreadPage } from "./ThreadPage";

/** One clock for every "· 12 s" on screen: the block and the card above the box never differ by a second. */
const secondClock = (() => {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const subs = new Set<() => void>();
  return {
    subscribe(fn: () => void) {
      subs.add(fn);
      if (!timer) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const f of subs) f();
        }, 1000);
      }
      return () => {
        subs.delete(fn);
        if (subs.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    get: () => now,
  };
})();
const still = () => () => {};
/** The shared clock while `active` (else it holds still). */
const useSecond = (active: boolean) => useSyncExternalStore(active ? secondClock.subscribe : still, secondClock.get);

/** Live statuses of a run still at work on its conversation (a new message steers into it). */
const WORKING: ReadonlySet<string> = new Set(["thinking", "queued", "running", "waiting_approval"]);

/** Header and empty state of a channel, or of a DM (same layout). */
export interface ChannelChrome {
  header?: ReactNode;
  emptyText?: string;
  /** Composer label/placeholder target, e.g. "Ada" instead of "#eng". */
  composerTarget?: string;
  /** A DM with this agent: it answers every message (optimistic "pensando…" is allowed). */
  dmAgentId?: string;
  /** A DM with this person: "Visto" under my latest message once they read it. */
  dmPersonId?: string;
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
  /** A thread in the panel beside its channel (telas/ThreadPainel.html): a section, not the page's main. */
  panel?: boolean;
  /** A thread view where a person's reply makes it a "Responder" thread (`openThread` on the post). */
  openThread?: boolean;
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
export function ChannelSkeleton({ panel }: { panel?: boolean } = {}) {
  const { t } = useTranslation();
  const Tag = panel ? "section" : "main";
  return (
    <Tag className={cx("shell__main shell__main--chat", panel && "thread-panel__chat")}>
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
    </Tag>
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
  // A DM with a person: "Visto" under my latest message once they read it (live: `channel.read`).
  const reads = useDmReads(org.id, channel.id, Boolean(chrome?.dmPersonId) && isMember);
  const seenId = useMemo(
    () => (reads.data ? seenMessageId(channelMessages.data ?? [], me.user.id, reads.data) : null),
    [reads.data, channelMessages.data, me.user.id],
  );
  // Thread view: the thread's root and replies (the channel's page still holds my unsent replies).
  const threadMessages = useThreadMessages(org.id, thread && isMember ? channel.id : undefined, thread?.id ?? "");
  const messages = thread ? threadMessages : channelMessages;
  // The channel's threads: closed lines, context marks, markers (not in a thread view or while adjusting).
  const listsThreads = isMember && !thread;
  const openThreads = useChannelThreads(org.id, channel.id, "all", listsThreads);
  const archivedThreads = useChannelThreads(org.id, channel.id, "archived", listsThreads);
  const threadList = useMemo(
    () => [...(openThreads.data?.threads ?? []), ...(archivedThreads.data?.threads ?? [])],
    [openThreads.data, archivedThreads.data],
  );
  // Live runs shown here: a thread view shows its own; the channel, those answering in the channel
  // (asked there, D67). A thread's runs are in its panel; the channel shows its line. A "pensando…"
  // the app guessed hangs off the message sent: shown here when that message is in the channel.
  const topLevelIds = useMemo(
    () => new Set((channelMessages.data ?? []).flatMap((m) => (m.threadId ? [] : [m.id]))),
    [channelMessages.data],
  );
  const runVisible = useRef<(r: { threadId: string | null; provisional?: boolean }) => boolean>(() => true);
  runVisible.current = thread ? (r) => r.threadId === thread.id : (r) => inMainTimeline(r, topLevelIds);
  const scopedRuns = (s: StreamsState) => runsInChannel(s, channel.id).filter((r) => runVisible.current(r));
  const live = useLiveStore();
  const join = useJoinChannel(org.id, channel.id);
  const sendTyping = useTypingSender(channel.id);
  // ⌘K "Pedir a um agente" leaves the text for this DM's composer.
  const draftKey = chrome?.dmAgentId ? `agent:${chrome.dmAgentId}` : null;
  const [draft, setDraft] = useState(() => (draftKey ? (peekDraft(draftKey) ?? "") : ""));
  // Stopping is immediate, nothing asked (what it did stays, "Continuar" picks it up): the composer's
  // button when the box is empty, or Esc anywhere on the page (composer empty, nothing open).
  const { canStop: mayStop, stop: stopRun } = useStopRun();
  const stoppableKey = useStreams((s) =>
    scopedRuns(s)
      .filter((r) => isStoppable(r) && !r.stopping)
      .map((r) => r.runId)
      .join(" "),
  );
  /** The most recent run at work here (anyone writing chooses "Juntar" or "Parar e mandar" for it). */
  const busyTarget = stoppableKey
    ? scopedRuns(live.get().streams)
        .filter((r) => isStoppable(r) && !r.stopping)
        .at(-1)
    : undefined;
  /** The most recent run here that I may stop. */
  const stopTarget = stoppableKey
    ? scopedRuns(live.get().streams)
        .filter((r) => isStoppable(r) && !r.stopping && mayStop(r))
        .at(-1)
    : undefined;
  const draftRef = useRef("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || draftRef.current.trim()) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (!stopTarget) return;
      e.preventDefault();
      stopRun(stopTarget);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // The thread open in the panel beside the channel ("Responder", a thread's line); `reply`: to its composer.
  const [panel, setPanel] = useState<{ id: string; reply: boolean } | null>(null);
  // "Ver perfil" (a DM's header, the profile card): the agent's page in the same place; one panel at a time.
  const [profileId, setProfileId] = useState<string | null>(null);
  const outerPanel = useOpenAgentPanel();
  const openAgentPanel = useCallback((agentId: string) => {
    setPanel(null);
    setProfileId(agentId);
  }, []);
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
  const qc = useQueryClient();
  // Failed copies already looked at (so a server refusal is never queued later as "offline").
  const seenFailed = useRef(new Set<string>());
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
      // An agent already at work here takes the message into that work ("lê na próxima pausa"): the
      // server starts no second run, so no second "pensando…" (a DM: any of its runs here; a thread: there).
      const atWork = (agentId: string) =>
        Object.values(live.get().streams.runs).some(
          (r) =>
            !r.provisional &&
            r.agentId === agentId &&
            r.channelId === channel.id &&
            WORKING.has(r.status) &&
            (chrome?.dmAgentId ? true : Boolean(local.threadId) && r.threadId === local.threadId),
        );
      const fresh = agents.filter((id) => !atWork(id));
      if (fresh.length > 0) live.expect(channel.id, local.id, fresh);
    },
    onSent: (message, local) => {
      if (local.clientId) outbox.remove(local.clientId);
      live.retarget(local.id, message.id);
    },
    // A thread archived meanwhile (`thread.archived`): say so in the person's language.
    onFailed: (error) => {
      if (errorCode(error)?.startsWith("thread.")) toast.show(errorText(t, error), "error");
      // No connection: the message waits ("sai quando a internet voltar") and goes out when it is back.
      // The copy turns "failed" right after this callback; pick it up then.
      const offline = failedOffline(error);
      queueMicrotask(() => {
        for (const m of qc.getQueryData<MessageType[]>(keys.messages(org.id, channel.id)) ?? []) {
          if (m.local !== "failed" || !m.clientId || seenFailed.current.has(m.clientId)) continue;
          seenFailed.current.add(m.clientId);
          if (offline) outbox.add(m.clientId);
        }
      });
    },
  });
  const { send, retry } = sendHelpers(post);
  // Back online (the socket reopened, or the browser says so): what waited goes out, in order.
  const status = useConnectionStatus();
  const flushOutbox = useRef(() => {});
  flushOutbox.current = () => {
    if (browserOffline()) return;
    for (const m of qc.getQueryData<MessageType[]>(keys.messages(org.id, channel.id)) ?? []) {
      if (m.local !== "failed" || !outbox.has(m.clientId ?? undefined)) continue;
      if (m.clientId) {
        outbox.remove(m.clientId);
        seenFailed.current.delete(m.clientId);
      }
      retry(m);
    }
  };
  useEffect(() => {
    if (status === "open") flushOutbox.current();
  }, [status]);
  useEffect(() => {
    const online = () => flushOutbox.current();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);

  const api = useApi();
  // Reading the channel marks it read: the sidebar's badges (channel and DM) clear at once.
  const markChannelRead = useMarkChannelRead(org.id).mutate;
  const lastId = channelMessages.data?.at(-1)?.id;
  useEffect(() => {
    if (isMember && lastId && !lastId.startsWith("local-")) markChannelRead(channel.id);
  }, [markChannelRead, channel.id, isMember, lastId]);

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

  // The channel's messages: only what was said in the channel (agents asked there answer there, D67).
  // Every thread with replies is one line under its root; its replies live in the panel.
  const channelList = useMemo(() => {
    if (thread) return null;
    const top = [...older, ...(channelMessages.data ?? [])];
    const hidden = hiddenByThreads(threadList, top);
    // My replies from the panel wait in the channel's page until sent: they belong to the thread.
    const visible = top.filter((m) => !m.threadId && !hidden(m));
    const lines = new Map<string, { thread: ThreadInfo; count: number }>();
    for (const x of threadList) {
      // A range thread has its marker, a mission its card, a closed thread its own line.
      if (x.state !== "open" || x.context || x.mission || x.replyCount === 0) continue;
      lines.set(x.id, { thread: x, count: x.replyCount });
    }
    return { visible, lines };
  }, [thread, older, channelMessages.data, threadList]);
  // The channel's threads as the timeline draws them (none in a thread view).
  const threadsView = useMemo<ChannelThreadsView | null>(() => {
    if (thread || !channelList) return null;
    return {
      byId: new Map(threadList.filter((x) => x.state !== "archived").map((x) => [x.id, x])),
      marks: contextMarks(threadList, [...older, ...(channelMessages.data ?? [])], channel.id),
      open: panel?.id ?? null,
      lines: channelList.lines,
    };
  }, [thread, channelList, threadList, older, channelMessages.data, channel.id, panel?.id]);
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
    const items = buildTimeline(channelList?.visible ?? [], [], []);
    // A marker, a closed line or a thread's line is not a message: nothing groups under it.
    const special = (m: MessageType) =>
      Boolean(threadStartOf(m.meta)) ||
      threadsView?.byId.get(m.id)?.state === "closed" ||
      Boolean(channelList?.lines.has(m.id));
    return ungroupAfter(items, special);
  }, [thread, channelList, channelMessages.data, threadMessages.data, threadsView]);

  // The agents' blocks at the end of the conversation (one per run, from "pensando" to its final
  // message: `chat/run-slots.ts`). They change when runs start or end, never on a streaming delta.
  const liveRunsKey = useStreams((s) =>
    scopedRuns(s)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .map((r) => `${r.runId}\t${r.agentId}\t${r.provisional ? 1 : 0}`)
      .join("\n"),
  );
  const landedRuns = useMemo(
    () =>
      new Set(timeline.flatMap((i) => (i.kind === "message" && i.message.agentRunId ? [i.message.agentRunId] : []))),
    [timeline],
  );
  const slotsRef = useRef<RunSlot[]>([]);
  // Every block's key by run (the final message is drawn under it), kept for this view.
  const runKeys = useRef(new Map<string, string>());
  const [holdTick, setHoldTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `holdTick` re-checks blocks waiting for their message
  const slots = useMemo(() => {
    const live = liveRunsKey
      ? liveRunsKey.split("\n").map((line) => {
          const [runId = "", agentId = "", provisional] = line.split("\t");
          return { runId, agentId, provisional: provisional === "1" };
        })
      : [];
    // Its message is in a cache already (it lands in the timeline on the next render): hold the block.
    const expected = (runId: string) =>
      qc
        .getQueriesData<MessageType[]>({ queryKey: ["org", org.id, "channel", channel.id] })
        .some(([, list]) => Array.isArray(list) && list.some((m) => m?.agentRunId === runId));
    const next = nextSlots(slotsRef.current, live, {
      landed: (runId) => landedRuns.has(runId),
      expected,
      now: Date.now(),
    });
    for (const slot of next) runKeys.current.set(slot.runId, slot.key);
    const kept = sameSlots(slotsRef.current, next) ? slotsRef.current : next;
    slotsRef.current = kept;
    return kept;
  }, [liveRunsKey, landedRuns, holdTick, qc, org.id, channel.id]);
  // A block waiting for its message: look again once the wait is over (it goes if nothing came).
  useEffect(() => {
    if (!slots.some((x) => x.goneAt !== null)) return;
    const timer = setTimeout(() => setHoldTick((n) => n + 1), SLOT_HOLD_MS + 50);
    return () => clearTimeout(timer);
  }, [slots]);
  const slotsKey = slots.map((x) => x.key).join(" ");

  // Newest at the bottom: follow new messages and streaming text while the person is at the
  // bottom; if they scrolled up, offer "Novas mensagens" instead of jumping.
  const scroller = useRef<HTMLElement>(null);
  // Coming back to a channel scrolled up: restore that position (else the bottom).
  // A thread view (page or panel) keeps its own place, apart from its channel's.
  const scrollKey = thread ? `${channel.id}:${thread.id}` : channel.id;
  const savedScroll = useRef(scrollPositions.get(scrollKey));
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
  /** The newest row, when it is an agent's answer (walked from the end: no query over every row). */
  const newestAnswer = () => {
    let el = scroller.current?.lastElementChild ?? null;
    while (el && !el.classList.contains("ac-msg")) el = el.previousElementSibling;
    return el instanceof HTMLElement && el.dataset.readId ? el : null;
  };
  /** The person saw the end of the conversation: its newest answer never jumps back to its start. */
  const markRead = () => {
    const id = newestAnswer()?.dataset.readId;
    if (id) landed.current.add(id);
  };
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  // Scrolled up while things arrive: the first unseen row ("Novas" goes before it), an agent that
  // started meanwhile, and the divider (it fades ~3.5 s after the person gets there).
  const [unseenFrom, setUnseenFrom] = useState<string | null>(null);
  const [unseenRun, setUnseenRun] = useState(false);
  const [divider, setDivider] = useState<{ key: string; fading: boolean } | null>(null);
  const dividerTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const dropDividerTimers = () => {
    for (const timer of dividerTimers.current) clearTimeout(timer);
    dividerTimers.current = [];
  };
  useEffect(
    () => () => {
      for (const timer of dividerTimers.current) clearTimeout(timer);
    },
    [],
  );
  const unseenFromRef = useRef<string | null>(null);
  const dividerOn = useRef(false);
  /** Something arrived out of view: the divider before `key` (the first one since the person left). */
  const markUnseen = (key: string) => {
    if (unseenFromRef.current !== null) return;
    unseenFromRef.current = key;
    dropDividerTimers();
    dividerOn.current = true;
    setUnseenFrom(key);
    setDivider({ key, fading: false });
  };
  /** The person reached what was new: the pill goes, the divider fades a little later. */
  const clearUnseen = () => {
    if (unseenFromRef.current !== null) {
      unseenFromRef.current = null;
      setUnseenFrom(null);
    }
    setUnseenRun(false);
    if (!dividerOn.current || dividerTimers.current.length > 0) return;
    dividerTimers.current = [
      setTimeout(() => setDivider((d) => (d ? { ...d, fading: true } : d)), 3500),
      setTimeout(() => {
        dividerTimers.current = [];
        dividerOn.current = false;
        setDivider(null);
      }, 4100),
    ];
  };
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
        clearUnseen();
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
    clearUnseen();
  };
  const followRef = useRef(follow);
  followRef.current = follow;
  // Pinned to the bottom: anything that grows (an agent's words, images, cards, the skeleton turning
  // into messages, fonts) keeps the latest message in view until the person scrolls. A ResizeObserver
  // on the rows does it (at most once a frame, after layout), not a loop per streaming delta.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list only exists for members; re-attach when it appears
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const pin = () => {
      if (stick.current && Date.now() >= autoScrollUntil.current) followRef.current();
    };
    const ro = new ResizeObserver(pin);
    for (const child of Array.from(el.children)) ro.observe(child);
    ro.observe(el);
    // Only rows that came in are watched (observing every row again on each change cost a pass per delta).
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            for (const r of records) for (const n of Array.from(r.addedNodes)) if (n instanceof Element) ro.observe(n);
          });
    mo?.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, [isMember]);
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
    clearUnseen();
  };
  const previousSlots = useRef(slotsKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever rows or agents' blocks come
  useLayoutEffect(() => {
    // A new row glides down (streaming text is followed by the ResizeObserver above).
    // Not while the channel is still loading (first page, thread replies): that lands at once.
    const before = previousLastKey.current;
    const newRow = before !== lastKey;
    const settled = before !== undefined && Date.now() - openedAt.current > 1500;
    previousLastKey.current = lastKey;
    const blocks = previousSlots.current.split(" ");
    const newBlock = slotsKey.split(" ").some((k) => k && !blocks.includes(k));
    previousSlots.current = slotsKey;
    if (stick.current) follow((newRow || newBlock) && settled);
    // Holding a long answer at its start: "Fim da resposta" already leads to what comes after it.
    else if (!holdingRef.current) {
      const first = newRow ? firstNewKey(timeline, before) : null;
      if (first) markUnseen(first);
      if (newBlock) setUnseenRun(true);
    }
  }, [lastKey, slotsKey]);

  // Which agents' blocks are on screen: the line above the composer speaks only for those out of view.
  // By run: a "pensando…" hands its block (same key) to the real run, and that run must count as in view.
  const inView = useBlocksInView(scroller, slots.map((x) => x.runId).join(" "));
  const outOfView = useMemo(() => (runId: string) => !inView.has(runId), [inView]);
  /** "Ver" on that line: back to the agent's block. */
  const seeRun = (runId: string) => {
    const row = Array.from(scroller.current?.querySelectorAll<HTMLElement>("[data-run-id]") ?? []).find(
      (el) => el.dataset.runId === runId,
    );
    row?.scrollIntoView?.({ block: "end", behavior: reducedMotion ? "auto" : "smooth" });
  };

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
      if (stick.current || lastScrollTop.current === null) scrollPositions.delete(scrollKey);
      else scrollPositions.set(scrollKey, lastScrollTop.current);
    },
    [scrollKey],
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
    pillAgents.length > 0 || missionReply ? (
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

  const onSend = (text: string, opts?: { interrupt?: boolean }) => {
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
    const meta = localMeta(null, "", attached);
    // From the thread panel or page: the reply makes it a "Responder" thread (out of the channel's timeline).
    if (thread && chrome?.openThread) meta[OPEN_THREAD] = true;
    // "Parar e mandar" (⌘↵): the agent drops the step it is on and reads this now.
    send(text, thread ? thread.id : null, meta, opts?.interrupt ? { steer: "now" } : undefined);
    dropFiles(() => false);
  };
  // While an agent works here: the send button turns into stop (box empty), and typing offers
  // "Juntar ao que ele faz" (↵) or "Parar e mandar" (⌘↵).
  const stopName = stopTarget ? (dir.agentById.get(stopTarget.agentId)?.name ?? t("channel.unknownAgent")) : "";
  const stopGrammar = agentGrammar(t, stopName);
  const working = stopTarget
    ? {
        stopLabel: t("run.stopAgent", stopGrammar),
        stopText: `${t("run.stopAgent", stopGrammar)} · Esc`,
        onStop: () => stopRun(stopTarget),
      }
    : null;
  // The choice is for anyone who writes while an agent works (the stop button only for who may stop it).
  const busyGrammar = agentGrammar(
    t,
    busyTarget ? (dir.agentById.get(busyTarget.agentId)?.name ?? t("channel.unknownAgent")) : "",
  );
  const choice = busyTarget
    ? {
        label: t("run.choice.label", busyGrammar),
        joinLabel: t("run.choice.join", busyGrammar),
        interruptLabel: t("run.choice.interrupt"),
        hint: (c: "join" | "interrupt", mod: string) => (
          <>
            <Kbd>↵</Kbd> {c === "join" ? t("run.choice.joins") : t("run.choice.interrupts")} · <Kbd>{mod}↵</Kbd>{" "}
            {c === "join" ? t("run.choice.interrupts") : t("run.choice.joins")}
          </>
        ),
      }
    : undefined;
  // The "↓ novas" pill: how many, who spoke, and who is writing now.
  const unseenSummary = useMemo(() => unseenOf(timeline, unseenFrom, me.user.id), [timeline, unseenFrom, me.user.id]);
  const writingAgents = useStreams((s) =>
    scopedRuns(s)
      .filter((r) => r.status === "running" && r.text.length > 0)
      .map((r) => r.agentId)
      .filter((id, i, all) => all.indexOf(id) === i)
      .join(" "),
  );
  const pillOn = unseenFrom !== null || unseenRun;
  const pillWriting = pillOn && writingAgents ? writingAgents.split(" ") : [];
  const pillAuthors = unseenSummary.authors.filter((a) => !(a.type === "agent" && pillWriting.includes(a.id ?? "")));
  const pillText = pillParts(
    t,
    unseenSummary.count,
    pillAuthors.map((a) => dir.authorName(a)),
    pillWriting.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent")),
  );
  /** The pill: to the "Novas" divider when it is far up, else to the end. */
  const openUnseen = () => {
    const el = scroller.current;
    const line = el?.querySelector<HTMLElement>(".channel__unread");
    // Without layout (no size) there is nothing to measure: the end.
    if (el && line && line.offsetHeight > 0) {
      const top = line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      if (dividerIsFar(top, el.scrollHeight, el.clientHeight)) {
        autoScrollUntil.current = Date.now() + 600;
        if (!reducedMotion && typeof el.scrollTo === "function") el.scrollTo({ top: top - 12, behavior: "smooth" });
        else el.scrollTop = top - 12;
        clearUnseen();
        return;
      }
    }
    toBottom(true);
  };
  const emptySuggestions = useMemo(() => {
    if (chrome?.suggestions) return chrome.suggestions;
    const first = channelAgents[0];
    return first ? greetingSuggestions(t, first.role).map((s) => `@${first.handle} ${s}`) : [];
  }, [chrome?.suggestions, channelAgents, t]);

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
    // "Responder": in a thread view everything already goes to the thread; in a channel, the message's
    // thread opens in the panel (a reply there starts it).
    reply: thread
      ? () => composer.current?.focus()
      : (message) => {
          setProfileId(null);
          setPanel({ id: message.threadId ?? message.id, reply: true });
        },
    openThread: thread
      ? undefined
      : (id) => {
          setProfileId(null);
          setPanel({ id, reply: false });
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
    replyToMission: (missionId, label) => {
      setMissionReply({ missionId, label });
      composer.current?.focus();
    },
  };

  // A DM with an agent: the agent's chip sits in the composer's toolbar row.
  const agentDm = Boolean(chrome?.dmAgentId) && !thread;
  const Tag = chrome?.panel ? "section" : "main";
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
    // A thread inside the panel opens profiles in its channel's panel, not inside itself.
    <AgentPanelContext.Provider value={chrome?.panel ? outerPanel : openAgentPanel}>
      <ChannelActionsContext.Provider value={actions}>
        <ChannelThreadsContext.Provider value={threadsView}>
          {/* A DM with an agent reads as one centered column; channels, threads and DMs between people
            are a left-aligned team chat (telas/RefinoUI.html, "Conversa: Nova leitura"). */}
          <Tag className={cx("shell__main shell__main--chat", chrome?.panel && "thread-panel__chat")}>
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
                    if (near) clearUnseen();
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
                  {messages.isSuccess && timeline.length === 0 && slots.length === 0 && !thread && !adjusting && (
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
                      <Timeline
                        items={timeline}
                        ready={messages.isSuccess}
                        slots={slots}
                        runKeys={runKeys.current}
                        divider={divider}
                        channelId={channel.id}
                        runVisible={runVisible}
                        seenId={thread ? null : seenId}
                      />
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
                </section>
                {holding && (
                  <div className="channel__pill">
                    <Button size="sm" className="ac-new-messages" onClick={() => toBottom(true)}>
                      <Icon name="chevronDown" size={16} />
                      {t("channel.endOfReply")}
                    </Button>
                  </div>
                )}
                <div className="channel__pill">
                  <button
                    type="button"
                    className="channel__newpill"
                    data-on={(pillOn && !holding) || undefined}
                    aria-hidden={!pillOn || holding || undefined}
                    tabIndex={pillOn && !holding ? 0 : -1}
                    aria-label={t("channel.newPill.label", { text: pillText.join(" · ") || t("channel.newMessages") })}
                    onClick={openUnseen}
                  >
                    <Icon name="chevronDown" size={16} />
                    <span className="channel__newpill-stack" aria-hidden="true">
                      {[
                        ...pillWriting.map((id) => ({ type: "agent" as const, id })),
                        ...pillAuthors.flatMap((a) => (a.id ? [{ type: a.type, id: a.id }] : [])),
                      ]
                        .filter((a, i, all) => all.findIndex((x) => x.type === a.type && x.id === a.id) === i)
                        .slice(0, 3)
                        .map((a) => (
                          <ActorAvatar key={`${a.type}:${a.id}`} actor={a} size="xs" name={dir.authorName(a)} />
                        ))}
                    </span>
                    <span>{pillText[0] ?? t("channel.newMessages")}</span>
                    {pillText.length > 1 && (
                      <span className="channel__newpill-more">
                        {pillText
                          .slice(1)
                          .map((x) => `· ${x}`)
                          .join(" ")}
                      </span>
                    )}
                  </button>
                </div>
                <div className="channel__composer">
                  <ConnectionBanner status={status} />
                  <ActivityBar
                    channelId={channel.id}
                    visible={runVisible}
                    outOfView={outOfView}
                    onSee={seeRun}
                    stoppable={stopTarget?.runId}
                  />
                  {adjustThreadId ? (
                    <RangeBar adjust={adjust} />
                  ) : chrome?.composerReplacement ? (
                    chrome.composerReplacement
                  ) : (
                    <>
                      <Composer
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
                        id={`composer-${thread?.id ?? channel.id}`}
                        textareaRef={composer}
                        value={draft}
                        onChange={(v) => {
                          setDraft(v);
                          if (v.trim()) sendTyping();
                        }}
                        onSend={onSend}
                        working={chrome?.locked ? null : working}
                        choice={choice}
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
                        commands={
                          commands.length > 0 ? { listLabel: t("composer.commands"), list: commands } : undefined
                        }
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
          </Tag>
          {panel && (
            <button
              type="button"
              className="thread-panel__scrim"
              tabIndex={-1}
              aria-label={t("common.close")}
              onClick={() => setPanel(null)}
            />
          )}
          {panel && (
            <aside className="thread-panel" aria-label={t("threads.side.label")}>
              <ThreadPage key={panel.id} threadId={panel.id} reply={panel.reply} onClose={() => setPanel(null)} />
            </aside>
          )}
          {profileId && <AgentPanel key={profileId} agentId={profileId} onClose={() => setProfileId(null)} />}
        </ChannelThreadsContext.Provider>
      </ChannelActionsContext.Provider>
    </AgentPanelContext.Provider>
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

/**
 * Persisted rows, then the agents' live blocks (always last while they work: new messages go above
 * them). One flat keyed list: an answer seen live is drawn under its block's key, so the final message
 * takes the block's place without a remount. Memoized: streaming deltas don't re-render it.
 */
const Timeline = memo(function Timeline({
  items,
  ready,
  slots,
  runKeys,
  divider,
  channelId,
  runVisible,
  seenId = null,
}: {
  items: ReturnType<typeof buildTimeline>;
  /** The first page loaded: rows from then on slide in. */
  ready: boolean;
  /** The agents' blocks at work (`chat/run-slots.ts`). */
  slots: RunSlot[];
  /** Each block's key by run id: its final message is drawn under it. */
  runKeys: Map<string, string>;
  /** "Novas": before this row, fading once the person got there. */
  divider: { key: string; fading: boolean } | null;
  /** This conversation's channel, and which runs' threads it shows (a held browser card's place). */
  channelId: string;
  runVisible: { current: (r: { threadId: string | null; provisional?: boolean }) => boolean };
  /** A DM with a person: my message they read last ("Visto" under it). */
  seenId?: string | null;
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
  // A block slides in once, when it first shows (not the ones already working when the page opened).
  const blockEnters = useRef(new Map<string, boolean>());
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
  /** A closed thread is one line; the root of a thread made from a range is its marker (or stub). */
  const threadRow = (key: string, m: MessageType) => {
    // What reached an agent's conversation (a routine's report nobody answered yet, another agent's
    // answer): quiet lines, never a person's or the agent's own voice.
    if (noticeOf(m.meta)) return <NoticeLine key={key} message={m} />;
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
  // A run can post more than one message (text before a card, the card, the final reply): only its
  // last one is drawn under the block's key, the others under their own (keys stay unique).
  const blockRows = useMemo(() => blockRowByRun(items, new Set(slots.map((s) => s.runId))), [items, slots]);
  // Each run's last message here carries its browser card while a take over holds it (`HeldBrowserCard`).
  const lastByRun = useMemo(() => {
    const out = new Map<string, string>();
    for (const i of items) if (i.kind === "message" && i.message.agentRunId) out.set(i.message.agentRunId, i.key);
    return out;
  }, [items]);
  // The block that opens is the first one at work: a failed or stopped block draws anyway and never hides it.
  const opener = useStreams(
    (s) =>
      slots.find((x) => {
        const r = s.runs[x.runId];
        return !r || !drawsBehind(r);
      })?.runId,
  );
  // A take over whose run has no live block and no message here: its card at the end (`HeldBrowserRow`).
  const heldPlaces = useHeldPlaces();
  const held = useMemo(
    () =>
      heldRowsIn(heldPlaces, {
        channelId,
        visible: (threadId) => runVisible.current({ threadId: threadId ?? null }),
        live: new Set(slots.map((x) => x.runId)),
        landed: new Set(lastByRun.keys()),
      }),
    [heldPlaces, channelId, runVisible, slots, lastByRun],
  );
  const rows: ReactNode[] = [];
  for (const item of items) {
    if (divider?.key === item.key) {
      rows.push(
        <div key="unread-divider" className="channel__unread" data-fade={divider.fading || undefined}>
          {t("channel.unreadDivider")}
        </div>,
      );
    }
    if (item.kind === "day") {
      rows.push(<DayDivider key={item.key}>{dayLabel(t, i18n.language, item.iso)}</DayDivider>);
      continue;
    }
    if (item.kind !== "message") continue;
    const m = item.message;
    const special = threadRow(item.key, m);
    if (special) {
      rows.push(special);
      continue;
    }
    const entering = initial !== null && entersWithMotion(item.key, m.createdAt, initial, mountedAt);
    const blockKey = m.agentRunId && blockRows.get(m.agentRunId) === item.key ? runKeys.get(m.agentRunId) : undefined;
    rows.push(
      blockKey && m.agentRunId ? (
        // Seen live: the same block, grouped as it was while it worked.
        <RunBlock
          key={blockKey}
          runId={m.agentRunId}
          message={m}
          grouped={item.grouped}
          entering={false}
          modelLabels={modelLabels}
          contextMark={threadsView?.marks.has(m.id)}
          replyContext={item.context}
          lastOfRun={lastByRun.get(m.agentRunId) === item.key}
        />
      ) : (
        <TimelineMessage
          key={item.key}
          message={m}
          grouped={item.grouped}
          entering={entering}
          modelLabels={modelLabels}
          contextMark={threadsView?.marks.has(m.id)}
          replyContext={item.context}
          lastOfRun={Boolean(m.agentRunId && lastByRun.get(m.agentRunId) === item.key)}
        />
      ),
    );
    if (m.id === seenId)
      rows.push(
        <p key="dm-seen" className="channel__seen" aria-live="polite">
          {t("channel.seen")}
        </p>,
      );
  }
  // The first block at work follows the last message: under the agent's own, it has no header of its own.
  const lastItem = items.at(-1);
  const after = lastItem?.kind === "message" ? lastItem.message : null;
  slots.forEach((slot, i) => {
    if (!blockEnters.current.has(slot.key)) blockEnters.current.set(slot.key, ready && Date.now() - mountedAt > 1500);
    rows.push(
      <RunBlock
        key={slot.key}
        runId={slot.runId}
        after={i === 0 ? after : null}
        opens={slot.runId === (opener ?? slots[0]?.runId)}
        grouped={false}
        entering={blockEnters.current.get(slot.key) ?? false}
        modelLabels={modelLabels}
      />,
    );
  });
  for (const place of held) rows.push(<HeldBrowserRow key={`held-${place.runId}`} place={place} />);
  return <>{rows}</>;
});

/**
 * A person holds the agent's browser (Assumir) for a run that has no live block and posted nothing
 * here (it paused without a word, or ended): the card stays at the end of its conversation, as the
 * agent's row, until the browser is handed back.
 */
function HeldBrowserRow({ place }: { place: HeldPlace }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const held = useHeldTakeover(place.agentId, place.runId);
  if (!held) return null;
  const name = dir.agentById.get(place.agentId)?.name ?? t("channel.unknownAgent");
  return (
    <Message
      agent
      stacked
      avatar={<AgentAvatar agentId={place.agentId} name={name} state="idle" />}
      author={name}
      time={t("common.now")}
    >
      <HeldBrowserCard agentId={place.agentId} runId={place.runId} name={name} />
    </Message>
  );
}

/** A run's last message asks whether a take over still holds its browser only this recently (older: events only). */
const HELD_RECENT_MS = 12 * 60 * 60_000;

/** Model names for the rows of "Ajustar trecho" (no usage line is shown there). */
const NO_LABELS = new Map<string, string>();

/** The live run as a message, while it has none (the block's text and header come from the run). */
function liveMessageOf(r: LiveRun): MessageType {
  return {
    id: `live:${r.runId}`,
    channelId: r.channelId,
    threadId: r.threadId,
    author: { type: "agent", id: r.agentId },
    body: "",
    mentionedAgentIds: [],
    agentRunId: r.runId,
    meta: {},
    createdAt: new Date(r.startedAt ?? Date.now()).toISOString(),
  } as MessageType;
}

/**
 * One agent's answer, from "pensando" to its final message (telas/Mensagens.html, "Um bloco só"): the
 * live run while it works, then the message, in the same component (same element: nothing remounts or
 * flashes). Until the message lands, the last live state stays on screen. Subscribed by run id, so a
 * streaming delta re-renders only this block.
 */
function RunBlock({
  runId,
  message,
  after,
  opens = true,
  grouped,
  ...rest
}: {
  runId: string;
  message?: MessageType;
  /** At work: the message right above it (the agent's own groups it, as a saved message would). */
  after?: Pick<MessageType, "author" | "createdAt"> | null;
  /** At work: the first block, the only one drawn while others work too (`drawsBehind`). */
  opens?: boolean;
  grouped: boolean;
  entering: boolean;
  modelLabels: Map<string, string>;
  contextMark?: boolean;
  replyContext?: ReplyRef;
  lastOfRun?: boolean;
}) {
  const run = useStreams((s) => (message ? undefined : s.runs[runId]));
  const last = useRef<LiveRun | undefined>(undefined);
  if (run) last.current = run;
  const live = message ? undefined : (run ?? last.current);
  const liveId = live?.runId;
  const liveAgent = live?.agentId;
  const liveChannel = live?.channelId;
  const liveThread = live?.threadId;
  const liveStart = live?.startedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the placeholder only depends on who and when
  const placeholder = useMemo(
    () => (live ? liveMessageOf(live) : null),
    [liveId, liveAgent, liveChannel, liveThread, liveStart],
  );
  // Just started and nothing of its own yet: it waits a moment, as a person would before answering.
  const quiet = Boolean(live && saysNothingYet(live));
  const due = useDue(liveStart ?? null, live ? openerDelayMs(live.runId) : 0, quiet);
  const shown = message ?? placeholder;
  if (!shown || (live && !opens && !drawsBehind(live))) return null;
  if (live && !message && quiet && !due) return null;
  const together = message
    ? grouped
    : Boolean(placeholder && groupsWith(after, placeholder.author, placeholder.createdAt));
  return (
    <TimelineMessage
      message={shown}
      live={live ?? null}
      seenLive={message ? last.current : undefined}
      grouped={together}
      {...rest}
    />
  );
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

/** The generic phrases a block opens with (`openerOf`). */
const OPENER_KEYS = ["run.opener0", "run.opener1", "run.opener2"] as const;

/**
 * The block's header: the time it started, as any message. What it is doing and for how long is the
 * bar's above the composer (saying it twice was noise).
 */
function RunClock({ run }: { run: LiveRun }) {
  const { i18n } = useTranslation();
  const [at] = useState(() => new Date(run.startedAt ?? Date.now()).toISOString());
  return <time dateTime={at}>{formatTime(i18n.language, at)}</time>;
}

/** Under a live block: "sem notícias há 4 min · Atualizar", or what it is doing between its steps. */
function LiveRunStatus({ run }: { run: LiveRun }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const liveStore = useLiveStore();
  // A run with no news for minutes (orphaned by a restart?): say so and offer to check.
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
  const quiet = isQuiet(run);
  const [checking, setChecking] = useState(false);
  const recheck = () => {
    setChecking(true);
    void reconcileChannelRuns(api, liveStore, org.id, run.channelId, [run.runId])
      .then((dropped) => {
        if (dropped) void qc.invalidateQueries({ queryKey: keys.messages(org.id, run.channelId) });
      })
      .finally(() => setChecking(false));
  };
  const doing = run.tool ? toolActivity(run.tool, run.connector) : null;
  const showDoing =
    !quiet && doing && doing.kind !== "thinking" && !(run.work ?? []).some((w) => w.kind === "call" && w.running);
  if (!quiet && !showDoing) return null;
  return (
    <div className="run-status">
      {quiet ? (
        <p className="ac-msg__activity run-quiet">
          {t("run.quiet", {
            minutes: Math.max(3, Math.floor((Date.now() - (run.lastEventAt ?? run.startedAt ?? 0)) / 60_000)),
          })}
          {" · "}
          <Button variant="ghost" size="sm" loading={checking} onClick={recheck}>
            {t("run.refresh")}
          </Button>
        </p>
      ) : (
        doing && (
          <p className="ac-msg__activity" aria-live="polite">
            {capitalize(activityVerb(t, doing))}…
          </p>
        )
      )}
    </div>
  );
}

/**
 * Under a stopped answer (telas/Mensagens.html): "Parado por você · Continuar". Continuar starts a new
 * run of the same agent from where it stopped; it goes away for everyone once someone pressed it.
 */
function StoppedLine({
  runId,
  byUserId,
  note,
  owner,
  message,
}: {
  runId: string | null | undefined;
  byUserId: string | null | undefined;
  /** The server's line, for older messages without a person in the meta. */
  note?: string | null;
  /** Who may continue: the same people who may stop it. */
  owner: { agentId: string; channelId: string; threadId: string; triggerMessageId?: string | null } | null;
  /** The stopped reply, once it is saved (its meta says when it was continued). */
  message?: MessageType;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { canStop } = useStopRun();
  const cont = useContinueRun();
  const continued = useWasContinued(runId, message);
  const stopper = byUserId ? dir.memberById.get(byUserId)?.name : undefined;
  const who =
    byUserId && byUserId === me.user.id
      ? t("run.stoppedByYou")
      : stopper
        ? t("run.stoppedBy", { name: stopper })
        : byUserId || !note
          ? t("run.stopped")
          : note;
  // Only a run a person stopped picks up again.
  const can = Boolean(runId && byUserId && owner && !continued && canStop(owner));
  return (
    <p className="ac-msg__activity run-canceled">
      <PixelStop size={12} dim />
      <span>{who}</span>
      {can && runId && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="run-continue" disabled={cont.isPending} onClick={() => cont.mutate(runId)}>
            <Icon name="play" size={14} />
            {t("run.continueRun")}
          </button>
        </>
      )}
    </p>
  );
}

/**
 * Under a message sent while an agent worked: "Theo lê na próxima pausa" → "Theo leu" (its face);
 * "Theo parou para ler" when the person asked it to stop and read now (or it woke a wait); "Theo
 * recebeu" once handed to Claude Code mid-turn; "lê depois da sua decisão no card" while an approval
 * holds it; "encerrou o pedido de ajuda" when it ended the wait.
 */
function SteerLine({ steer }: { steer: SteerState }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.agentById.get(steer.agentId)?.name;
  if (!name) return null;
  return (
    <p className="msg-steer" data-state={steer.state} aria-live="polite">
      {/* Keyed by the state: each new word swaps in. */}
      <span key={steer.state} className="msg-steer__swap">
        {steer.state === "waiting" ? (
          <>
            <PixelSpinner size={14} />
            {t("run.steer.waiting", { name })}
          </>
        ) : steer.state === "now" ? (
          <>
            <Icon name="bolt" size={14} />
            {t("run.steer.now", { name })}
          </>
        ) : steer.state === "delivered" ? (
          <>
            <Icon name="check" size={14} />
            {t("run.steer.delivered", { name })}
          </>
        ) : steer.state === "held" ? (
          <>
            <Icon name="waiting" size={14} />
            {t("run.steer.held", { name })}
          </>
        ) : (
          <>
            <AgentAvatar agentId={steer.agentId} name={name} size="xs" state="idle" />
            {t(steer.state === "resolved" ? "run.steer.resolved" : "run.steer.read", { name })}
          </>
        )}
      </span>
    </p>
  );
}

/** Shows only after `ms` while `on` ("enviando" waits half a second: most sends never show it). */
/** True from `from + ms` on (now when `from` is unknown, i.e. counted from the mount), while `on`. */
function useDue(from: number | null, ms: number, on: boolean) {
  const [start] = useState(() => Date.now());
  const at = (from ?? start) + ms;
  const [, tick] = useState(0);
  const wait = at - Date.now();
  useEffect(() => {
    if (!on || wait <= 0) return;
    const timer = setTimeout(() => tick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [on, wait]);
  return !on || wait <= 0;
}

function useAfter(ms: number, on: boolean) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [ms, on]);
  return on && late;
}

/**
 * Above the composer when the connection drops: "Sem internet. O que você mandar sai sozinho quando
 * voltar." (what is sent meanwhile waits and goes out on its own), then "Conectado de novo" for 1.6 s.
 * A socket that only reconnects for a moment says nothing.
 */
function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  const { t } = useTranslation();
  const [offline, setOffline] = useState(browserOffline);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  const reconnecting = status === "reconnecting";
  const [longReconnect, setLongReconnect] = useState(false);
  useEffect(() => {
    if (!reconnecting) {
      setLongReconnect(false);
      return;
    }
    const timer = setTimeout(() => setLongReconnect(true), 1500);
    return () => clearTimeout(timer);
  }, [reconnecting]);
  const down = offline || (reconnecting && longReconnect);
  const [back, setBack] = useState(false);
  const wasDown = useRef(false);
  useEffect(() => {
    if (down) {
      wasDown.current = true;
      setBack(false);
      return;
    }
    if (!wasDown.current) return;
    wasDown.current = false;
    setBack(true);
    const timer = setTimeout(() => setBack(false), 1600);
    return () => clearTimeout(timer);
  }, [down]);
  if (!down && !back) return null;
  return (
    <p className="channel__conn" data-back={!down || undefined} role="status">
      <Icon name={down ? "cloud" : "check"} size={16} />
      {down ? t("channel.offline") : t("channel.backOnline")}
    </p>
  );
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * The live blocks (`data-run-id`) at least partly inside the scroller: measured once when they come
 * (no frame of the line above the composer for a block in plain sight), then by an IntersectionObserver.
 */
function useBlocksInView(scroller: { current: HTMLElement | null }, key: string) {
  const [inView, setInView] = useState<Set<string>>(() => new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` changes when blocks come or go
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-run-id]"));
    const box = root.getBoundingClientRect();
    const now = new Set<string>();
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.height > 0 && r.bottom > box.top && r.top < box.bottom) now.add(row.dataset.runId ?? "");
    }
    setInView((prev) => (sameSet(prev, now) ? prev : now));
    if (typeof IntersectionObserver === "undefined" || rows.length === 0) return;
    const io = new IntersectionObserver(
      (entries) =>
        setInView((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.runId ?? "";
            if (e.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return sameSet(prev, next) ? prev : next;
        }),
      { root, threshold: 0 },
    );
    for (const row of rows) io.observe(row);
    return () => io.disconnect();
  }, [key]);
  return inView;
}

/**
 * The card right above the composer (telas/CardTrabalhando.html, A): while an agent works, the glass
 * pill in its color with a turning phrase (a light line while it thinks, what it does, what it said
 * last), the time, "Ver" when its block is out of view and the stop; and who is typing.
 */
function ActivityBar({
  channelId,
  visible,
  outOfView,
  onSee,
  stoppable,
}: {
  channelId: string;
  /** Which runs belong here (a thread view shows only its own). */
  visible?: { current: (r: { threadId: string | null; provisional?: boolean }) => boolean };
  /** The run's block is not on screen ("Ver" brings it back). */
  outOfView: (runId: string) => boolean;
  /** "Ver": back to that block. */
  onSee: (runId: string) => void;
  /** The run Esc stops (the pill shows its stop). */
  stoppable?: string;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const all = useStreams((s) => runsInChannel(s, channelId).filter((r) => visible?.current(r) ?? true), sameRuns);
  const runs = all.filter((r) => r.status !== "failed" && r.status !== "canceled");
  const typing = useLive((s) => s.typing[channelId]);
  // Ticks while someone is on it (a question out counts: seen on the last render).
  const asking = useRef(false);
  const now = useSecond(runs.length > 0 || Boolean(typing) || asking.current);
  // An agent asking another one: "Dev está perguntando ao Infra… 0:12" (its run pauses meanwhile).
  const consults = useLive(
    (s) => consultsIn(s.consults, channelId, now).filter((c) => visible?.current(c) ?? true),
    sameList,
  );
  asking.current = consults.length > 0;
  const ids = typingIn({ [channelId]: typing ?? {} }, channelId, now, me.user.id);
  const entries = barEntries(
    runs,
    ids,
    (id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent"),
    (id) => dir.memberById.get(id)?.name,
    consults,
    true,
  );
  const { stop } = useStopRun();
  const active = entries.length > 0;
  // The strip behind the bar (and the orbit) take the color of the first agent at work.
  const firstAgent = entries.find((e) => e.type === "agent");
  const firstRun = firstAgent ? runs.find((r) => r.agentId === firstAgent.id) : undefined;
  const took = firstRun ? elapsedParts(now - (firstRun.startedAt ?? now)) : null;
  // Agents running code: "Ver código" with the live code and output.
  const coding = runs.filter(
    (r) => outOfView(r.runId) && r.code && (r.work ?? []).some((w) => w.kind === "call" && w.running),
  );
  // An agent working in its browser: the bar says so, and a click opens its browser card in the conversation.
  const browsing = runs.find((r) => !isWriting(r) && usesBrowser(r));
  const openBrowser = browsing ? () => requestBrowserCard({ agentId: browsing.agentId }) : undefined;
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
                // Its own buttons (Ver) keep their job.
                if ((e.target as HTMLElement).closest("button, [role=dialog]")) return;
                openBrowser();
              }
            : undefined
        }
      >
        {active && (
          <>
            {firstAgent && <ActivitySky color={colorOf(dir.agentById.get(firstAgent.id))} />}
            {/* Agents at work: the pixel orbit in the first one's color (people only typing: the dots). */}
            {firstAgent && <AgentSpinner agentId={firstAgent.id} size={14} />}
            <WorkingStack entries={entries} />
            {/* The phrase turns: the old one leaves upward, the new one comes from below. Names in ink. */}
            <span className="ac-typing__text">
              <BarPhrase entries={entries} runs={runs} />
            </span>
            <ConsultClock entries={entries} now={now} />
            {took && !entries.some((e) => e.consult?.status === "asking") && (
              <span className="ac-typing__elapsed ac-num">
                {took.m > 0
                  ? t("run.elapsedMinutes", { m: took.m, s: took.s })
                  : t("run.elapsedSeconds", { n: took.s })}
              </span>
            )}
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
            {firstRun && outOfView(firstRun.runId) && (
              <>
                <span className="ac-typing__sep" aria-hidden="true" />
                <button type="button" className="ac-typing__see" onClick={() => onSee(firstRun.runId)}>
                  {t("run.strip.see")}
                </button>
              </>
            )}
            {firstRun && stoppable === firstRun.runId && <StopButton run={firstRun} onStop={stop} place="bar" />}
          </>
        )}
      </div>
    </>
  );
}

/**
 * One row; agent replies get feedback actions, people's messages get receipts. With `live`, the agent's
 * answer while it works (its steps, its words arriving, how to stop it): the same component, so the
 * final message takes over in place (`RunBlock`).
 */
export const TimelineMessage = memo(function TimelineMessage({
  message: m,
  grouped,
  entering,
  modelLabels,
  contextMark,
  replyContext,
  live = null,
  seenLive,
  lastOfRun = false,
}: {
  message: MessageType;
  grouped: boolean;
  entering: boolean;
  modelLabels: Map<string, string>;
  /** Part of a thread's context (still in the channel): the quiet mark in the gutter. */
  contextMark?: boolean;
  /** Shown away from the message it answers: that message, quoted above (`buildTimeline`). */
  replyContext?: ReplyRef;
  /** The run still at work (the row is its live block; `message` is a placeholder). */
  live?: LiveRun | null;
  /** This answer was watched live here: its last live state (the steps fold into "3 passos"). */
  seenLive?: LiveRun;
  /** The last message of its run here: it carries the run's browser card while a take over holds it. */
  lastOfRun?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const qc = useQueryClient();
  const dismissRun = useDismissRun();
  // The words arrive at a steady reading pace, each fading in (`MessageBody live`).
  const revealed = useRevealedText(live?.text ?? "");
  const liveFailed = live?.status === "failed";
  const liveWaiting = live?.status === "waiting_approval";
  const liveStopped = live?.status === "canceled";
  const opening = live ? openerOf(live) : { said: null, opener: null, work: [] };
  // A sent message that waits for the connection: not "Não enviada", it goes out on its own.
  const queued = useQueued(m.local === "failed" ? (m.clientId ?? undefined) : undefined);
  const local = m.local === "failed" && queued ? "pending" : m.local;
  const slowSend = useAfter(500, local === "pending");
  // The streamed row it replaces was already on screen: take its place without sliding in again.
  const replacesLive = useStreams((s) => Boolean(m.agentRunId && s.finished[m.agentRunId]));
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const threadLine = useChannelThreadsView()?.lines.get(m.id);
  const [active, setActive] = useState(false);
  const agent = m.author.type === "agent" ? dir.agentById.get(m.author.id ?? "") : undefined;
  const person = m.author.type === "person" ? dir.memberById.get(m.author.id ?? "") : undefined;
  const name = dir.authorName(m.author);
  // What a routine found, told by its agent (`meta.routine`): a tag that opens the routine, and the report
  // it answers on demand (that report's own line folds into this message).
  const routine = routineReplyOf(m);
  const [reportOpen, setReportOpen] = useState(false);
  const report = routine?.noticeId
    ? routineReportText(
        [
          ...(qc.getQueryData<MessageType[]>(keys.messages(org.id, m.channelId)) ?? []),
          ...((m.threadId && qc.getQueryData<MessageType[]>(keys.thread(org.id, m.channelId, m.threadId))) || []),
        ],
        routine.noticeId,
      )
    : null;
  // A short reply it gave while its task kept working (the talker): its message, "enquanto trabalha".
  const talker = m.author.type === "agent" && isTalkerReply(m.meta);
  const wikiLink = useWikiLinkRenderer();
  // It went into a running task: "Theo lê na próxima pausa" → "Theo leu" / "Theo parou para ler".
  const steer = useSteerState(org.id, m.channelId, m.author.type === "person" && !m.local ? m.id : "");
  /** A message that went into this run's work, as the well inside it shows it. */
  const steerNote = (messageId: string): SteerNote | undefined => {
    const lists = [
      qc.getQueryData<MessageType[]>(keys.messages(org.id, m.channelId)),
      m.threadId ? qc.getQueryData<MessageType[]>(keys.thread(org.id, m.channelId, m.threadId)) : undefined,
    ];
    const found = lists.flatMap((l) => l ?? []).find((x) => x.id === messageId);
    if (!found) return undefined;
    return {
      author: dir.authorName(found.author),
      mine: found.author.type === "person" && found.author.id === me.user.id,
      text: found.body,
    };
  };
  // A stopped run's message (`meta.canceled`): the text so far, and "Interrompido por Walter" as a note.
  // A text the server wrote (`meta.bodyCode`, a deploy's notice) is shown in the person's language.
  const stopped = useMemo(() => splitCanceled(serverBody(t, m.body, m.meta), m.meta), [t, m.body, m.meta]);
  const body = reminderBody(stopped.body, m.meta);

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
  // Where it browsed (`meta.browser`): the card stays after the run, its steps leave the work list.
  const browserTrail = useMemo(
    () => (m.author.type === "agent" ? browserTrailOf(m.meta) : []),
    [m.author.type, m.meta],
  );
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
  // Preparing the mission's copy of the project failed (ADR 0044): the card with "Tentar de novo".
  const missionSetup = missionSetupOf(meta);
  const missionCard = Boolean(
    missionPlan || missionDecision || missionReview || missionDelivery || missionCommand || missionSetup,
  );
  // The root of a mission in the channel: its work lives in its thread.
  const missionStart = !m.threadId && Boolean(meta.missionStart) && actions?.openThread !== undefined;
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
  const feedback = m.author.type === "agent" && !card && !m.local && !live;
  const menu = useMessageMenu(m, channelName ?? "", { feedback });
  // Watched live here: the steps it took stay in the block, folded ("3 passos"), instead of the summary.
  const keptAll = seenLive?.work?.length ? seenLive.work : null;
  const keptWork =
    keptAll && browserTrail.length > 0 ? keptAll.filter((w) => !(w.kind === "call" && isBrowserTool(w.tool))) : keptAll;
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
      data-message-id={live ? undefined : m.id}
      data-run-id={live?.runId}
      data-live={live?.status}
      // An agent's answer: lands at its start when long (same id as its live block, so only once).
      data-read-id={m.author.type === "agent" && !m.local ? (m.agentRunId ?? m.id) : undefined}
      grouped={grouped}
      entering={entering && !replacesLive}
      streaming={Boolean(live) && !liveFailed && !liveWaiting && !liveStopped}
      className={cx(local && `ac-msg--local ac-msg--${local}`, contextMark && "msg--context")}
      onMouseEnter={feedback ? () => setActive(true) : undefined}
      onFocus={feedback ? () => setActive(true) : undefined}
      onContextMenu={live ? undefined : menu.onContextMenu}
      avatar={
        m.author.id ? (
          <ProfileTrigger actor={{ type: m.author.type, id: m.author.id }} label={t("profile.of", { name })} decorative>
            {agent ? (
              // At work: thinking, then writing; a saved message: the agent at rest.
              // A person's 👍/👎 on this message plays a face on it (`applyReactions`).
              <AgentAvatar
                agentId={agent.id}
                name={name}
                state={live ? agentStateOfRun(live) : "idle"}
                reactionKey={live ? undefined : m.id}
              />
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
        m.author.id ? (
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
            {routine && (
              <RoutineTag
                routine={routine}
                report={report}
                open={reportOpen}
                onToggle={() => setReportOpen((o) => !o)}
              />
            )}
            {talker && (
              <span className="msg-reminder msg-talker" title={t("chat.notice.talkerTip")}>
                {t("chat.notice.talker")}
              </span>
            )}
          </>
        ) : (
          name
        )
      }
      time={
        live ? <RunClock run={live} /> : <time dateTime={m.createdAt}>{formatTime(i18n.language, m.createdAt)}</time>
      }
      meta={m.local || live ? undefined : details}
      note={joinedTip ? { label: t("chat.joined.label"), tip: joinedTip } : undefined}
      status={
        liveWaiting
          ? { icon: "waiting", label: t("channel.waitingApproval") }
          : local === "pending"
            ? {
                // "enviando" only past half a second (most sends never show it); offline it says when it goes.
                mark: slowSend ? <PixelSpinner size={14} /> : undefined,
                label: (
                  <span className={slowSend ? undefined : "ac-visually-hidden"}>
                    {queued ? t("channel.sendingOffline") : t("channel.sending")}
                  </span>
                ),
              }
            : undefined
      }
      aside={m.author.type === "person" && !m.local ? <MessageReceipts message={m} /> : undefined}
      stacked={Boolean(card)}
    >
      {live ? (
        <>
          {/* It opens as if it had answered: a generic phrase until the first thing it says takes its place. */}
          {(opening.said || opening.opener !== null) && (
            <MessageText>
              <MessageBody
                body={opening.said ?? t(OPENER_KEYS[opening.opener ?? 0] ?? "run.opener0")}
                resolveMention={dir.mentionName}
              />
            </MessageText>
          )}
          {/* Steps, the messages it read, and each tool call (the same list folds when it is done). */}
          <LiveWorkList work={opening.work} steerNote={steerNote} agentId={live.agentId} stopped={liveStopped} />
          {liveFailed && (
            <p className="ac-msg__error" role="alert">
              <Icon name="alert" size={18} />
              <span style={{ flex: 1 }}>
                {live.error
                  ? t("channel.runFailed", { agent: name, reason: live.error })
                  : t("channel.runFailedNoReason", { agent: name })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                aria-label={t("common.close")}
                onClick={() => dismissRun(live.runId)}
              />
            </p>
          )}
          {/* Also on a failed or stopped run, for the person still in control (they hand back from it). */}
          <RunBrowserCard run={live} name={name} />
          {!liveFailed && revealed && (
            <MessageText>
              <MessageBody body={revealed} resolveMention={dir.mentionName} live={!liveStopped} />
            </MessageText>
          )}
          {liveStopped ? (
            <StoppedLine runId={live.runId} byUserId={live.canceledBy} owner={live} />
          ) : (
            !liveFailed && <LiveRunStatus run={live} />
          )}
          {!liveFailed && !liveWaiting && !liveStopped && (
            <span className="ac-visually-hidden">{t("channel.writing")}</span>
          )}
        </>
      ) : (
        <>
          {keptWork?.length && seenLive ? (
            <LiveWorkList
              work={keptWork}
              steerNote={steerNote}
              agentId={seenLive.agentId}
              done
              stopped={stopped.canceled}
            />
          ) : null}
          {routine && report && reportOpen && <RoutineReport text={report} />}
          {quoted && <QuotedMessage reply={quoted} />}
          {m.author.id &&
            consulted.map((c) => (
              <ConsultationCard key={c.consultationId} consultation={c} askerId={m.author.id ?? ""} />
            ))}
          {!missionCard &&
            !forumSuggestion &&
            !issueWork &&
            !waitNotice &&
            // A question's card already says it: its own text isn't repeated above.
            !(question && body.trim() === question.text.trim()) &&
            (body.trim() || (!card && !stopped.canceled && artifacts.length === 0)) && (
              <MessageText>
                <MessageBody
                  body={body}
                  resolveMention={dir.mentionName}
                  renderMention={renderMention}
                  wikiLink={wikiLink}
                />
              </MessageText>
            )}
          {stopped.canceled && (
            <StoppedLine
              runId={m.agentRunId}
              byUserId={stopped.byUserId}
              note={stopped.note}
              owner={
                m.author.type === "agent" && m.author.id
                  ? { agentId: m.author.id, channelId: m.channelId, threadId: m.threadId ?? m.id }
                  : null
              }
              message={m}
            />
          )}
          {local === "failed" && (
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
            memoryUpdates.map((u) => (
              <MemoryChangeCard key={`${u.action}-${u.itemId}`} update={u} agentId={agent.id} />
            ))}
          {waitNotice && <WaitingCard notice={waitNotice} agentId={m.author.id ?? null} />}
          {question && <QuestionCard question={question} />}
          {secretRequest && <SecretCard request={secretRequest} />}
          {browserHandoff && <BrowserHandoffCard handoff={browserHandoff} />}
          {browserTrail.length > 0 && m.author.id && !m.local && (
            <BrowserTrailCard
              agentId={m.author.id}
              runId={m.agentRunId ?? null}
              name={name}
              steps={browserTrail}
              stopped={stopped.canceled ? { byUserId: stopped.byUserId } : null}
              recent={Date.now() - Date.parse(m.createdAt) < HELD_RECENT_MS}
            />
          )}
          {lastOfRun && m.author.type === "agent" && m.author.id && m.agentRunId && !m.local && (
            <HeldBrowserCard
              agentId={m.author.id}
              runId={m.agentRunId}
              name={name}
              enabled={Date.now() - Date.parse(m.createdAt) < HELD_RECENT_MS}
            />
          )}
          {m.author.type === "agent" && m.agentRunId && !card && !m.local && !keptAll && (
            <MessageWork
              runId={m.agentRunId}
              meta={m.meta}
              agentName={agent?.name ?? name}
              skipBrowser={browserTrail.length > 0}
            />
          )}
          {forumTopicId && !forumSuggestion && <ForumMessageCard topicId={forumTopicId} />}
          {forumSuggestion && <ForumSuggestionCard message={m} suggestion={forumSuggestion} />}
          {missionPlan && <MissionPlanCard plan={missionPlan} />}
          {missionDecision && <MissionDecisionCard message={missionDecision} />}
          {missionReview && <MissionReviewCard message={missionReview} />}
          {missionDelivery && <MissionDeliveryCard message={missionDelivery} />}
          {missionCommand && <MissionCommandCard command={missionCommand} />}
          {missionSetup && <MissionSetupCard setup={missionSetup} threadId={m.threadId ?? null} />}
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
          {/* A "Responder" thread went on from here: its line (opens the panel). */}
          {threadLine && <ThreadReplyLine thread={threadLine.thread} count={threadLine.count} />}
          {feedback && (
            <MessageFeedback
              messageId={m.id}
              agentName={agent?.name ?? t("channel.unknownAgent")}
              active={active}
              initial={m.reactions}
              quick={<ReplyButton message={m} />}
              more={<MessageMoreMenu message={m} channelName={channelName ?? ""} />}
            />
          )}
          {feedback && <CorrectionAsk message={m} agentName={agent?.name ?? t("channel.unknownAgent")} />}
          {steer && <SteerLine steer={steer} />}
          {m.author.type === "person" && !m.local && (
            <PersonMessageActions message={m} authorName={name} channelName={channelName ?? ""} />
          )}
          {menu.dialog}
        </>
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

/** Above this many members the channel details list gets a search field. */
const DETAILS_SEARCH_FROM = 8;

/**
 * "Detalhes do canal" (telas/CanalDetalhes.html B): the description edited in place under the name
 * (saves on blur, Enter or close), members grouped as agents and people, one "⋯" per row with how an
 * agent replies and "Tirar do canal".
 */
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
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const roster = useRoster(org.id, channel.id, open && channel.isMember);
  const update = useUpdateChannel(org.id, channel.id);
  // The channel's creator may too, but the API doesn't say who created it yet: admins only.
  const editable = can(org.role, "configure");
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState(channel.topic);
  const [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState(false);
  // Who is about to be removed: asked first, in a dialog of its own.
  const [removing, setRemoving] = useState<{ kind: "person" | "agent"; id: string; name: string } | null>(null);
  // The last description sent: blur and close both save, and closing with the X does both.
  const sentTopic = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setTopic(channel.topic);
    sentTopic.current = null;
  }, [open, channel.topic]);
  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(id);
  }, [saved]);
  const saveTopic = () => {
    const next = topic.trim();
    if (!editable || next === channel.topic || next === sentTopic.current) return;
    sentTopic.current = next;
    update.mutate(
      { topic: next },
      {
        onSuccess: () => setSaved(true),
        onError: () => {
          sentTopic.current = null;
        },
      },
    );
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.roster(org.id, channel.id) });
    void qc.invalidateQueries({ queryKey: keys.channelMembers(org.id, channel.id) });
  };
  const remove = useMutation({
    mutationFn: (r: { kind: "person" | "agent"; id: string }) =>
      api.chat.removeMember(org.id, channel.id, r.kind === "agent" ? { agentId: r.id } : { userId: r.id }),
    onSuccess: () => {
      refresh();
      setRemoving(null);
    },
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
  const all = (roster.data ?? []).map((m) => ({
    key: `${m.type}-${m.id}`,
    kind: m.type,
    id: m.id,
    name: m.name,
    handle: m.handle ?? "",
    email: m.type === "person" ? (dir.memberById.get(m.id)?.email ?? "") : "",
    autoReply: Boolean(m.autoReply),
  }));
  const shown = all.filter((r) => !needle || `${r.name} ${r.handle} ${r.email}`.toLowerCase().includes(needle));
  const agents = shown.filter((r) => r.kind === "agent");
  const people = shown.filter((r) => r.kind === "person");
  const agentCount = all.filter((r) => r.kind === "agent").length;
  const inChannel = new Set((roster.data ?? []).map((m) => `${m.type}:${m.id}` as PickKey));
  const group = (label: string, count: number) => (
    <p className="member-group">
      <span className="ac-eyebrow">{label}</span>
      <span className="member-group__count">{count}</span>
    </p>
  );
  return (
    <>
      <Dialog
        open={open && !adding && !removing}
        onOpenChange={(o) => {
          if (!o) saveTopic();
          onOpenChange(o);
        }}
        title={
          <>
            {t("channel.detailsTitle", { channel: channel.name })}
            {editable && (
              <span className="channel-topic__saved" data-show={saved || undefined} aria-live="polite">
                {saved && (
                  <>
                    <Icon name="check" />
                    {t("common.saved")}
                  </>
                )}
              </span>
            )}
          </>
        }
        description={editable ? undefined : channel.topic || t("channel.noTopic")}
        closeLabel={t("common.close")}
      >
        {editable && (
          <div className="channel-topic">
            <input
              className="channel-topic__input"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onBlur={saveTopic}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder={t("channel.topicPlaceholder")}
              aria-label={t("channel.topicLabel")}
              maxLength={250}
            />
          </div>
        )}
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          search={all.length > DETAILS_SEARCH_FROM}
          searchLabel={t("channel.detailsSearch")}
          searchPlaceholder={t("channel.detailsSearch")}
          isEmpty={roster.isSuccess && shown.length === 0 && Boolean(needle)}
          emptyText={t("channel.detailsEmpty", { q })}
        >
          {agents.length > 0 && group(t("channelMembers.agents"), agentCount)}
          {agents.map((r) => (
            <div key={r.key} className="member-row">
              <ActorAvatar actor={{ type: "agent", id: r.id }} size="sm" name={r.name} />
              <span className="list-col">
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <span className="small muted">
                  {r.autoReply ? t("channelMembers.aloneLine") : t("channelMembers.mentionLine", { handle: r.handle })}
                </span>
              </span>
              {editable && (
                <Menu
                  align="end"
                  label={t("channelMembers.actions", { name: r.name })}
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="more"
                      aria-label={t("channelMembers.actions", { name: r.name })}
                      disabled={autoReply.isPending && autoReply.variables?.agentId === r.id}
                    />
                  }
                >
                  <MenuRadioGroup
                    label={t("channelMembers.replyHeading")}
                    value={r.autoReply ? "alone" : "mention"}
                    onValueChange={(v) => autoReply.mutate({ agentId: r.id, on: v === "alone" })}
                    options={[
                      {
                        value: "alone",
                        label: (
                          <>
                            {t("channelMembers.replyAlone")}
                            <span className="ac-menu__desc">{t("channelMembers.replyAloneHelp")}</span>
                          </>
                        ),
                      },
                      {
                        value: "mention",
                        label: (
                          <>
                            {t("channelMembers.replyMention")}
                            <span className="ac-menu__desc">
                              {t("channelMembers.replyMentionHelp", { handle: r.handle })}
                            </span>
                          </>
                        ),
                      },
                    ]}
                  />
                  <MenuSeparator />
                  <MenuItem icon="close" danger onSelect={() => setRemoving({ kind: "agent", id: r.id, name: r.name })}>
                    {t("channelMembers.remove")}
                  </MenuItem>
                </Menu>
              )}
            </div>
          ))}
          {people.length > 0 && group(t("channelMembers.people"), all.length - agentCount)}
          {people.map((r) => (
            <div key={r.key} className="member-row">
              <ActorAvatar actor={{ type: "person", id: r.id }} size="sm" name={r.name} />
              <span className="list-col">
                <span style={{ fontWeight: 600 }}>
                  {r.name}
                  {r.id === me.user.id && <span className="member-row__you">{t("common.you")}</span>}
                </span>
                <span className="small muted">{r.email}</span>
              </span>
              {/* Not on my own row: removing myself from my own list reads as a mistake. */}
              {editable && r.id !== me.user.id && (
                <Menu
                  align="end"
                  label={t("channelMembers.actions", { name: r.name })}
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="more"
                      aria-label={t("channelMembers.actions", { name: r.name })}
                    />
                  }
                >
                  <MenuItem
                    icon="close"
                    danger
                    onSelect={() => setRemoving({ kind: "person", id: r.id, name: r.name })}
                  >
                    {t("channelMembers.remove")}
                  </MenuItem>
                </Menu>
              )}
            </div>
          ))}
          {editable && !needle && (
            <button type="button" className="member-row member-row--add" onClick={() => setAdding(true)}>
              <span className="member-row__plus" aria-hidden="true">
                <Icon name="plus" />
              </span>
              {t("channelMembers.addRow")}
            </button>
          )}
        </DialogSearchList>
        <DialogFooter note={editable ? undefined : t("channelMembers.readOnly")} />
      </Dialog>
      <Dialog
        open={open && Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("channelMembers.removeTitle", { name: removing?.name ?? "", channel: channel.name })}
        description={t(
          removing?.kind === "agent" ? "channelMembers.removeAgentBody" : "channelMembers.removePersonBody",
        )}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>
            {t("channelMembers.removeConfirm")}
          </Button>
        </DialogFooter>
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
