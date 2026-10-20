import {
  ApiError,
  type ArtifactDetail,
  type BrowserHandoff,
  type ConnectionStatus,
  heldTakeoversHere,
  type LiveRun,
  MESSAGES_PAGE,
  type Message,
  type MessagePin,
  sendHelpers,
  useAgentsBrowserHandoffs,
  useApi,
  useChannels,
  useChannelThreads,
  useCreateMission,
  useDmReads,
  useDms,
  useHeldPlaces,
  useJoinChannel,
  useMarkChannelRead,
  useMessages,
  useMissionControl,
  usePostMessage,
  useRoster,
  useThreadInfo,
  useThreadMessages,
  useThreadMission,
  useThreads,
} from "@agenteschat/client";
import { listNames } from "@agenteschat/client/lib/activity";
import { issueTakenOf } from "@agenteschat/client/lib/issues";
import { supersededBrainNotices } from "@agenteschat/client/lib/machine-outages";
import { can } from "@agenteschat/client/lib/permissions";
import { seenMessageId } from "@agenteschat/client/lib/seen";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router, useIsFocused } from "expo-router";
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, type LayoutChangeEvent, Pressable, StyleSheet, View } from "react-native";
import { KeyboardGestureArea, KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { isListedThread, threadTitle } from "../chats/logic";
import { chatHref } from "../links/logic";
import { MissionCardView } from "../missions/cards";
import { isOpenMission } from "../missions/logic";
import { RemindSheet } from "../reminders/RemindSheet";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { FocusLive, PushedHeader, Tile } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { FirstDay } from "./FirstDay";
import { composerSuggestions } from "./intent";
import { IssueTakenLine } from "./issue-work";
import { browsingRuns, TurnRow, WorkingLine } from "./LiveRows";
import { useChatLive } from "./live";
import {
  buildRows,
  type ChatRow,
  mayStopRun,
  mergeTimeline,
  parseSlash,
  pinTarget,
  stoppableInLine,
  threadRootsToLoad,
} from "./logic";
import { MentionPicker, useMentionMembers } from "./MentionPicker";
import { MessageRow } from "./MessageRow";
import { insertMention, mentionQuery } from "./mentions";
import { PinsSheet } from "./PinsSheet";
import {
  appendedKeys,
  type HeldRun,
  HOLD_FINISHED_RUN_MS,
  landsOnDivider,
  lastSeenKey,
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
import { openingRuns, turnRuns, withOpacity } from "./turn";

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
/** An agent's block and its saved reply share a key and a type: the reply takes the block's row in place. */
const rowType = (r: Row) => (r.kind === "run" || (r.kind === "message" && r.key.startsWith("turn-")) ? "turn" : r.kind);
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
/** The composer's safe-area padding hides behind the open keyboard; this much stays between them. */
const KEYBOARD_GAP = 8;
const COMPOSER_INPUT_ID = "chat-composer";

/**
 * A conversation: a channel, a DM, a thread or a mission's thread (`threadId`). `handoffId`: a request
 * for help a push or the inbox opened it for (its card opens in place, in control).
 */
export function ChatScreen({
  channelId,
  threadId,
  handoffId,
}: {
  channelId: string;
  threadId?: string | null;
  handoffId?: string | null;
}) {
  return (
    <SheetHostProvider>
      <FocusLive>
        <OpenHandoffProvider handoffId={handoffId ?? null}>
          <Chat channelId={channelId} threadId={threadId ?? null} />
        </OpenHandoffProvider>
      </FocusLive>
    </SheetHostProvider>
  );
}

function Chat({ channelId, threadId }: { channelId: string; threadId: string | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const api = useApi();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const insets = useSafeAreaInsets();
  const when = useWhen();

  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const channel = channels.data?.find((x) => x.id === channelId);
  const dm = dms.data?.find((d) => d.channelId === channelId);
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
  const { linkThreads, collapsed } = useMemo(() => {
    const all = channelThreads.data?.threads ?? [];
    return {
      linkThreads: new Map(all.filter(isListedThread).map((x) => [x.id, x])),
      collapsed: new Set(all.filter((x) => x.state !== "open").map((x) => x.id)),
    };
  }, [channelThreads.data]);
  const [older, setOlder] = useState<Message[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  const roots = useMemo(
    () => threadRootsToLoad(top.data ?? [], new Set([...linkThreads.keys(), ...collapsed])),
    [top.data, linkThreads, collapsed],
  );
  const threads = useThreads(orgId, channelId, isThread ? [] : roots);
  // The thread lists are new arrays on every render: their update times say when the data changed.
  const threadsAt = threads.map((q) => q.dataUpdatedAt).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `threadsAt` stands for the thread lists' data
  const list = useMemo(() => {
    if (isThread) {
      // My replies still sending wait in the channel's list.
      const mine = (top.data ?? []).filter((m) => m.local && m.threadId === threadId);
      return mergeTimeline(threadMessages.data ?? [], [mine]);
    }
    return mergeTimeline(
      [...older, ...(top.data ?? [])],
      threads.map((q) => q.data),
    );
  }, [isThread, threadId, top.data, threadMessages.data, older, threadsAt]);
  // A DM with a person: "Visto" under my latest message once they read it (live: `channel.read`).
  const reads = useDmReads(orgId, channelId, dm?.with.type === "person" && !isThread);
  const seenId = useMemo(
    () => (reads.data && meId ? seenMessageId(top.data ?? [], meId, reads.data) : null),
    [reads.data, top.data, meId],
  );

  // ── Live ──
  const live = useChatLive(orgId, channelId, member);
  const runs = useMemo(
    () =>
      live.runs.filter((r) =>
        isThread ? r.threadId === threadId : !linkThreads.has(r.threadId) && !collapsed.has(r.threadId),
      ),
    [live.runs, isThread, threadId, linkThreads, collapsed],
  );
  const consults = useMemo(
    () => live.consults.filter((x) => (isThread ? x.threadId === threadId : !linkThreads.has(x.threadId))),
    [live.consults, isThread, threadId, linkThreads],
  );

  // "Parar" in the working line (as on the web): admins, the agent's owner, or who started it.
  const role = useOrg().org?.role;
  const canStop = useCallback(
    (r: LiveRun) =>
      mayStopRun(r, {
        meId,
        manageAgents: can(role, "manage_agents"),
        agentOwnerId: dir.agentById.get(r.agentId)?.ownerUserId,
        messages: list,
      }),
    [meId, role, dir.agentById, list],
  );
  const { stop } = live;
  const stopRun = useCallback(
    (r: LiveRun) => {
      if (meId) stop(r.runId, meId);
    },
    [meId, stop],
  );
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
  // An agent at work in its browser: its card in the conversation (NavegadorNoChat A), open on demand.
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
  // Every agent at work is one block, the last thing in the conversation (Mensagens.html): "pensando",
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
  // The messages an agent read while working (its "Leu seu recado" wells quote them).
  const bodiesRef = useRef(new Map<string, string>());
  bodiesRef.current = useMemo(() => new Map(list.map((m) => [m.id, m.body])), [list]);
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
              text: t("mobile.chat.startedIn", { channel: info?.channelName ?? channel?.name ?? "" }),
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
        ...runRowsOf(openingRuns(shownRuns)),
      ];
    }
    const hidden = (m: Message) =>
      superseded.has(m.id) || Boolean(m.threadId && (linkThreads.has(m.threadId) || collapsed.has(m.threadId)));
    return [
      ...asTurns(buildRows(list, hidden)),
      ...browsing.map((run) => ({ kind: "browser" as const, key: `browser-${run.agentId}`, run })),
      ...held.map((h) => ({ kind: "browser" as const, key: `browser-${h.agentId}`, run: null, handoff: h })),
      ...runRowsOf(openingRuns(shownRuns)),
    ];
  }, [
    isThread,
    threadId,
    list,
    thread.data,
    channel?.name,
    shownRuns,
    turnKeyOf,
    browsing,
    held,
    linkThreads,
    collapsed,
    superseded,
    t,
  ]);

  // ── Following the end ──
  // The list sticks to the end only while the person is near it (Legend List's maintainScrollAtEnd); farther
  // up nothing moves (the scroll is never taken): a pill says what arrived below and who, a "Novas" line
  // marks the first of it, and the pill lands there when it is far (Mensagens.html).
  const listRef = useRef<LegendListRef>(null);
  const scrollRows = useMemo<ScrollRow[]>(
    () =>
      rows.map((r) => ({
        key: r.key,
        kind: r.kind === "message" ? "message" : r.kind === "run" ? "run" : "other",
        mine: r.kind === "message" && r.message.author.type === "person" && r.message.author.id === meId,
        ...(r.kind === "message" && r.message.author.id
          ? { who: `${r.message.author.type}:${r.message.author.id}` }
          : r.kind === "run"
            ? { who: `agent:${r.run.agentId}` }
            : {}),
      })),
    [rows, meId],
  );
  const [atEnd, setAtEnd] = useState(true);
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
    setAtEnd(true);
    requestAnimationFrame(() => void listRef.current?.scrollToEnd({ animated: true }));
  }, []);
  // The pill: to the "Novas" line when it is far, else to the end.
  const toUnseen = useCallback(() => {
    const state = listRef.current?.getState();
    const index = shownRows.findIndex((r) => r.key === DIVIDER_KEY);
    const far = state && landsOnDivider(state.contentLength, state.positionByKey(DIVIDER_KEY), state.scrollLength);
    if (far && index >= 0) {
      void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset: 12 });
      // What is new is in view now: the pill goes, the line fades after a while.
      setSeenKey(latestSeen);
      setReached(true);
      return;
    }
    toEnd();
  }, [shownRows, latestSeen, toEnd]);

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
  const loadOlder = useCallback(() => {
    if (isThread || olderDone || loadingOlder || !top.data) return;
    const oldest = older[0] ?? top.data[0];
    if (!oldest || top.data.length < MESSAGES_PAGE) {
      setOlderDone(true);
      return;
    }
    setLoadingOlder(true);
    api.chat
      .messages(orgId, channelId, { before: oldest.createdAt, limit: MESSAGES_PAGE })
      .then((page) => {
        setOlder((prev) => [...page, ...prev]);
        if (page.length < MESSAGES_PAGE) setOlderDone(true);
      })
      .catch(() => setOlderDone(true))
      .finally(() => setLoadingOlder(false));
  }, [api, orgId, channelId, isThread, olderDone, loadingOlder, top.data, older]);

  // ── Sending ──
  // Without internet a message isn't "failed": it waits with a clock and goes by itself when the connection
  // is back (or the app comes back to the front).
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());
  const post = usePostMessage(orgId, channelId, {
    me: { id: meId ?? "" },
    // An agent DM: "pensando…" at once, on the message the agent answers. Not when it went into the work
    // already going (the server steered it: no second run, its block says "lê na próxima pausa").
    onSent: (message) => {
      const steered = Array.isArray(message.meta?.steeredRunIds) && message.meta.steeredRunIds.length > 0;
      if (dmAgentId && !steered) live.expect(message.threadId ?? message.id, [dmAgentId]);
    },
    onFailed: (error, { clientId }) => {
      if (error instanceof ApiError) {
        toast({ title: t("mobile.chat.notSent"), icon: "x" });
        return;
      }
      // No answer at all (no internet): this message (only this one; others the server refused stay
      // "failed") waits instead.
      setWaiting((prev) => (prev.has(clientId) ? prev : new Set([...prev, clientId])));
    },
  });
  const { send, retry } = sendHelpers(post);
  // Rows keep the same callback (so a streaming reply doesn't re-render every message).
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const onRetry = useCallback((m: Message) => retryRef.current(m), []);
  const realtime = useRealtime().status;
  const outboxRef = useRef({ list, waiting });
  outboxRef.current = { list, waiting };
  const flushWaiting = useCallback(() => {
    const { list: shown, waiting: ids } = outboxRef.current;
    if (ids.size === 0) return;
    setWaiting(new Set());
    for (const m of shown) if (m.local === "failed" && m.clientId && ids.has(m.clientId)) retryRef.current(m);
  }, []);
  useEffect(() => {
    if (realtime === "open") flushWaiting();
  }, [realtime, flushWaiting]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") flushWaiting();
    });
    return () => sub.remove();
  }, [flushWaiting]);
  const control = useMissionControl(orgId);
  const createMission = useCreateMission(orgId);
  const channelAgents = (roster.data ?? []).filter((r) => r.type === "agent").map((r) => r.id);
  const soleAgent = dmAgentId ?? (channelAgents.length === 1 ? (channelAgents[0] ?? null) : null);

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
  const goToPin = (pin: MessagePin) => {
    sheet.close();
    const shown = rowsRef.current;
    const target = pinTarget(pin, new Set(shown.flatMap((r) => (r.kind === "message" ? [r.message.id] : []))));
    if (target.kind === "scroll") {
      const index = shown.findIndex((r) => r.kind === "message" && r.message.id === target.messageId);
      if (index >= 0) void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
      return;
    }
    if (target.threadId !== threadId) router.push(chatHref(channelId, target.threadId));
  };
  const openPins = () => sheet.open(<PinsSheet channelId={channelId} onPick={goToPin} />);

  // ── Header ──
  const info = thread.data;
  const title = isThread ? (info ? threadTitle(info) : "") : dm ? dm.with.name : channel ? `#${channel.name}` : "";
  const agentsHere = (roster.data ?? []).filter((r) => r.type === "agent").length;
  const subtitle = isThread
    ? info
      ? t(
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
        ? t("mobile.chat.members", { count: roster.data.length, agents: agentsHere })
        : undefined;
  const right = isThread ? (
    info ? (
      <IconButton
        icon="more"
        label={t("mobile.chat.options")}
        onPress={() =>
          sheet.open(
            <ThreadOptions
              thread={info}
              mission={mission}
              onMission={() => openNewMission("", info.id)}
              onPins={openPins}
            />,
          )
        }
      />
    ) : null
  ) : dm || channel ? (
    <View style={styles.side}>
      {dmAgentId ? (
        <Pressable
          onPress={() => router.push(`/agent/${dmAgentId}`)}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.chat.profile")}
          hitSlop={8}
        >
          {/* In the header's glass pill the agent stands on its own: a square tile fights the round glass. */}
          <AgentFace agentId={dmAgentId} size={28} framed={false} />
        </Pressable>
      ) : channel && roster.data ? (
        <View style={styles.faces} accessible accessibilityLabel={subtitle}>
          {roster.data.slice(0, 3).map((r, i) => (
            <View key={`${r.type}:${r.id}`} style={i > 0 ? styles.overlap : undefined}>
              <Face who={r} size={22} live={false} framed={false} />
            </View>
          ))}
        </View>
      ) : null}
      <IconButton
        icon="more"
        label={t("mobile.chat.options")}
        onPress={() =>
          sheet.open(
            <ChannelOptions
              channelId={channelId}
              title={title}
              {...(subtitle ? { subtitle } : {})}
              leading={
                dm ? <Face who={{ type: dm.with.type, id: dm.with.id }} size={36} live={false} /> : <Tile icon="hash" />
              }
              agentId={dmAgentId}
              onPins={openPins}
            />,
          )
        }
      />
    </View>
  ) : null;

  const placeholder = isThread
    ? t("mobile.chat.reply")
    : dm
      ? t("mobile.chat.messageTo", { name: dm.with.name })
      : t("mobile.chat.messageIn", { channel: channel ? `#${channel.name}` : "" });
  // What to say next comes from the latest card (MobileIntencional.html): a code change, a file; none
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
          // An agent took an issue made from this conversation: one quiet line, not a voice.
          if (issueTakenOf(item.message.meta)) return <IssueTakenLine message={item.message} />;
          return (
            // A finished reply replaces its streaming row in place: it doesn't rise in again.
            <Animated.View entering={isFresh(item.key) && !item.message.agentRunId ? ENTER : undefined}>
              <MessageRow
                message={item.message}
                grouped={item.grouped}
                meId={meId}
                thread={isThread ? undefined : linkThreads.get(item.message.id)}
                onLongPress={onLongPress}
                onRetry={onRetry}
                offline={Boolean(item.message.clientId && waiting.has(item.message.clientId))}
              />
              {item.message.id === seenId ? (
                <Animated.View entering={FadeIn.duration(200)}>
                  <Text variant="caption" tone="muted" style={styles.seen} accessibilityLiveRegion="polite">
                    {t("mobile.chat.seen")}
                  </Text>
                </Animated.View>
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
      waiting,
      seenId,
      t,
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
  const lift = Math.max(0, bottomPad - KEYBOARD_GAP);
  const showList = !loading && !(rows.length === 0 && runs.length === 0);

  // Whether the person is near the end (what the list follows): the "new messages" button shows otherwise.
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    // A new list opens at the end (initialScrollAtEnd); only changes count from here, so the button never
    // flashes on open.
    setAtEnd(true);
    return state.listen("isWithinMaintainScrollAtEndThreshold", setAtEnd);
  }, [showList]);

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={title} {...(subtitle ? { subtitle } : {})} right={right} />
      {pinned ? (
        <View style={[styles.pin, { backgroundColor: c.bg }]}>
          <MissionCardView mission={pinned} pinned />
        </View>
      ) : null}
      <KeyboardGestureArea
        style={styles.grow}
        interpolator="ios"
        textInputNativeID={COMPOSER_INPUT_ID}
        offset={Math.max(0, composerHeight - lift)}
      >
        {loading ? (
          <View style={[styles.center, { paddingBottom: composerHeight }]}>
            <Text tone="faint">{t("mobile.common.loading")}</Text>
          </View>
        ) : !showList ? (
          dmAgent && !isThread ? (
            <FirstDay agent={dmAgent} bottomInset={composerHeight} onAsk={onSend} />
          ) : (
            <View style={[styles.center, { paddingBottom: composerHeight }]}>
              <Text tone="faint" style={styles.emptyText}>
                {t("mobile.chat.empty")}
              </Text>
            </View>
          )
        ) : (
          <KeyboardAwareLegendList
            ref={listRef}
            style={styles.grow}
            data={shownRows}
            keyExtractor={rowKey}
            getItemType={rowType}
            renderItem={renderItem}
            estimatedItemSize={72}
            // Opens at the latest message, short conversations sit at the bottom like any chat.
            initialScrollAtEnd
            alignItemsAtEnd
            // New messages, a reply growing word by word and the working line keep the end in view, but
            // only while the person is near it.
            maintainScrollAtEnd
            maintainScrollAtEndThreshold={STICK_TO_END_THRESHOLD}
            // Older pages above and rows changing size keep what is on screen still.
            maintainVisibleContentPosition
            onStartReached={loadOlder}
            onStartReachedThreshold={0.5}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            keyboardOffset={lift}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            contentContainerStyle={styles.listPad}
          />
        )}
        <KeyboardStickyView
          offset={{ opened: lift }}
          style={[styles.jumpDock, { bottom: composerHeight + 10 }]}
          pointerEvents="box-none"
        >
          {showList && !atEnd ? (
            unseen.messages > 0 || unseen.working.length > 0 ? (
              <NewPill unseen={unseen} onPress={toUnseen} />
            ) : (
              <ToLatest onPress={toEnd} />
            )
          ) : null}
        </KeyboardStickyView>
        <KeyboardStickyView offset={{ opened: lift }} style={styles.composerDock}>
          <View
            ref={composerRef}
            onLayout={onComposerBoxLayout}
            style={[styles.composer, { paddingBottom: bottomPad, backgroundColor: c.bg }]}
          >
            <Connection status={realtime} />
            {/* Who is working, right above the composer (as on the web), while they work. */}
            {member ? (
              <WorkingLine
                runs={runs}
                consults={consults}
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
                inputNativeID={COMPOSER_INPUT_ID}
                {...(suggestions.length > 0 ? { suggestions } : {})}
                {...(dmAgentId && !isThread ? { face: <AgentFace agentId={dmAgentId} size={22} /> } : {})}
                mentionAt={mentionQuery}
                insertMention={insertMention}
                mention={({ query, pick }) => (
                  <MentionPicker query={query} pick={pick} channelId={channelId} members={mentionMembers} />
                )}
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
 * "↓ 2 novas · Marina e Ada · Theo escrevendo" (Mensagens.html): who spoke below, not just a count, with
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
 * The connection, above the composer (Mensagens.html): "Sem internet. O que você mandar sai sozinho quando
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
  // "Visto": right under my latest message, at the right edge (the receipts' side).
  seen: { alignSelf: "flex-end", marginTop: -4, marginBottom: 4, paddingHorizontal: 16 },
  // Under the agent's words, like a card on its message (MessageRow: 14 + 34 avatar + 11 gap).
  browserRow: { paddingLeft: 59, paddingRight: 16, paddingBottom: 6 },
  screen: { flex: 1 },
  grow: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { textAlign: "center" },
  pin: { paddingHorizontal: 12, paddingBottom: 10 },
  day: { alignSelf: "center", textAlign: "center", marginTop: 16, marginBottom: 6, fontWeight: "600" },
  listPad: { paddingTop: 8, paddingBottom: 8 },
  composer: { paddingHorizontal: 10, paddingTop: 6 },
  composerDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  jumpDock: { position: "absolute", left: 14, right: 14 },
  jumpEnd: { alignSelf: "flex-end" },
  jump: { width: 40, height: 40, borderRadius: 20 },
  jumpIcon: { flex: 1, alignItems: "center", justifyContent: "center" },
  // The "↓ novas" pill: centered, the "tato com canto" corner (Cards.html I).
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
  side: { flexDirection: "row", alignItems: "center", gap: 2 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
});
