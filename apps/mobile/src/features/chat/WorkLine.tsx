import { type Issue, type Message, useApi, useChannels, type WorkView } from "@agenteschat/client";
import { blockedText, workLine, workPlanProgress } from "@agenteschat/client/lib/long-work";
import { can } from "@agenteschat/client/lib/permissions";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Icon, PixelOrbit, Text, useToast } from "@/ui";
import { chatHref } from "../links/logic";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";

/** The conversation's list scrolls to one of its messages (false: it doesn't show it). */
export const JumpToMessageContext = createContext<((messageId: string) => boolean) | null>(null);

/** Redraws a live work's minutes every half minute. */
function useNow(live: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

/** The phone's long-work line (ADR 0121), as the web's WorkLine: how it stands, its last update and its actions. */
function useLine(work: WorkView) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const manage = can(useOrg().org, "manage_agents");
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const live = work.status === "live" || work.status === "queued";
  const now = useNow(live);
  const agent = dir.agentById.get(work.agentId);
  // As `mayStopRun` decides (who asked, the agent's owner, an admin); the server has the last word, said in a toast.
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(orgId, runId),
    onError: () => toast({ title: t("work.stopFailed"), icon: "info" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", work.channelId] }),
  });
  const view = workLine(t, work, {
    locale: i18n.language || "pt-BR",
    now,
    meId,
    agentName: agent?.name ?? "",
    nameOf: (id) => dir.memberById.get(id)?.name ?? null,
    canStop: manage || agent?.ownerUserId === meId || work.requestedByUserId === meId,
  });
  return { view, stop, t };
}

/** The work's thread, where its updates are. */
const threadHref = (work: WorkView) => chatHref(work.channelId, work.threadId ?? work.anchorMessageId);

function Line({ work, onThread, extra }: { work: WorkView; onThread?: () => void; extra?: ReactNode }) {
  const c = useColors();
  const { view, stop, t } = useLine(work);
  const jump = useContext(JumpToMessageContext);
  const mark =
    view.tone === "done" ? c.ok : view.tone === "failed" ? c.danger : view.tone === "stopped" ? c.muted : c.warn;
  // Ver resultado: the report where it was asked, scrolled to when this conversation shows it.
  const seeResult = (messageId: string) => {
    if (!jump?.(messageId)) router.push(chatHref(work.channelId, work.homeThreadId));
  };
  return (
    <View style={[styles.line, { backgroundColor: c.plateSoft, borderColor: c.line }]} accessibilityRole="summary">
      <View style={styles.mark}>
        {view.tone === "working" ? (
          <PixelOrbit color="sky" size={12} />
        ) : (
          <View style={[styles.dot, { backgroundColor: mark }]} />
        )}
      </View>
      <View style={styles.body}>
        <Text variant="small" tone="ink2">
          {view.text}
        </Text>
        {view.update ? (
          <Text variant="small" tone="muted">
            {view.update}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {onThread && view.threadId ? <Action label={t("work.openThread")} onPress={onThread} /> : null}
          {view.task ? (
            <Action label={view.task.label} onPress={() => router.push(`/issues/${view.task?.number}`)} />
          ) : null}
          {view.result ? (
            <Action label={view.result.label} onPress={() => seeResult(view.result?.messageId as string)} />
          ) : null}
          {view.stop ? (
            <Action
              label={t("work.stop")}
              danger
              disabled={stop.isPending}
              onPress={() => stop.mutate(view.stop?.runId as string)}
            />
          ) : null}
          {extra}
        </View>
      </View>
    </View>
  );
}

function Action({
  label,
  onPress,
  danger,
  disabled,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      hitSlop={8}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Text variant="small" style={[styles.action, { color: disabled ? c.faint : danger ? c.danger : c.agent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Under the agent's "Vou cuidar disso": the work's line. Abrir thread only where nothing else opens it: not under a
 * root whose thread link shows (`threaded`), nor inside that thread.
 */
export function MessageWorkLine({ message, threaded }: { message: Message; threaded?: boolean }) {
  const { thread } = useLocalSearchParams<{ thread?: string }>();
  const work = message.longWork;
  if (!work) return null;
  const inside = thread === (work.threadId ?? work.anchorMessageId);
  return <Line work={work} onThread={threaded || inside ? undefined : () => router.push(threadHref(work))} />;
}

/** On a task's screen: the work's line and the agent's plan. */
export function IssueWorkLine({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const work = issue.backgroundWork;
  const blocked = blockedText(t, issue.blocked);
  if (!work && !blocked) return null;
  const progress = work ? workPlanProgress(work) : null;
  return (
    <View style={styles.block}>
      {blocked ? (
        <Text variant="small" style={[styles.blocked, { backgroundColor: c.warnSoft, color: c.warn }]}>
          {blocked}
        </Text>
      ) : null}
      {work ? (
        <Line
          work={work}
          onThread={() => router.push(threadHref(work))}
          extra={<ShareAction issue={issue} work={work} />}
        />
      ) : null}
      {work && progress ? (
        <View style={styles.plan}>
          <Text variant="caption" tone="faint" style={styles.bold}>
            {t("work.plan")} · {t("work.planProgress", progress)}
          </Text>
          {work.plan.map((p) => (
            <View key={p.id} style={styles.step}>
              <Icon
                name={p.state === "done" ? "check" : p.state === "doing" ? "bolt" : "circle"}
                size={13}
                color={p.state === "done" ? c.ok : p.state === "doing" ? c.agent : c.faint}
              />
              <Text variant="small" tone={p.state === "todo" ? "muted" : "ink2"} style={styles.grow}>
                {p.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Mostrar para todos: a card a DM or a private channel holds back, for who may show it to the whole workspace (who
 * asked for the work, its creator, an admin).
 */
function ShareAction({ issue, work }: { issue: Issue; work: WorkView }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const admin = can(useOrg().org, "manage_agents");
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useChannels(orgId);
  const share = useMutation({
    mutationFn: () => api.issues.share(orgId, issue.id),
    onSuccess: () => {
      toast({ title: t("work.shared"), icon: "check" });
      void qc.invalidateQueries({ queryKey: ["org", orgId, "issues"] });
    },
    onError: () => toast({ title: t("work.shareFailed"), icon: "info" }),
  });
  const channel = issue.channelId ? channels.data?.find((c) => c.id === issue.channelId) : undefined;
  const heldBack = Boolean(issue.channelId && channels.data && (!channel || channel.visibility === "private"));
  const mayShare =
    work.requestedByUserId === meId || (issue.createdBy.type === "person" && issue.createdBy.id === meId) || admin;
  if (!heldBack || !mayShare) return null;
  return <Action label={t("work.shareEveryone")} disabled={share.isPending} onPress={() => share.mutate()} />;
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  mark: { width: 16, paddingTop: 3, alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: { flex: 1, minWidth: 0, gap: 3 },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4, marginTop: 2 },
  action: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
  block: { gap: 10 },
  blocked: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
    fontWeight: "600",
  },
  plan: { gap: 6 },
  step: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
