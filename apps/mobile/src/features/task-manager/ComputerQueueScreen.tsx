import { type QueueTurn, useComputerQueue } from "@agenteschat/client";
import { formatDuration } from "@agenteschat/client/lib/work";
import { router, useIsFocused } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { ComputerIcon, useComputerKind } from "@/computer/ComputerPortrait";
import { Button, Chip, PixelOrbit, SectionHeader, Text, weights } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useStopper } from "./hooks";
import { turnSub, turnTitle } from "./logic";
import { StopButton, useAgentColor } from "./parts";

/**
 * A computer's line (ADR 0127), pushed from the task manager, a task or an agent's tasks: whether it has room or how
 * many wait for it, what runs there now, then who waits, in the order they start (people first), each saying what it
 * is for only to who sees its conversation. "Você vai primeiro" on your own request at the front; "Parar" for who may
 * stop a turn; a turn you see opens its task. Asked again while it's on screen.
 */
export function ComputerQueueScreen({ machineId }: { machineId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const focused = useIsFocused();
  const now = useNow(10_000);
  const kind = useComputerKind(orgId, machineId);
  const queue = useComputerQueue(orgId, focused ? machineId : null);
  const pull = usePullRefresh(queue.refetch);
  const { stopping, stop } = useStopper();
  const data = queue.data;
  const waiting = data?.line.length ?? 0;
  return (
    <PushedLargeTitle
      title={t("taskManager.queue.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {queue.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      ) : queue.isError && !data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.taskManager.loadFailed")}
          </Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void queue.refetch()} />
        </View>
      ) : data ? (
        <>
          <Text variant="subhead" tone="muted" style={styles.sub}>
            {t("taskManager.queue.sub", { name: data.computer.name })}
          </Text>
          <View style={[styles.well, { backgroundColor: c.sunken }]}>
            <ComputerIcon kind={kind} size={18} color={c.muted} />
            <Text variant="callout" style={styles.semibold}>
              {waiting > 0 ? t("taskManager.queue.full", { count: waiting }) : t("taskManager.queue.room")}
            </Text>
          </View>
          <SectionHeader title={t("taskManager.queue.working")} count={data.working.length} />
          {data.working.map((turn, i) => (
            <TurnRow key={turn.runId} turn={turn} where="working" divider={i > 0} now={now} />
          ))}
          <SectionHeader title={t("taskManager.queue.line")} count={waiting} />
          {waiting === 0 ? (
            <Text variant="footnote" tone="faint" style={styles.empty}>
              {t("taskManager.queue.empty")}
            </Text>
          ) : (
            data.line.map((turn, i) => (
              <TurnRow
                key={turn.runId}
                turn={turn}
                where="line"
                place={i + 1}
                first={turn.mine && turn.people}
                divider={i > 0}
                now={now}
                stopping={stopping.has(turn.runId)}
                onStop={() => stop([turn.runId])}
              />
            ))
          )}
          <Text variant="footnote" tone="faint" style={styles.note}>
            {t("taskManager.queue.note")}
          </Text>
        </>
      ) : null}
    </PushedLargeTitle>
  );
}

/**
 * A turn: its place in line (the agent's orbit while it runs), the agent, what it is for (or whose it is, when you
 * don't see its conversation), since when, and "Parar" in line for who may stop it. One you see opens its task.
 */
function TurnRow({
  turn,
  where,
  place = null,
  first = false,
  divider,
  now,
  stopping = false,
  onStop,
}: {
  turn: QueueTurn;
  where: "working" | "line";
  place?: number | null;
  first?: boolean;
  divider: boolean;
  now: number;
  stopping?: boolean;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const color = useAgentColor(turn.agentId);
  const agent = dir.nameOf({ type: "agent", id: turn.agentId }) || t("channel.unknownAgent");
  const title = turnTitle(t, turn, agent);
  const sub = turnSub(t, turn, where, turn.since ? formatDuration(t, now - Date.parse(turn.since)) : null);
  const at = place === null ? null : t("taskManager.queue.place", { position: place });
  const label = [at, title, first ? t("taskManager.queue.first") : null, sub].filter(Boolean).join(", ");
  const body: ReactNode = (
    <>
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <View style={styles.lead}>
        {at ? (
          <Text variant="footnote" tone="muted" style={[styles.semibold, styles.num]}>
            {at}
          </Text>
        ) : (
          <PixelOrbit color={color} size={12} />
        )}
      </View>
      <AgentFace agentId={turn.agentId} size={30} live={false} />
      <View style={styles.text}>
        <View style={styles.titleRow}>
          <Text variant="subhead" numberOfLines={1} style={[styles.medium, styles.shrink]}>
            {title}
          </Text>
          {first ? <Chip icon="person" label={t("taskManager.queue.first")} /> : null}
        </View>
        {sub ? (
          <Text variant="footnote" tone="muted" numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {where === "line" && turn.canStop && onStop ? (
        <StopButton label={t("taskManager.actions.stop")} stopping={stopping} onPress={onStop} />
      ) : null}
    </>
  );
  if (!turn.visible) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      onPress={() => router.push(`/task-manager/${turn.runId}`)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      {body}
    </Pressable>
  );
}

/** Where a turn's words start: after its place and the face (16 + 26 + 10 + 30 + 10). */
const TEXT_INSET = 92;

const styles = StyleSheet.create({
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  sub: { paddingHorizontal: 20, paddingBottom: 12 },
  // The app's "tato com canto": round, the bottom left corner small.
  well: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 4,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 16 },
  divider: { position: "absolute", top: 0, left: TEXT_INSET, right: 0, height: StyleSheet.hairlineWidth },
  lead: { width: 26, alignItems: "center" },
  text: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  shrink: { flexShrink: 1 },
  medium: { fontWeight: weights.medium },
  semibold: { fontWeight: weights.semibold },
  num: { fontVariant: ["tabular-nums"] },
  empty: { paddingHorizontal: 20, paddingVertical: 8 },
  note: { paddingHorizontal: 20, paddingTop: 20 },
});
