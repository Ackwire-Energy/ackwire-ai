import {
  type Agent,
  type ArtifactDetail,
  type ArtifactRef,
  type BrowserHandoff,
  type ConnectionStatus,
  heldTakeoversHere,
  inMainTimeline,
  keys,
  type LiveRun,
  MESSAGES_PAGE,
  type Message,
  type MessageMedia,
  type MessagePin,
  type MessageReceipt,
  newClientId,
  type ReceiptsState,
  type ReplyRef,
  type RunConsultation,
  type SearchHit,
  sendHelpers,
  type ThreadInfo,
  typingIn,
  useAgentsBrowserHandoffs,
  useAiStatus,
  useApi,
  useChannels,
  useChannelThreads,
  useConsultations,
  useCreateMission,
  useDmReads,
  useDms,
  useHeldPlaces,
  useJoinChannel,
  useMarkChannelRead,
  useMarkThreadRead,
  useMessages,
  useMissionControl,
  usePins,
  usePostMessage,
  useRightHandWave,
  useRoster,
  useSettings,
  useSteerState,
  useThreadActivity,
  useThreadInfo,
  useThreadMessages,
  useThreadMission,
  useWaitingOnMe,
} from "@agenteschat/client";
import { activityVerb, consultDetails, lineStep, listNames } from "@agenteschat/client/lib/activity";
import { handoffAsk } from "@agenteschat/client/lib/agent-work";
import { canTalk } from "@agenteschat/client/lib/audience";
import { runPosition, screenAboveEnd } from "@agenteschat/client/lib/chat";
import { CHAT_RHYTHM, firstUnreadId, opensAtLastRead, unreadThreadRootId } from "@agenteschat/client/lib/chat-look";
import { type ConversationWait, conversationWaits } from "@agenteschat/client/lib/computer-queue";
import {
  asExchanges,
  consultBlocksNearEnd,
  consultNoticeFolds,
  consultsForLine,
} from "@agenteschat/client/lib/consult-group";
import { errorText, sendFailureOf, sendNeedsEdit } from "@agenteschat/client/lib/errors";
import { mentionsReader, offersEveryone } from "@agenteschat/client/lib/everyone";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "@agenteschat/client/lib/files";
import { capitalize } from "@agenteschat/client/lib/format";
import { issueTakenOf, issueWorkOf, taskConversationOf } from "@agenteschat/client/lib/issues";
import { workIsOver } from "@agenteschat/client/lib/long-work";
import { supersededBrainNotices } from "@agenteschat/client/lib/machine-outages";
import {
  isMediaAfterReply,
  isMediaAlone,
  mediaTabsOf,
  messageMediaOf,
  textOrMedia,
} from "@agenteschat/client/lib/media";
import { isEventLine } from "@agenteschat/client/lib/notices";
import { can } from "@agenteschat/client/lib/permissions";
import { pinsIn } from "@agenteschat/client/lib/pins";
import { localMeta } from "@agenteschat/client/lib/reply";
import { retryAnswer } from "@agenteschat/client/lib/retry-answer";
import { isRightHand, rightHandSeenKey } from "@agenteschat/client/lib/right-hand";
import { ConversationSeat } from "@agenteschat/client/lib/seat-context";
import { seenMessageId } from "@agenteschat/client/lib/seen";
import { lastPostedId, upsertMessage } from "@agenteschat/client/lib/timeline";
import { voiceOf } from "@agenteschat/client/lib/voice";
import { waitingAway, waitingNotification } from "@agenteschat/client/lib/waiting";
import { makingImage, stopsMovedOn } from "@agenteschat/client/lib/work";
import { isIdHandle } from "@agenteschat/ui/names";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef, OnViewableItemsChanged } from "@legendapp/list/react-native";
import { useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useIsFocused, useIsPreview } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import {
  type ComponentRef,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Keyboard,
  type LayoutChangeEvent,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import {
  KeyboardController,
  KeyboardEvents,
  KeyboardGestureArea,
  KeyboardStickyView,
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  Keyframe,
  LayoutAnimationConfig,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { frameClock } from "@/agent/clock";
import { StickerStageContext } from "@/agent/StickerCanvas";
import { createStickerStage } from "@/agent/sticker-stage";
import { holdOpenConversation } from "@/lib/push";
import { rightHandSeen } from "@/lib/storage";
import { useAppActive } from "@/lib/useAppActive";
import { useOrg } from "@/providers/org";
import { usePush } from "@/providers/push";
import { useRealtime } from "@/providers/realtime";
import {
  Button,
  Composer,
  type ComposerProps,
  type ComposerWorking,
  Count,
  Icon,
  IconButton,
  LineIcon,
  motion,
  PressScale,
  type SendHow,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { ComposerFloat, createComposerFloat } from "@/ui/Composer";
import { router } from "@/ui/navigation";
import { AgentSetupIntro, useSetupSteps } from "../agents/setup/SetupCard";
import { usePlanHold } from "../ai/parts";
import { BrowserCard, BrowserRunCard } from "../browser/BrowserCard";
import { OpenHandoffProvider } from "../browser/open";
import { threadTitle } from "../chats/logic";
import { ImageMaking } from "../files/ImageMaking";
import { isLocalMedia, LOCAL_FILES, type LocalFile, localFilesOf } from "../files/local-files";
import { rememberLocalCopy } from "../files/source";
import { uploadPart } from "../files/upload-part";
import { chatHref, consultationHref, notificationHref } from "../links/logic";
import { MissionCardView } from "../missions/cards";
import { isOpenMission } from "../missions/logic";
import { PushOfferLine } from "../push/PushOfferLine";
import { FanStrip, QueueWaitRow } from "../queue/parts";
import { DmQueueButton, QueueButton, useAgentsQueue, useOpenQueue } from "../queue/QueueSheet";
import { RemindSheet } from "../reminders/RemindSheet";
import { RightHandIntro } from "../right-hand/Intro";
import { ConversationSearch } from "../search/ConversationSearch";
import { hitTarget } from "../search/logic";
import { takeShareHandoff, useShareHandoff } from "../share/handoff";
import { AgentFace, Face, OpensAgent } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useMyHandle, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, previewOf } from "../shared/logic";
import { FocusLive, PushedHeader, Tile } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { RetryLine } from "../shared/TeamSkyEmpty";
import { useDmStatusLine, usePresenceOf, usePresenceWord } from "../status/hooks";
import { PersonStatusCard } from "../status/StatusCard";
import { AgentTasksButton, useDmAgentTasks } from "../task-manager/AgentTasksButton";
import { agentTasksHref, tasksBadge } from "../task-manager/logic";
import { retryVoice, type VoiceRefusal } from "../voice/outbox";
import { useVoiceComposer } from "../voice/useVoiceComposer";
import type { VoiceTarget } from "../voice/useVoiceTake";
import { AgentReceiptLine, EveryoneLine } from "./AgentReceipts";
import { AttachmentStrip, MAX_PENDING, type PendingFile } from "./AttachmentStrip";
import { markRowId, receiptMessageId } from "./agent-receipts";
import { AskStore } from "./ask-store";
import { AskBar, AskProbes, AskStoreProvider, useAskWatch, useAwayAsk, WaitingHereBar } from "./asks";
import { ChannelHello } from "./ChannelHello";
import { ChannelPicker } from "./ChannelPicker";
import { ChannelWelcome } from "./ChannelWelcome";
import { ChatPeek, usePullPastEnd } from "./ChatPeek";
import { ChatSkeleton } from "./ChatSkeleton";
import { type OpenedMessages, OpenedMessagesContext } from "./ClippedMessage";
import { ConversationSwitcher } from "./ConversationSwitcher";
import { takeComposerRequest, useComposerRequest } from "./composer-request";
import { DATE_PILL_IDLE_MS, DatePill } from "./DatePill";
import { DmComputerButton } from "./DmComputerButton";
import { createDockHeight, type DockHeight } from "./dock-height";
import { EventLine } from "./EventLine";
import { FirstDay } from "./FirstDay";
import { HeaderPill } from "./HeaderPill";
import { IssueTakenLine } from "./issue-work";
import { browsingRuns, WorkingLine } from "./LiveRows";
import { useChatLive } from "./live";
import {
  buildRows,
  type ChatRow,
  dayInView,
  keepSameRows,
  mayStopRun,
  mergeTimeline,
  parseSlash,
  pinnedAsListed,
  pinTarget,
  quietInset,
  readMark,
  runInConversation,
  sameItems,
  stoppableInLine,
  workingEntries,
} from "./logic";
import { RowLookContext, useConversationLook, useRhythm } from "./look";
import { MediaPickerSheet } from "./MediaPickerSheet";
import { MentionPicker, useMentionMembers } from "./MentionPicker";
import { MessageMenuFor } from "./MessageMenu";
import { MessageRow } from "./MessageRow";
import { stickerRowsOnScreen } from "./media";
import { channelMembersHrefs } from "./members";
import { insertRef, refQuery } from "./mentions";
import { NoAiBanner } from "./NoAiBanner";
import { newMissionHref } from "./new-mission";
import { endsOnNoAiCard, noAiBanner } from "./no-ai-banner";
import { PinnedLines, PinsSheet } from "./PinsSheet";
import { peekAgentOf } from "./peek";
import { QuoteBar } from "./QuoteLine";
import { AgentLocked, UnavailableLines } from "./ReachLines";
import { ReturnLine, ReturnsSheet, useReturnsHere } from "./Returns";
import { SwipeReply } from "./SwipeReply";
import {
  appendedKeys,
  bandAim,
  lastSeenKey,
  type Place,
  placeCorrection,
  type ScrollRow,
  STICK_TO_END_THRESHOLD,
  type Unseen,
  unseenBelow,
} from "./scroll";
import { datedBehind } from "./send-order";
import {
  ChannelOptions,
  MessageActions,
  type MessageActionsContext,
  MissionSummaryView,
  PlusActions,
  type PlusPick,
  ThreadOptions,
} from "./sheets";
import { movedOnKey, StoppedRunsContext, StopsMovedOnContext, stoppedRunsKey, stoppedRunsOf } from "./stopped-runs";
import { rememberTurn, turnItems, turnRuns, turnSignature, withOpacity } from "./turn";
import { JumpToMessageContext } from "./WorkLine";

/** A run's messages this recent are asked whether a take over still holds the agent's browser. */
const HELD_RECENT_MS = 12 * 60 * 60_000;

type Row =
  | (ChatRow & {
      /** A quiet line right under another: they stack as one group. */
      afterLine?: boolean;
      /** The next row of a turn under anything but a row of it: it takes a turn's gap. */
      newTurn?: boolean;
    })
  | { kind: "marker"; key: string; text: string }
  /** A run in line for its computer (`conversationWaits`): no live row of its own, this one for all its messages. */
  | { kind: "wait"; key: string; wait: ConversationWait }
  /** An agent's browser card: its live run in the browser, or (no run row) a take over held here. */
  | { kind: "browser"; key: string; run: LiveRun; handoff?: undefined }
  | { kind: "browser"; key: string; run: null; handoff: BrowserHandoff }
  /** Where the picture an agent is making will show (`makingImage`), until its reply takes its place. */
  | { kind: "image"; key: string; run: LiveRun }
  | { kind: "unseen"; key: string };

const rowKey = (r: Row) => r.key;
const isQuietLine = (r: Row | undefined) =>
  r?.kind === "message" && (isEventLine(r.message.meta) || issueTakenOf(r.message.meta) !== null);
/**
 * A row's type for the list, which keeps sizes per type: messages by how long they are and whether they carry a card
 * (as Expensify buckets them), so a row not measured yet is guessed close to its size and older pages land without a
 * jump.
 */
const rowType = (r: Row) => {
  if (r.kind !== "message") return r.kind;
  // A GIF or a sticker alone (ADR 0091) is about its picture's size, not a text's.
  if (voiceOf(r.message.meta)) return "message-voice";
  const media = r.message.body.trim() ? null : messageMediaOf(r.message.meta);
  if (media) return `message-${media.kind}`;
  const n = r.message.body.length;
  const size = n < 80 ? "s" : n < 320 ? "m" : n < 1200 ? "l" : "xl";
  return r.message.meta && Object.keys(r.message.meta).length > 0 ? `message-${size}-card` : `message-${size}`;
};
/** A sticker's row counts as in view from here: one barely in at the edge doesn't take a place among those playing. */
const STICKER_VIEW = { id: "stickers", itemVisiblePercentThreshold: 30 };
const DIVIDER_KEY = "unseen-divider";
/** A dropped connection shows only past this long (a quick reconnect says nothing). */
const OFFLINE_AFTER_MS = 1200;
/** "Conectado de novo" stays this long. */
const BACK_ONLINE_MS = 1600;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/**
 * A row that just arrived at the bottom rises 6pt into place (`--dur-base`, as on the web), on the strong ease-out
 * every entrance uses; only while it is fresh: history, a jump and a row scrolled back into view never do.
 */
const ENTER = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 6 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE_OUT },
}).duration(motion.base);
const FRESH_MS = 800;
/** How close to the end a scroll has to stop for a list held at a long message's start to follow again. */
const READ_RELEASE_PX = 24;
/** A row the list takes to the top of the room (a long reply's start, the "Novas" line) sits this far under the bar. */
const BAND_GAP = 8;
/** The row above the oldest loaded message while older ones exist: one height whether it waits, loads or is empty. */
const OLDER_ROW = 44;
/** How far from its end a list that follows it may rest (rounding) before it is taken there. */
const END_SLACK = 2;
/** The composer's safe-area padding hides behind the open keyboard; this much stays between them. */
const KEYBOARD_GAP = 8;
const COMPOSER_INPUT_ID = "chat-composer";
/** How long the conversation is held in place after something opens over it and after it closes (ms). */
const HOLD_MS = 900;
/** Holding a message opens the system's menu where there is one (iOS); elsewhere, the app's sheet. */
const NATIVE_MENU = Platform.OS === "ios";
/**
 * The agent peeking past the conversation's end (`ChatPeek`) where the list reports a pull there: iOS bounces past its
 * end; Android's list stops at it (its stretch is drawn, never in the offset).
 */
const PEEK = Platform.OS === "ios";
/** The notifications line was shown and answered here: it doesn't come back on this screen. */
const OFFER_DONE = "done";
/** How long the list keeps ignoring the keyboard after what covered it closed (its closing animation, ms). */
const FREEZE_AFTER_MS = 450;
/** The list shows by itself after this even if it never said it was placed (ms). */
const SHOW_LIST_MS = 700;
/** Going to a pinned message: at most this many older pages loaded looking for it. */
const SEEK_MAX_PAGES = 10;
/** How long the message gone to stays lit. */
const FLASH_MS = 1600;
/** How long a photo or file picker takes to cover the screen as it opens (ms). */
const PICKER_COVERS_MS = 500;
/** No questions to other agents here (yet): the same list each time, so the memos over it keep. */
const NO_CONSULTATIONS: RunConsultation[] = [];
/**
 * A run in these takes a new message of its conversation into its work (the server steers it there): no second
 * "pensando…" for it. One waiting for an approval never does (the message gets a run of its own).
 */
const AT_WORK: ReadonlySet<string> = new Set(["thinking", "queued", "running"]);

/**
 * The conversation's list, drawn again only when what it is handed changes: the screen redraws for someone typing, a
 * presence, an agent's step, and the list (a large component) was drawn again with each. Typed as the list itself: a
 * memo keeps its props but not its item type.
 */
const ConversationList = memo(KeyboardAwareLegendList) as unknown as typeof KeyboardAwareLegendList;

/**
 * A conversation: a channel, a DM, a thread or a mission's thread (`threadId`). `handoffId`: a request
 * for help a push or the inbox opened it for (its card opens in place, in control).
 */
/** "Revisor, Dev" for a screen reader, or just "Revisor" while there is no role or status (never "Revisor, ."). */
const who = (name: string, status: string) => (status ? `${name}, ${status}` : name);

export function ChatScreen({
  channelId,
  threadId,
  handoffId,
  focusId,
}: {
  channelId: string;
  threadId?: string | null;
  handoffId?: string | null;
  /** Open at this message: paged in, scrolled to and lit for a moment (a pin). */
  focusId?: string | null;
}) {
  return (
    <SheetHostProvider>
      <FocusLive>
        <OpenHandoffProvider handoffId={handoffId ?? null}>
          <Chat channelId={channelId} threadId={threadId ?? null} focusId={focusId ?? null} />
        </OpenHandoffProvider>
      </FocusLive>
    </SheetHostProvider>
  );
}

function Chat({
  channelId,
  threadId,
  focusId,
}: {
  channelId: string;
  threadId: string | null;
  focusId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const myHandle = useMyHandle();
  const api = useApi();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const insets = useSafeAreaInsets();
  const when = useWhen();
  // The requests waiting here and which messages are on screen: the line above the composer says when one
  // waits out of view (waiting beats working).
  const [asks] = useState(() => new AskStore());
  const awayAsk = useAwayAsk(asks);

  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const channel = channels.data?.find((x) => x.id === channelId);
  const dm = dms.data?.find((d) => d.channelId === channelId);
  // A conversation the loaded lists don't have yet (opened a moment ago, or reached by a link): they load
  // again once, so the header gets its name.
  const unlisted = channels.isSuccess && dms.isSuccess && !channel && !dm;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once each time the conversation goes missing
  useEffect(() => {
    if (!unlisted) return;
    void channels.refetch();
    void dms.refetch();
  }, [unlisted]);
  const isThread = Boolean(threadId);
  const thread = useThreadInfo(orgId, threadId);
  const missionQ = useThreadMission(orgId, threadId);
  const mission = missionQ.data ?? null;
  const dmAgentId = dm?.with.type === "agent" ? dm.with.id : null;
  const dmAgent = dmAgentId ? dir.agentById.get(dmAgentId) : undefined;
  const rightHandId = useMemo(() => dir.agents.find(isRightHand)?.id, [dir.agents]);
  const rowLook = useConversationLook(
    Boolean(dm) || thread.data?.channelKind === "dm",
    dmAgent ? agentLook(dmAgent).color : undefined,
  );
  const rhythm = CHAT_RHYTHM[rowLook.style];
  const quiet = quietInset(rowLook);
  // The right hand (ADR 0137): its own line and composer hint, no computer, and its greeting on top.
  const rightHand = isRightHand(dmAgent) && !isThread;
  // A new agent's setup checklist (ADR 0155 §2) for whoever sets it up: its greeting and the checklist on top.
  const setupIntro = useSetupSteps(dmAgent).length > 0 && !rightHand && !isThread;
  // Its DM is open, from its row or any other way in: its row's "Novo" goes.
  useEffect(() => {
    if (rightHand && meId) rightHandSeen.mark(rightHandSeenKey(meId, orgId));
  }, [rightHand, meId, orgId]);
  // Its wave on the person's first visit, kept here: the greeting moves into the list with the first message, and
  // the wave neither goes nor plays again.
  const wave = useRightHandWave(orgId, rightHand && dmAgent ? dmAgent.id : "");
  const waveFrom = useMemo(() => (wave ? frameClock.time() : undefined), [wave]);
  const member = dm ? true : (channel?.isMember ?? true);
  // An administrator reads every channel without joining it (ADR 0151): only what needs being in it waits for Entrar.
  const admin = can(useOrg().org, "administrator");
  const readable = member || admin;
  const roster = useRoster(orgId, channelId, Boolean(channel?.isMember) && !isThread);
  // The computer this conversation's agents share, while turns wait for it: the bar's way into its line.
  const queueAgents = useMemo(
    () => (dmAgentId ? [dmAgentId] : (roster.data ?? []).filter((r) => r.type === "agent").map((r) => r.id)),
    [dmAgentId, roster.data],
  );
  const { machineId: queueMachineId, queue: barQueue } = useAgentsQueue(queueAgents);
  const openQueue = useOpenQueue();
  const queueShown = Boolean(queueMachineId && barQueue?.waiting.length && !isThread);
  const join = useJoinChannel(orgId, channelId);
  // The "@" picker's sections: a channel's members (also in its threads); a DM has none.
  const mentionMembers = useMentionMembers(channelId, !dm && Boolean(channel?.isMember));

  // ── Messages ──
  const top = useMessages(orgId, channelId, readable && !isThread);
  const threadMessages = useThreadMessages(orgId, isThread && readable ? channelId : undefined, threadId ?? "");
  const channelThreads = useChannelThreads(orgId, channelId, "all", readable && !isThread);
  // Every thread with replies is a link under its root (as on the web): agents asked in the
  // channel answer in the channel, so a thread is always a conversation of its own.
  const linkThreads = useMemo(
    () =>
      new Map(
        (channelThreads.data?.threads ?? [])
          .filter((x) => x.state !== "archived" && (x.replyCount > 0 || x.mission || x.context))
          .map((x) => [x.id, x]),
      ),
    [channelThreads.data],
  );
  const [older, setOlder] = useState<Message[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  // Something is pinned here: its lines wait above the first message (`PinnedLines`). Older pages take their pins from
  // it (`pinnedAsListed`): no cache update reaches them.
  const pinsData = usePins(orgId, channelId, member).data;
  const olderPinned = useMemo(() => pinnedAsListed(older, pinsData), [older, pinsData]);
  const list = useMemo(() => {
    if (isThread) {
      // My replies still sending wait in the channel's list.
      const mine = (top.data ?? []).filter((m) => m.local && m.threadId === threadId);
      return mergeTimeline(threadMessages.data ?? [], [mine]);
    }
    return mergeTimeline([...olderPinned, ...(top.data ?? [])], []);
  }, [isThread, threadId, top.data, threadMessages.data, olderPinned]);
  // Messages said in the channel itself: a "thinking" row the app guessed hangs off one of them.
  const topIds = useMemo(() => new Set(list.flatMap((m) => (m.threadId ? [] : [m.id]))), [list]);
  // A DM with a person: their face beside my latest message once they read it (live: `channel.read`).
  const reads = useDmReads(orgId, channelId, dm?.with.type === "person" && !isThread);
  const seenId = useMemo(
    () => (reads.data && meId ? seenMessageId(top.data ?? [], meId, reads.data) : null),
    [reads.data, top.data, meId],
  );
  const seenBy = seenId ? dm?.with.id : undefined;

  // ── Live ──
  const live = useChatLive(orgId, channelId, readable);
  // Agents my message here named that won't answer me: in this conversation or this thread only.
  const notices = useMemo(
    () => live.notices.filter((n) => (isThread ? n.threadId === threadId : n.threadId === null)),
    [live.notices, isThread, threadId],
  );
  // People's messages loaded over HTTP start (or catch up) their agents' receipts, as on the web.
  const { seed: seedReceipts } = live;
  useEffect(() => {
    if (list.length > 0) seedReceipts(list);
  }, [list, seedReceipts]);
  const runs = useMemo(
    () => live.runs.filter((r) => (isThread ? r.threadId === threadId : inMainTimeline(r, topIds))),
    [live.runs, isThread, threadId, topIds],
  );
  const consults = useMemo(
    () => live.consults.filter((x) => (isThread ? x.threadId === threadId : inMainTimeline(x, topIds))),
    [live.consults, isThread, threadId, topIds],
  );

  // "Parar" in the working line (as on the web): who manages agents, the agent's owner, or who started it.
  const { org } = useOrg();
  const manageAgents = can(org, "manage_agents");
  const canStop = useCallback(
    (r: LiveRun) =>
      mayStopRun(r, {
        meId,
        manageAgents,
        agentOwnerId: dir.agentById.get(r.agentId)?.ownerUserId,
        messages: list,
      }),
    [meId, manageAgents, dir.agentById, list],
  );
  const { stop } = live;
  const stopRun = useCallback(
    (r: LiveRun) => {
      if (meId) stop(r.runId, meId);
    },
    [meId, stop],
  );
  // Who is typing here, in this conversation or this thread (never me), as on the web; `live` drops who stopped.
  const typing = useMemo(
    () => typingIn(live.typing, channelId, Date.now(), meId ?? undefined, threadId),
    [live.typing, channelId, meId, threadId],
  );
  const { sendTyping } = live;
  // While an agent works here, a tap on send reaches it at its next pause and holding send stops it and sends (the
  // server takes a steer). "Parar" itself is a word at the end of the line above the composer (and of the live row
  // while it shows): the composer keeps only its send, the one ink circle.
  const busyRuns = useMemo(() => stoppableInLine(runs).filter((r) => !r.stopping), [runs]);
  const stoppable = useMemo(() => stoppableInLine(runs).filter((r) => canStop(r)), [runs, canStop]);
  // The same object while someone works: the field isn't redrawn by each step of that work.
  const busy = busyRuns.length > 0;
  const working = useMemo<ComposerWorking | null>(() => (busy ? {} : null), [busy]);
  const lineStop = useMemo(
    () => (stoppable.length > 0 ? { runs: stoppable, onStop: stopRun } : undefined),
    [stoppable, stopRun],
  );
  // An agent's DM header counts its tasks, here and elsewhere (ADR 0128); a tap opens them, pushed like a thread.
  const agentTasks = useDmAgentTasks(member && !isThread ? dmAgentId : null);

  // ── Agents' blocks ──
  // An agent at work in its browser: its card in the conversation, open on demand. The same array while its runs are
  // the same objects: another agent's step (a new `runs` many times a second) leaves the rows built from it alone.
  const browsingRef = useRef<readonly LiveRun[]>([]);
  const browsing = useMemo(() => {
    browsingRef.current = sameItems(browsingRef.current, browsingRuns(runs));
    return browsingRef.current;
  }, [runs]);
  // An agent making a picture: its place in the conversation, as the web's live row. Its row draws only who makes it,
  // so it is new only when that changes.
  const makingNow = runs.filter((r) => r.status !== "failed" && makingImage(r));
  const makingKey = makingNow.map((r) => `${r.runId}:${r.agentId}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `makingKey` stands for the runs making a picture
  const making = useMemo(() => makingNow, [makingKey]);
  // A take over held here after its run's live row went (the run paused for the person, or ended): the
  // same card stays, at the end, until the browser is handed back. Its runs: recent ones of this
  // conversation, the ones taken over here (or heard of in its events), and the live ones.
  const heldPlaces = useHeldPlaces();
  const heldAsk = useMemo(() => {
    const since = Date.now() - HELD_RECENT_MS;
    const runIds = new Set<string>(runs.map((r) => r.runId));
    const agentIds = new Set<string>();
    for (const m of list) {
      if (m.author.type !== "agent" || !m.author.id || !m.agentRunId || Date.parse(m.createdAt) < since) continue;
      runIds.add(m.agentRunId);
      agentIds.add(m.author.id);
    }
    for (const p of heldPlaces) {
      if (p.channelId !== channelId || (isThread && p.threadId !== threadId)) continue;
      runIds.add(p.runId);
      agentIds.add(p.agentId);
    }
    return { runIds, agentIds: [...agentIds].sort() };
  }, [runs, list, heldPlaces, channelId, threadId, isThread]);
  const agentHandoffs = useAgentsBrowserHandoffs(orgId, heldAsk.agentIds);
  const heldNow = heldTakeoversHere(agentHandoffs, {
    runIds: heldAsk.runIds,
    drawnAgents: new Set(browsing.map((r) => r.agentId)),
  });
  const heldKey = heldNow.map((h) => `${h.id}:${h.runId}:${h.controllerUserId ?? ""}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rows change only when what is held changes
  const held = useMemo(() => heldNow, [heldKey]);
  // The messages an agent read while working (its "Leu seu recado" wells quote them; a GIF or a sticker by its word).
  const bodiesRef = useRef(new Map<string, string>());
  bodiesRef.current = useMemo(() => new Map(list.map((m) => [m.id, textOrMedia(t, m.body, m.meta)])), [list, t]);
  const bodyOf = useCallback((id: string) => bodiesRef.current.get(id), []);
  // Every agent at work here draws nothing in the conversation while it works: the line above the composer says who
  // works, on what and for how long, and its reply shows whole once posted, with the work it did (kept here, so the
  // reply shows it at once, `recentTurn`). A run in its browser has its browser card instead.
  const atWork = useMemo(() => turnRuns(runs, new Set(browsing.map((r) => r.runId))), [runs, browsing]);
  const workKey = useMemo(() => atWork.map((r) => `${r.runId}:${turnSignature(turnItems(r))}`).join("|"), [atWork]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `workKey` stands for the runs' work
  useEffect(() => {
    for (const run of atWork) {
      const items = turnItems(run, true);
      const quotes = Object.fromEntries(
        items.flatMap((x) => (x.kind === "steer" ? [[x.messageId, bodyOf(x.messageId) ?? ""]] : [])),
      );
      rememberTurn(run.runId, { items, quotes, at: Date.now() });
    }
  }, [workKey]);
  const [openBrowsers, setOpenBrowsers] = useState<ReadonlySet<string>>(() => new Set());
  const toggleBrowser = useCallback((agentId: string, open: boolean) => {
    setOpenBrowsers((prev) => {
      if (prev.has(agentId) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(agentId);
      else next.delete(agentId);
      return next;
    });
  }, []);

  // ── Rows ──
  // One waiting card per agent and computer: an older "my computer is away" gives way to the newer one.
  const superseded = useMemo(() => supersededBrainNotices(list), [list]);
  // Looked for again when the messages, the receipts or the runs change, not on every redraw (someone typing).
  const waitsNow = useMemo(
    () =>
      conversationWaits(isThread ? list : list.filter((m) => !m.threadId), live.receipts, (id) =>
        live.runs.some((r) => r.runId === id),
      ),
    [isThread, list, live.receipts, live.runs],
  );
  const waitsKey = waitsNow.map((w) => `${w.agentId}:${w.runId}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: new only when the waits change, not on every receipt
  const waits = useMemo(() => waitsNow, [waitsKey]);
  // A thread's first line: in a DM, with whom (its channel name is internal, "dm-…"); in a channel, where. Its words and
  // its count, not the lists' objects: the DM and channel lists are read again with each message, and the rows were
  // all built again with them.
  const startedText = isThread
    ? thread.data?.channelKind === "dm" || dm
      ? t("mobile.chat.startedWith", { name: dm?.with.name ?? "" })
      : t("mobile.chat.startedIn", { channel: thread.data?.channelName ?? channel?.name ?? "" })
    : "";
  const replyCount = thread.data?.replyCount;
  // The messages' rows, built again only when the messages (or the thread's head) change: an agent's run events, many a
  // second while it works, touch only the live rows after them.
  const messageRows = useMemo<Row[]>(() => {
    if (isThread && threadId) {
      const root = list.find((m) => m.id === threadId);
      const replies = list.filter((m) => m.id !== threadId);
      // A task's conversation (ADR 0145): its root stands for the task, one screen back; only the replies show.
      const head: Row[] =
        root && !taskConversationOf(root.meta)
          ? [
              { kind: "marker", key: "started", text: startedText },
              // The root as it started the thread (its mission card is pinned above already).
              {
                kind: "message",
                key: root.id,
                message: { ...root, meta: { ...root.meta, missionStart: undefined, missionLink: undefined } },
                grouped: false,
              },
              {
                kind: "marker",
                key: "replies",
                text: t("mobile.chat.replies", { count: replyCount ?? replies.length }),
              },
            ]
          : [];
      return [...head, ...buildRows(replies, (m) => superseded.has(m.id))];
    }
    // A thread's replies live in the thread; the channel shows its link.
    const hidden = (m: Message) => superseded.has(m.id) || Boolean(m.threadId);
    return buildRows(list, hidden);
  }, [isThread, threadId, list, startedText, replyCount, superseded, t]);
  // What agents do here now, after the messages: browser cards, a picture on its way, turns waiting for a computer.
  const liveRows = useMemo<Row[]>(
    () => [
      ...browsing.map((run) => ({ kind: "browser" as const, key: `browser-${run.agentId}`, run })),
      ...held.map((h) => ({ kind: "browser" as const, key: `browser-${h.agentId}`, run: null, handoff: h })),
      ...making.map((run) => ({ kind: "image" as const, key: `image-${run.runId}`, run })),
      ...waits.map((wait) => ({ kind: "wait" as const, key: `wait-${wait.runId ?? wait.agentId}`, wait })),
    ],
    [browsing, held, making, waits],
  );
  const rows = useMemo(
    () => (liveRows.length > 0 ? [...messageRows, ...liveRows] : messageRows),
    [messageRows, liveRows],
  );
  // From the messages' rows alone (the live rows hold none): what is built on them keeps through run events.
  const shownMessages = useMemo(
    () => messageRows.flatMap((r) => (r.kind === "message" ? [r.message] : [])),
    [messageRows],
  );
  // Questions agents asked other agents, in the pair row before the replies that asked (`ConsultGroup`): how each
  // answer's notice draws (hidden under a reply close by, one line to one farther up, and while its asker still works
  // and posted nothing yet: its reply brings the row), and the working line without the questions a reply near the
  // end shows (an asker at work shows none: the line says them).
  // An exchange between the same two agents draws on its first asking run's reply (`asExchanges`).
  const consultations = useConsultations(orgId, channelId);
  const consultData = consultations.data;
  const consultList = useMemo(() => (consultData ? asExchanges(consultData) : NO_CONSULTATIONS), [consultData]);
  // The threads' links under their roots and these questions load beside the messages and change rows: the list waits
  // for them before it shows (`revealOpened`), so no row grows under the person as the conversation appears. Only on
  // a first read: messages already on the phone (in memory, or the snapshot, which keeps both lists with them) show at
  // once, as they did, never held behind two reads from the network (the whole fallback offline).
  const openedOnPhone = useRef(
    isThread ? threadMessages.data !== undefined && !threadMessages.isPlaceholderData : top.data !== undefined,
  ).current;
  const rowsComplete =
    openedOnPhone || ((isThread || !readable || channelThreads.isFetched) && consultations.isFetched);
  const rowsCompleteRef = useRef(rowsComplete);
  rowsCompleteRef.current = rowsComplete;
  const liveTurns = useMemo(
    () => new Set(atWork.flatMap((r) => (shownMessages.some((m) => m.agentRunId === r.runId) ? [] : [r.runId]))),
    [atWork, shownMessages],
  );
  const foldsNow = useMemo(
    () => consultNoticeFolds(shownMessages, consultList, liveTurns, "first"),
    [shownMessages, consultList, liveTurns],
  );
  // The rows redraw when a notice's fold changes, not on every message (the folds are rebuilt on each).
  const foldsKey = [...foldsNow].map(([id, f]) => `${id}:${f.fold === "line" ? f.messageId : f.fold}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `foldsKey` stands for the folds
  const consultFolds = useMemo(() => foldsNow, [foldsKey]);
  // One stop is one pill: the stopped reply's, with its notice's words (who, the reason), the notice itself drawing
  // nothing while that reply is here (`stoppedRunsOf`). Rebuilt with the messages, redrawn only when a stop changes.
  const stoppedNow = useMemo(() => stoppedRunsOf(shownMessages), [shownMessages]);
  const stoppedKey = stoppedRunsKey(stoppedNow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stoppedKey` stands for the stops
  const stoppedRuns = useMemo(() => stoppedNow, [stoppedKey]);
  // A stop whose agent works here again, or wrote after it, is over: its pill offers no "Continue".
  const movedNow = useMemo(
    () =>
      stopsMovedOn(
        shownMessages,
        // At work for real, not a guess at who will answer.
        runs.filter((r) => !r.provisional).map((r) => r.agentId),
      ),
    [shownMessages, runs],
  );
  const movedKey = movedOnKey(movedNow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `movedKey` stands for the set
  const stopsMoved = useMemo(() => movedNow, [movedKey]);
  // Work handed off from here stays on the line for as long as it is out (ADR 0095 addendum), with the other agent's
  // state: its step, what it waits on, or what waits on me (its work for me, when that work is the hand-off's run, says
  // so before the list does).
  const presence = usePresenceOf();
  const lineConsults = useMemo(
    () =>
      [
        ...consultsForLine(
          consults.filter((x) => x.kind !== "note"),
          consultBlocksNearEnd(shownMessages, consultList, undefined, "first"),
        ),
        ...consults.filter((x) => x.kind === "note"),
      ].map((x) => ({
        ...x,
        ...consultDetails(
          x,
          consultData ?? [],
          (id, run) => handoffAsk(presence.agent(id)?.work, run),
          (id) => lineStep(t, presence.agent(id)?.status?.status),
        ),
      })),
    [consults, shownMessages, consultList, consultData, presence, t],
  );

  // ── Following the end ──
  // The list sticks to the end only while the person is near it (Legend List's maintainScrollAtEnd); farther
  // up nothing moves (the scroll is never taken): the round button at the top right counts what arrived below (in
  // red when it mentions me) and goes back to the end, and a "Novas" line marks the first of it.
  const listRef = useRef<LegendListRef>(null);
  // The person dragging the list, a new hold on their place (see "Keeping the place") and the app moving it on
  // purpose (sending, the pill, a pin): each lets go of a held place.
  const dragging = useRef(false);
  const holding = useRef(0);
  const aimed = useRef(0);
  const letGo = useCallback(() => {
    holding.current++;
    aimed.current++;
  }, []);
  // The room the list shows rows in: under the floating bar (a pinned card already holds that room) and over the dock
  // riding the keyboard. Its top and the keyboard's share are set as the screen draws (`band.current`, below), the
  // dock's height as it lays out (`dock`, `onComposerBoxLayout`); it is read when the list is aimed, after that.
  const band = useRef({ top: 0, lift: 0 });
  const [dock] = useState(createDockHeight);
  const roomNow = useCallback(() => {
    const state = listRef.current?.getState();
    if (!state) return null;
    const { top, lift } = band.current;
    const keyboard = KeyboardController.isVisible() ? Math.max(0, KeyboardController.state().height - lift) : 0;
    return { state, top, height: state.scrollLength - top - dock.get() - keyboard };
  }, [dock]);
  /** `scrollToIndex`'s place for a row in that room (`bandAim`): sent to the top, it lands under the bar. */
  const aimAt = useCallback(
    (index: number, viewPosition: number, tall: "start" | "end") => {
      const room = roomNow();
      if (!room) return { viewPosition };
      return bandAim({ viewPosition, size: room.state.sizeAtIndex(index), band: room.height, top: room.top, tall });
    },
    [roomNow],
  );
  const scrollRows = useMemo<ScrollRow[]>(
    () =>
      rows.map((r) => ({
        key: r.key,
        kind: r.kind === "message" ? "message" : "other",
        ...(r.kind === "message" ? { id: r.message.id } : {}),
        mine: r.kind === "message" && r.message.author.type === "person" && r.message.author.id === meId,
        // An agent's sticker or GIF after its reply (ADR 0091) is never news of its own.
        silent: r.kind === "message" && isMediaAfterReply(r.message.meta),
        mentionsMe: r.kind === "message" && r.message.author.id !== meId && mentionsReader(r.message, myHandle),
        ...(r.kind === "message" && r.message.author.id
          ? { who: `${r.message.author.type}:${r.message.author.id}` }
          : {}),
      })),
    [rows, meId, myHandle],
  );
  const [atEnd, setAtEnd] = useState(true);
  const atEndRef = useRef(atEnd);
  atEndRef.current = atEnd;
  // Held at the start of a long message someone else wrote (see "Reading from the top"), or where "Ver mais" opened
  // one: the list doesn't follow the end until the person gets there, sends, or takes the pill.
  const [readHold, setReadHold] = useState(false);
  // The person's first touch here, anywhere (a scroll, the box, a message): the day's greeting closes a while after.
  const [touched, setTouched] = useState(false);
  // The messages "Ver mais" opened in place: they stay open while the screen lives (rows unmount off screen).
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const openedMessages = useMemo<OpenedMessages>(
    () => ({
      has: (id) => opened.has(id),
      open: (id) => {
        setOpened((s) => new Set(s).add(id));
        if (atEndRef.current) setReadHold(true);
      },
    }),
    [opened],
  );
  const [seenKey, setSeenKey] = useState<string | null>(null);
  // The message posted last when the person was last at the end: one posted since in a place above the last row they
  // saw (`PLACE_KEPT_MS`) is new to them too.
  const [seenPostedId, setSeenPostedId] = useState<string | undefined>();
  const latestSeen = lastSeenKey(scrollRows);
  const postedNow = useMemo(() => lastPostedId(list), [list]);
  useEffect(() => {
    if (!atEnd) return;
    setSeenKey(latestSeen);
    setSeenPostedId(postedNow);
  }, [atEnd, latestSeen, postedNow]);
  // More than a screen above the end: the round button shows even with nothing new below, and the header's pill
  // closes to the face.
  const [far, setFar] = useState(false);
  // Who writes now ("Atlas escrevendo"): its reply comes below, whole once posted.
  const writingKey = [...new Set(atWork.filter((r) => r.status === "running").map((r) => `agent:${r.agentId}`))].join(
    " ",
  );
  const unseen: Unseen = useMemo(
    () =>
      atEnd
        ? { messages: 0, firstKey: null, authors: [], working: [], mentionsMe: false }
        : { ...unseenBelow(scrollRows, seenKey, seenPostedId), working: writingKey ? writingKey.split(" ") : [] },
    [atEnd, scrollRows, seenKey, seenPostedId, writingKey],
  );
  // "Novas": before the first new row while the person reads above, in the same frame as that row (put a render later,
  // it pushed the row down under the person's eyes). It stays where it was put for as long as the conversation is on
  // screen, as a chat's own line does, and goes once the screen is left (out of sight): a line taken out while the
  // person scrolls moved every message under it.
  const [placedDivider, setPlacedDivider] = useState<string | null>(null);
  const dividerKey = placedDivider ?? unseen.firstKey;
  useEffect(() => {
    if (unseen.firstKey && !placedDivider) setPlacedDivider(unseen.firstKey);
  }, [unseen.firstKey, placedDivider]);
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) setPlacedDivider(null);
  }, [focused]);
  // Each row object as it was when nothing in it changed (`keepSameRows`): the list redraws the rows that did.
  const shownRef = useRef<readonly Row[]>([]);
  const shownRows = useMemo(() => {
    const at = dividerKey ? rows.findIndex((r) => r.key === dividerKey) : -1;
    const all: Row[] = at >= 0 ? [...rows.slice(0, at), { kind: "unseen", key: DIVIDER_KEY }, ...rows.slice(at)] : rows;
    const next = all.map((r, i): Row => {
      if (r.kind !== "message") return r;
      const above = all[i - 1];
      if (isQuietLine(r)) return isQuietLine(above) ? { ...r, afterLine: true } : r;
      return r.grouped && (above?.kind !== "message" || isQuietLine(above)) ? { ...r, newTurn: true } : r;
    });
    shownRef.current = keepSameRows(shownRef.current, next);
    return shownRef.current;
  }, [rows, dividerKey]);
  const toEnd = useCallback(() => {
    letGo();
    // Going to the end (a send, the round button) leaves nothing waiting to be read from the top: the room may have
    // shrunk since (the dock grew), and a reply that fit would be taken for a tall one as my message lands.
    toReadRef.current = null;
    setReadHold(false);
    setAtEnd(true);
    requestAnimationFrame(() => void listRef.current?.scrollToEnd({ animated: true }));
  }, [letGo]);

  // The person is at the end of what they were reading (they scrolled there, or the list landed there): the list
  // follows again, and the round button, with nothing below to go to, goes.
  const releaseAtEnd = useCallback(() => {
    const state = listRef.current?.getState();
    if (state && state.distanceFromEnd <= READ_RELEASE_PX) setReadHold(false);
  }, []);
  // "Ver" on the requests' line: the list goes to the request and stays there. It stops following the end, as
  // when reading a long message from its top, so a reply streaming in doesn't pull it back down; reaching the end,
  // sending or the pill follow again. The card ends its message: in the middle of the room, or, a message taller than
  // the room, its end.
  const holdAt = useCallback(
    (messageId: string | undefined) => {
      const key = messageId ? rows.find((r) => r.kind === "message" && r.message.id === messageId)?.key : undefined;
      if (!key) return false;
      letGo();
      setReadHold(true);
      // After the render that turns following off, so the end doesn't pull it back down.
      requestAnimationFrame(() => {
        const index = listRef.current?.getState().indexByKey(key);
        if (index === undefined) return;
        void listRef.current?.scrollToIndex({ index, animated: true, ...aimAt(index, 0.5, "end") })?.then(releaseAtEnd);
      });
      return true;
    },
    [rows, letGo, aimAt, releaseAtEnd],
  );
  const seeAsk = useCallback(() => void holdAt(awayAsk?.ask.messageId), [awayAsk, holdAt]);
  // What waits on me here with its card not loaded (older, or in a thread): the line counts it and opens the oldest.
  const waitingOnMe = useWaitingOnMe(orgId).data?.items;
  const waitingHere = useMemo(
    () =>
      waitingAway(
        waitingOnMe,
        channelId,
        threadId ?? null,
        new Set(rows.flatMap((r) => (r.kind === "message" ? [r.message.id] : []))),
      ),
    [waitingOnMe, channelId, threadId, rows],
  );
  const waitingFirst = awayAsk ? undefined : waitingHere[0];
  const seeWaiting = useCallback(() => {
    const href = waitingFirst && notificationHref(waitingNotification(waitingFirst));
    if (href) router.push(href);
  }, [waitingFirst]);

  // Rows that arrive at the bottom while the screen is open rise in; older pages and the first load don't.
  const prevKeysRef = useRef<string[]>([]);
  const freshRef = useRef(new Map<string, number>());
  const rowKeys = useMemo(() => rows.map(rowKey), [rows]);
  useMemo(() => {
    const now = Date.now();
    for (const key of appendedKeys(prevKeysRef.current, rowKeys)) freshRef.current.set(key, now);
    for (const [key, t0] of freshRef.current) if (now - t0 > FRESH_MS) freshRef.current.delete(key);
  }, [rowKeys]);
  useEffect(() => {
    prevKeysRef.current = rowKeys;
  }, [rowKeys]);
  // Less motion asked for: nothing rises in.
  const stillRows = useReducedMotion();
  const isFresh = useCallback(
    (key: string) => {
      const t0 = freshRef.current.get(key);
      return !stillRows && t0 !== undefined && Date.now() - t0 <= FRESH_MS;
    },
    [stillRows],
  );

  // ── Read ──
  // Seen up to the message posted last (`ReadMark`, drawn with the screen). Peeked at from the list (iOS's long press
  // preview): nothing is read until it is opened.
  const peeking = useIsPreview();

  // ── Older pages (channel view) ──
  // The row above the oldest message shows a page loading and, when one didn't come, the way to ask again (`OlderRow`):
  // a failed page is not the conversation's start, so the start stays to be reached.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  // The list asks for older rows on a layout change too, not only a scroll (Legend List 3.7): one page at a
  // time, whatever the state says this render.
  const fetchingOlder = useRef(false);
  const fetchOlder = useCallback(() => {
    if (isThread || olderDone || fetchingOlder.current || !top.data) return;
    const oldest = older[0] ?? top.data[0];
    if (!oldest || top.data.length < MESSAGES_PAGE) {
      setOlderDone(true);
      return;
    }
    fetchingOlder.current = true;
    setLoadingOlder(true);
    setOlderFailed(false);
    api.chat
      .messages(orgId, channelId, { before: oldest.createdAt, limit: MESSAGES_PAGE })
      .then((page) => {
        setOlder((prev) => [...page, ...prev]);
        if (page.length < MESSAGES_PAGE) setOlderDone(true);
      })
      .catch(() => setOlderFailed(true))
      .finally(() => {
        fetchingOlder.current = false;
        setLoadingOlder(false);
      });
  }, [api, orgId, channelId, isThread, olderDone, top.data, older]);
  // The list's own asks (reaching the top, a layout) stop after a page failed: without a connection they would ask
  // again at every layout. "Try again" on the row asks again.
  const loadOlder = useCallback(() => {
    if (!olderFailed && !loadingOlder) fetchOlder();
  }, [olderFailed, loadingOlder, fetchOlder]);

  // ── Sending ──
  // Without a connection (no internet, or the server restarting) a message isn't "failed": it waits with a
  // clock and goes by itself when the connection is back, from whatever screen is open (`useSendWaiting`).
  const post = usePostMessage(orgId, channelId, {
    me: { id: meId ?? "" },
    // The moment my message is in the conversation, as on the web: an agent DM's "pensando…" on it, so the dock grows in
    // the frame the message appears (from the server's answer it grew while the list was still going down to it). Not
    // when the agent is at work here already: the server takes the message into that work ("lê na próxima pausa"), no
    // second run; nor for a GIF or a sticker alone, which no agent answers (ADR 0091).
    onOptimistic: (local) => {
      // What waits behind it stays under it (`keepBehind`).
      if (waitingBehind.current.length > 0) keepBehind(local);
      if (isMediaAlone(local)) return;
      const atWork = live.runs.some(
        (r) =>
          !r.provisional &&
          r.agentId === dmAgentId &&
          AT_WORK.has(r.status) &&
          runInConversation(r, local.threadId ?? null),
      );
      if (dmAgentId && !atWork) live.expect(local.threadId ?? local.id, [dmAgentId], local.id);
      // A channel with agents: the router (or a mention) decides who answers, and `message.routed` always follows.
      if (channel && channelAgents.length > 0) live.picking(local.id);
    },
    // Its server id: what was guessed on its copy moves there (in the same update when the socket's copy comes first).
    // Taken into work already going here after all (the server steered it into a run with its own row), its
    // "pensando…" goes: no second run comes. Steered into a run waiting with no row (a wait this message ends), the
    // guess stays until the run resumes and takes its place: dropped now, the line went and came back a moment later.
    onSent: (message, local) => {
      live.retarget(local.id, message.id);
      const steered = Array.isArray(message.meta?.steeredRunIds) ? (message.meta.steeredRunIds as string[]) : [];
      if (live.runs.some((r) => !r.provisional && steered.includes(r.runId))) live.forget(message.id, false);
    },
    // Why, in words: the failed row under it says the same and keeps the text. Not sent, nothing answers it yet.
    onFailed: (error, { clientId, waits }) => {
      live.forget(`local-${clientId}`, true);
      if (!waits) toast({ title: errorText(t, error, i18n.language), icon: "x" });
    },
  });
  const { send, retry } = sendHelpers(post);
  // A message with files goes once they are up (seconds for a video), and the server dates it then: one sent meanwhile
  // went before it, its files landing under it, for everyone. While files of mine go up here, what I send next waits
  // behind them (`sendText`): its copy in its place at once, under them, and its request after theirs.
  const filesAhead = useRef<Promise<void> | null>(null);
  // The copies waiting there, in the order they were sent (their `clientId`s).
  const waitingBehind = useRef<string[]>([]);
  const behindFiles = useCallback((task: () => Promise<unknown>) => {
    const turn = (filesAhead.current ?? Promise.resolve()).then(task).then(
      () => undefined,
      () => undefined,
    );
    filesAhead.current = turn;
    void turn.then(() => {
      if (filesAhead.current === turn) filesAhead.current = null;
    });
  }, []);
  // "Responder" in a thread: the next message answers this one (`meta.replyTo`).
  const [quote, setQuote] = useState<Message | null>(null);
  const [replyAt, setReplyAt] = useState(0);
  const onReply = useCallback((m: Message) => {
    setQuote(m);
    setReplyAt(Date.now());
  }, []);
  const takeQuote = (files: ArtifactRef[] = []) => {
    if (!quote) return files.length > 0 ? localMeta(null, "", files) : undefined;
    setQuote(null);
    return localMeta(quote, dir.nameOf(quote.author), files);
  };
  const qc = useQueryClient();
  const voiceRefused = useCallback(
    (reason: VoiceRefusal) => toast({ title: t(reason === "limit" ? "voice.limit" : "voice.notSent"), icon: "x" }),
    [t, toast],
  );
  // Rows keep the same callback (so a streaming reply doesn't re-render every message).
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const onRetry = useCallback(
    (m: Message) => {
      // Files that didn't go up go again, from the phone, then the message with them.
      if (m.local && localFilesOf(m.meta).length > 0) {
        qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) =>
          list?.map((x) => (x.id === m.id ? { ...x, local: "pending" as const, sendFailure: undefined } : x)),
        );
        behindFiles(() => deliverFilesRef.current(m));
      }
      // A voice note waits in its own outbox: tried again there, now.
      else if (voiceOf(m.meta) && m.local) retryVoice(qc, m.clientId, voiceRefused);
      // Only a change to its text can make it go: it leaves the list and the text returns to the field.
      else if (sendNeedsEdit(m.sendFailure)) {
        qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) => list?.filter((x) => x.id !== m.id));
        setCaptionBack({ text: m.body, at: Date.now(), join: true });
      } else retryRef.current(m);
    },
    [qc, voiceRefused, orgId, channelId, behindFiles],
  );
  // "Tentar de novo" under a message no agent could answer: the agent answers that same message again; only when it
  // can't, the same words go again, here (the web's `resend`).
  const sendRef = useRef(send);
  sendRef.current = send;
  const onResend = useCallback(
    (m: Message) =>
      retryAnswer(api, orgId, m, () => {
        sendRef.current(m.body, threadId);
        toEnd();
      }).catch((error) => toast({ title: errorText(t, error), icon: "x" })),
    [api, orgId, threadId, toEnd, toast, t],
  );
  const realtime = useRealtime().status;
  const control = useMissionControl(orgId);
  const createMission = useCreateMission(orgId);
  const channelAgents = (roster.data ?? []).filter((r) => r.type === "agent").map((r) => r.id);
  const soleAgent = dmAgentId ?? (channelAgents.length === 1 ? (channelAgents[0] ?? null) : null);
  // An empty channel says hi through one of its agents that answers me, by a handle people can read (as the web).
  const talkable = channelAgents.map((id) => dir.agentById.get(id)).filter((a): a is Agent => Boolean(a) && canTalk(a));
  const helloAgent = talkable.find((a) => !isIdHandle(a.handle)) ?? talkable[0];

  // A form, so a screen pushed over the conversation (its place kept for the way back), from wherever it is asked: the
  // "+", the thread's options or a message's actions (their sheet goes), the system's menu, `/mission`.
  const openNewMission = (goal = "", homeThreadId: string | null = threadId) => {
    sheet.close();
    leavePlace();
    router.push(
      newMissionHref({
        channelId,
        threadId: homeThreadId,
        goal,
        agentId: mission?.agentId ?? soleAgent,
        currentThreadId: threadId,
      }),
    );
  };
  const openRemind = (input: { text?: string; message?: Message } = {}) =>
    sheet.push(
      <RemindSheet
        channelId={channelId}
        threadId={threadId}
        {...(input.message ? { message: input.message } : {})}
        {...(input.text ? { initialText: input.text } : {})}
      />,
    );
  /** My words (or a GIF, a sticker) here: at once, or behind files of mine still going up (`filesAhead`). */
  const sendText = (body: string, meta?: Record<string, unknown>) => {
    if (!filesAhead.current) {
      send(body, threadId, meta);
      return;
    }
    // As `send` puts it: "Parar e mandar" rides as the request's `steer`, not in what the message carries.
    const { steer, ...rest } = meta ?? {};
    const clientId = newClientId();
    const local: Message = {
      id: `local-${clientId}`,
      channelId,
      threadId: threadId ?? null,
      author: { type: "person", id: meId ?? "" },
      body,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: rest,
      clientId,
      local: "pending",
      createdAt: new Date().toISOString(),
    };
    qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) => upsertMessage(list, local));
    waitingBehind.current.push(clientId);
    behindFiles(() => {
      waitingBehind.current = waitingBehind.current.filter((id) => id !== clientId);
      return post.mutateAsync({
        body,
        clientId,
        threadId,
        meta: meta ? rest : undefined,
        ...(steer === "now" ? { steer: "now" as const } : {}),
      });
    });
  };
  /** The copies waiting behind files stay under `ahead`, the message going out before them (`datedBehind`). */
  const keepBehind = (ahead: Message) =>
    qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) =>
      datedBehind(list, ahead, waitingBehind.current),
    );
  const summarize = () => {
    if (mission) sheet.push(<MissionSummaryView missionId={mission.id} />);
    else sendText(t("mobile.chat.summaryMessage"));
  };

  // Sending always goes to the end. While an agent works, "Parar e mandar" makes it read this one now.
  const onSend = (raw: string, how: SendHow = "join") => {
    const text = raw.trim();
    // Photos or files waiting above the field: they go with the words, which are their caption (or with none).
    if (pending.length > 0) {
      sendWithFiles(text, how);
      return;
    }
    if (!text) return;
    const cmd = parseSlash(text);
    if (!cmd) {
      const meta = takeQuote();
      sendText(text, how === "now" ? { ...meta, steer: "now" } : meta);
      toEnd();
      return;
    }
    switch (cmd.command) {
      case "mission":
        if (cmd.arg && soleAgent && !mission)
          createMission.mutate(
            { agentId: soleAgent, goal: cmd.arg, ...(threadId ? { threadId } : { channelId }) },
            {
              onSuccess: (m) => {
                toast({
                  title: t("mobile.newMission.created", { name: dir.agentById.get(soleAgent)?.name ?? "" }),
                  agentId: m.agentId,
                });
                if (m.threadId !== threadId) router.push(chatHref(m.channelId, m.threadId));
              },
              onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
            },
          );
        else openNewMission(cmd.arg);
        return;
      case "summary":
        summarize();
        return;
      case "remind":
        openRemind({ text: cmd.arg });
        return;
      case "plan":
        if (mission) router.push(`/mission/${mission.id}`);
        else toast({ title: t("mobile.chat.noMission"), icon: "x" });
        return;
      default: {
        if (!mission) {
          toast({ title: t("mobile.chat.noMission"), icon: "x" });
          return;
        }
        const action = cmd.command;
        control.mutate(
          { missionId: mission.id, action },
          {
            onSuccess: () => toast({ title: t(`mobile.chat.missionDone.${action}`), agentId: mission.agentId }),
            onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
          },
        );
      }
    }
  };

  // GIFs and stickers (ADR 0091): the button only where one can go; one tap in the sheet sends it like any message of
  // mine. The list is aimed at the end before the sheet closes: the place it held under the sheet doesn't come back.
  const settings = useSettings(orgId).data;
  const mediaTabs = mediaTabsOf(settings, dir.agents.length, Boolean(api.gifs));
  const voiceOn = Boolean(meId && settings?.voiceAvailable && settings.voiceMessages);
  const afterVoice = useCallback(() => {
    setQuote(null);
    toEnd();
  }, [toEnd]);
  // A take goes with the words typed beside it and the files waiting above the field, in one message. The files that
  // can't upload keep the take, paused, and the words in the field (the composer puts them back).
  const withVoice = async (text: string) => {
    if (pending.length === 0) return { text, artifacts: [] };
    const artifacts = await uploadPending(pending);
    if (!artifacts) return null;
    artifacts.forEach((a, i) => {
      const file = pending[i];
      if (file) sentWithVoice.current.set(a.id, file);
    });
    setPending([]);
    return { text, artifacts };
  };
  const onRecording = useCallback(() => sendTyping(threadId, undefined, "voice"), [sendTyping, threadId]);
  // "gravando áudio…" goes on for the others while my recording uploads here; the server keeps it from then until the
  // message comes.
  const uploading = useMemo(
    () =>
      list.some(
        (m) =>
          m.local === "pending" &&
          m.author.id === meId &&
          voiceOf(m.meta) &&
          !m.meta?.voiceAccepted &&
          (m.threadId ?? null) === (threadId ?? null),
      ),
    [list, meId, threadId],
  );
  useEffect(() => {
    if (!uploading) return;
    const timer = setInterval(() => sendTyping(threadId, undefined, "voice", true), 1000);
    return () => clearInterval(timer);
  }, [uploading, sendTyping, threadId]);
  const sendMedia = (media: MessageMedia) => {
    sendText("", { ...takeQuote(), media });
    toEnd();
    sheet.close();
  };
  const openMedia = () =>
    sheet.open(
      <MediaPickerSheet
        tabs={mediaTabs}
        channelId={channelId}
        isDm={Boolean(dm)}
        dmAgentId={dmAgentId}
        onSend={sendMedia}
      />,
    );

  // ── Photos and files ──
  // Picked, they wait in the field (`AttachmentStrip`): × takes one out, the words typed are their caption, and
  // send uploads them and sends everything as one message. A thumbnail dims while its upload runs; one that fails
  // stays, marked, and the caption comes back to the field, so nothing typed is lost.
  const [pending, setPending] = useState<PendingFile[]>([]);
  // A picker is open or still handing its files over (a video being converted): a thumbnail says so in the field.
  const [preparing, setPreparing] = useState(false);
  // That thumbnail only once the picker covers the screen: set as the picker opened, it came up in the dock for the
  // moment before the picker did (growing the dock, moving the conversation), and a cancel took it away again.
  const whilePicking = async <T,>(pick: () => Promise<T>): Promise<T> => {
    const covered = setTimeout(() => setPreparing(true), PICKER_COVERS_MS);
    try {
      return await pick();
    } finally {
      clearTimeout(covered);
      setPreparing(false);
    }
  };
  const [captionBack, setCaptionBack] = useState<{ text: string; at: number; join?: boolean } | null>(null);
  // The local files a take carried, by their uploaded ids: a refused take puts them back above the field.
  const sentWithVoice = useRef(new Map<string, PendingFile>());
  const voiceTakeBack = useCallback(({ text, artifacts }: { text: string; artifacts: ArtifactRef[] }) => {
    if (text) setCaptionBack({ text, at: Date.now(), join: true });
    const files = artifacts.flatMap((a) => {
      const file = sentWithVoice.current.get(a.id);
      return file ? [{ ...file, state: "waiting" as const }] : [];
    });
    if (files.length > 0) setPending((now) => [...files, ...now].slice(0, MAX_PENDING));
  }, []);
  const addPending = (all: Omit<PendingFile, "id" | "state">[]) => {
    // Past the upload limit a file never goes: said as it is picked, not after a wait at send.
    const files = all.filter((f) => f.size === undefined || f.size <= MAX_UPLOAD_BYTES);
    if (files.length < all.length)
      toast({ title: t("errors.artifact.fileTooLarge", { max: MAX_UPLOAD_MB }), icon: "x" });
    if (files.length === 0) return;
    const at = Date.now();
    const picked = files.map((f, i): PendingFile => ({ ...f, id: `${at}-${i}-${f.uri}`, state: "waiting" }));
    if (pending.length + picked.length > MAX_PENDING)
      toast({ title: t("mobile.chat.attach.tooMany", { count: MAX_PENDING }), icon: "file" });
    setPending((now) => [...now, ...picked].slice(0, MAX_PENDING));
  };
  const removePending = (id: string) => setPending((now) => now.filter((f) => f.id !== id));
  // A draft past the length limit goes as a text file instead, which agents open like any other.
  const longAsFile = (text: string) => {
    const dir = new Directory(Paths.cache, "drafts", String(Date.now()));
    dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, t("channel.tooLong.fileName"));
    file.write(text);
    addPending([{ uri: file.uri, name: file.name, type: "text/plain" }]);
  };
  const uploadOne = async (file: LocalFile): Promise<ArtifactRef> => {
    const saved: ArtifactDetail = await api.artifacts.upload(orgId, uploadPart(file), {
      channelId,
      ...(threadId ? { threadId } : {}),
    });
    return { id: saved.id, version: saved.version, title: saved.title };
  };
  /** Uploads what waits above the field; null when one failed (they stay, the failed ones marked). */
  const uploadPending = async (files: PendingFile[]): Promise<ArtifactRef[] | null> => {
    setPending((now) => now.map((f): PendingFile => ({ ...f, state: "sending" })));
    const results = await Promise.allSettled(files.map(uploadOne));
    const failed = new Set(files.filter((_, i) => results[i]?.status === "rejected").map((f) => f.id));
    if (failed.size > 0) {
      // Nothing goes half sent: the ones that failed stay marked.
      const after = (f: PendingFile): PendingFile["state"] => (failed.has(f.id) ? "failed" : "waiting");
      setPending((now) => now.map((f) => ({ ...f, state: after(f) })));
      // Why, when it is known (too large, the workspace's storage full, no connection…); else the plain line.
      const reason = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
      const said = reason ? errorText(t, reason, i18n.language, { maxMb: MAX_UPLOAD_MB }) : null;
      toast({ title: said && said !== t("common.unknownError") ? said : t("mobile.chat.uploadFailed"), icon: "x" });
      return null;
    }
    return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  };
  // Sent with files, the message is in the conversation at once, its files drawn from the phone (`LocalFiles`), and
  // the field is free for the next one: they upload behind it, then it goes with them under the same `clientId`, so
  // the server's copy takes its place. One that can't go up turns "Não foi enviada" with "Tentar de novo".
  const sendWithFiles = (text: string, how: SendHow, files: PendingFile[] = pending) => {
    if (files.length === 0) return;
    const replyTo = quote;
    if (replyTo) setQuote(null);
    const clientId = newClientId();
    const local: Message = {
      id: `local-${clientId}`,
      channelId,
      threadId: threadId ?? null,
      author: { type: "person", id: meId ?? "" },
      body: text,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        ...localMeta(replyTo, replyTo ? dir.nameOf(replyTo.author) : "", []),
        [LOCAL_FILES]: files.map(
          (f): LocalFile => ({
            uri: f.uri,
            name: f.name,
            type: f.type,
            ...(f.size !== undefined ? { size: f.size } : {}),
            ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
            ...(f.duration ? { duration: f.duration } : {}),
          }),
        ),
      },
      clientId,
      local: "pending",
      createdAt: new Date().toISOString(),
    };
    qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) => upsertMessage(list, local));
    const sent = new Set(files.map((f) => f.id));
    setPending((now) => now.filter((f) => !sent.has(f.id)));
    toEnd();
    // Behind files still going up, it waits as words do (`sendText`): kept under them as they go (`keepBehind`), where
    // dated when sent it jumped above them (and what was sent between) when they went.
    if (filesAhead.current) waitingBehind.current.push(clientId);
    behindFiles(() => {
      waitingBehind.current = waitingBehind.current.filter((id) => id !== clientId);
      return deliverFiles(local, how);
    });
  };
  /** A just-sent message's files go up, then the message goes with them; one that can't turns it "Não foi enviada". */
  const deliverFiles = async (local: Message, how?: SendHow) => {
    const files = localFilesOf(local.meta);
    const results = await Promise.allSettled(files.map(uploadOne));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) =>
        list?.map((m) =>
          m.local && m.clientId === local.clientId
            ? { ...m, local: "failed" as const, sendFailure: sendFailureOf(failed.reason) }
            : m,
        ),
      );
      // Why, when it is known (too large, the workspace's storage full, no connection…); else the plain line.
      const said = errorText(t, failed.reason, i18n.language, { maxMb: MAX_UPLOAD_MB });
      toast({ title: said !== t("common.unknownError") ? said : t("mobile.chat.uploadFailed"), icon: "x" });
      return;
    }
    const refs = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    // The phone's own copies stand in for the server's: the sent pictures never fade out and back in.
    results.forEach((r, i) => {
      const f = files[i];
      if (r.status === "fulfilled" && f && isLocalMedia(f)) rememberLocalCopy(r.value.id, f.uri);
    });
    const meta = Object.fromEntries(Object.entries(local.meta ?? {}).filter(([k]) => k !== LOCAL_FILES));
    // Awaited (its answer or its failure, which marks the row): what waits behind it goes after it (`behindFiles`).
    await post
      .mutateAsync({
        body: local.body,
        clientId: local.clientId ?? newClientId(),
        threadId: local.threadId,
        meta: { ...meta, artifacts: refs },
        ...(how === "now" ? { steer: "now" as const } : {}),
      })
      .catch(() => undefined);
  };
  const deliverFilesRef = useRef(deliverFiles);
  deliverFilesRef.current = deliverFiles;
  // What another app shared ("Compartilhar com…" picked this agent): it goes at once, through this conversation's own
  // sending, so the photos show in the strip while they upload and the agent starts reading as soon as it lands.
  const shareIn = useShareHandoff(channelId);
  const shareReady = Boolean(meId) && (Boolean(dm) || Boolean(channel));
  // biome-ignore lint/correctness/useExhaustiveDependencies: sent once per handoff (`at`), when the conversation is known
  useEffect(() => {
    if (!shareIn || !shareReady) return;
    takeShareHandoff(shareIn.at);
    if (shareIn.files.length > 0) {
      const files = shareIn.files.map(
        (f, i): PendingFile => ({ ...f, id: `${shareIn.at}-${i}-${f.uri}`, state: "sending" }),
      );
      sendWithFiles(shareIn.text, "join", files);
    } else if (shareIn.text) {
      sendText(shareIn.text);
      toEnd();
    }
  }, [shareIn?.at, shareReady]);
  const pickedAsset = (a: ImagePicker.ImagePickerAsset) => ({
    uri: a.uri,
    name: a.fileName ?? (a.type === "video" ? "video.mp4" : "photo.jpg"),
    type: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"),
    ...(a.fileSize ? { size: a.fileSize } : {}),
    // Its shape and length for its thumbnail in the field.
    ...(a.width > 0 && a.height > 0 ? { width: a.width, height: a.height } : {}),
    ...(a.type === "video" && a.duration ? { duration: a.duration / 1000 } : {}),
  });
  const openPlus = () => sheet.open(<PlusActions media={mediaTabs.length > 0} onPick={(p) => void onPlus(p)} />);
  const onPlus = async (pick: PlusPick) => {
    // What opens next opens once the sheet is gone (`sheet.close` says when): the library, the camera and the files
    // picker presented over it while it slid out were taken away with it, and the app waited for an answer that never
    // came; the next sheet (GIFs, a mission, a reminder, a mission's summary) takes its place the same way. Only the
    // summary sent as a message has nothing to wait for.
    const after = pick !== "summary" || Boolean(mission);
    if (after) await new Promise<void>((done) => sheet.close(done));
    else sheet.close();
    switch (pick) {
      case "media":
        openMedia();
        return;
      case "camera": {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          toast({
            title: t("mobile.plus.noCamera"),
            icon: "camera",
            action: { label: t("mobile.common.openSettings"), onPress: () => void Linking.openSettings() },
          });
          return;
        }
        const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
        if (!res.canceled) addPending(res.assets.map(pickedAsset));
        return;
      }
      case "photos": {
        // iOS closes its picker as soon as the person picks and converts a video after (seconds for a long one), with
        // nothing on the screen: a thumbnail that says "preparing" holds the place until the files arrive.
        const res = await whilePicking(() =>
          ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images", "videos"],
            quality: 0.8,
            // A video goes as 720p H.264 (iOS converts it as it is picked): the library's own (4K, HEVC) passed the
            // upload limit in seconds, and H.264 plays in every browser. Android hands the original, checked by size.
            videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
            allowsMultipleSelection: true,
            selectionLimit: Math.max(1, MAX_PENDING - pending.length),
            orderedSelection: true,
          }),
        );
        if (!res.canceled) addPending(res.assets.map(pickedAsset));
        return;
      }
      case "file": {
        // A large file is copied before the picker answers: the same "preparing" thumbnail meanwhile.
        const res = await whilePicking(() =>
          DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true }),
        );
        if (!res.canceled)
          addPending(
            res.assets.map((a) => ({
              uri: a.uri,
              name: a.name,
              type: a.mimeType ?? "application/octet-stream",
              ...(a.size ? { size: a.size } : {}),
            })),
          );
        return;
      }
      case "mission":
        openNewMission();
        return;
      case "summary":
        summarize();
        return;
      case "remind":
        openRemind();
        return;
    }
  };

  // ── Holding a message, swiping it ──
  // "Responder" quotes the message above the field, in the conversation or the thread (the server keeps the quote in
  // the same place), wherever I can write.
  const canMission = !mission && (Boolean(dm) || Boolean(channel));
  const canReply =
    member &&
    !org?.deletion &&
    (!isThread || thread.data?.state !== "archived") &&
    channel?.can?.post !== false &&
    (!dmAgent || canTalk(dmAgent));
  // What a message's menu works with: the system's menu (iOS, built by each row, `ChatMessage`) and the app's sheet
  // (Android) list the same actions. What it calls keeps its identity, reading the screen as it is when called.
  const onMission = useLatest((goal: string, rootId: string) => openNewMission(goal, rootId));
  const onRemind = useLatest((message: Message) => openRemind({ message }));
  // The app's own sheet only where the platform has no menu of its own: on iOS a hold is the system's.
  const openActions = useLatest((m: Message) =>
    sheet.open(
      <MessageActions
        message={m}
        canMission={canMission}
        inThread={isThread}
        thread={linkThreads.get(m.threadId ?? m.id)}
        onMission={onMission}
        onRemind={onRemind}
        onReply={canReply ? onReply : undefined}
      />,
    ),
  );
  const onLongPress = NATIVE_MENU ? undefined : openActions;

  // ── Pins ──
  const rowsRef = useRef<Row[]>([]);
  // Going to a message (a pin, `?m=`): found among the rows, or older pages loaded until it is (at most
  // `SEEK_MAX_PAGES`); then scrolled to and lit for a moment.
  const [seek, setSeek] = useState<string | null>(focusId);
  const [flashId, setFlashId] = useState<string | null>(null);
  const seekPages = useRef(0);
  const seekPressed = useRef(false);
  const seekReady = isThread ? threadMessages.isSuccess && !threadMessages.isPlaceholderData : top.isSuccess;
  const seekRefreshing = isThread ? threadMessages.isFetching : top.isFetching;
  useEffect(() => {
    if (!seek || !seekReady) return;
    const index = shownRows.findIndex((r) => r.kind === "message" && r.message.id === seek);
    if (index >= 0) {
      setSeek(null);
      seekPressed.current = false;
      letGo();
      void listRef.current?.scrollToIndex({ index, animated: true, ...aimAt(index, 0.4, "start") });
      setFlashId(seek);
      return;
    }
    // A page that failed before this search is asked for again (the search is an explicit ask); one that fails while
    // it looks ends it.
    const pageFailed = olderFailed && seekPages.current > 0;
    if (isThread || olderDone || pageFailed || seekPages.current >= SEEK_MAX_PAGES) {
      // A cached page refreshing may still bring it.
      if (seekRefreshing) return;
      setSeek(null);
      // A page that didn't come says so: the message may well be there.
      if (pageFailed) toast({ title: t("common.loadFailed"), icon: "x" });
      else if (seekPressed.current) toast({ title: t("channel.jumpTooFar") });
      else toast({ title: t("channel.jumpMissing"), icon: "x" });
      seekPressed.current = false;
      return;
    }
    if (!loadingOlder) {
      seekPages.current += 1;
      fetchOlder();
    }
  }, [
    seek,
    seekReady,
    seekRefreshing,
    shownRows,
    isThread,
    olderDone,
    olderFailed,
    loadingOlder,
    fetchOlder,
    letGo,
    aimAt,
    t,
    toast,
  ]);
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);
  const onQuote = useCallback(
    (reply: ReplyRef) => {
      // A thread's reply isn't a row of the conversation: it is on the thread's screen.
      if (!isThread && reply.threadId) {
        router.push(chatHref(channelId, reply.threadId, reply.messageId));
        return;
      }
      seekPages.current = 0;
      seekPressed.current = true;
      setSeek(reply.messageId);
    },
    [isThread, channelId],
  );
  const goToPin = (pin: MessagePin) => {
    sheet.close();
    const target = pinTarget(pin, threadId);
    if (target.kind === "open") {
      router.push(chatHref(channelId, target.threadId, target.messageId));
      return;
    }
    seekPages.current = 0;
    setSeek(target.messageId);
  };
  // From the conversation's options, the next page of that sheet.
  const openPins = () => sheet.push(<PinsSheet channelId={channelId} threadId={threadId} onPick={goToPin} />);
  // The returns agents set here (ADR 0037 addendum): the dock's line at rest, the sheet behind it; a row goes to the
  // reply that said it.
  const returns = useReturnsHere(channelId, threadId);
  const goToReturn = (messageId: string) => {
    sheet.close();
    seekPages.current = 0;
    setSeek(messageId);
  };
  const openReturns = () => sheet.open(<ReturnsSheet channelId={channelId} threadId={threadId} onPick={goToReturn} />);
  // "Buscar nesta conversa" (as the web's header search): on the timeline, not in a thread.
  const searchPlace = isThread
    ? null
    : dm
      ? { id: channelId, name: dm.with.name, dm: true }
      : channel
        ? { id: channelId, name: channel.name }
        : null;
  const goToHit = (hit: SearchHit) => {
    sheet.close();
    const target = hitTarget(hit, channelId);
    if (target.kind === "open") {
      router.push(target.href);
      return;
    }
    seekPages.current = 0;
    setSeek(target.messageId);
  };
  const openSearch = () =>
    searchPlace ? sheet.push(<ConversationSearch place={searchPlace} onPick={goToHit} />) : undefined;
  // "Ver resultado" on a work's line: its report, when this conversation shows it. Its place is the list's, by its key:
  // counted in the rows, it fell one short under the "Novas" line (a row of the list's own).
  const jumpToMessage = useCallback(
    (messageId: string) => {
      const key = rowsRef.current.find((r) => r.kind === "message" && r.message.id === messageId)?.key;
      const index = key === undefined ? undefined : listRef.current?.getState().indexByKey(key);
      if (index === undefined) return false;
      void listRef.current?.scrollToIndex({ index, animated: true, ...aimAt(index, 0.4, "start") });
      return true;
    },
    [aimAt],
  );
  // Who is in the channel: managing it is a screen pushed over the conversation (its place kept for the way back).
  const openMembers = () => {
    if (!channel) return;
    leavePlace();
    router.push(channelMembersHrefs.list(channelId));
  };

  // ── Header ──
  // The header is glass over the conversation: the system's
  // back and "…" circles, and in the middle a pill with who or where, its sky and what the agent is doing.
  const info = thread.data;
  // A task's work thread: its root was written by the server in one language ("Issue #1: …"); the card's
  // number and title, in the reader's.
  const root = isThread ? list.find((m) => m.id === threadId) : undefined;
  const rootWork = issueWorkOf(root?.meta);
  // A task's conversation (ADR 0145): "Conversa da tarefa", the task under it.
  const rootTask = taskConversationOf(root?.meta);
  const title = isThread
    ? rootTask
      ? t("issues.conversation.title")
      : rootWork
        ? t("issues.open", { number: rootWork.number, title: rootWork.title })
        : info
          ? // A thread on a GIF or a sticker has no words of its own to title it (ADR 0091).
            threadTitle(info) || previewOf(root ? textOrMedia(t, root.body, root.meta) : "") || t("mobile.chat.thread")
          : ""
    : dm
      ? dm.with.name
      : channel
        ? `#${channel.name}`
        : "";
  const agentsHere = (roster.data ?? []).filter((r) => r.type === "agent").length;
  const subtitle = isThread
    ? rootTask
      ? `#${rootTask.number} · ${rootTask.title}`
      : info
        ? info.channelKind === "dm"
          ? // A DM's channel name is internal ("dm-…"): the thread says who it is with.
            t(
              mission
                ? "mobile.chat.missionWith"
                : info.state === "closed"
                  ? "mobile.chat.closedThreadWith"
                  : "mobile.chat.threadWith",
              { name: dm?.with.name ?? "" },
            )
          : t(
              mission
                ? "mobile.chat.missionIn"
                : info.state === "closed"
                  ? "mobile.chat.closedThreadIn"
                  : "mobile.chat.threadIn",
              {
                channel: info.channelName,
              },
            )
        : undefined
    : dmAgentId
      ? rightHand
        ? `${t("rightHand.label")} · ${t("rightHand.actsAsYou")}`
        : dir.agentById.get(dmAgentId)?.role || undefined
      : channel && roster.data
        ? // People and agents counted apart: "1 pessoa · 3 agentes", never "4 membros · 3 agentes".
          `${t("mobile.chat.people", { count: roster.data.length - agentsHere })} · ${t("mobile.chat.agentsHere", { count: agentsHere })}`
        : undefined;
  // An agent's DM while it works: the pill's quiet line says what it does ("Consultando o GitHub").
  const dmDoing = useMemo(() => {
    if (!dmAgentId || isThread) return null;
    const entry = workingEntries(runs, lineConsults, (id) => dir.agentById.get(id)?.name ?? "").find(
      (e) => e.type === "agent" && e.id === dmAgentId,
    );
    if (!entry) return null;
    return capitalize(activityVerb(t, entry.activity), i18n.language);
  }, [dmAgentId, isThread, runs, lineConsults, dir.agentById, t, i18n.language]);
  // A DM's pill says how the other side is (ADR 0084): an agent's presence and what it does, a person's line.
  const dmLine = useDmStatusLine(
    dm && !isThread ? { type: dm.with.type, id: dm.with.id } : null,
    dmDoing,
    dmAgentId ? subtitle : undefined,
  );
  // The ⋯ of a DM with a person says how they appear, their line in a card under it.
  const personDm = dm && !dmAgentId && !isThread ? dm.with.id : null;
  const optionsLine = usePresenceWord(personDm ? { type: "person", id: personDm } : null) ?? subtitle;
  // ── Keeping the place ──
  // Something opening over the conversation must not move it: on iOS it jumped when a header button opened a sheet
  // or the agent's computer. Where the person was (the end, or a row on screen) is taken before it opens, and given
  // back for a moment after it opens and after it closes, whichever way the list moved, unless they drag it or
  // the app scrolls it on purpose (sending, the pill, a pin).
  const placeNow = useCallback((): Place | null => {
    const list = listRef.current;
    const state = list?.getState();
    if (!list || !state) return null;
    if (state.isFollowingEnd) return { end: true };
    const anchor = list.anchorVisibleContent({ hold: false });
    const position = anchor ? state.positionByKey(anchor.key) : undefined;
    return { end: false, scroll: state.scroll, key: anchor?.key ?? null, position: position ?? null };
  }, []);
  const holdPlace = useCallback((place: Place | null) => {
    if (!place) return;
    const hold = ++holding.current;
    dragging.current = false;
    const until = Date.now() + HOLD_MS;
    const check = () => {
      if (dragging.current || holding.current !== hold) return;
      const list = listRef.current;
      const state = list?.getState();
      if (list && state) {
        const fix = placeCorrection(place, {
          scroll: state.scroll,
          distanceFromEnd: state.distanceFromEnd,
          positionOf: state.positionByKey,
        });
        if (fix === "end") void list.scrollToEnd({ animated: false });
        else if (fix !== null) void list.scrollToOffset({ offset: fix, animated: false });
      }
      if (Date.now() < until) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, []);
  // Stickers play in the rows in view (a few of them), never under a sheet (ADR 0091).
  const [stickers] = useState(createStickerStage);
  useEffect(() => sheet.subscribe(stickers.setCovered), [sheet, stickers]);
  // The floating date: the day at the top of what is in view, shown while the person drags or flings the list.
  const [topDay, setTopDay] = useState<string | null>(null);
  const dayShown = useSharedValue(0);
  const dayTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideDay = useCallback(() => {
    clearTimeout(dayTimer.current);
    dayTimer.current = setTimeout(() => {
      dayShown.value = withTiming(0, { duration: 300 });
    }, DATE_PILL_IDLE_MS);
  }, [dayShown]);
  const showDay = useCallback(() => {
    dayShown.value = withTiming(1, { duration: 120 });
    hideDay();
  }, [dayShown, hideDay]);
  useEffect(() => () => clearTimeout(dayTimer.current), []);
  const onViewable = useCallback<NonNullable<OnViewableItemsChanged<Row>>>(
    ({ viewableItems }) => {
      stickers.setOnScreen(stickerRowsOnScreen(viewableItems));
      setTopDay((prev) => dayInView(viewableItems, prev));
    },
    [stickers],
  );
  // While something covers the conversation (a sheet, the agent's computer) the list ignores the keyboard: one that
  // opens and closes under the cover (a sheet's own field) must not move it. A keyboard already up leaves first, the
  // list going down with it as with any keyboard closing: frozen while it left, the list kept its room, and a
  // keyboard-tall gap stood over the dock until it dropped all at once after the cover closed.
  const freeze = useSharedValue(false);
  const covered = useRef(false);
  const freezeOnHide = useRef(false);
  const cover = useCallback(() => {
    covered.current = true;
    if (KeyboardController.isVisible()) freezeOnHide.current = true;
    else freeze.value = true;
  }, [freeze]);
  // `now`: back on screen (a pushed screen popped), released at once when no keyboard is up or leaving: kept frozen
  // a moment more, a quick tap on the field raised the keyboard and the dock over the last messages, and the list
  // snapped up after. A keyboard still about (a form sent from JS, closing as it pops) keeps the delay.
  const uncover = useCallback(
    (now = false) => {
      covered.current = false;
      freezeOnHide.current = false;
      if (now && !KeyboardController.isVisible()) {
        freeze.value = false;
        return;
      }
      setTimeout(() => {
        if (!covered.current) freeze.value = false;
      }, FREEZE_AFTER_MS);
    },
    [freeze],
  );
  useEffect(() => {
    const gone = KeyboardEvents.addListener("keyboardDidHide", () => {
      if (!freezeOnHide.current) return;
      freezeOnHide.current = false;
      if (covered.current) freeze.value = true;
    });
    return () => gone.remove();
  }, [freeze]);
  // Every sheet of this screen says when it opens (before the keyboard leaves) and closes: one place for all of
  // them (the header's, a message's, the composer's).
  useEffect(() => {
    let place: Place | null = null;
    let aimedAt = 0;
    return sheet.subscribe((open) => {
      if (open) {
        // A sheet opened from another keeps the place taken by the first.
        if (!covered.current) {
          place = placeNow();
          aimedAt = aimed.current;
        }
        cover();
        holdPlace(place);
        return;
      }
      uncover();
      // Unless the app moved the list on purpose meanwhile (a message sent from the sheet).
      if (aimed.current === aimedAt) holdPlace(place);
    });
  }, [sheet, cover, uncover, placeNow, holdPlace]);
  // The agent's computer opens full screen: where the conversation was is kept, and given back on return.
  const away = useRef<Place | null>(null);
  const left = useRef(false);
  const leavePlace = useCallback(() => {
    away.current = placeNow();
    left.current = true;
    holdPlace(away.current);
    cover();
    Keyboard.dismiss();
  }, [placeNow, holdPlace, cover]);
  useFocusEffect(
    useCallback(() => {
      if (!left.current) return;
      left.current = false;
      holdPlace(away.current);
      uncover(true);
    }, [holdPlace, uncover]),
  );
  const openOptions = () =>
    info && isThread
      ? sheet.open(
          <ThreadOptions
            thread={info}
            mission={mission}
            onMission={() => openNewMission("", info.id)}
            onPins={openPins}
          />,
        )
      : sheet.open(
          <ChannelOptions
            channelId={channelId}
            title={title}
            {...(optionsLine ? { subtitle: optionsLine } : {})}
            leading={
              dm ? (
                <OpensAgent agentId={dm.with.id}>
                  <Face who={{ type: dm.with.type, id: dm.with.id }} size={36} live={false} />
                </OpensAgent>
              ) : (
                <Tile icon="hash" />
              )
            }
            agentId={dmAgentId}
            about={personDm ? <PersonStatusCard userId={personDm} /> : undefined}
            onPins={openPins}
            onMembers={
              channel && !dm
                ? () => {
                    sheet.close();
                    openMembers();
                  }
                : undefined
            }
            onSearch={dm && searchPlace ? openSearch : undefined}
          />,
        );
  // Holding the pill: "Trocar de conversa". The pick swaps the conversation in place (the route's params; the
  // screen is keyed by them), not a new screen sliding in: the slide made the header's pill jump at its end.
  // The swap waits for the sheet to be gone (it lives in this screen, which the swap remounts): `sheet.close` says when.
  // The params merge, so the message this one opened at (`m`, from a notification) goes too: kept, the next
  // conversation paged back through its history looking for it, then said it couldn't reach it.
  const hold = {
    onHold: () => {
      sheet.open(
        <ConversationSwitcher
          channelId={channelId}
          onPick={(id) => {
            if (id === channelId) sheet.close();
            else sheet.close(() => router.setParams({ channelId: id, thread: "", handoff: "", m: "" }));
          }}
        />,
      );
    },
    holdHint: t("mobile.chat.switchHint"),
  };
  const pill =
    isThread && info ? (
      <HeaderPill
        lead={<Icon name="reply" size={18} color={c.muted} />}
        title={title}
        subtitle={subtitle}
        onPress={openOptions}
        {...hold}
        label={t("mobile.chat.headerChannel", { who: who(title, subtitle ?? "") })}
      />
    ) : dm ? (
      <HeaderPill
        lead={
          dmAgentId ? (
            <AgentFace
              agentId={dmAgentId}
              size={32}
              framed={false}
              mode={dmDoing ? "run" : "idle"}
              presence
              ring={c.glassSolid}
            />
          ) : (
            <Face who={{ type: dm.with.type, id: dm.with.id }} size={32} live={false} presence ring={c.glassSolid} />
          )
        }
        title={dm.with.name}
        subtitle={dmLine ?? dmDoing ?? subtitle}
        color={dmAgentId ? agentLook(dmAgent).color : undefined}
        working={Boolean(dmDoing)}
        // Reading far up, only the face stays (the screen is the messages); a new reply opens it again.
        collapsed={far && unseen.messages === 0}
        extraActions={(dmAgentId ? 1 : 0) + (queueShown ? 1 : 0) + (agentTasks ? tasksBadge(agentTasks).room : 0)}
        onPress={dmAgentId ? () => router.push(`/agent/${dmAgentId}`) : openOptions}
        {...hold}
        label={
          dmAgentId
            ? t("mobile.chat.headerAgent", { who: who(dm.with.name, dmLine ?? dmDoing ?? subtitle ?? "") })
            : t("mobile.chat.headerChannel", { who: who(dm.with.name, dmLine ?? "") })
        }
      />
    ) : channel ? (
      <HeaderPill
        lead={<Icon name="hash" size={18} color={c.muted} />}
        title={channel.name}
        subtitle={roster.data ? t("mobile.chat.here", { count: roster.data.length }) : undefined}
        // The channel's sky in the pill, as an agent's DM: the color of the first agent in it.
        color={agentLook(dir.agentById.get(roster.data?.find((r) => r.type === "agent")?.id ?? "")).color}
        trailing={
          roster.data && roster.data.length > 0 ? (
            <View style={styles.faces}>
              {roster.data.slice(0, 3).map((r, i) => (
                // Every face the same size and shape box, ringed in the pill's glass: an agent in its tile
                // (its body alone stood lower than a person's circle), a person in a circle.
                <View
                  key={`${r.type}:${r.id}`}
                  style={[
                    styles.pillFace,
                    i > 0 && styles.pillOverlap,
                    { borderColor: c.glassSolid },
                    r.type !== "agent" && styles.round,
                  ]}
                >
                  <Face who={r} size={20} live={false} />
                </View>
              ))}
            </View>
          ) : undefined
        }
        onPress={openMembers}
        extraActions={(queueShown ? 1 : 0) + (searchPlace ? 1 : 0)}
        {...hold}
        // A channel's pill opens who is in it, and says so (its "…" holds the options).
        label={t("mobile.chat.headerMembers", { who: who(title, subtitle ?? "") })}
      />
    ) : null;
  // An agent's DM also opens its tasks while it has some (ADR 0128), pushed like a thread, and its computer (as the
  // web's DM header) for whoever may watch it: one entry, the line while turns wait for the computer (the way on to
  // it inside), else the computer.
  const dmComputer = dmAgentId && !isThread && !rightHand ? { agentId: dmAgentId, onOpen: leavePlace } : undefined;
  const right =
    (isThread && info) || dm || channel ? (
      <>
        {dmAgentId && agentTasks ? (
          <AgentTasksButton
            agentId={dmAgentId}
            view={agentTasks}
            onPress={() => {
              leavePlace();
              router.push(agentTasksHref(dmAgentId, { channelId, threadId }));
            }}
          />
        ) : null}
        {/* Its AI and model are changed on its profile ("Pensa com"), not from the bar. */}
        {queueShown && barQueue && queueMachineId ? (
          dmComputer ? (
            <DmQueueButton
              agentId={dmComputer.agentId}
              queue={barQueue}
              onPress={() => openQueue(queueMachineId, dmComputer)}
            />
          ) : (
            <QueueButton queue={barQueue} onPress={() => openQueue(queueMachineId)} />
          )
        ) : dmComputer ? (
          <DmComputerButton agentId={dmComputer.agentId} onOpen={leavePlace} />
        ) : null}
        {/* A DM searches from its "…" (its name and the agent's own buttons keep the room). */}
        {searchPlace && !dm ? (
          <IconButton icon="search" label={t("searchPage.searchHere")} onPress={openSearch} />
        ) : null}
        <IconButton icon="more" label={t("mobile.chat.options")} onPress={openOptions} />
      </>
    ) : null;

  const placeholder = isThread
    ? rootTask
      ? // One line on the phone: the tip after "·" in the web's placeholder doesn't fit.
        t("issues.comment")
      : t("mobile.chat.reply")
    : dm
      ? // One line on the phone: the right hand's "nada muda sem você" doesn't fit beside its name.
        t("mobile.chat.messageTo", { name: dm.with.name })
      : t("mobile.chat.messageIn", { channel: channel ? `#${channel.name}` : "" });
  rowsRef.current = rows;
  const pinned = mission && isOpenMission(mission) ? mission : null;
  const hasPins = useMemo(() => pinsIn(pinsData ?? [], threadId).length > 0, [pinsData, threadId]);

  // ── Agents' receipts and "no AI" ──
  // One receipt on screen (`receiptMessageId`): a mark beside my bubble, or at the end of the name line of someone
  // else's turn; a line under the message only for what asks something of you.
  const receiptId = useMemo(() => receiptMessageId(shownMessages, live.receipts), [shownMessages, live.receipts]);
  const receiptMine = Boolean(meId && shownMessages.find((m) => m.id === receiptId)?.author.id === meId);
  // Someone else's message sent into a task at work says nothing here (mine wears it: `ReceiptMark`).
  const receiptSteered = useSteerState(orgId, channelId, receiptId && !receiptMine ? receiptId : "") !== null;
  const markAt = useMemo(
    () =>
      !receiptId || receiptSteered
        ? null
        : receiptMine
          ? receiptId
          : markRowId(rows, receiptId, { faces: rowLook.faces, bubbles: rowLook.style === "bubbles" }),
    [receiptId, receiptSteered, receiptMine, rows, rowLook.faces, rowLook.style],
  );
  // The line redraws when what it shows changes, not on every event that touches the receipt (typing).
  const receiptNow = receiptId ? live.receipts[receiptId] : undefined;
  const receiptKey = receiptNow
    ? JSON.stringify([
        receiptNow.agents,
        receiptNow.routed,
        receiptNow.noAi ?? null,
        receiptNow.blocked ?? null,
        receiptNow.referenced ?? null,
        receiptNow.mentioned ?? null,
        receiptNow.picking ?? null,
        receiptNow.mentionNeeded ?? null,
        receiptNow.decidedBy ?? null,
      ])
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `receiptKey` stands for the receipt
  const receipt = useMemo(() => receiptNow, [receiptKey]);
  // Agents' messages that called several agents (their strip, `FanStrip`) and a person's mention of everyone one agent
  // answered for all (`EveryoneLine`). Only their receipts redraw the list.
  const fanned = useMemo(
    () =>
      shownMessages.filter(
        (m) => (m.author.type === "agent" && m.mentionedAgentIds.length > 1) || m.meta?.everyoneShape,
      ),
    [shownMessages],
  );
  const fanNow = fanned.map((m) => [m.id, live.receipts[m.id]] as const);
  const fanKey = JSON.stringify(fanNow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fanKey` stands for the receipts
  const receipts: ReceiptsState = useMemo(() => Object.fromEntries(fanNow.filter(([, r]) => r)), [fanKey]);
  // Above the box: an agent here without an AI, or the whole workspace without one (as on the web).
  const aiStatus = useAiStatus(orgId);
  const planHeld = usePlanHold(orgId, org) !== null;
  // The right hand's greeting says it itself (its Connect AI card).
  const banner =
    member && !rightHand && !planHeld && !setupIntro
      ? noAiBanner(aiStatus.data, {
          agentIds: dmAgentId ? [dmAgentId] : channelAgents,
          dmAgentId,
          cardShown: endsOnNoAiCard(shownMessages),
        })
      : null;
  const connectInline = banner === null;
  // A thread opens on its root the channel holds (`isPlaceholderData`) when it has no replies to wait for.
  const loading = isThread
    ? threadMessages.isLoading || (threadMessages.isPlaceholderData && (thread.data?.replyCount ?? 1) > 0)
    : top.isLoading;

  // ── Asking for notifications where it makes sense ──
  // Right after an agent says it will take a while (a long work it is still on, ADR 0121), once, under that
  // message: "Quer saber quando a Dora terminar?" with Avisar. Only while the app may still ask (the person
  // hasn't answered the system yet), and never twice on this screen.
  const push = usePush();
  const longWorkAt = useMemo(() => {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.author.type === "agent" && m.longWork && !workIsOver(m.longWork)) return m.id;
    }
    return null;
  }, [list]);
  const [offerAt, setOfferAt] = useState<string | null>(null);
  const { markOffered } = push;
  const mayOffer = push.offer.answer && member;
  useEffect(() => {
    if (offerAt || !longWorkAt || !mayOffer) return;
    setOfferAt(longWorkAt);
    // Counted as offered once it shows: the home's own ask waits its turn after this one.
    markOffered();
  }, [offerAt, longWorkAt, mayOffer, markOffered]);

  // What every message row is handed alike (`ChatMessage`), each keeping its identity across the screen's redraws.
  const onOfferDone = useCallback(() => setOfferAt(OFFER_DONE), []);
  const hands = useMemo<RowHands>(
    () => ({ onReply, onMission, onRemind, onLongPress, onRetry, onQuote, onResend, onOfferDone }),
    [onReply, onMission, onRemind, onLongPress, onRetry, onQuote, onResend, onOfferDone],
  );

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.kind) {
        case "day":
          return (
            <Text variant="footnote" tone="faint" style={[styles.day, { marginTop: rhythm.turn }]}>
              {when.day(item.iso)}
            </Text>
          );
        case "marker":
          return (
            <Text variant="footnote" tone="faint" style={[styles.day, { marginTop: rhythm.turn }]}>
              {item.text}
            </Text>
          );
        case "wait":
          return <QueueWaitRow channelId={channelId} wait={item.wait} />;
        case "unseen":
          return <UnseenLine />;
        case "browser": {
          const agentId = item.run ? item.run.agentId : item.handoff.agentId;
          return (
            <Animated.View
              entering={isFresh(item.key) ? ENTER : undefined}
              style={[styles.browserRow, { paddingLeft: quiet, marginTop: rhythm.turn }]}
            >
              {item.run ? (
                <BrowserRunCard
                  run={item.run}
                  open={openBrowsers.has(agentId)}
                  onToggle={(open) => toggleBrowser(agentId, open)}
                />
              ) : (
                <BrowserCard
                  agentId={agentId}
                  handoff={item.handoff}
                  open={openBrowsers.has(agentId)}
                  onToggle={(open) => toggleBrowser(agentId, open)}
                />
              )}
            </Animated.View>
          );
        }
        case "image":
          return (
            <Animated.View
              entering={isFresh(item.key) ? ENTER : undefined}
              style={[styles.browserRow, { paddingLeft: quiet, marginTop: rhythm.turn }]}
            >
              <ImageMaking color={agentLook(dir.agentById.get(item.run.agentId)).color} />
            </Animated.View>
          );
        case "message":
          // What reached an agent's conversation (a routine's report, another agent's answer) and a routine
          // that ran in the background: quiet lines, never a person's or the agent's own voice.
          if (isEventLine(item.message.meta))
            return (
              <EventLine
                message={item.message}
                fold={consultFolds.get(item.message.id)}
                gap={item.afterLine ? rhythm.part : rhythm.turn}
              />
            );
          // An agent took an issue made from this conversation: one quiet line, not a voice.
          if (issueTakenOf(item.message.meta))
            return <IssueTakenLine message={item.message} gap={item.afterLine ? rhythm.part : rhythm.turn} />;
          // Handed only what is its own (the rest is the same for every row): a receipt or a lit row redraws one row.
          return (
            <ChatMessage
              item={item}
              fresh={isFresh(item.key)}
              lit={item.message.id === flashId}
              isThread={isThread}
              meId={meId}
              canReply={canReply}
              canMission={canMission}
              thread={isThread ? undefined : linkThreads.get(item.message.id)}
              menuThread={linkThreads.get(item.message.threadId ?? item.message.id)}
              aboveThread={item.above && !isThread ? linkThreads.has(item.above.id) : false}
              markReceipt={item.message.id === markAt ? receipt : undefined}
              seenBy={item.message.id === seenId ? seenBy : undefined}
              fanReceipt={receipts[item.message.id]}
              line={item.message.id === receiptId}
              lineReceipt={item.message.id === receiptId ? receipt : undefined}
              connectInline={connectInline}
              offer={item.message.id === offerAt}
              hands={hands}
            />
          );
      }
    },
    [
      when,
      rhythm,
      quiet,
      meId,
      isThread,
      channelId,
      isFresh,
      openBrowsers,
      toggleBrowser,
      receiptId,
      receipt,
      markAt,
      seenId,
      seenBy,
      connectInline,
      consultFolds,
      flashId,
      receipts,
      canReply,
      canMission,
      linkThreads,
      offerAt,
      hands,
      dir,
    ],
  );

  // Pushes about this conversation stay quiet while it is on screen (no banner, no buzz), and so does the island.
  useEffect(() => {
    if (!focused) return;
    // The release clears it only if it still holds this screen's conversation (the next screen may have
    // taken over before this one's blur).
    return holdOpenConversation({ orgId, channelId, threadId });
  }, [focused, orgId, channelId, threadId]);
  // "Falar com o Theo" from two agents' conversation: "@theo " in this field, once this screen is in view again.
  const composerRequest = useComposerRequest(channelId);
  const prefill = focused ? composerRequest : null;
  useEffect(() => {
    if (prefill) takeComposerRequest(prefill.at);
  }, [prefill]);

  // ── Composer and keyboard ──
  // The field is its own piece (`ChatComposer`), handed things that stay the same from one render of the conversation
  // to the next: an agent's work arrives here many times a second, and none of it redraws the field under the
  // person's typing. What it calls reads the conversation as it is at that moment (`useLatest`).
  const sendFromField = useLatest(onSend);
  const voiceFromField = useLatest(withVoice);
  const plusFromField = useLatest(openPlus);
  const longFromField = useLatest(longAsFile);
  const removeFromStrip = useLatest(removePending);
  const cancelQuote = useCallback(() => setQuote(null), []);
  const quoteName = quote ? dir.nameOf(quote.author) : null;
  const canAttach = pending.length < MAX_PENDING;
  // Whom it answers, over the field.
  const composerBanner = useMemo(
    () => (quoteName !== null ? <QuoteBar name={quoteName} onCancel={cancelQuote} /> : undefined),
    [quoteName, cancelQuote],
  );
  // Photos and files waiting to go, inside the field over their caption.
  const composerAttachments = useMemo(
    () =>
      pending.length > 0 || preparing ? (
        <AttachmentStrip files={pending} preparing={preparing} onRemove={removeFromStrip} />
      ) : undefined,
    [pending, preparing, removeFromStrip],
  );
  const everyoneOffered = offersEveryone(org, Boolean(dm));
  const mentionCard = useCallback<NonNullable<ComposerProps["mention"]>>(
    ({ query, sigil, pick }) =>
      sigil === "#" ? (
        <ChannelPicker query={query} pick={pick} />
      ) : (
        <MentionPicker
          query={query}
          pick={pick}
          channelId={channelId}
          members={mentionMembers}
          everyone={everyoneOffered}
        />
      ),
    [channelId, mentionMembers, everyoneOffered],
  );
  const onType = useCallback((text: string) => sendTyping(threadId, text), [sendTyping, threadId]);
  // The composer floats over the list's bottom and rides the keyboard (KeyboardStickyView); the list's end
  // inset is the composer's height plus the keyboard, moved on the UI thread frame by frame (also while the
  // keyboard is dragged down interactively).
  // The "@" picker floats above the box, outside what is measured (`ComposerFloat`): it comes and goes as the person
  // types and the conversation stays where it is. No suggestion pills over the conversation: always there, they read
  // as noise (the owner had them removed).
  const composerRef = useRef<ComponentRef<typeof View>>(null);
  const [composerFloat] = useState(createComposerFloat);
  const endInset = useSharedValue(0);
  // On iOS the keyboard library moves what rides the keyboard (the composer's dock) when a move starts and while
  // the keyboard is dragged, and never when the move ends, while the list takes its room from the start and the
  // end. A last event that wasn't the final state left the box up at the keyboard's height over a list that had
  // gone back down. The end of every move has the last word for both.
  const keyboardAt = useReanimatedKeyboardAnimation();
  useKeyboardHandler(
    {
      onEnd: (e) => {
        "worklet";
        keyboardAt.height.value = -e.height;
        keyboardAt.progress.value = e.progress;
      },
    },
    [],
  );
  // And the system's own word once the keyboard is fully shown or gone: a drag down that let go mid-way could end with
  // no final move at all, the dock left floating over the conversation with the keyboard gone (seen on a phone). The
  // system tells JS when the keyboard finished hiding or showing; that settles both. On iOS only: there the system's
  // height is the library's (the keyboard's frame), while Android's leaves out the navigation bar the library counts
  // edge to edge, so a late event sank the box that far behind the keys; and there the library ends every move itself.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const settle = (height: number) => {
      keyboardAt.height.value = -height;
      keyboardAt.progress.value = height > 0 ? 1 : 0;
    };
    const hide = Keyboard.addListener("keyboardDidHide", () => settle(0));
    const show = Keyboard.addListener("keyboardDidShow", (e) => settle(e.endCoordinates.height));
    return () => {
      hide.remove();
      show.remove();
    };
  }, [keyboardAt]);
  // Read while laying out the box: at the conversation's end and following it (not held where the person reads).
  const followingEnd = useRef(true);
  followingEnd.current = atEnd && !readHold;
  // Whether the conversation follows its end right now. The screen's `atEnd` is false while the list is still on its
  // way down to a message just sent; the list's own follow (`maintainScrollAtEnd`) is on then, and is what counts.
  const followsEnd = () => {
    if (readHold) return false;
    if (followingEnd.current) return true;
    const state = listRef.current?.getState();
    return !!state && (state.isFollowingEnd || state.isAtEnd);
  };
  const onComposerBoxLayout = (e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height;
    const before = dock.get();
    const grew = before > 0 && height > before + 0.5;
    endInset.value = height;
    // Only what is drawn from it redraws (`DockHeight`); the waiting requests look again at their band's new bottom.
    dock.set(height);
    watchList();
    // The dock grew under the conversation (who is working, the reply bar, a taller field) while it follows its end.
    // The libraries cover only part of it: the keyboard's scroll view shifts the list by the grown inset only when it
    // rests at its end, and with the keyboard up the list learns the new inset without following it. A message just
    // sent is still scrolling down when an agent starts thinking, so its last lines stayed under the working line.
    // Two frames on, once the inset is in (the list's distance counts it), a list left short goes on to the end: one
    // that the scroll view already shifted is at its end and isn't moved twice.
    if (grew && followsEnd())
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const state = listRef.current?.getState();
          if (followsEnd() && state && state.distanceFromEnd > END_SLACK)
            void listRef.current?.scrollToEnd({ animated: true });
        }),
      );
  };
  const bottomPad = Math.max(insets.bottom, 10);
  // The header floats over the conversation (glass on iOS 26, a blur before; round plates on Android), which
  // fades under it.
  // Peeked at from the list (iOS's long press): no bar over it and no composer, so no room for either.
  const barHeight = useHeaderHeight();
  const headerHeight = peeking ? 0 : barHeight;
  // The list draws a screen's height of rows past each edge of what shows (half again more ahead of the scroll): a row
  // mounts and measures itself out of sight, never under the person's eyes as they fling.
  const { height: windowHeight } = useWindowDimensions();
  // How far down the fade under the header stays solid: the status bar's share of it.
  const topFadeSolid = headerHeight > 0 ? Math.min(1, insets.top / (headerHeight + 28)) : 0;
  const lift = Math.max(0, bottomPad - KEYBOARD_GAP);
  const showList = !loading && !(rows.length === 0 && runs.length === 0);
  // The conversation starts below the clear bar by our own padding, on both platforms (the pinned card, when there
  // is one, already holds that room). iOS's automatic inset made keyboard moves land short at the end.
  const hasPin = pinned !== null;
  band.current = { top: hasPin ? 0 : headerHeight, lift };
  // The conversation's first message is loaded (a thread loads whole): what sits above it can show.
  const atStart = isThread || olderDone || (top.data?.length ?? 0) < MESSAGES_PAGE;
  const listPad = useMemo(
    () => (hasPin ? styles.listPad : [styles.listPad, { paddingTop: headerHeight + 8 }]),
    [hasPin, headerHeight],
  );

  // ── Requests out of view ──
  // A waiting request shows while 40 points of its card do in the list's band: below the floating header (a pinned
  // card already holds that room) and above the composer, which rides the keyboard less `lift` (its dock's offset).
  // Nothing is out of view before the list is placed at the end, so the line above the composer never flashes.
  const listFrame = useRef<ComponentRef<typeof View>>(null);
  const listPlaced = useRef(false);
  const askInsets = useCallback(() => {
    if (!listPlaced.current) return null;
    const keyboard = KeyboardController.isVisible() ? Math.max(0, KeyboardController.state().height - lift) : 0;
    return { top: hasPin ? 0 : headerHeight, bottom: dock.get() + keyboard };
  }, [hasPin, headerHeight, lift, dock]);
  // A row the list doesn't draw now (outside what it keeps mounted) has no card: its request is out of view.
  const askDrawn = useCallback((messageId: string) => {
    const state = listRef.current?.getState();
    const key = rowsRef.current.find((r) => r.kind === "message" && r.message.id === messageId)?.key;
    const index = state && key !== undefined ? state.indexByKey(key) : undefined;
    return state !== undefined && index !== undefined && index >= state.startBuffered && index <= state.endBuffered;
  }, []);
  const watchList = useAskWatch(asks, { frame: () => listFrame.current, insets: askInsets, drawn: askDrawn });
  const onListScroll = useCallback(() => {
    watchList();
    const state = listRef.current?.getState();
    if (state) setFar(screenAboveEnd(state.distanceFromEnd, state.scrollLength));
  }, [watchList]);
  // The conversation's agent peeks up from behind the dock as the person pulls past the last message (`ChatPeek`), read
  // from the list's scroll view on the UI thread: the keyboard's list lends it through `refScrollView`, next to its own.
  const listScroll = useAnimatedRef<Animated.ScrollView>();
  const peekAgentId = useMemo(() => (PEEK ? peekAgentOf(dmAgentId, shownMessages) : null), [dmAgentId, shownMessages]);
  const pull = usePullPastEnd(listScroll, peekAgentId !== null);

  // The list shows once it sits where it opens, at the end or at the "Novas" line (no frame of it placing itself), as
  // Bluesky's and Expensify's do; from a little opacity, not none, so the glass inside rows keeps drawing.
  const listShown = useSharedValue(0.05);
  const listFade = useAnimatedStyle(() => ({ opacity: listShown.value }));
  // Until then the conversation's skeleton stands where the messages will (`ChatSkeleton`), and leaves as they fade in.
  const [placed, setPlaced] = useState(false);
  const revealList = useCallback(() => {
    listShown.value = withTiming(1, { duration: 160 });
    listPlaced.current = true;
    setPlaced(true);
    watchList();
  }, [listShown, watchList]);
  useEffect(() => {
    if (!showList) return;
    const timer = setTimeout(revealList, SHOW_LIST_MS);
    return () => clearTimeout(timer);
  }, [showList, revealList]);

  // Whether the list follows the end (its own intent: kept through a drag's momentum and while a scroll to the end
  // lands, released by reading up, rearmed back near the end): the "new messages" button shows otherwise.
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    // A new list opens at the end (initialScrollAtEnd); only changes count from here, so the button never
    // flashes on open.
    setAtEnd(true);
    return state.listen("isFollowingEnd", setAtEnd);
  }, [showList]);

  // "Última mensagem lida" with something unread: it opens at the "Novas" line, kept as it was on opening because
  // reading moves it. Threads open at their end, and a conversation asked to open at a message (a pin) at that message.
  // Read as the lists arrive: a notification can open it before them; one they don't have opens at its end.
  const readFrom = useRef<{ at: string | null | undefined } | null | undefined>(undefined);
  if (readFrom.current === undefined && (isThread || focusId || channel || dm || unlisted))
    readFrom.current =
      !isThread && !focusId && opensAtLastRead(org?.chatPrefs, channel?.unreadCount ?? dm?.unread ?? 0)
        ? { at: channel?.lastReadAt ?? dm?.lastReadAt }
        : null;
  const openFrom = readFrom.current;
  // The list laid out (`onReady`) shows only once where it opens is settled: placed at its end and taken to the line
  // after, it showed its end and then jumped. `SHOW_LIST_MS` still shows it whatever happens.
  const listReady = useRef(false);
  const atReadDone = useRef(false);
  const goingToLine = useRef(false);
  const revealOpened = useCallback(() => {
    if (listReady.current && atReadDone.current && !goingToLine.current && rowsCompleteRef.current) revealList();
  }, [revealList]);
  const onListReady = useCallback(() => {
    listReady.current = true;
    revealOpened();
  }, [revealOpened]);
  useEffect(() => {
    if (rowsComplete) revealOpened();
  }, [rowsComplete, revealOpened]);
  // The line at the top of the room under the bar, with no glide, what came since right under it (sent to the top as
  // is, it landed under the bar, the line and the first new message hidden). The list stops following its end there,
  // as when reading a long message from its top. The line is a row this same render puts in: the list has it a frame
  // or two on.
  const openAtLine = useCallback(
    (key: string) =>
      new Promise<void>((landed) => {
        letGo();
        setReadHold(true);
        let frames = 0;
        const go = () => {
          const list = listRef.current;
          const line = list?.getState().indexByKey(DIVIDER_KEY);
          if (list && line === undefined && ++frames < 4) {
            requestAnimationFrame(go);
            return;
          }
          const index = line ?? list?.getState().indexByKey(key);
          if (!list || index === undefined) {
            landed();
            return;
          }
          const viewOffset = band.current.top + BAND_GAP;
          void list.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset }).finally(landed);
        };
        // After the render that turns following off, so the end doesn't pull it back down.
        requestAnimationFrame(go);
      }),
    [letGo],
  );
  useEffect(() => {
    if (atReadDone.current || openFrom === undefined) return;
    if (openFrom === null) {
      atReadDone.current = true;
      revealOpened();
      return;
    }
    if (!showList || !top.data || rows.length === 0) return;
    const id = firstUnreadId(list, openFrom.at, meId);
    const key = rows.find((r) => r.kind === "message" && r.message.id === id)?.key;
    // A page kept from an earlier visit has none of them: wait for the fresh one.
    atReadDone.current = Boolean(key) || !top.isFetching;
    if (!key) {
      revealOpened();
      return;
    }
    setPlacedDivider(key);
    goingToLine.current = true;
    void openAtLine(key).then(() => {
      goingToLine.current = false;
      // All that came since fits above the dock: at the end already, it follows it.
      releaseAtEnd();
      revealOpened();
    });
  }, [openFrom, showList, top.data, top.isFetching, rows, list, meId, openAtLine, releaseAtEnd, revealOpened]);

  // Opened with something unread that isn't at its end: a reply in a thread, one link under its root, maybe far
  // above. That root comes into view, flashed, instead of an end with nothing new (as on the web). Once, with what
  // was unread on opening; never over a message the screen was asked to open at.
  const openedUnread = useRef<{ count: number; at: string | null | undefined } | undefined>(undefined);
  if (openedUnread.current === undefined && (channel || dm))
    openedUnread.current = {
      count: isThread || focusId ? 0 : (channel?.unreadCount ?? dm?.unread ?? 0),
      at: channel?.lastReadAt ?? dm?.lastReadAt,
    };
  const threadLanded = useRef(false);
  useEffect(() => {
    const opened = openedUnread.current;
    // The messages and the threads as the server has them now: lists kept from an earlier visit know nothing new.
    if (threadLanded.current || !opened || !showList || !top.isSuccess || top.isFetching) return;
    if (opened.count > 0 && (!channelThreads.isSuccess || channelThreads.isFetching)) return;
    threadLanded.current = true;
    if (opened.count === 0) return;
    const root = unreadThreadRootId(
      list.filter((m) => !m.threadId),
      // A thread made from a range has no root in the conversation (its marker stands there).
      (channelThreads.data?.threads ?? []).filter((x) => !x.context),
      opened.at,
      meId,
    );
    if (!root) return;
    seekPages.current = 0;
    seekPressed.current = true;
    setSeek(root);
  }, [
    showList,
    top.isSuccess,
    top.isFetching,
    channelThreads.isSuccess,
    channelThreads.isFetching,
    channelThreads.data,
    list,
    meId,
  ]);

  // ── Reading from the top ──
  // A message someone else wrote (an agent's reply, also while it streams, or a teammate's) taller than the room
  // between the bar and the box lands once with its first line under the bar, as on the web (`readingLanding`),
  // and the list stops following the end, so it reads top to bottom. Reaching the end, sending or the pill
  // follow again. Rows there when the conversation opens, and one arriving while the person reads above, never
  // move it.
  const landedRef = useRef(new Set<string>());
  const toReadRef = useRef<string | null>(null);
  const readPrevRef = useRef<string[]>([]);
  useEffect(() => {
    const byKey = new Map(scrollRows.map((r) => [r.key, r]));
    for (const key of appendedKeys(readPrevRef.current, rowKeys)) {
      const r = byKey.get(key);
      if (!r || r.kind === "other") continue;
      // Your own message goes to the end as always; what was waiting to be read before it no longer jumps.
      toReadRef.current = r.mine || landedRef.current.has(key) ? null : key;
    }
    readPrevRef.current = rowKeys;
  }, [rowKeys, scrollRows]);
  // Taller than the room it shows in (under the bar, over the dock and the keyboard). The list says the new size before
  // it measures the row (an estimate): a row not measured yet waits for its own size, never taken for a tall one.
  const checkReading = useCallback(() => {
    const key = toReadRef.current;
    const room = roomNow();
    if (!key || !room) return;
    const index = room.state.indexByKey(key);
    if (index === undefined) return;
    // Typed as always known; it is the measured size, and a row not measured yet has none.
    const size: number | undefined = room.state.sizeAtIndex(index);
    if (size === undefined || size <= room.height - BAND_GAP) return;
    toReadRef.current = null;
    landedRef.current.add(key);
    if (!atEndRef.current) return;
    setReadHold(true);
    // After the render that turns following off, so the end doesn't pull it back down.
    requestAnimationFrame(() => {
      const viewOffset = band.current.top + BAND_GAP;
      void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset });
    });
  }, [roomNow]);
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    return state.listen("totalSize", checkReading);
  }, [showList, checkReading]);
  // A reply is judged against the room it landed in. One that fit with the keyboard down is never judged again over
  // the keyboard: a row changing size while the person types pulled the conversation up to that old reply's first line.
  useEffect(() => {
    const shown = KeyboardEvents.addListener("keyboardWillShow", () => {
      toReadRef.current = null;
    });
    return () => shown.remove();
  }, []);
  // Rows growing or shrinking (a reply streaming, a card opening) move the waiting requests' cards and the live rows.
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    return state.listen("totalSize", watchList);
  }, [showList, watchList]);

  // ── The list's own props ──
  // The list is drawn again only when what it is handed changes (`ConversationList`): someone typing, a presence, an
  // agent's step redraw the screen many times a minute and leave it alone. So nothing it is handed is made anew there.
  const listIndicator = useMemo(() => ({ top: headerHeight }), [headerHeight]);
  const onDragStart = useCallback(() => {
    dragging.current = true;
    showDay();
  }, [showDay]);
  const onScrollSettled = useCallback(() => {
    releaseAtEnd();
    hideDay();
  }, [releaseAtEnd, hideDay]);
  const openPinsHere = useLatest(openPins);
  const goToPinHere = useLatest(goToPin);
  // Before the conversation's start: the older pages' row (a spinner while one loads, the way to ask again when one
  // didn't). At its start, once it is loaded: the pinned messages (pulling down past the first message reveals them),
  // then the right hand's greeting or a new agent's checklist.
  const listHeader = useMemo(
    () =>
      !atStart ? (
        <OlderRow loading={loadingOlder} failed={olderFailed} onRetry={fetchOlder} />
      ) : hasPins || (dmAgent && (rightHand || setupIntro)) ? (
        <>
          {hasPins ? (
            <PinnedLines channelId={channelId} threadId={threadId} onOpen={openPinsHere} onPick={goToPinHere} />
          ) : null}
          {dmAgent && rightHand ? (
            <RightHandIntro agent={dmAgent} channelId={channelId} waveFrom={waveFrom} />
          ) : dmAgent && setupIntro ? (
            <AgentSetupIntro agent={dmAgent} channelId={channelId} />
          ) : null}
        </>
      ) : (
        // The older pages' row keeps its room once the start is reached: taking it out moved every message up as the
        // last page came in.
        <View style={styles.older} />
      ),
    [
      atStart,
      loadingOlder,
      olderFailed,
      fetchOlder,
      hasPins,
      dmAgent,
      rightHand,
      setupIntro,
      channelId,
      threadId,
      openPinsHere,
      goToPinHere,
      waveFrom,
    ],
  );

  return (
    <AskStoreProvider store={asks}>
      <AskProbes messages={shownMessages} />
      <ReadMark
        orgId={orgId}
        channelId={channelId}
        threadId={threadId}
        member={member}
        postedNow={postedNow}
        peeking={peeking}
        focused={focused}
      />
      <View
        style={[styles.screen, { backgroundColor: c.bg }]}
        onTouchStart={touched ? undefined : () => setTouched(true)}
      >
        {/* A clear bar on every conversation (DM, channel, thread): the band behind it is ours, below, so the
            system's scroll edge never makes one look different from another. */}
        <PushedHeader title={pill ?? title} plate solid={false} right={right} />
        {hasPin ? (
          // The bar is see-through (the conversation runs under it): an open mission's card starts below it. Pinned
          // messages have no bar here: they wait above the first message, revealed by pulling down (`PinnedLines`).
          <View style={{ backgroundColor: c.bg, paddingTop: headerHeight }}>
            {pinned ? (
              <View style={styles.pin}>
                <MissionCardView mission={pinned} pinned />
              </View>
            ) : null}
          </View>
        ) : null}
        <DockGestureArea dock={dock} lift={lift}>
          {loading ? null : (
            <>
              {/* Mounted before the first message too: a list that appears while the keyboard is already up never
                  hears it open, and its first message landed under it. */}
              <Animated.View style={[styles.grow, listFade]}>
                {/* The list's frame, where the waiting requests' cards are measured from (never flattened away). */}
                <View ref={listFrame} collapsable={false} style={styles.grow} onLayout={watchList}>
                  {/* The right hand's cards here show the place its work in this conversation is on. */}
                  <ConversationSeat
                    orgId={orgId}
                    channelId={channelId}
                    rightHandId={rightHandId}
                    dm={Boolean(dm) || thread.data?.channelKind === "dm"}
                  >
                    <StickerStageContext.Provider value={stickers}>
                      <JumpToMessageContext.Provider value={jumpToMessage}>
                        <RowLookContext.Provider value={rowLook}>
                          <StoppedRunsContext.Provider value={stoppedRuns}>
                            <StopsMovedOnContext.Provider value={stopsMoved}>
                              <OpenedMessagesContext.Provider value={openedMessages}>
                                <ConversationList
                                  ref={listRef}
                                  refScrollView={listScroll}
                                  style={styles.grow}
                                  data={shownRows}
                                  keyExtractor={rowKey}
                                  getItemType={rowType}
                                  renderItem={renderItem}
                                  // The list redraws mounted rows only when this changes: what a row shows beyond its
                                  // message (the thread link that loads after it, a held state) lives in `renderItem`'s
                                  // dependencies.
                                  extraData={renderItem}
                                  estimatedItemSize={72}
                                  drawDistance={Math.round(windowHeight)}
                                  // Opens at the latest message, short conversations sit at the bottom like any chat.
                                  initialScrollAtEnd
                                  alignItemsAtEnd
                                  // New messages, a reply growing word by word and the working line keep the end in view,
                                  // but only while the person is near it.
                                  maintainScrollAtEnd={!readHold}
                                  maintainScrollAtEndThreshold={STICK_TO_END_THRESHOLD}
                                  // Older pages above and rows changing size keep what is on screen still.
                                  maintainVisibleContentPosition
                                  // Our own insets, never the system's (the keyboard library's advice for chat lists): the
                                  // bar's room is the content's top padding, the indicator kept below the bar.
                                  contentInsetAdjustmentBehavior="never"
                                  automaticallyAdjustContentInsets={false}
                                  scrollIndicatorInsets={listIndicator}
                                  // Still while a sheet or the agent's computer covers the conversation.
                                  freeze={freeze}
                                  onReady={onListReady}
                                  onStartReached={loadOlder}
                                  // A look at the waiting requests' cards and the live rows, once a frame and only while
                                  // there is one.
                                  onScroll={onListScroll}
                                  onViewableItemsChanged={onViewable}
                                  viewabilityConfig={STICKER_VIEW}
                                  onScrollBeginDrag={onDragStart}
                                  onScrollEndDrag={onScrollSettled}
                                  onMomentumScrollBegin={showDay}
                                  onMomentumScrollEnd={onScrollSettled}
                                  onStartReachedThreshold={0.5}
                                  keyboardDismissMode="interactive"
                                  keyboardShouldPersistTaps="handled"
                                  keyboardOffset={lift}
                                  // The dock's height (who is working, someone typing, the connection, a request out of
                                  // view) and the keyboard move the conversation only at its end. Above it nothing moves:
                                  // with the library's default the words being read shifted each time an agent started
                                  // or finished, under the person's finger.
                                  keyboardLiftBehavior="whenAtEnd"
                                  contentInsetEndAdjustment={endInset}
                                  contentContainerStyle={listPad}
                                  ListHeaderComponent={listHeader}
                                />
                              </OpenedMessagesContext.Provider>
                            </StopsMovedOnContext.Provider>
                          </StoppedRunsContext.Provider>
                        </RowLookContext.Provider>
                      </JumpToMessageContext.Provider>
                    </StickerStageContext.Provider>
                  </ConversationSeat>
                  <DatePill day={topDay} shown={dayShown} top={hasPin ? 8 : headerHeight + 8} />
                </View>
              </Animated.View>
              {showList ? null : (
                // A conversation with nothing yet: the agent's first day or a quiet line, over the empty list, above
                // the dock (its height read here alone).
                <DockRoom dock={dock}>
                  {(dockHeight) => {
                    // A DM's intro before its first message (the right hand's greeting, a new agent's checklist): below
                    // the bar, above the box, its buttons answering the first tap while the keyboard is up, the
                    // keyboard going with a drag and its last rows reachable above it.
                    const introScroll = {
                      contentContainerStyle: { paddingTop: headerHeight, paddingBottom: dockHeight },
                      scrollIndicatorInsets: { top: headerHeight, bottom: dockHeight },
                      keyboardShouldPersistTaps: "handled" as const,
                      keyboardDismissMode: "interactive" as const,
                      automaticallyAdjustKeyboardInsets: true,
                    };
                    return (
                      <View style={StyleSheet.absoluteFill}>
                        {dmAgent && rightHand ? (
                          <ScrollView {...introScroll}>
                            <RightHandIntro agent={dmAgent} channelId={channelId} waveFrom={waveFrom} />
                          </ScrollView>
                        ) : dmAgent && setupIntro ? (
                          <ScrollView {...introScroll}>
                            <AgentSetupIntro agent={dmAgent} channelId={channelId} />
                          </ScrollView>
                        ) : dmAgent && !isThread ? (
                          <FirstDay
                            agent={dmAgent}
                            topInset={headerHeight}
                            bottomInset={dockHeight}
                            keyboardLift={lift}
                            onAsk={onSend}
                          />
                        ) : channel && helloAgent && !dm && !isThread ? (
                          <ChannelHello
                            channelId={channelId}
                            channel={channel.name}
                            topic={channel.topic}
                            agents={[helloAgent, ...talkable.filter((a) => a.id !== helloAgent.id)]}
                            members={roster.data ?? []}
                            topInset={headerHeight}
                            bottomInset={dockHeight}
                            keyboardLift={lift}
                            onAsk={onSend}
                          />
                        ) : (
                          <View style={[styles.center, { paddingBottom: dockHeight }]}>
                            {/* No button: the composer under it is the next step. */}
                            <FirstUse place="chat" size="panel" acts={member && channel?.can?.post !== false} />
                          </View>
                        )}
                      </View>
                    );
                  }}
                </DockRoom>
              )}
            </>
          )}
          {/* The messages on their way, or the list still placing itself at its end: their shape, never a blank screen. */}
          {loading || (showList && !placed) ? (
            <DockRoom dock={dock}>
              {(dockHeight) => <ChatSkeleton look={rowLook} top={hasPin ? 0 : headerHeight} bottom={dockHeight} />}
            </DockRoom>
          ) : null}
          {!hasPin ? (
            // The conversation fades under the floating header, as it does under the box. Not under a pinned bar
            // or card: the list already starts below them, and a header-tall fade there was a dark band over the
            // first messages (the pinned bar's own hairline is the edge). Solid behind the status bar: a message
            // passing there showed through the clock and the indicators, its words cut by them.
            <LinearGradient
              pointerEvents="none"
              colors={[c.bg, c.bg, withOpacity(c.bg, 0.86), withOpacity(c.bg, 0)]}
              locations={[0, topFadeSolid, Math.max(0.62, topFadeSolid), 1]}
              style={[styles.topFade, { height: headerHeight + 28 }]}
            />
          ) : null}
          {channel && !dm && !isThread && member && showList ? (
            // The channel greets you under the bar, as the web's: a newcomer's #general, or the first channel of a day.
            <ChannelWelcome
              channelId={channelId}
              channelName={channel.name}
              messages={top.data}
              agentIds={channelAgents}
              top={headerHeight + 8}
              touched={touched}
            />
          ) : null}
          {peeking ? null : (
            <KeyboardStickyView offset={{ opened: lift }} style={styles.composerDock} pointerEvents="box-none">
              {/* First in the dock, so everything in it draws over the face. */}
              {peekAgentId && showList ? <ChatPeek agentId={peekAgentId} pull={pull} dock={endInset} /> : null}
              {/* Right above the composer and its working line, in the same dock: it rides the keyboard with them and
                  moves with the box in the same frame when the field grows a line (placed from the box's measured
                  height it came a render later). */}
              {showList && (readHold || (!atEnd && (far || unseen.messages > 0 || unseen.working.length > 0))) ? (
                <View style={styles.jumpAt} pointerEvents="box-none">
                  <ToLatest unseen={unseen} onPress={toEnd} />
                </View>
              ) : null}
              {/* The "@" picker, right above the box and outside it: the box's height insets the list, and the picker
                  comes and goes with each key typed. */}
              <View style={styles.float} pointerEvents="box-none">
                <ComposerFloat slot={composerFloat} />
              </View>
              <View
                ref={composerRef}
                onLayout={onComposerBoxLayout}
                style={[styles.composer, { paddingBottom: bottomPad }]}
              >
                {/* The conversation fades under the box: no hard edge above it. */}
                <LinearGradient
                  pointerEvents="none"
                  colors={[withOpacity(c.bg, 0), withOpacity(c.bg, 0.9), c.bg]}
                  locations={[0, 0.3, 1]}
                  style={StyleSheet.absoluteFill}
                />
                <Connection status={realtime} />
                {banner && !org?.deletion ? <NoAiBanner banner={banner} /> : null}
                <UnavailableLines notices={notices} />
                {/* Who is working, right above the composer (as on the web), while they work; a request waiting out
                    of view takes the line, with "Ver" (and the working line's stop while one agent works). */}
                {member && awayAsk ? (
                  <AskBar
                    away={awayAsk}
                    onSee={seeAsk}
                    runs={runs}
                    consults={lineConsults}
                    canStop={canStop}
                    onStop={stopRun}
                  />
                ) : null}
                {member && waitingFirst ? (
                  <WaitingHereBar
                    count={waitingHere.length}
                    agentId={waitingFirst.asker?.type === "agent" ? waitingFirst.asker.id : null}
                    onSee={seeWaiting}
                  />
                ) : null}
                {member && !awayAsk && !waitingFirst ? (
                  <WorkingLine
                    runs={runs}
                    consults={lineConsults}
                    typing={typing}
                    onSeeConsult={(id) => router.push(consultationHref(id, channelId))}
                    onOpenBrowser={(agentId) => {
                      // The agent's browser card opens in the conversation (at the end), not another screen.
                      toggleBrowser(agentId, true);
                      toEnd();
                    }}
                    stop={lineStop}
                    rest={returns.length > 0 ? <ReturnLine returns={returns} onOpen={openReturns} /> : null}
                  />
                ) : null}
                {org?.deletion ? (
                  // Being deleted, it reads as ever and takes no message, nor anyone joining (ADR 0088 §7).
                  <Text variant="footnote" tone="muted" style={styles.readOnly}>
                    {t("deleting.composer")}
                  </Text>
                ) : member && dmAgent && !canTalk(dmAgent) ? (
                  <AgentLocked agent={dmAgent} />
                ) : member && channel?.can?.post === false ? (
                  // The channel's exceptions keep me from sending here (ADR 0134): reading stays open.
                  <Text variant="footnote" tone="muted" style={styles.readOnly}>
                    {t("channel.perms.readOnlyComposer")}
                  </Text>
                ) : member ? (
                  <ChatComposer
                    placeholder={placeholder}
                    onSend={sendFromField}
                    working={working}
                    // GIFs and stickers live in the "+", with the photos: the field only sends.
                    onPlus={plusFromField}
                    draftKey={threadId ? `${channelId}:${threadId}` : channelId}
                    inputNativeID={COMPOSER_INPUT_ID}
                    float={composerFloat}
                    mentionAt={refQuery}
                    insertMention={insertRef}
                    prefill={prefill ?? captionBack}
                    focusAt={replyAt}
                    banner={composerBanner}
                    attachments={composerAttachments}
                    sendEmpty={pending.length > 0}
                    {...(canAttach ? { onLongAsFile: longFromField } : {})}
                    mention={mentionCard}
                    onType={onType}
                    orgId={orgId}
                    channelId={channelId}
                    threadId={threadId}
                    agentId={dmAgentId}
                    replyTo={quote?.id ?? null}
                    authorId={meId ?? ""}
                    voiceOn={voiceOn}
                    onVoiceSent={afterVoice}
                    prepareVoice={voiceFromField}
                    voiceTakeBack={voiceTakeBack}
                    onRecording={onRecording}
                  />
                ) : (
                  <>
                    {admin ? (
                      <Text variant="footnote" tone="muted" style={styles.readOnly}>
                        {t("channel.adminReading")}
                      </Text>
                    ) : null}
                    <Button
                      variant="primary"
                      wide
                      label={t("mobile.chat.join")}
                      disabled={join.isPending}
                      onPress={() => join.mutate()}
                    />
                  </>
                )}
              </View>
            </KeyboardStickyView>
          )}
        </DockGestureArea>
      </View>
    </AskStoreProvider>
  );
}

/** The dock's height where it is drawn (`DockHeight`): what reads it redraws, not the conversation around it. */
const useDockHeight = (dock: DockHeight) => useSyncExternalStore(dock.subscribe, dock.get, dock.get);

/**
 * The keyboard's gesture area around the conversation and its dock, its offset the dock's room above the keys: on
 * Android the keyboard starts following a drag there. No `textInputNativeID`: with it the composer could stay down while
 * the keyboard was up (iOS 26); without it iOS takes no offset (the keyboard follows the finger from its own top edge).
 * The offset is whole points: a fractional one made the overscroll glitch.
 */
function DockGestureArea({ dock, lift, children }: { dock: DockHeight; lift: number; children: ReactNode }) {
  const height = useDockHeight(dock);
  return (
    <KeyboardGestureArea style={styles.grow} interpolator="ios" offset={Math.round(Math.max(0, height - lift))}>
      {children}
    </KeyboardGestureArea>
  );
}

/** What is drawn from the dock's height (an empty conversation's greeting, the skeleton), redrawn alone with it. */
function DockRoom({ dock, children }: { dock: DockHeight; children: (height: number) => ReactNode }) {
  const height = useDockHeight(dock);
  return <>{children(height)}</>;
}

type MessageItem = Extract<Row, { kind: "message" }>;

/** What every message row of the conversation is handed alike: callbacks that keep their identity. */
interface RowHands {
  onReply: (m: Message) => void;
  onMission: (goal: string, threadId: string) => void;
  onRemind: (m: Message) => void;
  /** Where the platform has no menu of its own (Android): the app's sheet on a hold. */
  onLongPress: ((m: Message) => void) | undefined;
  onRetry: (m: Message) => void;
  onQuote: (reply: ReplyRef) => void;
  onResend: (m: Message) => Promise<unknown> | undefined;
  onOfferDone: () => void;
}

/**
 * A message's row with what stands around it: the swipe that answers it, the system's menu on a hold (iOS), and under
 * it the strip of the agents it called, its receipt's line and the notifications' offer. Kept as it was unless what is
 * its own changes: a receipt arriving, a thread's link or the lit row redraw that one row, never every row on screen
 * with its menu (each builds its actions, with their queries, and the system's menu). A row mounted again as it
 * scrolls back into view plays nothing in again (`skipEntering`); what shows up on it later still comes in.
 */
const ChatMessage = memo(function ChatMessage({
  item,
  fresh,
  lit,
  isThread,
  meId,
  canReply,
  canMission,
  thread,
  menuThread,
  aboveThread,
  markReceipt,
  seenBy,
  fanReceipt,
  line,
  lineReceipt,
  connectInline,
  offer,
  hands,
}: {
  item: MessageItem;
  /** Just arrived at the bottom: it rises in, an agent's reply too (it shows whole, once, with nothing to replace). */
  fresh: boolean;
  /** The message gone to, lit for a moment. */
  lit: boolean;
  isThread: boolean;
  meId: string | null;
  canReply: boolean;
  canMission: boolean;
  /** The thread it starts, a link under it in the conversation. */
  thread: ThreadInfo | undefined;
  /** The thread its menu works with: the one it starts or the one it is in. */
  menuThread: ThreadInfo | undefined;
  aboveThread: boolean;
  /** The agents' receipt its mark shows, on the row that wears it. */
  markReceipt: MessageReceipt | undefined;
  seenBy: string | undefined;
  /** The receipt of an agent's message that called several agents, or of a mention of everyone. */
  fanReceipt: MessageReceipt | undefined;
  /** Its receipt's line under it (the one message that has it), with that receipt. */
  line: boolean;
  lineReceipt: MessageReceipt | undefined;
  connectInline: boolean;
  /** The notifications' offer under it. */
  offer: boolean;
  hands: RowHands;
}) {
  const m = item.message;
  const c = useColors();
  const dir = useDirectory();
  const { onReply, onMission, onRemind } = hands;
  const reply = useCallback(() => onReply(m), [onReply, m]);
  const menu = useMemo<MessageActionsContext>(
    () => ({
      message: m,
      canMission,
      inThread: isThread,
      thread: menuThread,
      onMission,
      onRemind,
      onReply: canReply ? onReply : undefined,
    }),
    [m, canMission, isThread, menuThread, onMission, onRemind, canReply, onReply],
  );
  const row = (
    <MessageRow
      message={m}
      grouped={item.grouped}
      newTurn={item.newTurn}
      run={runPosition(item.grouped, item.continued ?? false)}
      above={item.above}
      aboveThread={aboveThread}
      meId={meId}
      thread={thread}
      inThread={isThread}
      {...(hands.onLongPress ? { onLongPress: hands.onLongPress } : {})}
      onRetry={hands.onRetry}
      onQuote={hands.onQuote}
      receipt={markReceipt}
      seenBy={seenBy}
    />
  );
  return (
    <Animated.View entering={fresh ? ENTER : undefined} style={lit ? { backgroundColor: c.sunken } : undefined}>
      {/* Swipe right to answer it (a quote above the field); hold it for the system's menu (iOS) or the app's sheet. A
          message still on its way can't be swiped, and its menu offers only copying its words; the same views stand
          around it either way, so it isn't drawn again when it turns sent. */}
      <SwipeReply enabled={canReply && !m.local} onReply={reply}>
        {NATIVE_MENU ? (
          <MessageMenuFor context={menu} href={chatHref(m.channelId, m.threadId, m.id)}>
            {/* One plain view for the menu to lift (the row can be a fragment: a pair row, a quote). */}
            <View collapsable={false}>{row}</View>
          </MessageMenuFor>
        ) : (
          row
        )}
      </SwipeReply>
      <LayoutAnimationConfig skipEntering>
        {m.author.type === "agent" && m.mentionedAgentIds.length > 1 ? (
          <FanStrip message={m} receipt={fanReceipt} />
        ) : null}
        {m.meta?.everyoneShape ? <EveryoneLine message={m} receipt={fanReceipt} mine={m.author.id === meId} /> : null}
        {line ? (
          <AgentReceiptLine
            message={m}
            receipt={lineReceipt}
            mine={m.author.id === meId}
            connectInline={connectInline}
            onRetry={hands.onResend}
          />
        ) : null}
        {offer ? <PushOfferLine agent={dir.nameOf(m.author)} onDone={hands.onOfferDone} /> : null}
      </LayoutAnimationConfig>
    </Animated.View>
  );
});

/**
 * Marks the conversation read up to the message posted last, wherever its place: the list's badges (a channel's or a
 * DM's, or a thread's) clear at once. Only in view (`focused`): under another screen, or with the app in the
 * background, what arrives stays unread, and is read once the person is back on it. On its own: its requests' states
 * and the threads' replies redraw it, not the whole conversation (twice for every message that landed).
 */
const ReadMark = memo(function ReadMark({
  orgId,
  channelId,
  threadId,
  member,
  postedNow,
  peeking,
  focused,
}: {
  orgId: string;
  channelId: string;
  threadId: string | null;
  member: boolean;
  postedNow: string | undefined;
  peeking: boolean;
  focused: boolean;
}) {
  const markRead = useMarkChannelRead(orgId).mutate;
  const markThreadRead = useMarkThreadRead(orgId).mutate;
  const inFront = useAppActive();
  // A reply in one of its threads counts in the conversation's mark and is no message of this list: read again on it.
  const threadReplies = useThreadActivity(orgId, channelId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread's reply marks the conversation read again
  useEffect(() => {
    if (peeking || !focused || !inFront || !member || !postedNow) return;
    const mark = readMark(channelId, threadId);
    if (mark.kind === "thread") markThreadRead(mark.id);
    else markRead(mark.id);
  }, [peeking, focused, inFront, markRead, markThreadRead, channelId, threadId, member, postedNow, threadReplies]);
  return null;
});

/** The latest of a function behind one that never changes: what it is handed to isn't redrawn when the function is. */
function useLatest<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * The conversation's field with its voice messages. On its own so that it redraws for what it shows (the words, a
 * take's clock and wave) and never for the conversation above it: everything it is handed keeps its identity between
 * the conversation's renders.
 */
const ChatComposer = memo(function ChatComposer({
  orgId,
  channelId,
  threadId,
  agentId,
  replyTo,
  authorId,
  voiceOn,
  onVoiceSent,
  prepareVoice,
  voiceTakeBack,
  onRecording,
  ...composer
}: Omit<ComposerProps, "voice"> & {
  orgId: string;
  channelId: string;
  threadId: string | null;
  /** The agent this conversation is with, if one (its face listens in the field). */
  agentId: string | null;
  /** The message a voice take answers. */
  replyTo: string | null;
  authorId: string;
  voiceOn: boolean;
  onVoiceSent: () => void;
  /** What goes with a take: the words typed beside it and the files, uploaded (`VoiceTarget.prepare`). */
  prepareVoice: NonNullable<VoiceTarget["prepare"]>;
  voiceTakeBack: NonNullable<VoiceTarget["takeBack"]>;
  /** While a take records: the others see "gravando áudio…" (throttled by the caller). */
  onRecording: () => void;
}) {
  const voice = useVoiceComposer({
    orgId,
    channelId,
    threadId,
    agentId,
    replyTo,
    authorId,
    enabled: voiceOn,
    prepare: prepareVoice,
    takeBack: voiceTakeBack,
    afterSend: onVoiceSent,
    onRecording,
  });
  return <Composer {...composer} voice={voice} />;
});

/**
 * Back to the latest messages: a round button at the bottom right, right above the composer, as on the web.
 * It counts what arrived below, in red when one mentions me; its label says who spoke and who is writing.
 */
function ToLatest({ unseen, onPress }: { unseen: Unseen; onPress: () => void }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const { colors, shadows, reducedMotion } = useTheme();
  const nameOf = (who: string) => {
    const at = who.indexOf(":");
    return dir.nameOf({ type: who.slice(0, at), id: who.slice(at + 1) });
  };
  const said = [
    unseen.messages > 0 ? t("mobile.chat.unseen.count", { count: unseen.messages }) : "",
    unseen.authors.length > 0 ? listNames(t, unseen.authors.map(nameOf)) : "",
    unseen.working.length > 0
      ? t("mobile.chat.unseen.working", { names: listNames(t, unseen.working.map(nameOf)) })
      : "",
    unseen.mentionsMe ? t("mobile.chat.unseen.mentionsYou") : "",
  ].filter(Boolean);
  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeIn.duration(160)}
      exiting={reducedMotion ? undefined : FadeOut.duration(120)}
      pointerEvents="box-none"
    >
      <PressScale
        to={0.92}
        onPress={onPress}
        accessibilityRole="button"
        // A 40-point circle: 4 around it gives the 48 a thumb needs.
        hitSlop={4}
        accessibilityLabel={
          said.length > 0 ? t("mobile.chat.toLatestNew", { text: said.join(" · ") }) : t("mobile.chat.toLatest")
        }
        style={[styles.jump, { backgroundColor: colors.raised, boxShadow: `${shadows.e2}, ${shadows.top}` }]}
      >
        <View style={styles.jumpIcon}>
          <Icon name="down" size={20} color={colors.ink2} />
        </View>
      </PressScale>
      {unseen.messages > 0 ? (
        <View style={[styles.jumpCount, { borderColor: colors.bg }]} pointerEvents="none">
          <Count
            value={unseen.messages}
            size={11}
            inverted
            max={99}
            {...(unseen.mentionsMe ? { fill: colors.danger, color: colors.raised } : {})}
          />
        </View>
      ) : null}
    </Animated.View>
  );
}

/**
 * Above the oldest loaded message while older ones exist: a small spinner while a page loads, and when one didn't come,
 * what happened with "Try again" (`RetryLine`). Waiting or loading it keeps one height, so a page starting to load
 * never moves the conversation.
 */
function OlderRow({ loading, failed, onRetry }: { loading: boolean; failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  if (failed && !loading) return <RetryLine onRetry={onRetry} />;
  return (
    <View style={styles.older}>
      {loading ? (
        <ActivityIndicator size="small" color={c.muted} accessibilityLabel={t("common.loadingMessages")} />
      ) : null}
    </View>
  );
}

/** "Novas": before the first message that arrived while the person read above, until they leave the conversation. */
function UnseenLine() {
  const { t } = useTranslation();
  const rhythm = useRhythm();
  const c = useColors();
  return (
    <View style={[styles.unseen, { marginTop: rhythm.turn }]} accessibilityRole="text">
      <Text variant="caption" style={[styles.unseenText, { color: c.agent }]}>
        {t("mobile.chat.unseen.divider")}
      </Text>
      <View style={[styles.unseenRule, { backgroundColor: c.agent }]} />
    </View>
  );
}

/**
 * The connection, above the composer: "Sem conexão. O que você mandar sai sozinho quando
 * voltar." while it is down (a quick reconnect says nothing), then "Conectado de novo" for a moment.
 */
function Connection({ status }: { status: ConnectionStatus }) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const down = status === "reconnecting" || status === "closed";
  const [shown, setShown] = useState<"down" | "back" | null>(null);
  useEffect(() => {
    if (down) {
      const id = setTimeout(() => setShown("down"), OFFLINE_AFTER_MS);
      return () => clearTimeout(id);
    }
    if (status === "open") setShown((s) => (s === "down" ? "back" : s));
  }, [down, status]);
  useEffect(() => {
    if (shown !== "back") return;
    const id = setTimeout(() => setShown(null), BACK_ONLINE_MS);
    return () => clearTimeout(id);
  }, [shown]);
  if (!shown) return null;
  const back = shown === "back";
  return (
    <Animated.View
      key={shown}
      entering={reduced ? undefined : FadeInDown.duration(220)}
      exiting={reduced ? undefined : FadeOut.duration(160)}
      accessibilityLiveRegion="polite"
      style={[styles.conn, { backgroundColor: back ? withOpacity(c.ok, 0.14) : c.warnSoft }]}
    >
      {/* On the first line: the offline sentence wraps, and centred on both lines the icon floated between them. */}
      <LineIcon variant="small" name={back ? "check" : "wifi"} size={15} color={back ? c.ok : c.warn} />
      <Text variant="small" style={[styles.connText, { color: back ? c.ok : c.warn }]}>
        {back ? t("mobile.chat.connection.back") : t("mobile.chat.connection.down")}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  topFade: { position: "absolute", top: 0, left: 0, right: 0 },
  // Under the agent's words, like a card on its message.
  browserRow: { paddingRight: 16 },
  screen: { flex: 1 },
  grow: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  pin: { paddingHorizontal: 12, paddingBottom: 10 },
  day: { alignSelf: "center", textAlign: "center", fontWeight: "600" },
  listPad: { paddingTop: 8, paddingBottom: 8 },
  composer: { paddingHorizontal: 10, paddingTop: 6 },
  readOnly: { textAlign: "center", paddingHorizontal: 16, paddingVertical: 12 },
  composerDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  // Over the list, at the dock's top right; the list under the rest of its row still takes the touches.
  jumpAt: { alignSelf: "flex-end", marginRight: 14, marginBottom: 10 },
  // The composer's side inset, so the picker and the pills line up with the field under them.
  float: { paddingHorizontal: 10 },
  older: { height: OLDER_ROW, alignItems: "center", justifyContent: "center" },
  jump: { width: 40, height: 40, borderRadius: 20 },
  jumpIcon: { flex: 1, alignItems: "center", justifyContent: "center" },
  jumpCount: { position: "absolute", top: -6, right: -6, borderWidth: 2, borderRadius: 999 },
  pillFace: { borderWidth: 2, borderRadius: 8 },
  pillOverlap: { marginLeft: -6 },
  unseen: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16 },
  unseenText: { fontWeight: "700" },
  unseenRule: { flex: 1, height: StyleSheet.hairlineWidth * 2, opacity: 0.45 },
  conn: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginHorizontal: 4,
    marginBottom: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderBottomLeftRadius: 3,
  },
  connText: { flexShrink: 1, fontWeight: "600" },
  faces: { flexDirection: "row" },
  round: { borderRadius: 12 },
});
