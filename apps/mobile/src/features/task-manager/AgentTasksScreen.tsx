import type { ManagedTask } from "@agenteschat/client";
import { linePlace, taskSince, taskTitle, taskWhere } from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Button, Chip, Count, Icon, PixelStop, Text, weights } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useAgentTasks, useStopper } from "./hooks";
import { computerQueueHref, type Place, rowState, taskStateText } from "./logic";
import { StopButton, StopConfirm, TaskMark, useAgentColor, UsingLine } from "./parts";

/**
 * An agent's tasks (ADR 0127), pushed from its DM's header the way a thread opens: how many it has now and how many
 * wait on you, three wells (Agora, Esperam você, Feitas hoje), then its tasks (people's first, then its routines'),
 * the ones asked in that conversation tagged "aqui", each with its state, what it uses now and "Parar"; a task opens
 * its own screen. At the end, "Abrir no gerenciador" and "Parar todas", which asks first, in place.
 */
export function AgentTasksScreen({ agentId, from }: { agentId: string; from: Place | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const now = useNow(10_000);
  const { stopping, stop } = useStopper();
  const { view, doneToday, query } = useAgentTasks(agentId, { here: from, stopping });
  const pull = usePullRefresh(query.refetch);
  const [asking, setAsking] = useState(false);
  const name = dir.nameOf({ type: "agent", id: agentId }) || t("channel.unknownAgent");
  const count = view?.rows.length ?? 0;
  const waiting = view?.waiting ?? 0;
  const stoppable = view?.stoppable ?? [];
  const waitingText = waiting > 0 ? t("taskManager.waiting", { count: waiting }) : null;
  const sub = [t("taskManager.agentPanel.now", { count }), waitingText].filter(Boolean).join(" · ");
  return (
    <PushedLargeTitle
      title={t("taskManager.agentTasks", { name })}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      ) : query.isError && !query.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.taskManager.loadFailed")}
          </Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void query.refetch()} />
        </View>
      ) : (
        <>
          <View style={styles.head}>
            <AgentFace agentId={agentId} size={28} mode={view && view.working > 0 ? "run" : "idle"} />
            <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.shrink}>
              {sub}
            </Text>
          </View>
          <View style={styles.wells}>
            <Well label={t("taskManager.agentPanel.wells.now")} value={count} />
            <Well label={t("taskManager.agentPanel.wells.waiting")} value={waiting} />
            <Well label={t("taskManager.agentPanel.wells.done")} value={doneToday} />
          </View>
          {view ? (
            view.rows.map(({ task, here }, i) => (
              <TaskRow
                key={task.runId}
                task={task}
                here={here}
                stopping={stopping}
                now={now}
                divider={i > 0}
                onStop={() => stop([task.runId])}
              />
            ))
          ) : (
            <Text variant="footnote" tone="faint" style={styles.free}>
              {t("taskManager.agentPanel.none", { name })}
            </Text>
          )}
          {asking && stoppable.length > 1 ? (
            <View style={styles.confirm}>
              <StopConfirm
                agentId={agentId}
                count={stoppable.length}
                onCancel={() => setAsking(false)}
                onStop={(reason) => {
                  setAsking(false);
                  stop(stoppable, reason);
                }}
              />
            </View>
          ) : (
            <View style={styles.foot}>
              <Pressable
                onPress={() => router.push("/task-manager")}
                accessibilityRole="button"
                hitSlop={6}
                style={({ pressed }) => [styles.manager, pressed && styles.pressed]}
              >
                <Text variant="small" tone="muted" style={styles.semibold}>
                  {t("taskManager.actions.openManager")}
                </Text>
                <Icon name="right" size={14} color={c.muted} />
              </Pressable>
              {stoppable.length > 1 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  label={t("taskManager.actions.stopAll")}
                  leading={(ink) => <PixelStop size={10} color={ink} moving={false} />}
                  onPress={() => setAsking(true)}
                />
              ) : null}
            </View>
          )}
        </>
      )}
    </PushedLargeTitle>
  );
}

/** One of the three numbers at the top: a small sunken well, the label over the count. */
function Well({ label, value }: { label: string; value: number }) {
  const c = useColors();
  return (
    <View style={[styles.well, { backgroundColor: c.sunken }]} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {label}
      </Text>
      <Count value={value} size={20} color={c.ink} />
    </View>
  );
}

/**
 * One of the agent's tasks: its mark, title ("aqui" for one asked in that conversation), a small line (what it waits
 * for, in amber, or where and for how long; its place when it waits for room on its computer, with "Ver fila"), what
 * it uses now, and "Parar". It opens the task's screen.
 */
function TaskRow({
  task,
  here,
  stopping,
  now,
  divider,
  onStop,
}: {
  task: ManagedTask;
  here: boolean;
  stopping: ReadonlySet<string>;
  now: number;
  divider: boolean;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const color = useAgentColor(task.agentId);
  const state = rowState(task, stopping);
  const title = taskTitle(t, task);
  const where = taskWhere(t, task);
  const place = where === title ? null : where;
  const waits = state === "ok" || state === "answer";
  const sub =
    state === "working"
      ? [place, formatDuration(t, now - taskSince(task))]
      : [taskStateText(t, task, state), state === "stopping" ? null : place];
  const line = sub.filter(Boolean).join(" · ");
  const label = [title, here ? t("taskManager.strip.here") : null, line].filter(Boolean).join(", ");
  // Waiting for room on its computer: its place is in the line above, and "Ver fila" opens the line.
  const inLine = state === "stopping" ? null : linePlace(task);
  return (
    <Pressable
      onPress={() => router.push(`/task-manager/${task.runId}`)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <View style={styles.mark}>
        <TaskMark state={state} color={color} />
      </View>
      <View style={styles.text}>
        <View style={styles.titleRow}>
          <Text variant="subhead" numberOfLines={2} style={[styles.medium, styles.shrink]}>
            {title}
          </Text>
          {here ? <Chip icon="chat" label={t("taskManager.strip.here")} /> : null}
        </View>
        <Text
          variant="footnote"
          numberOfLines={1}
          style={[waits && styles.semibold, { color: waits ? c.amber : c.muted }]}
        >
          {line}
        </Text>
        {state === "stopping" ? null : <UsingLine task={task} />}
        {inLine ? (
          <Pressable
            onPress={() => router.push(computerQueueHref(inLine.machineId))}
            accessibilityRole="button"
            hitSlop={6}
            style={({ pressed }) => [styles.see, pressed && styles.pressed]}
          >
            <Text variant="footnote" tone="muted" style={styles.semibold}>
              {t("taskManager.queue.see")}
            </Text>
            <Icon name="right" size={13} color={c.muted} />
          </Pressable>
        ) : null}
      </View>
      {task.canStop ? (
        <StopButton label={t("taskManager.actions.stop")} stopping={state === "stopping"} onPress={onStop} />
      ) : null}
    </Pressable>
  );
}

/** Where a task's words start: after its mark (16 + 16 + 10). */
const TEXT_INSET = 42;

const styles = StyleSheet.create({
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingBottom: 12 },
  wells: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  // The app's "tato com canto": round, the bottom left corner small.
  well: {
    flex: 1,
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 4,
  },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 11, paddingHorizontal: 16 },
  divider: { position: "absolute", top: 0, left: TEXT_INSET, right: 0, height: StyleSheet.hairlineWidth },
  mark: { paddingTop: 2 },
  text: { flex: 1, minWidth: 0, gap: 3 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  shrink: { flexShrink: 1 },
  medium: { fontWeight: weights.medium },
  semibold: { fontWeight: weights.semibold },
  free: { paddingHorizontal: 20, paddingVertical: 12 },
  confirm: { paddingHorizontal: 16, paddingTop: 16 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  manager: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 8, paddingHorizontal: 4 },
  pressed: { opacity: 0.6 },
  see: { flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", paddingVertical: 2 },
});
