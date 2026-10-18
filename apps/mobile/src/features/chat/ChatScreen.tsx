import {
  type ArtifactDetail,
  type DirectMessage,
  keys,
  type LiveRun,
  MESSAGES_PAGE,
  type Message,
  type MessagePin,
  sendHelpers,
  useApi,
  useChannels,
  useChannelThreads,
  useCreateMission,
  useDms,
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
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from "react-native";
import { KeyboardGestureArea, KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeInDown, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Composer, Count, Icon, IconButton, PressScale, Text, useTheme, useToast } from "@/ui";
import { isListedThread, threadTitle } from "../chats/logic";
import { chatHref } from "../links/logic";
import { MissionCardView } from "../missions/cards";
import { isOpenMission } from "../missions/logic";
import { RemindSheet } from "../reminders/RemindSheet";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { PushedHeader, Tile } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { StreamingRow, WorkingLine, writingRuns } from "./LiveRows";
import { useChatLive } from "./live";
import { buildRows, type ChatRow, mergeTimeline, parseSlash, pinTarget, threadRootsToLoad } from "./logic";
import { MessageRow } from "./MessageRow";
import { PinsSheet } from "./PinsSheet";
import {
  appendedKeys,
  type HeldRun,
  lastSeenKey,
  runsToShow,
  type ScrollRow,
  STICK_TO_END_THRESHOLD,
  unreadBelow,
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

type Row = ChatRow | { kind: "marker"; key: string; text: string } | { kind: "run"; key: string; run: LiveRun };

const rowKey = (r: Row) => r.key;
const rowType = (r: Row) => r.kind;
/** A row that just arrived at the bottom rises in (only while it is fresh: not when scrolled back into view). */
const ENTER = FadeInDown.duration(220);
const FRESH_MS = 800;
/** The composer's safe-area padding hides behind the open keyboard; this much stays between them. */
const KEYBOARD_GAP = 8;
const COMPOSER_INPUT_ID = "chat-composer";

/** A conversation: a channel, a DM, a thread or a mission's thread (`threadId`). */
export function ChatScreen({ channelId, threadId }: { channelId: string; threadId?: string | null }) {
  return (
    <SheetHostProvider>
      <Chat channelId={channelId} threadId={threadId ?? null} />
    </SheetHostProvider>
  );
}

function Chat({ channelId, threadId }: { channelId: string; threadId: string | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const api = useApi();
  const qc = useQueryClient();
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
  const member = dm ? true : (channel?.isMember ?? true);
  const roster = useRoster(orgId, channelId, Boolean(channel?.isMember) && !isThread);
  const join = useJoinChannel(orgId, channelId);

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

  // ── Streaming rows ──
  // A finished reply keeps its row (last words) until its saved message is listed: no empty frame between them.
  const heldRef = useRef(new Map<string, HeldRun<LiveRun>>());
  const shownRef = useRef<LiveRun[]>([]);
  const [holdTick, setHoldTick] = useState(0);
  const arrivedRuns = useMemo(() => new Set(list.flatMap((m) => (m.agentRunId ? [m.agentRunId] : []))), [list]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `holdTick` re-checks the held rows when one expires
  const runRows = useMemo(() => {
    const next = runsToShow(heldRef.current, shownRef.current, writingRuns(runs), arrivedRuns, Date.now());
    heldRef.current = next.held;
    shownRef.current = next.shown;
    return next;
  }, [runs, arrivedRuns, holdTick]);
  useEffect(() => {
    if (runRows.nextExpiry === null) return;
    const id = setTimeout(() => setHoldTick((n) => n + 1), Math.max(0, runRows.nextExpiry - Date.now()) + 16);
    return () => clearTimeout(id);
  }, [runRows]);
  const shownRuns = runRows.shown;

  // ── Rows ──
  const rows = useMemo<Row[]>(() => {
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
        ...buildRows(replies),
        ...shownRuns.map((run) => ({ kind: "run" as const, key: `run-${run.runId}`, run })),
      ];
    }
    const hidden = (m: Message) => Boolean(m.threadId && (linkThreads.has(m.threadId) || collapsed.has(m.threadId)));
    return [
      ...buildRows(list, hidden),
      ...shownRuns.map((run) => ({ kind: "run" as const, key: `run-${run.runId}`, run })),
    ];
  }, [isThread, threadId, list, thread.data, channel?.name, shownRuns, linkThreads, collapsed, t]);

  // ── Following the end ──
  // The list sticks to the end only while the person is near it (Legend List's maintainScrollAtEnd); farther
  // up nothing moves and a button counts what arrived below.
  const listRef = useRef<LegendListRef>(null);
  const scrollRows = useMemo<ScrollRow[]>(
    () =>
      rows.map((r) => ({
        key: r.key,
        kind: r.kind === "message" ? "message" : r.kind === "run" ? "run" : "other",
        mine: r.kind === "message" && r.message.author.type === "person" && r.message.author.id === meId,
      })),
    [rows, meId],
  );
  const [atEnd, setAtEnd] = useState(true);
  const [seenKey, setSeenKey] = useState<string | null>(null);
  const latestSeen = lastSeenKey(scrollRows);
  useEffect(() => {
    if (atEnd) setSeenKey(latestSeen);
  }, [atEnd, latestSeen]);
  const unread = atEnd ? 0 : unreadBelow(scrollRows, seenKey);
  const toEnd = useCallback(() => {
    requestAnimationFrame(() => void listRef.current?.scrollToEnd({ animated: true }));
  }, []);

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
    qc.setQueryData<DirectMessage[]>(keys.dms(orgId), (dmList) =>
      dmList?.map((d) => (d.channelId === channelId ? { ...d, unread: 0 } : d)),
    );
    markRead(channelId);
  }, [markRead, qc, orgId, channelId, member, lastId]);

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
  const post = usePostMessage(orgId, channelId, {
    me: { id: meId ?? "" },
    // An agent DM: "pensando…" at once, on the message the agent answers.
    onSent: (message) => {
      if (dmAgentId) live.expect(message.threadId ?? message.id, [dmAgentId]);
    },
    onFailed: () => toast({ title: t("mobile.chat.notSent"), icon: "x" }),
  });
  const { send, retry } = sendHelpers(post);
  // Rows keep the same callback (so a streaming reply doesn't re-render every message).
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const onRetry = useCallback((m: Message) => retryRef.current(m), []);
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

  const onSend = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const cmd = parseSlash(text);
    if (!cmd) {
      send(text, threadId);
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
          <AgentFace agentId={dmAgentId} size={28} />
        </Pressable>
      ) : channel && roster.data ? (
        <View style={styles.faces} accessible accessibilityLabel={subtitle}>
          {roster.data.slice(0, 3).map((r, i) => (
            <View key={`${r.type}:${r.id}`} style={i > 0 ? styles.overlap : undefined}>
              <Face who={r} size={22} live={false} />
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
      ? t("mobile.chat.writeTo", { name: dm.with.name })
      : t("mobile.chat.writeTo", { name: channel ? `#${channel.name}` : "" });
  const suggestions =
    !isThread && list.length < 6
      ? dmAgentId
        ? [
            { icon: "sparkle" as const, label: t("mobile.chat.suggest.doing") },
            { icon: "target" as const, label: t("mobile.chat.suggest.task") },
          ]
        : channel
          ? [
              { icon: "sparkle" as const, label: t("mobile.chat.suggest.summary") },
              { icon: "target" as const, label: t("mobile.chat.suggest.task") },
              { icon: "list" as const, label: t("mobile.chat.suggest.todo") },
            ]
          : []
      : [];
  rowsRef.current = rows;
  const pinned = mission && isOpenMission(mission) ? mission : null;
  const loading = isThread ? threadMessages.isLoading : top.isLoading;

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.kind) {
        case "day":
          return (
            <Text variant="caption" tone="faint" style={styles.day}>
              {when.day(item.iso)}
            </Text>
          );
        case "marker":
          return (
            <Text variant="caption" tone="faint" style={styles.day}>
              {item.text}
            </Text>
          );
        case "run":
          return (
            <Animated.View entering={isFresh(item.key) ? ENTER : undefined}>
              <StreamingRow run={item.run} />
            </Animated.View>
          );
        case "message":
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
              />
            </Animated.View>
          );
      }
    },
    [when, meId, isThread, linkThreads, onLongPress, onRetry, isFresh],
  );

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
          <View style={[styles.center, { paddingBottom: composerHeight }]}>
            <Text tone="faint" style={styles.emptyText}>
              {dmAgentId ? t("mobile.chat.emptyAgent", { name: dm?.with.name ?? "" }) : t("mobile.chat.empty")}
            </Text>
          </View>
        ) : (
          <KeyboardAwareLegendList
            ref={listRef}
            style={styles.grow}
            data={rows}
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
            ListFooterComponent={<WorkingLine runs={runs} consults={consults} />}
          />
        )}
        <KeyboardStickyView
          offset={{ opened: lift }}
          style={[styles.jumpDock, { bottom: composerHeight + 10 }]}
          pointerEvents="box-none"
        >
          {showList && !atEnd ? (
            <ToLatest
              unread={unread}
              onPress={() => {
                setAtEnd(true);
                void listRef.current?.scrollToEnd({ animated: true });
              }}
            />
          ) : null}
        </KeyboardStickyView>
        <KeyboardStickyView offset={{ opened: lift }} style={styles.composerDock}>
          <View
            ref={composerRef}
            onLayout={onComposerBoxLayout}
            style={[styles.composer, { paddingBottom: bottomPad, backgroundColor: c.bg }]}
          >
            {member ? (
              <Composer
                placeholder={placeholder}
                onSend={onSend}
                onPlus={() => sheet.open(<PlusActions onPick={(p) => void onPlus(p)} />)}
                inputNativeID={COMPOSER_INPUT_ID}
                {...(suggestions.length > 0 ? { suggestions } : {})}
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

/** Back to the latest messages: a round button over the list, with how many arrived below. */
function ToLatest({ unread, onPress }: { unread: number; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors, shadows } = useTheme();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
      <PressScale
        to={0.92}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={unread > 0 ? t("mobile.chat.newMessages", { count: unread }) : t("mobile.chat.toLatest")}
        style={[styles.jump, { backgroundColor: colors.raised, boxShadow: `${shadows.e2}, ${shadows.top}` }]}
      >
        <View style={styles.jumpIcon}>
          <Icon name="chev" size={20} color={colors.ink2} />
        </View>
        {unread > 0 ? (
          <View style={styles.jumpBadge} pointerEvents="none">
            <Count value={unread} size={11} inverted max={99} />
          </View>
        ) : null}
      </PressScale>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { textAlign: "center" },
  pin: { paddingHorizontal: 12, paddingBottom: 10 },
  day: { alignSelf: "center", textAlign: "center", marginTop: 10, marginBottom: 4, fontWeight: "600" },
  listPad: { paddingTop: 8, paddingBottom: 8 },
  composer: { paddingHorizontal: 10, paddingTop: 6 },
  composerDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  jumpDock: { position: "absolute", right: 14 },
  jump: { width: 40, height: 40, borderRadius: 20 },
  jumpIcon: { flex: 1, alignItems: "center", justifyContent: "center" },
  jumpBadge: { position: "absolute", top: -6, right: -6 },
  side: { flexDirection: "row", alignItems: "center", gap: 2 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
});
