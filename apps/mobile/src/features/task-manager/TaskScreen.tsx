import type { EndedTask, ManagedTask } from "@agenteschat/client";
import {
  endedState,
  linePlace,
  taskClock,
  taskSince,
  taskState,
  taskTitle,
} from "@agenteschat/client/lib/task-manager";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, PixelDone, PixelFail, PixelStop, PixelStopped, Section, Text, weights } from "@/ui";
import { RunSteps } from "../chat/ToolCalls";
import { chatHref } from "../links/logic";
import { useOpenQueue } from "../queue/QueueSheet";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { useStopper, useTasksToday } from "./hooks";
import { endedText, rowState, taskSubline } from "./logic";
import { StateLine, StopConfirm, UsingLine } from "./parts";

/**
 * A task's screen (ADR 0128), pushed from the task manager or an agent's tasks: whose it is, where and who asked, how
 * it stands (its place when it waits for room on its computer, with "Ver fila"), for how long, what it uses now and
 * where it runs, its steps so far, "Abrir na conversa" and "Parar tarefa". Once it ends, how it ended (the list it
 * came from keeps what ended today).
 */
export function TaskScreen({ runId }: { runId: string }) {
  return (
    <SheetHostProvider>
      <Task runId={runId} />
    </SheetHostProvider>
  );
}

function Task({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const tasks = useTasksToday();
  const task = tasks.data?.tasks.find((x) => x.runId === runId) ?? null;
  const ended = task ? null : (tasks.data?.ended.find((x) => x.runId === runId) ?? null);
  if (!task && !ended)
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title="" solid={false} />
        <View style={styles.center}>
          {tasks.isLoading ? (
            <ActivityIndicator color={c.muted} />
          ) : (
            <Text tone="muted">{t("mobile.taskManager.gone")}</Text>
          )}
        </View>
      </View>
    );
  if (task) return <Live task={task} />;
  if (ended) return <Ended task={ended} />;
  return null;
}

/** A task still on: its state moves, and who may stop it can. */
function Live({ task }: { task: ManagedTask }) {
  const { t } = useTranslation();
  const meId = useMeId();
  const now = useNow(1000);
  const { stopping, stop } = useStopper();
  const state = rowState(task, stopping);
  const title = taskTitle(t, task);
  const inLine = state === "stopping" ? null : linePlace(task);
  const dir = useDirectory();
  const nameOf = (id: string) => dir.anyAgent(id)?.name;
  const [asking, setAsking] = useState(false);
  return (
    <Page
      task={task}
      title={title}
      sub={taskSubline(t, task, meId, title, nameOf)}
      rows={[
        {
          key: "state",
          label: t("taskManager.columns.state"),
          value: <StateLine task={task} state={state} now={now} />,
        },
        {
          key: "time",
          label: t("taskManager.columns.time"),
          value: <Value text={taskClock(now - taskSince(task))} />,
        },
        { key: "using", label: t("taskManager.columns.using"), value: <UsingLine task={task} /> },
        {
          key: "computer",
          label: t("taskManager.columns.computer"),
          value: <Value text={task.machine?.name ?? t("taskManager.servers")} />,
        },
      ]}
      steps={{ calls: task.steps, live: taskState(task) === "working" }}
      line={inLine?.machineId ?? null}
      stop={
        !task.canStop ? null : asking ? (
          <StopConfirm
            agentId={task.agentId}
            count={1}
            helpers={task.helpers}
            onCancel={() => setAsking(false)}
            onStop={(reason) => {
              setAsking(false);
              stop([task.runId], reason, true);
            }}
          />
        ) : (
          <>
            {task.delegation ? (
              <Text variant="footnote" tone="muted">
                {t("taskManager.delegated.stopNote", { name: nameOf(task.delegation.agentId) ?? "" })}
              </Text>
            ) : null}
            <Button
              variant="primary"
              wide
              label={t(task.helpers ? "taskManager.actions.stopAll" : "taskManager.actions.stopTask")}
              leading={(ink) => <PixelStop size={11} color={ink} moving={false} />}
              loading={state === "stopping"}
              onPress={() => (task.helpers ? setAsking(true) : stop([task.runId]))}
            />
          </>
        )
      }
    />
  );
}

/** A task that ended today: how (done, stopped and by whom, couldn't), and how long it took. */
function Ended({ task }: { task: EndedTask }) {
  const { t } = useTranslation();
  const meId = useMeId();
  const state = endedState(task);
  const title = taskTitle(t, task);
  const took = Date.parse(task.finishedAt) - Date.parse(task.startedAt ?? task.finishedAt);
  return (
    <Page
      task={task}
      title={title}
      sub={taskSubline(t, { ...task, requester: null, plan: null }, meId, title)}
      rows={[
        {
          key: "state",
          label: t("taskManager.columns.state"),
          value: (
            <View style={styles.row}>
              {state === "done" ? (
                <PixelDone size={12} />
              ) : state === "failed" ? (
                <PixelFail size={12} />
              ) : (
                <PixelStopped size={10} />
              )}
              <Text variant="footnote" tone="ink2" style={styles.semibold}>
                {endedText(t, task, meId)}
              </Text>
            </View>
          ),
        },
        { key: "time", label: t("taskManager.columns.time"), value: <Value text={taskClock(took)} /> },
      ]}
      steps={{ calls: 0, live: false }}
      stop={null}
    />
  );
}

function Value({ text }: { text: string }) {
  return (
    <Text variant="footnote" tone="ink2" numberOfLines={1} style={[styles.semibold, styles.num]}>
      {text}
    </Text>
  );
}

/** The screen both kinds share: the head, the facts, the actions and the steps. */
function Page({
  task,
  title,
  sub,
  rows,
  steps,
  line = null,
  stop,
}: {
  task: Pick<ManagedTask, "runId" | "agentId" | "channelId" | "threadId" | "background" | "betweenAgents">;
  title: string;
  sub: string;
  rows: { key: string; label: string; value: ReactNode }[];
  steps: { calls: number; live: boolean };
  /** It waits for room on this computer: "Ver fila" opens its line (`QueueSheet`). */
  line?: string | null;
  stop: ReactNode;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const insets = useSafeAreaInsets();
  const openQueue = useOpenQueue();
  const agent = dir.anyAgent(task.agentId);
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={title} solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
      >
        <View style={styles.head}>
          <View style={styles.row}>
            <AgentFace agentId={task.agentId} size={24} live={false} />
            <Text variant="small" tone="muted" style={styles.semibold}>
              {agent?.name ?? t("channel.unknownAgent")}
            </Text>
          </View>
          <Text variant="title2" accessibilityRole="header">
            {title}
          </Text>
          {sub ? (
            <Text variant="body" tone="muted">
              {sub}
            </Text>
          ) : null}
        </View>
        <Card style={styles.facts}>
          {rows.map((r, i) => (
            <View
              key={r.key}
              style={[styles.fact, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }]}
            >
              <Text variant="footnote" tone="muted" style={styles.label}>
                {r.label}
              </Text>
              <View style={styles.value}>{r.value}</View>
            </View>
          ))}
        </Card>
        <View style={styles.actions}>
          {line ? (
            <Button
              variant="secondary"
              wide
              icon="laptop"
              label={t("taskManager.queue.see")}
              onPress={() => {
                if (line) openQueue(line);
              }}
            />
          ) : null}
          {task.background || task.betweenAgents ? null : (
            <Button
              variant="secondary"
              wide
              icon="chat"
              label={t("taskManager.actions.open")}
              onPress={() => router.push(chatHref(task.channelId, task.threadId))}
            />
          )}
          {stop}
        </View>
        <Section title={t("taskManager.panel.steps")}>
          <RunSteps runId={task.runId} color={agentLook(agent).color} calls={steps.calls} live={steps.live} />
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  scroll: { paddingTop: 4 },
  head: { paddingHorizontal: 20, gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  semibold: { fontWeight: weights.semibold },
  num: { fontVariant: ["tabular-nums"] },
  facts: { marginHorizontal: 16, marginTop: 16 },
  fact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  label: { width: 104 },
  value: { flex: 1, minWidth: 0 },
  actions: { gap: 10, paddingHorizontal: 16, marginTop: 16 },
});
