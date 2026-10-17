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
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Composer, fonts, IconButton, Text, useToast } from "@/ui";
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
  ChannelOptions,
  MessageActions,
  MissionSummaryView,
  NewMissionForm,
  PlusActions,
  type PlusPick,
  ThreadOptions,
} from "./sheets";

type Row = ChatRow | { kind: "marker"; key: string; text: string } | { kind: "run"; key: string; run: LiveRun };

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
        ...writingRuns(runs).map((run) => ({ kind: "run" as const, key: `run-${run.runId}`, run })),
      ];
    }
    const hidden = (m: Message) => Boolean(m.threadId && (linkThreads.has(m.threadId) || collapsed.has(m.threadId)));
    return [
      ...buildRows(list, hidden),
      ...writingRuns(runs).map((run) => ({ kind: "run" as const, key: `run-${run.runId}`, run })),
    ];
  }, [isThread, threadId, list, thread.data, channel?.name, runs, linkThreads, collapsed, t]);

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
  const listRef = useRef<FlashListRef<Row>>(null);
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
          return <StreamingRow run={item.run} />;
        case "message":
          return (
            <MessageRow
              message={item.message}
              grouped={item.grouped}
              meId={meId}
              thread={isThread ? undefined : linkThreads.get(item.message.id)}
              onLongPress={onLongPress}
              onRetry={onRetry}
            />
          );
      }
    },
    [when, meId, isThread, linkThreads, onLongPress, onRetry],
  );

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={title} {...(subtitle ? { subtitle } : {})} right={right} />
      {pinned ? (
        <View style={[styles.pin, { backgroundColor: c.bg }]}>
          <MissionCardView mission={pinned} pinned />
        </View>
      ) : null}
      <KeyboardAvoidingView style={styles.grow} behavior="padding">
        {loading ? (
          <View style={styles.center}>
            <Text tone="faint">{t("mobile.common.loading")}</Text>
          </View>
        ) : rows.length === 0 && runs.length === 0 ? (
          <View style={styles.center}>
            <Text tone="faint" style={styles.emptyText}>
              {dmAgentId ? t("mobile.chat.emptyAgent", { name: dm?.with.name ?? "" }) : t("mobile.chat.empty")}
            </Text>
          </View>
        ) : (
          <FlashList
            ref={listRef}
            data={rows}
            keyExtractor={(r) => r.key}
            getItemType={(r) => r.kind}
            renderItem={renderItem}
            maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}
            onStartReached={loadOlder}
            onStartReachedThreshold={0.5}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.listPad}
            ListFooterComponent={<WorkingLine runs={runs} consults={consults} />}
          />
        )}
        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          {member ? (
            <Composer
              placeholder={placeholder}
              onSend={onSend}
              onPlus={() => sheet.open(<PlusActions onPick={(p) => void onPlus(p)} />)}
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
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { textAlign: "center" },
  pin: { paddingHorizontal: 12, paddingBottom: 10 },
  day: { alignSelf: "center", textAlign: "center", marginTop: 10, marginBottom: 4, fontFamily: fonts.semibold },
  listPad: { paddingTop: 8, paddingBottom: 8 },
  composer: { paddingHorizontal: 10, paddingTop: 6 },
  side: { flexDirection: "row", alignItems: "center", gap: 2 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
});
