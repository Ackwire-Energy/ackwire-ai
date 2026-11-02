import type { ManagedTask } from "@agenteschat/client";
import { taskSince, taskTitle, taskWhere } from "@agenteschat/client/lib/task-manager";
import { splitAtNames } from "@agenteschat/client/lib/text";
import { formatDuration } from "@agenteschat/client/lib/work";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Chip, CHROME_MAX_SCALE, haptics, Icon, PixelOrbit, PixelStop, Text, useReducedMotion, useTheme } from "@/ui";
import { useDirectory, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useStopper, useTasksToday } from "./hooks";
import { rowState, stateText, type Strip, stripOf } from "./logic";
import { StopButton, StopConfirm, TaskMark, UsingLine } from "./parts";

/** While an agent's DM is open, its tasks elsewhere are asked again this often (its own work here comes live). */
const STRIP_POLL_MS = 5_000;

/**
 * The agent's tasks for the strip over its DM's composer (ADR 0125), and the stop it uses; `strip` is null while the
 * agent works only in this conversation, or not at all.
 */
export function useTaskStrip(agentId: string | null, channelId: string, threadId: string | null) {
  const tasks = useTasksToday({ enabled: agentId !== null, pollMs: STRIP_POLL_MS });
  const { stopping, stop } = useStopper();
  const list = tasks.data?.tasks;
  const strip = useMemo(
    () => (agentId && list ? stripOf(list, agentId, { channelId, threadId }, stopping) : null),
    [agentId, list, channelId, threadId, stopping],
  );
  return { strip, stopping, stop };
}

/**
 * The strip over an agent's DM composer (ADR 0125), in the working line's place while the agent has work elsewhere:
 * "Dev em 3 tarefas · 1 espera você", "Ver" (or "Fechar") and "Parar esta" for the task asked here. Open, it lists the
 * agent's tasks above (the one here tagged "aqui"), each with "Parar", and "Parar todas" turns the strip itself into a
 * short confirmation with an optional reason; nothing floats over the conversation.
 */
export function TaskStrip({
  agentId,
  strip,
  stopping,
  onStop,
}: {
  agentId: string;
  strip: Strip;
  stopping: ReadonlySet<string>;
  onStop: (runIds: readonly string[], reason?: string) => void;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const reduced = useReducedMotion();
  const dir = useDirectory();
  const now = useNow(10_000);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const name = dir.nameOf({ type: "agent", id: agentId }) || t("channel.unknownAgent");
  const color = agentLook(dir.anyAgent(agentId)).color;
  const tasksText = t("taskManager.strip.tasks", { name, count: strip.rows.length });
  const waitingText = strip.waiting > 0 ? t("taskManager.strip.waiting", { count: strip.waiting }) : null;
  const several = strip.stoppable.length > 1;
  return (
    <View style={styles.dock}>
      <Animated.View
        entering={reduced ? undefined : FadeIn.duration(160)}
        style={[styles.card, { backgroundColor: c.glassSolid, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
      >
        {open ? (
          <View style={[styles.rows, { borderBottomColor: c.line }]}>
            {strip.rows.map(({ task, here }) => (
              <StripRow
                key={task.runId}
                task={task}
                here={here}
                stopping={stopping}
                now={now}
                onStop={() => onStop([task.runId])}
              />
            ))}
          </View>
        ) : null}
        {asking ? (
          <View style={styles.confirm}>
            <StopConfirm
              agentId={agentId}
              count={strip.stoppable.length}
              onCancel={() => setAsking(false)}
              onStop={(reason) => {
                setAsking(false);
                onStop(strip.stoppable, reason);
              }}
            />
          </View>
        ) : (
          <View style={styles.bar}>
            {strip.working && !open ? (
              <Dither kind="sweep" tones={softTones(color, c.raised)} pixel={3} style={StyleSheet.absoluteFill} />
            ) : null}
            {strip.working ? <PixelOrbit color={color} size={14} /> : <Icon name="wait" size={14} color={c.amber} />}
            <Text
              variant="caption"
              tone="muted"
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_MAX_SCALE}
              accessibilityRole="summary"
              accessibilityLabel={[tasksText, waitingText].filter(Boolean).join(", ")}
              style={styles.words}
            >
              {splitAtNames(tasksText, [name]).map((p, i) =>
                typeof p === "number" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
                  <RNText key={i} style={[styles.ink, { color: c.ink }]}>
                    {name}
                  </RNText>
                ) : (
                  p
                ),
              )}
              {waitingText ? <RNText style={[styles.ink, { color: c.amber }]}>{` · ${waitingText}`}</RNText> : null}
            </Text>
            <BarAction
              label={open ? t("taskManager.strip.hide") : t("taskManager.strip.see")}
              expanded={open}
              onPress={() => setOpen((o) => !o)}
              chevron={open ? "down" : "up"}
            />
            {open && several ? (
              <BarAction label={t("taskManager.actions.stopAll")} stop onPress={() => setAsking(true)} />
            ) : strip.stopHere ? (
              <BarAction
                label={t("taskManager.strip.stopHere")}
                stop
                onPress={() => {
                  if (strip.stopHere) onStop([strip.stopHere.runId]);
                }}
              />
            ) : strip.stoppingHere ? (
              <View style={styles.stopping} accessible accessibilityLabel={t("taskManager.state.stopping")}>
                <ActivityIndicator size="small" color={c.muted} />
              </View>
            ) : null}
          </View>
        )}
      </Animated.View>
    </View>
  );
}

/** A word on the strip's line ("Ver", "Parar esta"): quiet, with the stop square or the chevron. */
function BarAction({
  label,
  onPress,
  stop = false,
  expanded,
  chevron,
}: {
  label: string;
  onPress: () => void;
  stop?: boolean;
  expanded?: boolean;
  chevron?: "up" | "down";
}) {
  const c = useTheme().colors;
  return (
    <Pressable
      onPress={() => {
        if (stop) haptics.firm();
        else haptics.light();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(expanded === undefined ? {} : { accessibilityState: { expanded } })}
      hitSlop={6}
      style={({ pressed }) => [styles.action, pressed && { backgroundColor: stop ? `${c.danger}1F` : c.plate }]}
    >
      {stop ? <PixelStop size={10} color={c.muted} moving={false} /> : null}
      <Text variant="caption" tone="muted" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.ink}>
        {label}
      </Text>
      {chevron ? (
        <View style={chevron === "up" ? styles.up : undefined}>
          <Icon name="chev" size={12} color={c.muted} />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * One of the agent's tasks in the open strip: its mark, title and what it does (here: what it uses now; elsewhere:
 * where), "aqui" for the one in this conversation, how long it has been on, and "Parar". It opens the task's screen.
 */
function StripRow({
  task,
  here,
  stopping,
  now,
  onStop,
}: {
  task: ManagedTask;
  here: boolean;
  stopping: ReadonlySet<string>;
  now: number;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const color = agentLook(useDirectory().anyAgent(task.agentId)).color;
  const state = rowState(task, stopping);
  const title = taskTitle(t, task);
  const where = taskWhere(t, task);
  const waits = state === "ok" || state === "answer";
  const place = where === title ? null : where;
  // Working here: what it uses now (its line); elsewhere, where; otherwise how it stands.
  const sub = state === "working" ? (here ? null : place) : [stateText(t, state), place].filter(Boolean).join(" · ");
  const said = sub ?? stateText(t, state);
  const label = [title, here ? t("taskManager.strip.here") : null, said].filter(Boolean).join(", ");
  return (
    <Pressable
      onPress={() => router.push(`/task-manager/${task.runId}`)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.plateSoft }]}
    >
      <TaskMark state={state} color={color} />
      <View style={styles.rowText}>
        <Text variant="footnote" tone="ink" numberOfLines={1} style={styles.ink}>
          {title}
        </Text>
        {sub === null ? (
          <UsingLine task={task} />
        ) : (
          <Text variant="caption" numberOfLines={1} style={[waits && styles.ink, { color: waits ? c.amber : c.muted }]}>
            {sub}
          </Text>
        )}
      </View>
      {here ? <Chip icon="chat" label={t("taskManager.strip.here")} /> : null}
      <Text variant="caption" tone="faint" style={styles.num}>
        {formatDuration(t, now - taskSince(task))}
      </Text>
      {task.canStop ? (
        <StopButton label={t("taskManager.actions.stop")} stopping={state === "stopping"} onPress={onStop} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // As wide as the box, as the working line whose place it takes.
  dock: { paddingHorizontal: 4, paddingBottom: 6 },
  card: { borderRadius: 16, overflow: "hidden" },
  rows: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingLeft: 10, paddingRight: 8 },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  bar: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingLeft: 10, paddingRight: 4 },
  words: { flex: 1, minWidth: 0 },
  ink: { fontWeight: "600" },
  num: { fontVariant: ["tabular-nums"] },
  action: { flexDirection: "row", alignItems: "center", gap: 4, height: 28, paddingHorizontal: 8, borderRadius: 999 },
  up: { transform: [{ rotate: "180deg" }] },
  stopping: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  confirm: { padding: 10 },
});
