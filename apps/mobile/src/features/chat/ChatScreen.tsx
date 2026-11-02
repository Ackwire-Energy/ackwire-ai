import {
  type Agent,
  type ArtifactDetail,
  type BrowserHandoff,
  type ConnectionStatus,
  heldTakeoversHere,
  inMainTimeline,
  type LiveRun,
  MESSAGES_PAGE,
  type Message,
  type MessageMedia,
  type MessagePin,
  type RunConsultation,
  sendHelpers,
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
  useMessages,
  useMissionControl,
  usePins,
  usePostMessage,
  useRoster,
  useSettings,
  useSteerState,
  useThreadInfo,
  useThreadMessages,
  useThreadMission,
} from "@agenteschat/client";
import { activityVerb, listNames } from "@agenteschat/client/lib/activity";
import { canTalk } from "@agenteschat/client/lib/audience";
import { runPosition } from "@agenteschat/client/lib/chat";
import {
  type ConsultNoticeFold,
  consultBlocksNearEnd,
  consultNoticeFolds,
  consultsForLine,
} from "@agenteschat/client/lib/consult-group";
import { capitalize } from "@agenteschat/client/lib/format";
import { issueTakenOf, issueWorkOf } from "@agenteschat/client/lib/issues";
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
import { seenMessageId } from "@agenteschat/client/lib/seen";
import { isIdHandle } from "@agenteschat/ui/names";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type { LegendListRef, OnViewableItemsChanged } from "@legendapp/list/react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { KeyboardController, KeyboardGestureArea, KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StickerStageContext } from "@/agent/StickerCanvas";
import { createStickerStage } from "@/agent/sticker-stage";
import { holdOpenConversation } from "@/lib/push";
import { useOrg } from "@/providers/org";
import { useRealtime } from "@/providers/realtime";
import {
  Button,
  Composer,
  type ComposerWorking,
  Icon,
  IconButton,
  PressScale,
  type SendHow,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { BrowserCard, BrowserRunCard } from "../browser/BrowserCard";
import { OpenHandoffProvider } from "../browser/open";
import { threadTitle } from "../chats/logic";
import { chatHref, consultationHref } from "../links/logic";
import { MissionCardView } from "../missions/cards";
import { isOpenMission } from "../missions/logic";
import { RemindSheet } from "../reminders/RemindSheet";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, previewOf } from "../shared/logic";
import { FocusLive, PushedHeader, Tile } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { useDmStatusLine, usePresenceWord } from "../status/hooks";
import { PersonStatusCard } from "../status/StatusCard";
import { AgentReceiptLine } from "./AgentReceipts";
import { receiptMessageId, turnHeadId } from "./agent-receipts";
import { AskStore } from "./ask-store";
import { AskBar, AskProbes, AskStoreProvider, useAskWatch, useAwayAsk } from "./asks";
import { ChannelHello } from "./ChannelHello";
import { ChannelMembersSheet } from "./ChannelMembers";
import { ChannelPicker } from "./ChannelPicker";
import { ConversationSwitcher } from "./ConversationSwitcher";
import { takeComposerRequest, useComposerRequest } from "./composer-request";
import { DATE_PILL_IDLE_MS, DatePill } from "./DatePill";
import { DmComputerButton } from "./DmComputerButton";
import { EventLine } from "./EventLine";
import { FirstDay } from "./FirstDay";
import { HeaderPill } from "./HeaderPill";
import { composerSuggestions } from "./intent";
import { IssueTakenLine } from "./issue-work";
import { browsingRuns, TurnRow, WorkingLine } from "./LiveRows";
import { useChatLive } from "./live";
import {
  buildRows,
  type ChatRow,
  dayInView,
  mayStopRun,
  mergeTimeline,
  parseSlash,
  pinTarget,
  stoppableInLine,
  workingEntries,
} from "./logic";
import { MediaPickerSheet } from "./MediaPickerSheet";
import { MentionPicker, useMentionMembers } from "./MentionPicker";
import { MessageRow } from "./MessageRow";
import { stickerRowsOnScreen } from "./media";
import { insertRef, refQuery } from "./mentions";
import { NoAiBanner } from "./NoAiBanner";
import { endsOnNoAiCard, noAiBanner } from "./no-ai-banner";
import { PinnedBar, PinsSheet } from "./PinsSheet";
import {
  appendedKeys,
  type HeldRun,
  HOLD_FINISHED_RUN_MS,
  landsOnDivider,
  lastSeenKey,
  type Place,
  placeCorrection,
  runsToShow,
  type ScrollRow,
  STICK_TO_END_THRESHOLD,
  type TurnKey,
  turnKeys,
  turnRowByRun,
  type Unseen,
  unseenBelow,
} from "./scroll";
import {
  ChannelOptions,
  MessageActions,
  MissionSummaryView,
  NewMissionForm,
  PlusActions,
  type PlusPick,
  ThreadOptions,
} from "./sheets";
import { turnOrder, turnRuns, withOpacity } from "./turn";
import { JumpToMessageContext } from "./WorkLine";

/** A run's messages this recent are asked whether a take over still holds the agent's browser. */
const HELD_RECENT_MS = 12 * 60 * 60_000;

type Row =
  | ChatRow
  | { kind: "marker"; key: string; text: string }
  | { kind: "run"; key: string; run: LiveRun }
  /** An agent's browser card: its live run in the browser, or (no run row) a take over held here. */
  | { kind: "browser"; key: string; run: LiveRun; handoff?: undefined }
  | { kind: "browser"; key: string; run: null; handoff: BrowserHandoff }
  | { kind: "unseen"; key: string; fading: boolean };

const rowKey = (r: Row) => r.key;
/**
 * A row's type for the list, which keeps sizes per type: an agent's block and its saved reply share one (the reply
 * takes the block's row in place); other messages by how long they are and whether they carry a card (as Expensify
 * buckets them), so a row not measured yet is guessed close to its size and older pages land without a jump.
 */
const rowType = (r: Row) => {
  if (r.kind === "run" || (r.kind === "message" && r.key.startsWith("turn-"))) return "turn";
  if (r.kind !== "message") return r.kind;
  // A GIF or a sticker alone (ADR 0091) is about its picture's size, not a text's.
  const media = r.message.body.trim() ? null : messageMediaOf(r.message.meta);
  if (media) return `message-${media.kind}`;
  const n = r.message.body.length;
  const size = n < 80 ? "s" : n < 320 ? "m" : n < 1200 ? "l" : "xl";
  return r.message.meta && Object.keys(r.message.meta).length > 0 ? `message-${size}-card` : `message-${size}`;
};
/** A sticker's row counts as in view from here: one barely in at the edge doesn't take a place among those playing. */
const STICKER_VIEW = { id: "stickers", itemVisiblePercentThreshold: 30 };
const DIVIDER_KEY = "unseen-divider";
/** The "Novas" line stays this long after the person reached it, then fades (~0.6 s). */
const DIVIDER_FADE_MS = 3500;
/** A dropped connection shows only past this long (a quick reconnect says nothing). */
const OFFLINE_AFTER_MS = 1200;
/** "Conectado de novo" stays this long. */
const BACK_ONLINE_MS = 1600;
/** A row that just arrived at the bottom rises in (only while it is fresh: not when scrolled back into view). */
const ENTER = FadeInDown.duration(220);
const FRESH_MS = 800;
/** How close to the end a scroll has to stop for a list held at a long message's start to follow again. */
const READ_RELEASE_PX = 24;
/** How long the sheet takes to slide away before the conversation it picked takes this one's place. */
const SHEET_LEAVE_MS = 240;
/** The composer's safe-area padding hides behind the open keyboard; this much stays between them. */
const KEYBOARD_GAP = 8;
const COMPOSER_INPUT_ID = "chat-composer";
/** How long the conversation is held in place after something opens over it and after it closes (ms). */
const HOLD_MS = 900;
/** How long the list keeps ignoring the keyboard after what covered it closed (its closing animation, ms). */
const FREEZE_AFTER_MS = 450;
/** The list shows by itself after this even if it never said it was placed (ms). */
const SHOW_LIST_MS = 700;
/** Going to a pinned message: at most this many older pages loaded looking for it. */
const SEEK_MAX_PAGES = 10;
/** How long the message gone to stays lit. */
const FLASH_MS = 1600;
/** No questions to other agents here (yet): the same list each time, so the memos over it keep. */
const NO_CONSULTATIONS: RunConsultation[] = [];

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
  const member = dm ? true : (channel?.isMember ?? true);
  const roster = useRoster(orgId, channelId, Boolean(channel?.isMember) && !isThread);
  const join = useJoinChannel(orgId, channelId);
  // The "@" picker's sections: a channel's members (also in its threads); a DM has none.
  const mentionMembers = useMentionMembers(channelId, !dm && Boolean(channel?.isMember));

  // ── Messages ──
  const top = useMessages(orgId, channelId, member && !isThread);
  const threadMessages = useThreadMessages(orgId, isThread && member ? channelId : undefined, threadId ?? "");
  const channelThreads = useChannelThreads(orgId, channelId, "all", member && !isThread);
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
  const list = useMemo(() => {
    if (isThread) {
      // My replies still sending wait in the channel's list.
      const mine = (top.data ?? []).filter((m) => m.local && m.threadId === threadId);
      return mergeTimeline(threadMessages.data ?? [], [mine]);
    }
    return mergeTimeline([...older, ...(top.data ?? [])], []);
  }, [isThread, threadId, top.data, threadMessages.data, older]);
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
  const live = useChatLive(orgId, channelId, member);
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
  const manageAgents = can(useOrg().org, "manage_agents");
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
  // While an agent works here, anyone who writes chooses "Juntar" or "Parar e mandar" (the server takes a
  // steer from them); the composer's "Parar" (the empty field's button) stops every agent at work here I
  // may stop, writing too, and only shows if there is one.
  const busyRuns = useMemo(() => stoppableInLine(runs).filter((r) => !r.stopping), [runs]);
  const stoppable = useMemo(() => busyRuns.filter((r) => canStop(r)), [busyRuns, canStop]);
  const working = useMemo<ComposerWorking | null>(() => {
    if (busyRuns.length === 0) return null;
    const first = stoppable[0];
    if (!first) return {};
    return {
      stop: {
        label: t("mobile.chat.stopAgent", { name: dir.agentById.get(first.agentId)?.name ?? "" }),
        onStop: () => {
          for (const r of stoppable) stopRun(r);
        },
      },
    };
  }, [busyRuns, stoppable, stopRun, dir.agentById, t]);

  // ── Agents' blocks ──
  // An agent at work in its browser: its card in the conversation, open on demand.
  const browsing = useMemo(() => browsingRuns(runs), [runs]);
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
  // Every agent at work is one block, the last thing in the conversation: "pensando",
  // its steps, its words. A finished one keeps its block (last words) until its saved message is listed: no
  // empty frame between them.
  const heldRef = useRef(new Map<string, HeldRun<LiveRun>>());
  const shownRef = useRef<LiveRun[]>([]);
  const [holdTick, setHoldTick] = useState(0);
  const arrivedRuns = useMemo(() => new Set(list.flatMap((m) => (m.agentRunId ? [m.agentRunId] : []))), [list]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `holdTick` re-checks the held rows when one expires
  const runRows = useMemo(() => {
    const atWork = turnRuns(runs, new Set(browsing.map((r) => r.runId)));
    const next = runsToShow(
      heldRef.current,
      shownRef.current,
      atWork,
      arrivedRuns,
      Date.now(),
      HOLD_FINISHED_RUN_MS,
      (r) => r.text.length > 0,
    );
    heldRef.current = next.held;
    shownRef.current = next.shown;
    return next;
  }, [runs, browsing, arrivedRuns, holdTick]);
  useEffect(() => {
    if (runRows.nextExpiry === null) return;
    const id = setTimeout(() => setHoldTick((n) => n + 1), Math.max(0, runRows.nextExpiry - Date.now()) + 16);
    return () => clearTimeout(id);
  }, [runRows]);
  const shownRuns = runRows.shown;
  // One key per block from its "pensando…" to its saved reply (no remount, no flash).
  const turnKeysRef = useRef(new Map<string, TurnKey>());
  const turnKeyOf = useMemo(() => {
    turnKeysRef.current = turnKeys(turnKeysRef.current, shownRuns);
    const registry = turnKeysRef.current;
    return (runId: string) => registry.get(runId)?.key;
  }, [shownRuns]);
  // The messages an agent read while working (its "Leu seu recado" wells quote them; a GIF or a sticker by its word).
  const bodiesRef = useRef(new Map<string, string>());
  bodiesRef.current = useMemo(() => new Map(list.map((m) => [m.id, textOrMedia(t, m.body, m.meta)])), [list, t]);
  const bodyOf = useCallback((id: string) => bodiesRef.current.get(id), []);
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
  const rows = useMemo<Row[]>(() => {
    // A saved reply that was live here keeps its block's key (only the run's last message: keys stay unique).
    const drawn = new Set(shownRuns.map((r) => r.runId));
    const asTurns = (chatRows: ChatRow[]): Row[] => {
      const last = turnRowByRun(chatRows, drawn);
      return chatRows.map((r) => {
        const runId = r.kind === "message" ? r.message.agentRunId : null;
        const key = runId && last.get(runId) === r.key ? turnKeyOf(runId) : undefined;
        return key ? { ...r, key } : r;
      });
    };
    const runRowsOf = (live: LiveRun[]): Row[] =>
      live.map((run) => ({ kind: "run" as const, key: turnKeyOf(run.runId) ?? `turn-${run.runId}`, run }));
    if (isThread && threadId) {
      const root = list.find((m) => m.id === threadId);
      const replies = list.filter((m) => m.id !== threadId);
      const info = thread.data;
      const head: Row[] = root
        ? [
            {
              kind: "marker",
              key: "started",
              // In a DM, with whom (its channel name is internal, "dm-…"); in a channel, where.
              text:
                info?.channelKind === "dm" || dm
                  ? t("mobile.chat.startedWith", { name: dm?.with.name ?? "" })
                  : t("mobile.chat.startedIn", { channel: info?.channelName ?? channel?.name ?? "" }),
            },
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
              text: t("mobile.chat.replies", { count: info?.replyCount ?? replies.length }),
            },
          ]
        : [];
      return [
        ...head,
        ...asTurns(buildRows(replies, (m) => superseded.has(m.id))),
        ...browsing.map((run) => ({ kind: "browser" as const, key: `browser-${run.agentId}`, run })),
        ...held.map((h) => ({ kind: "browser" as const, key: `browser-${h.agentId}`, run: null, handoff: h })),
        ...runRowsOf(turnOrder(shownRuns)),
      ];
    }
    // A thread's replies live in the thread; the channel shows its link.
    const hidden = (m: Message) => superseded.has(m.id) || Boolean(m.threadId);
    return [
      ...asTurns(buildRows(list, hidden)),
      ...browsing.map((run) => ({ kind: "browser" as const, key: `browser-${run.agentId}`, run })),
      ...held.map((h) => ({ kind: "browser" as const, key: `browser-${h.agentId}`, run: null, handoff: h })),
      ...runRowsOf(turnOrder(shownRuns)),
    ];
  }, [isThread, threadId, list, thread.data, channel?.name, dm, shownRuns, turnKeyOf, browsing, held, superseded, t]);
  const shownMessages = useMemo(() => rows.flatMap((r) => (r.kind === "message" ? [r.message] : [])), [rows]);
  // Questions agents asked other agents, inside the replies that asked (`ConsultGroup`): how each answer's notice
  // draws (hidden under a reply close by, one line to one farther up), and the working line without the questions
  // a reply near the end shows. A turn at work here doesn't show them yet: only saved replies count.
  const consultList = useConsultations(orgId, channelId).data ?? NO_CONSULTATIONS;
  const foldsNow = useMemo(
    () => consultNoticeFolds(shownMessages, consultList, undefined, "first"),
    [shownMessages, consultList],
  );
  // The rows redraw when a notice's fold changes, not on every message (the folds are rebuilt on each).
  const foldsKey = [...foldsNow].map(([id, f]) => `${id}:${f.fold === "line" ? f.messageId : f.fold}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `foldsKey` stands for the folds
  const consultFolds = useMemo(() => foldsNow, [foldsKey]);
  const lineConsults = useMemo(
    () => consultsForLine(consults, consultBlocksNearEnd(shownMessages, consultList, undefined, "first")),
    [consults, shownMessages, consultList],
  );

  // ── Following the end ──
  // The list sticks to the end only while the person is near it (Legend List's maintainScrollAtEnd); farther
  // up nothing moves (the scroll is never taken): a pill says what arrived below and who, a "Novas" line
  // marks the first of it, and the pill lands there when it is far.
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
  const scrollRows = useMemo<ScrollRow[]>(
    () =>
      rows.map((r) => ({
        key: r.key,
        kind: r.kind === "message" ? "message" : r.kind === "run" ? "run" : "other",
        mine: r.kind === "message" && r.message.author.type === "person" && r.message.author.id === meId,
        // An agent's sticker or GIF after its reply (ADR 0091) is never news of its own.
        silent: r.kind === "message" && isMediaAfterReply(r.message.meta),
        ...(r.kind === "message" && r.message.author.id
          ? { who: `${r.message.author.type}:${r.message.author.id}` }
          : r.kind === "run"
            ? { who: `agent:${r.run.agentId}` }
            : {}),
      })),
    [rows, meId],
  );
  const [atEnd, setAtEnd] = useState(true);
  const atEndRef = useRef(atEnd);
  atEndRef.current = atEnd;
  // Held at the start of a long message someone else wrote (see "Reading from the top"): the list doesn't follow
  // the end until the person gets there, sends, or takes the pill.
  const [readHold, setReadHold] = useState(false);
  const [seenKey, setSeenKey] = useState<string | null>(null);
  const latestSeen = lastSeenKey(scrollRows);
  useEffect(() => {
    if (atEnd) setSeenKey(latestSeen);
  }, [atEnd, latestSeen]);
  const unseen: Unseen = useMemo(
    () => (atEnd ? { messages: 0, firstKey: null, authors: [], working: [] } : unseenBelow(scrollRows, seenKey)),
    [atEnd, scrollRows, seenKey],
  );
  // "Novas": before the first new row while the person reads above; it fades a while after they reach it.
  const [divider, setDivider] = useState<{ beforeKey: string; fading: boolean } | null>(null);
  useEffect(() => {
    if (unseen.firstKey && (!divider || divider.fading)) setDivider({ beforeKey: unseen.firstKey, fading: false });
  }, [unseen.firstKey, divider]);
  const [reached, setReached] = useState(false);
  useEffect(() => {
    if (atEnd) setReached(true);
  }, [atEnd]);
  useEffect(() => {
    if (!divider || divider.fading || !reached) return;
    const fade = setTimeout(() => setDivider((d) => (d ? { ...d, fading: true } : d)), DIVIDER_FADE_MS);
    return () => clearTimeout(fade);
  }, [divider, reached]);
  useEffect(() => {
    if (!divider?.fading) return;
    const gone = setTimeout(() => setDivider((d) => (d?.fading ? null : d)), 700);
    return () => clearTimeout(gone);
  }, [divider]);
  useEffect(() => {
    if (!atEnd && unseen.firstKey) setReached(false);
  }, [atEnd, unseen.firstKey]);
  const shownRows = useMemo<Row[]>(() => {
    if (!divider) return rows;
    const at = rows.findIndex((r) => r.key === divider.beforeKey);
    if (at < 0) return rows;
    return [...rows.slice(0, at), { kind: "unseen", key: DIVIDER_KEY, fading: divider.fading }, ...rows.slice(at)];
  }, [rows, divider]);
  const toEnd = useCallback(() => {
    letGo();
    setReadHold(false);
    setAtEnd(true);
    requestAnimationFrame(() => void listRef.current?.scrollToEnd({ animated: true }));
  }, [letGo]);
  // The pill: to the "Novas" line when it is far, else to the end.
  const toUnseen = useCallback(() => {
    const state = listRef.current?.getState();
    const index = shownRows.findIndex((r) => r.key === DIVIDER_KEY);
    const far = state && landsOnDivider(state.contentLength, state.positionByKey(DIVIDER_KEY), state.scrollLength);
    if (far && index >= 0) {
      letGo();
      void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset: 12 });
      // What is new is in view now: the pill goes, the line fades after a while.
      setSeenKey(latestSeen);
      setReached(true);
      return;
    }
    toEnd();
  }, [shownRows, latestSeen, toEnd, letGo]);

  // "Ver" on the requests' line: the list goes to the request and stays there. It stops following the end, as
  // when reading a long message from its top, so a reply streaming in doesn't pull it back down; reaching the end,
  // sending or the pill follow again. The card ends its message: a message taller than the screen shows its end.
  const seeAsk = useCallback(() => {
    const id = awayAsk?.ask.messageId;
    const key = id ? rows.find((r) => r.kind === "message" && r.message.id === id)?.key : undefined;
    if (!key) return;
    letGo();
    setReadHold(true);
    // After the render that turns following off, so the end doesn't pull it back down.
    requestAnimationFrame(() => {
      const index = listRef.current?.getState().indexByKey(key);
      if (index === undefined) return;
      void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5, viewPositionFallback: "end" });
    });
  }, [awayAsk, rows, letGo]);

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
  const isFresh = useCallback((key: string) => {
    const t0 = freshRef.current.get(key);
    return t0 !== undefined && Date.now() - t0 <= FRESH_MS;
  }, []);

  // ── Read ──
  // Seen up to the latest message: the list's badges (channel and DM) clear at once.
  const markRead = useMarkChannelRead(orgId).mutate;
  const lastId = list.at(-1)?.id;
  useEffect(() => {
    if (!member || !lastId || lastId.startsWith("local-")) return;
    markRead(channelId);
  }, [markRead, channelId, member, lastId]);

  // ── Older pages (channel view) ──
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The list asks for older rows on a layout change too, not only a scroll (Legend List 3.7): one page at a
  // time, whatever the state says this render.
  const fetchingOlder = useRef(false);
  const loadOlder = useCallback(() => {
    if (isThread || olderDone || loadingOlder || fetchingOlder.current || !top.data) return;
    const oldest = older[0] ?? top.data[0];
    if (!oldest || top.data.length < MESSAGES_PAGE) {
      setOlderDone(true);
      return;
    }
    fetchingOlder.current = true;
    setLoadingOlder(true);
    api.chat
      .messages(orgId, channelId, { before: oldest.createdAt, limit: MESSAGES_PAGE })
      .then((page) => {
        setOlder((prev) => [...page, ...prev]);
        if (page.length < MESSAGES_PAGE) setOlderDone(true);
      })
      .catch(() => setOlderDone(true))
      .finally(() => {
        fetchingOlder.current = false;
        setLoadingOlder(false);
      });
  }, [api, orgId, channelId, isThread, olderDone, loadingOlder, top.data, older]);

  // ── Sending ──
  // Without a connection (no internet, or the server restarting) a message isn't "failed": it waits with a
  // clock and goes by itself when the connection is back, from whatever screen is open (`useSendWaiting`).
  const post = usePostMessage(orgId, channelId, {
    me: { id: meId ?? "" },
    // An agent DM: "pensando…" at once, on the message the agent answers. Not when it went into the work
    // already going (the server steered it: no second run, its block says "lê na próxima pausa"), nor for a GIF or a
    // sticker alone, which no agent answers (ADR 0091).
    onSent: (message) => {
      const steered = Array.isArray(message.meta?.steeredRunIds) && message.meta.steeredRunIds.length > 0;
      if (dmAgentId && !steered && !isMediaAlone(message)) {
        live.expect(message.threadId ?? message.id, [dmAgentId], message.id);
      }
      // A channel with agents: the router (or a mention) decides who answers, and `message.routed` always follows.
      // A GIF or a sticker alone routes to nobody, so it gets no clock to keep.
      if (channel && channelAgents.length > 0 && !isMediaAlone(message)) live.picking(message.id);
    },
    onFailed: (_error, { waits }) => {
      if (!waits) toast({ title: t("mobile.chat.notSent"), icon: "x" });
    },
  });
  const { send, retry } = sendHelpers(post);
  // Rows keep the same callback (so a streaming reply doesn't re-render every message).
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const onRetry = useCallback((m: Message) => retryRef.current(m), []);
  // "Tentar de novo" under a message no agent could answer: the same words again, here (the web's `resend`).
  const sendRef = useRef(send);
  sendRef.current = send;
  const onResend = useCallback(
    (m: Message) => {
      sendRef.current(m.body, threadId);
      toEnd();
    },
    [threadId, toEnd],
  );
  const realtime = useRealtime().status;
  const control = useMissionControl(orgId);
  const createMission = useCreateMission(orgId);
  const channelAgents = (roster.data ?? []).filter((r) => r.type === "agent").map((r) => r.id);
  const soleAgent = dmAgentId ?? (channelAgents.length === 1 ? (channelAgents[0] ?? null) : null);
  // An empty channel says hi through one of its agents that answers me, by a handle people can read (as the web).
  const talkable = channelAgents.map((id) => dir.agentById.get(id)).filter((a): a is Agent => Boolean(a) && canTalk(a));
  const helloAgent = talkable.find((a) => !isIdHandle(a.handle)) ?? talkable[0];

  const openNewMission = (goal = "", homeThreadId: string | null = threadId) =>
    sheet.open(
      <NewMissionForm
        goal={goal}
        channelId={channelId}
        threadId={homeThreadId}
        preferredAgentId={mission?.agentId ?? soleAgent}
        currentThreadId={threadId}
      />,
    );
  const openRemind = (input: { text?: string; message?: Message } = {}) =>
    sheet.open(
      <RemindSheet
        channelId={channelId}
        threadId={threadId}
        {...(input.message ? { message: input.message } : {})}
        {...(input.text ? { initialText: input.text } : {})}
      />,
    );
  const summarize = () => {
    if (mission) sheet.open(<MissionSummaryView missionId={mission.id} />);
    else send(t("mobile.chat.summaryMessage"), threadId);
  };

  // Sending always goes to the end. While an agent works, "Parar e mandar" makes it read this one now.
  const onSend = (raw: string, how: SendHow = "join") => {
    const text = raw.trim();
    if (!text) return;
    const cmd = parseSlash(text);
    if (!cmd) {
      send(text, threadId, how === "now" ? { steer: "now" } : undefined);
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
  const sendMedia = (media: MessageMedia) => {
    send("", threadId, { media });
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

  const upload = async (file: { uri: string; name: string; type: string }) => {
    toast({ title: t("mobile.chat.uploading"), icon: "file" });
    try {
      // React Native's FormData sends `{ uri, name, type }` as a file part.
      const asFile = file as unknown as Parameters<typeof api.artifacts.upload>[1];
      const saved: ArtifactDetail = await api.artifacts.upload(orgId, asFile, {
        channelId,
        ...(threadId ? { threadId } : {}),
      });
      send("", threadId, { artifacts: [{ id: saved.id, version: saved.version, title: saved.title }] });
      toEnd();
    } catch {
      toast({ title: t("mobile.chat.uploadFailed"), icon: "x" });
    }
  };
  const onPlus = async (pick: PlusPick) => {
    sheet.close();
    switch (pick) {
      case "camera": {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          toast({ title: t("mobile.plus.noCamera"), icon: "camera" });
          return;
        }
        const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
        const a = res.canceled ? null : res.assets[0];
        if (a) await upload({ uri: a.uri, name: a.fileName ?? "photo.jpg", type: a.mimeType ?? "image/jpeg" });
        return;
      }
      case "photos": {
        const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.8 });
        const a = res.canceled ? null : res.assets[0];
        if (a)
          await upload({
            uri: a.uri,
            name: a.fileName ?? (a.type === "video" ? "video.mp4" : "photo.jpg"),
            type: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"),
          });
        return;
      }
      case "file": {
        const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
        const a = res.canceled ? null : res.assets[0];
        if (a) await upload({ uri: a.uri, name: a.name, type: a.mimeType ?? "application/octet-stream" });
        return;
      }
      case "audio":
        toast({ title: t("mobile.plus.audioSoon"), icon: "mic" });
        return;
      case "mission":
        setTimeout(() => openNewMission(), 250);
        return;
      case "summary":
        summarize();
        return;
      case "remind":
        setTimeout(() => openRemind(), 250);
        return;
    }
  };

  // ── Long press ──
  const canMission = !mission && (Boolean(dm) || Boolean(channel));
  // biome-ignore lint/correctness/useExhaustiveDependencies: openNewMission reads the latest state when called
  const onLongPress = useCallback(
    (m: Message) =>
      sheet.open(
        <MessageActions
          message={m}
          canMission={canMission}
          inThread={isThread}
          thread={linkThreads.get(m.threadId ?? m.id)}
          onMission={(goal, rootId) => openNewMission(goal, rootId)}
          onRemind={(message) => openRemind({ message })}
        />,
      ),
    [sheet, canMission, isThread, linkThreads],
  );

  // ── Pins ──
  const rowsRef = useRef<Row[]>([]);
  // Going to a message (a pin, `?m=`): found among the rows, or older pages loaded until it is (at most
  // `SEEK_MAX_PAGES`); then scrolled to and lit for a moment.
  const [seek, setSeek] = useState<string | null>(focusId);
  const [flashId, setFlashId] = useState<string | null>(null);
  const seekPages = useRef(0);
  const seekReady = isThread ? threadMessages.isSuccess : top.isSuccess;
  useEffect(() => {
    if (!seek || !seekReady) return;
    const index = shownRows.findIndex((r) => r.kind === "message" && r.message.id === seek);
    if (index >= 0) {
      setSeek(null);
      letGo();
      void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
      setFlashId(seek);
      return;
    }
    if (isThread || olderDone || seekPages.current >= SEEK_MAX_PAGES) {
      setSeek(null);
      return;
    }
    if (!loadingOlder) {
      seekPages.current += 1;
      loadOlder();
    }
  }, [seek, seekReady, shownRows, isThread, olderDone, loadingOlder, loadOlder, letGo]);
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);
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
  const openPins = () => sheet.open(<PinsSheet channelId={channelId} threadId={threadId} onPick={goToPin} />);
  // "Ver resultado" on a work's line: its report, when this conversation shows it.
  const jumpToMessage = useCallback((messageId: string) => {
    const index = rowsRef.current.findIndex((r) => r.kind === "message" && r.message.id === messageId);
    if (index < 0) return false;
    void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
    return true;
  }, []);
  // "Ver" on an answer's line: the two agents' conversation on its own screen, as the block's line opens it.
  const seeConsult = useCallback(
    (fold: Extract<ConsultNoticeFold, { fold: "line" }>) =>
      router.push(consultationHref(fold.consultation.id, channelId)),
    [channelId],
  );
  const openMembers = () =>
    channel ? sheet.open(<ChannelMembersSheet channelId={channelId} channelName={channel.name} />) : undefined;

  // ── Header ──
  // The header is glass over the conversation: the system's
  // back and "…" circles, and in the middle a pill with who or where, its sky and what the agent is doing.
  const info = thread.data;
  // A task's work thread: its root was written by the server in one language ("Issue #1: …"); the card's
  // number and title, in the reader's.
  const root = isThread ? list.find((m) => m.id === threadId) : undefined;
  const rootWork = issueWorkOf(root?.meta);
  const title = isThread
    ? rootWork
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
    ? info
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
      ? dir.agentById.get(dmAgentId)?.role || undefined
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
  const showDay = useCallback(() => {
    clearTimeout(dayTimer.current);
    dayShown.value = withTiming(1, { duration: 120 });
  }, [dayShown]);
  const hideDay = useCallback(() => {
    clearTimeout(dayTimer.current);
    dayTimer.current = setTimeout(() => {
      dayShown.value = withTiming(0, { duration: 300 });
    }, DATE_PILL_IDLE_MS);
  }, [dayShown]);
  useEffect(() => () => clearTimeout(dayTimer.current), []);
  const onViewable = useCallback<NonNullable<OnViewableItemsChanged<Row>>>(
    ({ viewableItems }) => {
      stickers.setOnScreen(stickerRowsOnScreen(viewableItems));
      setTopDay((prev) => dayInView(viewableItems, prev));
    },
    [stickers],
  );
  // While something covers the conversation (a sheet, the agent's computer) the list ignores the keyboard: it
  // leaving under the cover, or coming back, must not move it (Bluesky and Mattermost freeze or dismiss first too).
  const freeze = useSharedValue(false);
  const covered = useRef(false);
  const cover = useCallback(() => {
    covered.current = true;
    freeze.value = true;
  }, [freeze]);
  const uncover = useCallback(() => {
    covered.current = false;
    setTimeout(() => {
      if (!covered.current) freeze.value = false;
    }, FREEZE_AFTER_MS);
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
      uncover();
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
              dm ? <Face who={{ type: dm.with.type, id: dm.with.id }} size={36} live={false} /> : <Tile icon="hash" />
            }
            agentId={dmAgentId}
            about={personDm ? <PersonStatusCard userId={personDm} /> : undefined}
            onPins={openPins}
            onMembers={channel && !dm ? openMembers : undefined}
          />,
        );
  // Holding the pill: "Trocar de conversa". The pick swaps the conversation in place (the route's params; the
  // screen is keyed by them), not a new screen sliding in: the slide made the header's pill jump at its end.
  // The swap waits for the sheet to finish closing (it lives in this screen, which the swap remounts).
  const hold = {
    onHold: () => {
      let picked: string | null = null;
      sheet.open(
        <ConversationSwitcher
          channelId={channelId}
          onPick={(id) => {
            picked = id === channelId ? null : id;
            sheet.close();
          }}
        />,
        {
          onClose: () => {
            const id = picked;
            // `onClose` runs as the sheet starts leaving: the swap waits for it to slide away.
            if (id) setTimeout(() => router.setParams({ channelId: id, thread: "", handoff: "" }), SHEET_LEAVE_MS);
          },
        },
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
        extraActions={dmAgentId ? 1 : 0}
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
        {...hold}
        label={t("mobile.chat.headerChannel", { who: who(title, subtitle ?? "") })}
      />
    ) : null;
  // An agent's DM also opens its computer (as the web's DM header), for whoever may watch it.
  const right =
    (isThread && info) || dm || channel ? (
      <>
        {dmAgentId && !isThread ? <DmComputerButton agentId={dmAgentId} onOpen={leavePlace} /> : null}
        <IconButton icon="more" label={t("mobile.chat.options")} onPress={openOptions} />
      </>
    ) : null;

  const placeholder = isThread
    ? t("mobile.chat.reply")
    : dm
      ? t("mobile.chat.messageTo", { name: dm.with.name })
      : t("mobile.chat.messageIn", { channel: channel ? `#${channel.name}` : "" });
  // What to say next comes from the latest card: a code change, a file; none
  // while the agent works, asks or waits for an approval.
  const people = useMemo(
    () => [...dir.memberById.values()].map((p) => ({ id: p.userId, name: p.name })),
    [dir.memberById],
  );
  const suggestions = useMemo(
    () =>
      composerSuggestions({ messages: list, meId, people }).map((x) => ({
        icon: x.icon,
        label: t(`mobile.chat.intent.suggest.${x.key}`, x.values ?? {}),
      })),
    [list, meId, people, t],
  );
  rowsRef.current = rows;
  const pinned = mission && isOpenMission(mission) ? mission : null;
  // The pinned bar shows while something is pinned here (`PinnedBar`).
  const pinsData = usePins(orgId, channelId, member).data;
  const hasPins = useMemo(() => pinsIn(pinsData ?? [], threadId).length > 0, [pinsData, threadId]);

  // ── Agents' receipts and "no AI" ──
  // One receipt on screen (`receiptMessageId`): a mark beside my bubble, or at the end of the name line of someone
  // else's turn; a line under the message only for what asks something of you.
  const receiptId = useMemo(() => receiptMessageId(shownMessages, live.receipts), [shownMessages, live.receipts]);
  const receiptMine = Boolean(meId && shownMessages.find((m) => m.id === receiptId)?.author.id === meId);
  // Someone else's message sent into a task at work says nothing here (mine wears it: `ReceiptMark`).
  const receiptSteered = useSteerState(orgId, channelId, receiptId && !receiptMine ? receiptId : "") !== null;
  const markAt = useMemo(
    () => (!receiptId || receiptSteered ? null : receiptMine ? receiptId : turnHeadId(rows, receiptId)),
    [receiptId, receiptSteered, receiptMine, rows],
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
  // Above the box: an agent here without an AI, or the whole workspace without one (as on the web).
  const aiStatus = useAiStatus(orgId);
  const banner = member
    ? noAiBanner(aiStatus.data, {
        agentIds: dmAgentId ? [dmAgentId] : channelAgents,
        dmAgentId,
        cardShown: endsOnNoAiCard(shownMessages),
      })
    : null;
  const connectInline = banner === null;
  const loading = isThread ? threadMessages.isLoading : top.isLoading;

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.kind) {
        case "day":
          return (
            <Text variant="footnote" tone="faint" style={styles.day}>
              {when.day(item.iso)}
            </Text>
          );
        case "marker":
          return (
            <Text variant="footnote" tone="faint" style={styles.day}>
              {item.text}
            </Text>
          );
        case "run":
          return (
            <Animated.View entering={isFresh(item.key) ? ENTER : undefined}>
              <TurnRow run={item.run} bodyOf={bodyOf} />
            </Animated.View>
          );
        case "unseen":
          return <UnseenLine fading={item.fading} />;
        case "browser": {
          const agentId = item.run ? item.run.agentId : item.handoff.agentId;
          return (
            <Animated.View entering={isFresh(item.key) ? ENTER : undefined} style={styles.browserRow}>
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
        case "message":
          // What reached an agent's conversation (a routine's report, another agent's answer) and a routine
          // that ran in the background: quiet lines, never a person's or the agent's own voice.
          if (isEventLine(item.message.meta))
            return <EventLine message={item.message} fold={consultFolds.get(item.message.id)} onSee={seeConsult} />;
          // An agent took an issue made from this conversation: one quiet line, not a voice.
          if (issueTakenOf(item.message.meta)) return <IssueTakenLine message={item.message} />;
          return (
            // A finished reply replaces its streaming row in place: it doesn't rise in again. An agent's sticker or
            // GIF after its reply (ADR 0091) replaces nothing: it rises in.
            <Animated.View
              entering={
                isFresh(item.key) && (!item.message.agentRunId || isMediaAfterReply(item.message.meta))
                  ? ENTER
                  : undefined
              }
              style={item.message.id === flashId ? { backgroundColor: c.sunken } : undefined}
            >
              <MessageRow
                message={item.message}
                grouped={item.grouped}
                run={runPosition(item.grouped, item.continued ?? false)}
                above={item.above}
                aboveThread={item.above && !isThread ? linkThreads.has(item.above.id) : false}
                meId={meId}
                thread={isThread ? undefined : linkThreads.get(item.message.id)}
                onLongPress={onLongPress}
                onRetry={onRetry}
                receipt={item.message.id === markAt ? receipt : undefined}
                seenBy={item.message.id === seenId ? seenBy : undefined}
              />
              {item.message.id === receiptId ? (
                <AgentReceiptLine
                  message={item.message}
                  receipt={receipt}
                  mine={item.message.author.id === meId}
                  connectInline={connectInline}
                  onRetry={onResend}
                />
              ) : null}
            </Animated.View>
          );
      }
    },
    [
      when,
      meId,
      isThread,
      linkThreads,
      onLongPress,
      onRetry,
      isFresh,
      openBrowsers,
      toggleBrowser,
      bodyOf,
      seenId,
      seenBy,
      receiptId,
      markAt,
      receipt,
      connectInline,
      onResend,
      consultFolds,
      seeConsult,
      flashId,
      c.sunken,
    ],
  );

  // Pushes about this conversation stay quiet while it is on screen (no banner, no buzz).
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) return;
    // The release clears it only if it still holds this screen's conversation (the next screen may have
    // taken over before this one's blur).
    return holdOpenConversation({ orgId, channelId });
  }, [focused, orgId, channelId]);
  // "Falar com o Theo" from two agents' conversation: "@theo " in this field, once this screen is in view again.
  const composerRequest = useComposerRequest(channelId);
  const prefill = focused ? composerRequest : null;
  useEffect(() => {
    if (prefill) takeComposerRequest(prefill.at);
  }, [prefill]);

  // ── Composer and keyboard ──
  // The composer floats over the list's bottom and rides the keyboard (KeyboardStickyView); the list's end
  // inset is the composer's height plus the keyboard, moved on the UI thread frame by frame (also while the
  // keyboard is dragged down interactively).
  const composerRef = useRef<ComponentRef<typeof View>>(null);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(listRef, composerRef);
  const [composerHeight, setComposerHeight] = useState(0);
  const onComposerBoxLayout = (e: LayoutChangeEvent) => {
    onComposerLayout(e);
    setComposerHeight(e.nativeEvent.layout.height);
  };
  const bottomPad = Math.max(insets.bottom, 10);
  // The header floats over the conversation (glass on iOS 26, a blur before; round plates on Android), which
  // fades under it.
  const headerHeight = useHeaderHeight();
  const lift = Math.max(0, bottomPad - KEYBOARD_GAP);
  const showList = !loading && !(rows.length === 0 && runs.length === 0);
  // The conversation starts below the clear bar by our own padding, on both platforms (the pinned card, when there
  // is one, already holds that room). iOS's automatic inset made keyboard moves land short at the end.
  const hasPin = pinned !== null || hasPins;
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
    return { top: hasPin ? 0 : headerHeight, bottom: composerHeight + keyboard };
  }, [hasPin, headerHeight, composerHeight, lift]);
  // A row the list doesn't draw now (outside what it keeps mounted) has no card: its request is out of view.
  const askDrawn = useCallback((messageId: string) => {
    const state = listRef.current?.getState();
    const key = rowsRef.current.find((r) => r.kind === "message" && r.message.id === messageId)?.key;
    const index = state && key !== undefined ? state.indexByKey(key) : undefined;
    return state !== undefined && index !== undefined && index >= state.startBuffered && index <= state.endBuffered;
  }, []);
  const watchAsks = useAskWatch(asks, { frame: () => listFrame.current, insets: askInsets, drawn: askDrawn });

  // The list shows once it sits at the end (no frame of it placing itself), as Bluesky's and Expensify's do; from
  // a little opacity, not none, so the glass inside rows keeps drawing.
  const listShown = useSharedValue(0.05);
  const listFade = useAnimatedStyle(() => ({ opacity: listShown.value }));
  const revealList = useCallback(() => {
    listShown.value = withTiming(1, { duration: 160 });
    listPlaced.current = true;
    watchAsks();
  }, [listShown, watchAsks]);
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
  const readRoom = headerHeight + 8;
  const checkReading = useCallback(() => {
    const key = toReadRef.current;
    const state = listRef.current?.getState();
    if (!key || !state) return;
    const index = state.indexByKey(key);
    if (index === undefined) return;
    if (state.sizeAtIndex(index) <= state.scrollLength - readRoom - composerHeight) return;
    toReadRef.current = null;
    landedRef.current.add(key);
    if (!atEndRef.current) return;
    setReadHold(true);
    // After the render that turns following off, so the end doesn't pull it back down.
    requestAnimationFrame(() => {
      void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset: readRoom });
    });
  }, [readRoom, composerHeight]);
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    return state.listen("totalSize", checkReading);
  }, [showList, checkReading]);
  // Rows growing or shrinking (a reply streaming, a card opening) move the waiting requests' cards too.
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    return state.listen("totalSize", watchAsks);
  }, [showList, watchAsks]);
  // The person scrolled down to the end of what they were reading: the list follows again.
  const releaseAtEnd = useCallback(() => {
    const state = listRef.current?.getState();
    if (state && state.distanceFromEnd <= READ_RELEASE_PX) setReadHold(false);
  }, []);

  return (
    <AskStoreProvider store={asks}>
      <AskProbes messages={shownMessages} />
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        {/* A clear bar on every conversation (DM, channel, thread): the band behind it is ours, below, so the
            system's scroll edge never makes one look different from another. */}
        <PushedHeader title={pill ?? title} plate solid={false} right={right} />
        {hasPin ? (
          // The bar is see-through (the conversation runs under it): the pinned bar and card start below it.
          <View style={{ backgroundColor: c.bg, paddingTop: headerHeight }}>
            {hasPins ? <PinnedBar channelId={channelId} threadId={threadId} onOpen={openPins} /> : null}
            {pinned ? (
              <View style={[styles.pin, hasPins && styles.pinBelowBar]}>
                <MissionCardView mission={pinned} pinned />
              </View>
            ) : null}
          </View>
        ) : null}
        {/* No `textInputNativeID`: with it the composer could stay down while the keyboard was up (iOS 26; Bluesky
            drops it too). The offset is whole points: a fractional one made the overscroll glitch. */}
        <KeyboardGestureArea
          style={styles.grow}
          interpolator="ios"
          offset={Math.round(Math.max(0, composerHeight - lift))}
        >
          {loading ? (
            <View style={[styles.center, { paddingBottom: composerHeight }]}>
              <Text tone="faint">{t("mobile.common.loading")}</Text>
            </View>
          ) : (
            <>
              {/* Mounted before the first message too: a list that appears while the keyboard is already up never
                  hears it open, and its first message landed under it. */}
              <Animated.View style={[styles.grow, listFade]}>
                {/* The list's frame, where the waiting requests' cards are measured from (never flattened away). */}
                <View ref={listFrame} collapsable={false} style={styles.grow} onLayout={watchAsks}>
                  <StickerStageContext.Provider value={stickers}>
                    <JumpToMessageContext.Provider value={jumpToMessage}>
                      <KeyboardAwareLegendList
                        ref={listRef}
                        style={styles.grow}
                        data={shownRows}
                        keyExtractor={rowKey}
                        getItemType={rowType}
                        renderItem={renderItem}
                        // The list redraws mounted rows only when this changes: what a row shows beyond its message (the
                        // thread link that loads after it, a held state) lives in `renderItem`'s dependencies.
                        extraData={renderItem}
                        estimatedItemSize={72}
                        // Opens at the latest message, short conversations sit at the bottom like any chat.
                        initialScrollAtEnd
                        alignItemsAtEnd
                        // New messages, a reply growing word by word and the working line keep the end in view, but
                        // only while the person is near it.
                        maintainScrollAtEnd={!readHold}
                        maintainScrollAtEndThreshold={STICK_TO_END_THRESHOLD}
                        // Older pages above and rows changing size keep what is on screen still.
                        maintainVisibleContentPosition
                        // Our own insets, never the system's (the keyboard library's advice for chat lists): the bar's
                        // room is the content's top padding, the indicator kept below the bar.
                        contentInsetAdjustmentBehavior="never"
                        automaticallyAdjustContentInsets={false}
                        scrollIndicatorInsets={{ top: headerHeight }}
                        // Still while a sheet or the agent's computer covers the conversation.
                        freeze={freeze}
                        onReady={revealList}
                        onStartReached={loadOlder}
                        // A look at the waiting requests' cards, once a frame and only while one waits.
                        onScroll={watchAsks}
                        onViewableItemsChanged={onViewable}
                        viewabilityConfig={STICKER_VIEW}
                        onScrollBeginDrag={() => {
                          dragging.current = true;
                          showDay();
                        }}
                        onScrollEndDrag={() => {
                          releaseAtEnd();
                          hideDay();
                        }}
                        onMomentumScrollBegin={showDay}
                        onMomentumScrollEnd={() => {
                          releaseAtEnd();
                          hideDay();
                        }}
                        onStartReachedThreshold={0.5}
                        keyboardDismissMode="interactive"
                        keyboardShouldPersistTaps="handled"
                        keyboardOffset={lift}
                        contentInsetEndAdjustment={contentInsetEndAdjustment}
                        contentContainerStyle={listPad}
                      />
                    </JumpToMessageContext.Provider>
                  </StickerStageContext.Provider>
                  <DatePill day={topDay} shown={dayShown} top={hasPin ? 8 : headerHeight + 8} />
                </View>
              </Animated.View>
              {showList ? null : (
                // A conversation with nothing yet: the agent's first day or a quiet line, over the empty list.
                <View style={StyleSheet.absoluteFill}>
                  {dmAgent && !isThread ? (
                    <FirstDay agent={dmAgent} bottomInset={composerHeight} keyboardLift={lift} onAsk={onSend} />
                  ) : channel && helloAgent && !dm && !isThread ? (
                    <ChannelHello
                      channel={channel.name}
                      agent={helloAgent}
                      bottomInset={composerHeight}
                      keyboardLift={lift}
                      onAsk={onSend}
                    />
                  ) : (
                    <View style={[styles.center, { paddingBottom: composerHeight }]}>
                      <Text tone="faint" style={styles.emptyText}>
                        {t("mobile.chat.empty")}
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </>
          )}
          <KeyboardStickyView
            offset={{ opened: lift }}
            style={[styles.jumpDock, { bottom: composerHeight + 10 }]}
            pointerEvents="box-none"
          >
            {showList && (!atEnd || readHold) ? (
              unseen.messages > 0 || unseen.working.length > 0 ? (
                <NewPill unseen={unseen} onPress={toUnseen} />
              ) : (
                <ToLatest onPress={toEnd} />
              )
            ) : null}
          </KeyboardStickyView>
          {!pinned ? (
            // The conversation fades under the floating header, as it does under the box.
            <LinearGradient
              pointerEvents="none"
              colors={[c.bg, withOpacity(c.bg, 0.86), withOpacity(c.bg, 0)]}
              locations={[0, 0.62, 1]}
              style={[styles.topFade, { height: headerHeight + 28 }]}
            />
          ) : null}
          <KeyboardStickyView offset={{ opened: lift }} style={styles.composerDock}>
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
              {banner ? <NoAiBanner banner={banner} /> : null}
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
              {member && !awayAsk ? (
                <WorkingLine
                  runs={runs}
                  consults={lineConsults}
                  typing={typing}
                  canStop={canStop}
                  onStop={stopRun}
                  onOpenBrowser={(agentId) => {
                    // The agent's browser card opens in the conversation (at the end), not another screen.
                    toggleBrowser(agentId, true);
                    toEnd();
                  }}
                />
              ) : null}
              {member ? (
                <Composer
                  placeholder={placeholder}
                  onSend={onSend}
                  working={working}
                  onPlus={() => sheet.open(<PlusActions onPick={(p) => void onPlus(p)} />)}
                  media={mediaTabs.length > 0 ? { label: t("media.picker.send"), onPress: openMedia } : null}
                  inputNativeID={COMPOSER_INPUT_ID}
                  {...(suggestions.length > 0 ? { suggestions } : {})}
                  {...(dmAgentId && !isThread ? { face: <AgentFace agentId={dmAgentId} size={22} /> } : {})}
                  mentionAt={refQuery}
                  insertMention={insertRef}
                  prefill={prefill}
                  mention={({ query, sigil, pick }) =>
                    sigil === "#" ? (
                      <ChannelPicker query={query} pick={pick} />
                    ) : (
                      <MentionPicker query={query} pick={pick} channelId={channelId} members={mentionMembers} />
                    )
                  }
                  onType={() => sendTyping(threadId)}
                />
              ) : (
                <Button
                  variant="primary"
                  wide
                  label={t("mobile.chat.join")}
                  disabled={join.isPending}
                  onPress={() => join.mutate()}
                />
              )}
            </View>
          </KeyboardStickyView>
        </KeyboardGestureArea>
      </View>
    </AskStoreProvider>
  );
}

/** Back to the latest messages: a round button over the list (nothing new below). */
function ToLatest({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const { colors, shadows } = useTheme();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={styles.jumpEnd}>
      <PressScale
        to={0.92}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.chat.toLatest")}
        style={[styles.jump, { backgroundColor: colors.raised, boxShadow: `${shadows.e2}, ${shadows.top}` }]}
      >
        <View style={styles.jumpIcon}>
          <Icon name="chev" size={20} color={colors.ink2} />
        </View>
      </PressScale>
    </Animated.View>
  );
}

/**
 * "↓ 2 novas · Marina e Ada · Theo escrevendo": who spoke below, not just a count, with
 * their stacked faces; it lands on the "Novas" line (or at the end when that is close).
 */
function NewPill({ unseen, onPress }: { unseen: Unseen; onPress: () => void }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const reduced = useReducedMotion();
  const { colors, shadows } = useTheme();
  const parse = (who: string) => {
    const at = who.indexOf(":");
    return { type: who.slice(0, at), id: who.slice(at + 1) };
  };
  const nameOf = (who: string) => dir.nameOf(parse(who));
  const count = unseen.messages > 0 ? t("mobile.chat.unseen.count", { count: unseen.messages }) : "";
  const working = unseen.working;
  const rest = [
    unseen.authors.length > 0 ? listNames(t, unseen.authors.map(nameOf)) : "",
    working.length > 0 ? t("mobile.chat.unseen.working", { names: listNames(t, working.map(nameOf)) }) : "",
  ].filter(Boolean);
  const faces = [...new Set([...unseen.authors, ...working])].slice(0, 3);
  const label = [count, ...rest].filter(Boolean).join(" · ");
  return (
    <Animated.View
      entering={reduced ? FadeIn.duration(120) : FadeInDown.springify().damping(14).stiffness(260)}
      exiting={FadeOut.duration(120)}
      style={styles.pillWrap}
    >
      <PressScale
        to={0.96}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.pill, { backgroundColor: colors.raised, boxShadow: `${shadows.e2}, ${shadows.top}` }]}
      >
        <View style={styles.pillIn}>
          <Icon name="down" size={16} color={colors.ink2} />
          <View style={styles.faces}>
            {faces.map((w, i) => (
              <View key={w} style={[styles.pillFace, i > 0 && styles.pillOverlap, { borderColor: colors.raised }]}>
                <Face who={parse(w)} size={20} live={false} />
              </View>
            ))}
          </View>
          <Text variant="footnote" tone="ink" numberOfLines={1} style={styles.pillText}>
            {count ? (
              <Text variant="footnote" tone="ink" style={styles.pillCount}>
                {count}
              </Text>
            ) : null}
            <Text variant="footnote" tone="muted">
              {(count ? rest.map((x) => ` · ${x}`) : [rest.join(" · ")]).join("")}
            </Text>
          </Text>
        </View>
      </PressScale>
    </Animated.View>
  );
}

/** "Novas": before the first message that arrived while the person read above; it fades once read. */
function UnseenLine({ fading }: { fading: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withTiming(fading ? 0 : 1, { duration: 600 });
  }, [fading, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[styles.unseen, style]} accessibilityRole="text">
      <Text variant="caption" style={[styles.unseenText, { color: c.agent }]}>
        {t("mobile.chat.unseen.divider")}
      </Text>
      <View style={[styles.unseenRule, { backgroundColor: c.agent }]} />
    </Animated.View>
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
      <Icon name={back ? "check" : "wifi"} size={15} color={back ? c.ok : c.warn} />
      <Text variant="small" style={[styles.connText, { color: back ? c.ok : c.warn }]}>
        {back ? t("mobile.chat.connection.back") : t("mobile.chat.connection.down")}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  topFade: { position: "absolute", top: 0, left: 0, right: 0 },
  // Under the agent's words, like a card on its message (MessageRow: 14 + 34 avatar + 11 gap).
  browserRow: { paddingLeft: 59, paddingRight: 16, paddingBottom: 6 },
  screen: { flex: 1 },
  grow: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { textAlign: "center" },
  pin: { paddingHorizontal: 12, paddingBottom: 10 },
  pinBelowBar: { paddingTop: 10 },
  day: { alignSelf: "center", textAlign: "center", marginTop: 16, marginBottom: 6, fontWeight: "600" },
  listPad: { paddingTop: 8, paddingBottom: 8 },
  composer: { paddingHorizontal: 10, paddingTop: 6 },
  composerDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  jumpDock: { position: "absolute", left: 14, right: 14 },
  jumpEnd: { alignSelf: "flex-end" },
  jump: { width: 40, height: 40, borderRadius: 20 },
  jumpIcon: { flex: 1, alignItems: "center", justifyContent: "center" },
  // The "↓ novas" pill: centered, the "tato com canto" corner.
  pillWrap: { alignSelf: "center", maxWidth: "100%" },
  pill: {
    minHeight: 36,
    borderTopLeftRadius: 13,
    borderTopRightRadius: 13,
    borderBottomRightRadius: 13,
    borderBottomLeftRadius: 4,
  },
  pillIn: { flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 8, paddingRight: 12 },
  pillFace: { borderWidth: 2, borderRadius: 8 },
  pillOverlap: { marginLeft: -6 },
  pillText: { flexShrink: 1 },
  pillCount: { fontWeight: "600" },
  unseen: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginVertical: 6 },
  unseenText: { fontWeight: "700" },
  unseenRule: { flex: 1, height: StyleSheet.hairlineWidth * 2, opacity: 0.45 },
  conn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 4,
    marginBottom: 6,
    paddingVertical: 7,
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
