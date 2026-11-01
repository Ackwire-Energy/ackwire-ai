import {
  ApiError,
  keys,
  type Message,
  type Mission,
  type MissionEligibleAgent,
  type ThreadInfo,
  useApi,
  useChannelCategories,
  useChannels,
  useCloseMission,
  useCreateMission,
  useEligibleAgents,
  useFollowThread,
  useMe,
  useMissionControl,
  usePinMessage,
  usePins,
  useReactions,
  useThreadInfo,
  useThreadMutation,
  useToggleReaction,
} from "@agenteschat/client";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { summaryParts } from "@agenteschat/client/lib/missions";
import { voiceOf } from "@agenteschat/client/lib/voice";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Button, CHROME_MAX_SCALE, Count, Icon, Text, useToast } from "@/ui";
import { useMovesChannel } from "../categories/CategoryScreens";
import { categoryHrefs } from "../categories/logic";
import { chatHref } from "../links/logic";
import { missionComputerText } from "../missions/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useEdition, useMeId, useNamesComputers, useOrgId } from "../shared/hooks";
import { genderOf, previewOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, copyText, successHaptic, Tile, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { cachePinned } from "./live";
import { QUICK_REACTIONS, reactionName, reactionPills } from "./logic";

// ── Long press on a message ──────────────────────────────────────────────────

export function MessageActions({
  message: m,
  canMission,
  inThread,
  thread,
  onMission,
  onRemind,
}: {
  message: Message;
  /** "Transformar em missão" is offered (a channel or a DM, not a mission thread). */
  canMission: boolean;
  /** The screen is the thread view (no "Responder em thread"). */
  inThread: boolean;
  thread: ThreadInfo | undefined;
  onMission: (goal: string, threadId: string) => void;
  /** "Lembrar disso": the screen opens the reminder sheet for this message. */
  onRemind: (m: Message) => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const surface = useSurface();
  const sheet = useSheet();
  const toast = useToast();
  const qc = useQueryClient();
  const cached = useReactions(orgId, m.id, false);
  const toggle = useToggleReaction(orgId, m.id);
  const pin = usePinMessage(orgId);
  const pinned = Boolean(m.pinned);
  const togglePin = () => {
    sheet.close();
    const next = !pinned;
    // The mark shows at once; the server's answer (or its event) confirms it.
    cachePinned(qc, orgId, m.channelId, m.id, next);
    pin.mutate(
      { channelId: m.channelId, messageId: m.id, pinned: next },
      {
        onSuccess: () => toast({ title: t(next ? "mobile.pins.pinned" : "mobile.pins.unpinned"), icon: "pin" }),
        onError: (e) => {
          cachePinned(qc, orgId, m.channelId, m.id, pinned);
          const full = e instanceof ApiError && e.code === "pins.limit";
          toast({ title: t(full ? "mobile.pins.full" : "mobile.app.failed"), icon: "x" });
        },
      },
    );
  };
  const pills = reactionPills(cached.data ?? m.reactions, meId);
  const agentName = m.author.type === "agent" ? dir.nameOf(m.author) : "";
  const rootId = m.threadId ?? m.id;
  // A voice message is its audio: no words to preview or copy here.
  const text = voiceOf(m.meta) ? "" : previewOf(m.body);
  const react = (emoji: string) => {
    tapHaptic();
    const reaction = reactionName(emoji);
    const mine = pills.find((p) => p.reaction === reaction)?.mine ?? false;
    toggle.mutate({ reaction, on: !mine });
    sheet.close();
  };
  return (
    <>
      <View style={[styles.preview, surface]}>
        <Face who={m.author} size={24} live={false} />
        <Text variant="small" tone="ink2" numberOfLines={3} style={styles.grow}>
          {text || previewOf(textOrMedia(t, m.body, m.meta)) || t("mobile.chat.approvalPreview")}
        </Text>
      </View>
      {m.local ? null : (
        <View style={[styles.emorow, surface]}>
          {QUICK_REACTIONS.map((e) => (
            <Pressable
              key={e}
              onPress={() => react(e)}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.chat.reactWith", { emoji: e })}
              style={({ pressed }) => [styles.emo, pressed && styles.emoPressed]}
            >
              <Text maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.emoText}>
                {e}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <ActionList
        items={[
          ...(!inThread && !m.local
            ? [
                {
                  key: "thread",
                  icon: "reply" as const,
                  label: thread ? t("mobile.chat.openThread") : t("mobile.chat.replyInThread"),
                  onPress: () => {
                    sheet.close();
                    router.push(chatHref(m.channelId, rootId));
                  },
                },
              ]
            : []),
          ...(canMission && !m.local
            ? [
                {
                  key: "mission",
                  icon: "target" as const,
                  label: t("mobile.chat.toMission"),
                  onPress: () => onMission(text, rootId),
                },
              ]
            : []),
          ...(text
            ? [
                {
                  key: "copy",
                  icon: "copy" as const,
                  label: t("mobile.chat.copy"),
                  onPress: () => {
                    sheet.close();
                    void copyText(m.body).then((ok) =>
                      toast(
                        ok
                          ? { title: t("mobile.chat.copied"), icon: "copy" }
                          : { title: t("mobile.app.failed"), icon: "x" },
                      ),
                    );
                  },
                },
              ]
            : []),
          ...(!m.local
            ? [
                {
                  key: "pin",
                  icon: "pin" as const,
                  label: pinned ? t("mobile.pins.unpin") : t("mobile.pins.pin"),
                  onPress: togglePin,
                },
                {
                  key: "remind",
                  icon: "clock" as const,
                  label: t("mobile.remind.aboutThis"),
                  onPress: () => onRemind(m),
                },
              ]
            : []),
          ...(m.author.type === "agent" && m.author.id
            ? [
                {
                  key: "agent",
                  leading: <AgentFace agentId={m.author.id} size={20} live={false} />,
                  label: t("mobile.chat.seeAgent", { name: agentName }),
                  onPress: () => {
                    sheet.close();
                    router.push(`/agent/${m.author.id}`);
                  },
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

// ── "+" in the composer ──────────────────────────────────────────────────────

export type PlusPick = "camera" | "photos" | "file" | "audio" | "mission" | "summary" | "remind";

export function PlusActions({ onPick }: { onPick: (pick: PlusPick) => void }) {
  const { t } = useTranslation();
  const surface = useSurface();
  const tiles: { key: PlusPick; icon: "camera" | "image" | "file" | "mic"; label: string }[] = [
    { key: "camera", icon: "camera", label: t("mobile.plus.camera") },
    { key: "photos", icon: "image", label: t("mobile.plus.photos") },
    { key: "file", icon: "file", label: t("mobile.plus.file") },
    { key: "audio", icon: "mic", label: t("mobile.plus.audio") },
  ];
  return (
    <>
      <View style={styles.tiles}>
        {tiles.map((x) => (
          <Pressable
            key={x.key}
            onPress={() => onPick(x.key)}
            accessibilityRole="button"
            accessibilityLabel={x.label}
            style={({ pressed }) => [styles.tileBtn, pressed && styles.emoPressed]}
          >
            <View style={[styles.bigTile, surface]}>
              <Icon name={x.icon} size={22} />
            </View>
            <Text variant="caption" tone="ink2" style={styles.bold}>
              {x.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <ActionList
        items={[
          {
            key: "mission",
            icon: "target",
            label: t("mobile.plus.mission"),
            hint: t("mobile.plus.missionHint"),
            code: "/mission",
            onPress: () => onPick("mission"),
          },
          {
            key: "summary",
            icon: "sparkle",
            label: t("mobile.plus.summary"),
            hint: t("mobile.plus.summaryHint"),
            code: "/summary",
            onPress: () => onPick("summary"),
          },
          {
            key: "remind",
            icon: "clock",
            label: t("mobile.plus.remind"),
            hint: t("mobile.plus.remindHint"),
            code: "/remind",
            onPress: () => onPick("remind"),
          },
        ]}
      />
    </>
  );
}

// ── ⋯ of a thread or a mission ───────────────────────────────────────────────

export function ThreadOptions({
  thread,
  mission,
  onMission,
  onPins,
}: {
  thread: ThreadInfo;
  mission: Mission | null;
  /** "Transformar em missão" (a plain thread). */
  onMission?: () => void;
  /** "Fixadas" of the conversation. */
  onPins?: () => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const sheet = useSheet();
  const qc = useQueryClient();
  const mutate = useThreadMutation(orgId);
  const follow = useFollowThread(orgId);
  // The sheet keeps the thread it opened with: "Seguir" reads the live view.
  const live = useThreadInfo(orgId, thread.id);
  const following = Boolean(live.data?.following ?? thread.following);
  const setFollowing = (next: boolean) => {
    const key = keys.threadInfo(orgId, thread.id);
    const put = (value: boolean) =>
      qc.setQueryData<ThreadInfo>(key, (cur) => (cur ? { ...cur, following: value } : cur));
    put(next);
    follow.mutate(
      { threadId: thread.id, following: next },
      {
        onError: () => {
          put(!next);
          fail();
        },
      },
    );
  };
  const control = useMissionControl(orgId);
  const close = useCloseMission(orgId);
  // A thread on a GIF or a sticker has no words of its own to title it (ADR 0091).
  const title = thread.title?.trim() || previewOf(thread.rootText) || t("mobile.chat.thread");
  const name = mission ? (dir.agentById.get(mission.agentId)?.name ?? "") : "";
  const g = genderOf(name);
  const fail = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const act = (action: "close" | "reopen" | "archive") =>
    mutate.mutate(
      { type: "action", thread, action },
      {
        onSuccess: () => {
          sheet.close();
          toast({
            title: t(`mobile.thread.done.${action}`),
            ...(action === "close" ? { subtitle: t("mobile.thread.done.closeSub") } : {}),
            icon: action === "archive" ? "archive" : "check",
          });
          if (action !== "reopen" && router.canGoBack()) router.back();
        },
        onError: fail,
      },
    );
  const open =
    mission &&
    (mission.status === "active" ||
      mission.status === "paused" ||
      mission.status === "proposed" ||
      mission.status === "awaiting_close");
  return (
    <>
      <SheetTitle
        leading={<Tile icon={mission ? "target" : "reply"} />}
        title={title}
        subtitle={
          mission
            ? t("mobile.thread.missionIn", { channel: thread.channelName })
            : t("mobile.thread.threadIn", { channel: thread.channelName })
        }
      />
      <ActionList
        items={[
          {
            key: "follow",
            icon: "bell" as const,
            label: t("mobile.thread.follow"),
            hint: t("mobile.thread.followHint"),
            checked: following,
            onPress: () => setFollowing(!following),
          },
          ...(onPins ? [{ key: "pins", icon: "pin" as const, label: t("mobile.pins.title"), onPress: onPins }] : []),
          ...(mission
            ? [
                {
                  key: "plan",
                  icon: "list" as const,
                  label: t("mobile.thread.seePlan"),
                  onPress: () => {
                    sheet.close();
                    router.push(`/mission/${mission.id}`);
                  },
                },
                ...(mission.canAct && mission.status === "active"
                  ? [
                      {
                        key: "pause",
                        icon: "pause" as const,
                        label: t("mobile.thread.pause"),
                        hint: t(`mobile.thread.pauseHint${g}`, { name }),
                        onPress: () =>
                          control.mutate(
                            { missionId: mission.id, action: "pause" },
                            {
                              onSuccess: () => {
                                sheet.close();
                                toast({ title: t("mobile.thread.done.paused"), agentId: mission.agentId });
                              },
                              onError: fail,
                            },
                          ),
                      },
                    ]
                  : []),
                ...(mission.canAct && mission.status === "paused"
                  ? [
                      {
                        key: "resume",
                        icon: "sparkle" as const,
                        label: t("mobile.thread.resume"),
                        onPress: () =>
                          control.mutate(
                            { missionId: mission.id, action: "resume" },
                            {
                              onSuccess: () => {
                                sheet.close();
                                toast({ title: t("mobile.thread.done.resumed"), agentId: mission.agentId });
                              },
                              onError: fail,
                            },
                          ),
                      },
                    ]
                  : []),
              ]
            : onMission
              ? [
                  {
                    key: "mission",
                    icon: "target" as const,
                    label: t("mobile.chat.toMission"),
                    hint: t("mobile.thread.toMissionHint"),
                    onPress: onMission,
                  },
                ]
              : []),
        ]}
      />
      <ActionList
        items={[
          ...(mission
            ? mission.canManage && open
              ? [
                  {
                    key: "done",
                    icon: "check" as const,
                    label: t("mobile.thread.conclude"),
                    hint: t("mobile.thread.concludeHint"),
                    onPress: () =>
                      close.mutate(
                        { missionId: mission.id, outcome: "done", saveToWiki: true },
                        {
                          onSuccess: () => {
                            sheet.close();
                            successHaptic();
                            toast({ title: t("mobile.thread.done.concluded"), agentId: mission.agentId });
                          },
                          onError: fail,
                        },
                      ),
                  },
                ]
              : []
            : thread.canManage
              ? [
                  thread.state === "closed"
                    ? {
                        key: "reopen",
                        icon: "reply" as const,
                        label: t("mobile.thread.reopen"),
                        onPress: () => act("reopen"),
                      }
                    : {
                        key: "close",
                        icon: "check" as const,
                        label: t("mobile.thread.close"),
                        hint: t("mobile.thread.closeHint"),
                        onPress: () => act("close"),
                      },
                ]
              : []),
          ...(thread.canManage
            ? [
                {
                  key: "archive",
                  icon: "archive" as const,
                  label: t("mobile.thread.archive"),
                  hint: t("mobile.thread.archiveHint"),
                  onPress: () => act("archive"),
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

// ── ⋯ of a channel or a DM ───────────────────────────────────────────────────

export function ChannelOptions({
  channelId,
  title,
  subtitle,
  leading,
  agentId,
  about,
  onPins,
  onMembers,
}: {
  channelId: string;
  title: string;
  subtitle?: string;
  leading: ReactNode;
  /** An agent's DM: "Perfil". */
  agentId?: string | null;
  /** Under the title: a person's status in a DM with them (ADR 0084). */
  about?: ReactNode;
  onPins: () => void;
  /** A channel: who is in it (and, for admins, adding and removing). */
  onMembers?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const pins = usePins(orgId, channelId);
  const count = pins.data?.length ?? 0;
  // A channel's sidebar category (ADR 0080), for whoever may move it.
  const moves = useMovesChannel(channelId);
  const channel = useChannels(orgId).data?.find((c) => c.id === channelId);
  const categories = useChannelCategories(orgId);
  const categoryName = channel?.categoryId
    ? categories.data?.find((c) => c.id === channel.categoryId)?.name
    : undefined;
  return (
    <>
      <SheetTitle leading={leading} title={title} {...(subtitle ? { subtitle } : {})} />
      {about}
      <ActionList
        items={[
          ...(onMembers
            ? [{ key: "members", icon: "members" as const, label: t("shell.members"), onPress: onMembers }]
            : []),
          {
            key: "pins",
            icon: "pin",
            label: t("mobile.pins.title"),
            ...(pins.isSuccess && count === 0 ? { hint: t("mobile.pins.none") } : {}),
            ...(count > 0 ? { trailing: <Count value={count} max={99} /> } : {}),
            onPress: onPins,
          },
          ...(onMembers && moves
            ? [
                {
                  key: "category",
                  icon: "list" as const,
                  label: t("channelCategories.category"),
                  hint: categoryName ?? t("channelCategories.noCategory"),
                  onPress: () => {
                    sheet.close();
                    router.push(categoryHrefs.pick(channelId));
                  },
                },
              ]
            : []),
          ...(agentId
            ? [
                {
                  key: "profile",
                  leading: <AgentFace agentId={agentId} size={20} live={false} />,
                  label: t("mobile.chat.profile"),
                  onPress: () => {
                    sheet.close();
                    router.push(`/agent/${agentId}`);
                  },
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

// ── Nova missão ──────────────────────────────────────────────────────────────

/**
 * "Começar uma missão" / "Transformar em missão": the goal, who does it (the
 * agents that can run one for you) and where; the agent makes a plan and
 * waits for "Começar".
 */
export function NewMissionForm({
  goal: initialGoal = "",
  channelId,
  threadId,
  preferredAgentId,
  currentThreadId,
}: {
  goal?: string;
  channelId: string;
  /** The thread that becomes its home (else a new thread in the channel). */
  threadId?: string | null;
  preferredAgentId?: string | null;
  /** The thread on screen: no navigation when the mission lives there. */
  currentThreadId?: string | null;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const eligible = useEligibleAgents(orgId);
  // On the Cloud missions wait for the workspace's own computer: nobody connects one.
  const waitCloud = useCloudMissionWait();
  const cloud = useEdition() === "cloud";
  const names = useNamesComputers();
  const create = useCreateMission(orgId);
  const [goal, setGoal] = useState(initialGoal);
  const [picked, setPicked] = useState<string | null>(null);
  const list = eligible.data ?? [];
  const usable = list.filter((a) => a.eligible !== false);
  const agentId =
    picked ??
    (preferredAgentId && usable.some((a) => a.agentId === preferredAgentId) ? preferredAgentId : null) ??
    usable[0]?.agentId ??
    null;
  const agent = list.find((a) => a.agentId === agentId);
  const submit = () => {
    if (!agentId || !goal.trim() || create.isPending) return;
    create.mutate(
      { agentId, goal: goal.trim(), ...(threadId ? { threadId } : { channelId }) },
      {
        onSuccess: (mission) => {
          sheet.close();
          successHaptic();
          toast({ title: t("mobile.newMission.created", { name: agent?.name ?? "" }), agentId: mission.agentId });
          if (mission.threadId !== currentThreadId) router.push(chatHref(mission.channelId, mission.threadId));
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  };
  return (
    <>
      <SheetTitle leading={<Tile icon="target" />} title={t("mobile.newMission.title")} />
      <Text variant="body" tone="muted">
        {t("mobile.newMission.intro")}
      </Text>
      <TextArea
        value={goal}
        onChangeText={setGoal}
        placeholder={t("mobile.newMission.placeholder")}
        accessibilityLabel={t("mobile.newMission.placeholder")}
        autoFocus={!initialGoal}
      />
      {eligible.isLoading ? <ActivityIndicator color={c.muted} /> : null}
      {list.length > 0 ? (
        <ActionList
          items={[
            ...list.map((a) => ({
              key: a.agentId,
              leading: <AgentFace agentId={a.agentId} size={26} live={false} />,
              label: a.name,
              hint: (waitCloud && !a.machine ? waitCloud : whereText(t, a, { cloud, names })) ?? undefined,
              disabled: a.eligible === false,
              trailing: a.agentId === agentId ? <Icon name="check" size={18} color={c.ink} /> : undefined,
              onPress: a.eligible === false ? undefined : () => setPicked(a.agentId),
            })),
          ]}
        />
      ) : eligible.isSuccess ? (
        <Text variant="small" tone="muted">
          {waitCloud ?? t("mobile.newMission.noAgents")}
        </Text>
      ) : null}
      <Button
        variant="primary"
        wide
        icon="sparkle"
        label={t("mobile.newMission.submit")}
        disabled={!agentId || !goal.trim() || create.isPending}
        onPress={submit}
      />
    </>
  );
}

/** "As missões começam quando o Computador da Acme ficar pronto." on the Cloud; null elsewhere. */
function useCloudMissionWait() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const org = useMe().data?.organizations.find((o) => o.id === orgId);
  if (useEdition() !== "cloud") return null;
  return t("missions.waitingCloud", { computer: t("computerSetup.title", { org: org?.name ?? "" }) });
}

/**
 * "MacBook do Walter · ligado" (`missionComputerText`: by name only where the workspace has more than one), or why
 * it can't do a mission for you; the Cloud's computer is never off.
 */
function whereText(t: TFunction, a: MissionEligibleAgent, where: { cloud: boolean; names: boolean }) {
  if (a.eligible === false && a.reason) return t(`mobile.newMission.reason.${a.reason}`);
  if (!a.machine) return t("mobile.newMission.reason.no_computer");
  return missionComputerText(t, a.machine, where);
}

// ── /summary of a mission ────────────────────────────────────────────────────

/** Where the mission stands (only for me), in the web card's lines: the server's `text` is English. */
export function MissionSummaryView({ missionId }: { missionId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const c = useColors();
  const summary = useQuery({
    queryKey: keys.missionPart(orgId, missionId, "summary"),
    queryFn: () => api.missions.summary(orgId, missionId),
    staleTime: 0,
  });
  return (
    <>
      <SheetTitle leading={<Tile icon="sparkle" />} title={t("mobile.plus.summary")} />
      {summary.isError ? (
        <Text tone="muted">{t("mobile.app.failed")}</Text>
      ) : !summary.data ? (
        <ActivityIndicator color={c.muted} />
      ) : (
        <Text variant="body" tone="ink2">
          {summaryParts(summary.data)
            .map((p) => t(`missions.summary.${p.key}`, { count: p.count, total: p.total ?? 0 }))
            .join("\n")}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  bold: { fontWeight: "600" },
  preview: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 18 },
  emorow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  emo: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  emoPressed: { transform: [{ scale: 1.15 }] },
  emoText: { fontSize: 26, lineHeight: 34 },
  tiles: { flexDirection: "row", justifyContent: "space-between" },
  tileBtn: { flex: 1, alignItems: "center", gap: 7, paddingVertical: 6 },
  bigTile: { width: 54, height: 54, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
