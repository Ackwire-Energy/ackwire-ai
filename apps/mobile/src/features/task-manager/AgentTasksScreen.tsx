import type { ManagedTask } from "@agenteschat/client";
import {
  agentCardLine,
  helpersOf,
  hiddenCount,
  linePlace,
  taskProgram,
  taskSince,
  taskTitle,
  taskWhere,
} from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { Button, Count, EmptyState, Icon, PixelStop, Text, useReducedMotion, weights } from "@/ui";
import { useOpenQueue } from "../queue/QueueSheet";
import { AgentFace, OpensAgent } from "../shared/Face";
import { useColors, useDirectory, useNow, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { SheetHostProvider } from "../shared/SheetHost";
import { useAgentTasks, useStopper } from "./hooks";
import { type Place, rowState, taskStateWords, usingNow } from "./logic";
import { StopButton, StopConfirm, TaskMark, useAgentColor, WaitLines } from "./parts";

/**
 * An agent's tasks (ADR 0128), pushed from its DM's header the way a thread opens: three wells (Agora, Esperam você,
 * Feitas hoje), then its tasks (people's first, then its routines'),
 * the ones asked in that conversation tagged "aqui", each with its state, what it uses now and "Parar"; a task opens
 * its own screen. At the end, "Abrir no gerenciador" and "Parar todas", which asks first, in place. A task waiting for
 * room on its computer opens that computer's line in a sheet ("Ver fila"), as the conversation's bar opens it.
 */
export function AgentTasksScreen({ agentId, from }: { agentId: string; from: Place | null }) {
  return (
    <SheetHostProvider>
      <AgentTasks agentId={agentId} from={from} />
    </SheetHostProvider>
  );
}

function AgentTasks({ agentId, from }: { agentId: string; from: Place | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const now = useNow(10_000);
  const { stopping, stop } = useStopper();
  const { view, doneToday, query } = useAgentTasks(agentId, { here: from, stopping });
  const pull = usePullRefresh(query.refetch);
  const [asking, setAsking] = useState(false);
  // Tasks that start or end while the person watches fade, and the rest slide into place; nothing moves with reduced
  // motion.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  const name = dir.nameOf({ type: "agent", id: agentId }) || t("channel.unknownAgent");
  const count = view?.rows.length ?? 0;
  const hidden = hiddenCount(query.data?.hidden, agentId);
  const waiting = view?.waiting ?? 0;
  const stoppable = view?.stoppable ?? [];
  const helpers = helpersOf((view?.rows ?? []).map((r) => r.task).filter((task) => stoppable.includes(task.runId)));
  return (
    <PushedLargeTitle
      title={t("taskManager.agentTasks", { name })}
      right={
        <OpensAgent agentId={agentId}>
          <AgentFace agentId={agentId} size={28} mode={view && view.working > 0 ? "run" : "idle"} />
        </OpensAgent>
      }
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
        // Loaded, the list fades in over the spinner; the rows it starts with don't each fade again.
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            {/* The three numbers are said once, here (no line above repeating them). */}
            <View style={styles.wells}>
              <Well label={t("taskManager.agentPanel.wells.now")} value={count} />
              <Well label={t("taskManager.agentPanel.wells.waiting")} value={waiting} />
              <Well label={t("taskManager.agentPanel.wells.done")} value={doneToday} />
            </View>
            {view ? (
              <>
                <WaitLines tasks={view.rows.map((r) => r.task)} now={now} />
                {view.rows.map(({ task, here }, i) => (
                  <Animated.View key={task.runId} {...fade} layout={layout}>
                    <TaskRow
                      task={task}
                      here={here}
                      stopping={stopping}
                      now={now}
                      divider={i > 0}
                      onStop={() => stop([task.runId], undefined, Boolean(task.helpers))}
                    />
                  </Animated.View>
                ))}
              </>
            ) : (
              <Animated.View {...fade}>
                <EmptyState
                  size="panel"
                  agent={agentLook(dir.anyAgent(agentId))}
                  mood="deal"
                  title={hidden > 0 ? agentCardLine(t, 0, hidden) : t("taskManager.agentPanel.none", { name })}
                />
              </Animated.View>
            )}
            {asking && stoppable.length > 1 ? (
              <Animated.View key="confirm" {...fade} layout={layout} style={styles.confirm}>
                <StopConfirm
                  agentId={agentId}
                  count={stoppable.length}
                  helpers={helpers}
                  onCancel={() => setAsking(false)}
                  onStop={(reason) => {
                    setAsking(false);
                    stop(stoppable, reason, helpers > 0);
                  }}
                />
              </Animated.View>
            ) : (
              <Animated.View key="foot" {...fade} layout={layout} style={styles.foot}>
                <Pressable
                  onPress={() => router.push("/task-manager")}
                  accessibilityRole="button"
                  hitSlop={6}
                  style={({ pressed }) => [styles.manager, pressed && styles.pressed]}
                >
                  <Text variant="small" tone="muted" style={styles.semibold}>
                    {t("taskManager.actions.openManager")}
                  </Text>
                  <Icon name="right" size={15} color={c.muted} />
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
              </Animated.View>
            )}
          </LayoutAnimationConfig>
        </Animated.View>
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
 * One of the agent's tasks, on two lines: its mark (which says its state: the agent's orbit working, amber waiting on
 * a person, the clock in a line) on the title's first line, the title whole, and one quiet line under it: where
 * (this conversation, a channel, a routine), the program it uses and for how long; waiting for room, a plan or a
 * budget, that wait and what comes next, with "Ver fila" for a computer's line. "Parar" is the stop square at the
 * row's right, on the title's line. It opens the task's screen.
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
  const { t, i18n } = useTranslation();
  const c = useColors();
  const color = useAgentColor(task.agentId);
  const openQueue = useOpenQueue();
  const state = rowState(task, stopping);
  const words = taskStateWords(t, i18n.language, task, state, now);
  const title = taskTitle(t, task);
  const where = taskWhere(t, task);
  const place = here ? t("taskManager.where.here") : where === title ? null : where;
  const waits = state === "ok" || state === "answer";
  const program = usingNow(t, taskProgram(task), { locale: i18n.language })?.name ?? null;
  // Working, or waiting on a person (the mark says which): where, the program, how long. Held or in a line: that
  // wait and what comes next, then where. Stopping: only that.
  const sub =
    state === "working" || waits
      ? [place, program, formatDuration(t, now - taskSince(task))]
      : state === "stopping"
        ? [words.state]
        : [words.state, words.next, place];
  const line = sub.filter(Boolean).join(" · ");
  const label = [title, waits ? words.state : null, line].filter(Boolean).join(", ");
  // What comes next shows under it; waiting for room on its computer, "Ver fila" opens the computer's line.
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
        <Text variant="subhead" style={styles.medium}>
          {title}
        </Text>
        <Text variant="footnote" tone="faint">
          {line}
        </Text>
        {inLine ? (
          <Pressable
            onPress={() => openQueue(inLine.machineId)}
            accessibilityRole="button"
            hitSlop={12}
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
        <View style={styles.stop}>
          <StopButton label={t("taskManager.actions.stop")} stopping={state === "stopping"} onPress={onStop} compact />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Where a task's words start: after its mark (16 + 16 + 10). */
const TEXT_INSET = 42;

const styles = StyleSheet.create({
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
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
    borderBottomLeftRadius: 6,
  },
  // Everything on the title's first line (20 points): the mark (16) two points down, the stop square (32) six up.
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 12, paddingHorizontal: 16 },
  divider: { position: "absolute", top: 0, left: TEXT_INSET, right: 0, height: StyleSheet.hairlineWidth },
  mark: { paddingTop: 2 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  stop: { marginTop: -6 },
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
