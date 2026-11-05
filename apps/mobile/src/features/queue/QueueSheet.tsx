import {
  type ComputerQueue,
  type QueueWaiting,
  type QueueWorking,
  useChannels,
  useDms,
  useMachineQueue,
  useMachines,
} from "@agenteschat/client";
import {
  durationText,
  nthText,
  type QueueNames,
  type QueueRow,
  queueAllStartedText,
  queueButtonText,
  queueLeftText,
  queuePurposeText,
  queueStartText,
  queueStatusText,
  queueView,
  queueWhereText,
} from "@agenteschat/client/lib/computer-queue";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button, CHROME_MAX_SCALE, Chip, Count, Icon, type IconName, PressScale, Text } from "@/ui";
import { useComputerSays, useWatchableComputer } from "../chat/DmComputerButton";
import { openComputer } from "../computer/AgentComputerRow";
import { AgentFace, OpensAgent } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useSheet } from "../shared/SheetHost";
import { machineOfAgents, queuePlace } from "./logic";

/** The line of the computer these agents share (the first one's), live; nothing while none has a computer. */
export function useAgentsQueue(agentIds: readonly string[]) {
  const orgId = useOrgId();
  const machines = useMachines(orgId);
  const machineId = machineOfAgents(machines.data, agentIds);
  const queue = useMachineQueue(orgId, machineId);
  return { machineId, queue: queue.data ?? null };
}

/** Opens a computer's line in the screen's sheet, over the conversation; `computer` adds the way on to it. */
export function useOpenQueue() {
  const sheet = useSheet();
  return useCallback(
    (machineId: string, computer?: OpenComputerProps) =>
      sheet.open(<QueueSheet machineId={machineId} computer={computer} />),
    [sheet],
  );
}

/**
 * The conversation bar's way into the line while turns wait for the computer: the waiting icon with how many wait.
 * The bar sits outside the screen's sheet host, so the screen opens the sheet (`onPress`).
 */
export function QueueButton({
  queue,
  onPress,
  icon = "wait",
  says = "",
}: {
  queue: ComputerQueue;
  onPress: () => void;
  icon?: IconName;
  /** The agent's computer state a screen reader hears too (`useComputerSays`). */
  says?: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <PressScale
      to={0.9}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={says ? `${queueButtonText(t, queue)}, ${says}` : queueButtonText(t, queue)}
      hitSlop={4}
      style={styles.button}
    >
      <Icon name={icon} size={20} color={c.ink2} />
      <View style={styles.badge} pointerEvents="none">
        <Count value={queue.waiting.length} size={10} inverted max={99} />
      </View>
    </PressScale>
  );
}

/** An agent's DM header while turns wait: the laptop with the count, saying what its computer says. */
export function DmQueueButton({ agentId, ...props }: { agentId: string; queue: ComputerQueue; onPress: () => void }) {
  return <QueueButton {...props} icon="laptop" says={useComputerSays(agentId)} />;
}

/**
 * A computer's line, as on the web's dialog: how full it is and when the next starts, "Working now" (every turn
 * running: what for, where, for how long, the time left) and "In line" (the order, who asked, the estimated start;
 * my own request marked "You go first"), and the rule that keeps it. What a turn is for, never its content.
 */
export function QueueSheet({ machineId, computer }: { machineId: string; computer?: OpenComputerProps }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const meId = useMeId();
  const q = useMachineQueue(orgId, machineId);
  const now = useNow(30_000);
  const words = useQueueWords();
  if (!q.data) {
    return q.isError ? (
      <Text tone="muted">{t("mobile.app.failed")}</Text>
    ) : (
      <ActivityIndicator color={c.muted} style={styles.loading} />
    );
  }
  const view = queueView(q.data, meId ?? "");
  const allStarted = queueAllStartedText(t, view, now);
  return (
    <>
      <View accessible accessibilityRole="header" accessibilityLabel={t("queue.label", { name: q.data.name })}>
        <SheetTitle title={q.data.name} subtitle={queueStatusText(t, view, now)} />
      </View>
      <View style={styles.group}>
        <GroupHead title={t("queue.workingNow", { n: view.working.length })} />
        {view.working.length === 0 ? (
          <Text variant="small" tone="muted">
            {t("queue.nothingWorking")}
          </Text>
        ) : (
          <View style={styles.rows}>
            {view.working.map((w) => (
              <WorkingRow key={w.runId} row={w} words={words} now={now} />
            ))}
          </View>
        )}
      </View>
      {view.waiting.length > 0 ? (
        <View style={[styles.group, styles.nextGroup, { borderTopColor: c.line }]}>
          <GroupHead title={t("queue.inLine", { n: view.waiting.length })} aside={allStarted} />
          <View style={styles.rows}>
            {view.waiting.map((w) => (
              <WaitingRow key={w.runId} row={w} words={words} now={now} />
            ))}
          </View>
        </View>
      ) : null}
      <Text variant="caption" tone="faint" style={styles.rule}>
        {t("queue.rule")}
      </Text>
      {computer ? <OpenComputer {...computer} /> : null}
    </>
  );
}

interface OpenComputerProps {
  agentId: string;
  /** The conversation keeps its place before the computer covers it. */
  onOpen?: () => void;
}

/** "Open the computer", for whoever may watch the agent's computer (as the DM header's own button). */
function OpenComputer({ agentId, onOpen }: OpenComputerProps) {
  const { t } = useTranslation();
  const sheet = useSheet();
  if (!useWatchableComputer(agentId)) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      icon="laptop"
      label={t("queue.openComputer")}
      onPress={() => {
        sheet.close();
        onOpen?.();
        openComputer(agentId);
      }}
    />
  );
}

/** Names and places as this person knows them: agents and people by name, conversations they can see. */
function useQueueWords() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  return useMemo(() => {
    const names: QueueNames = {
      viewerId: meId ?? "",
      agent: (id) => dir.anyAgent(id)?.name,
      person: (id) => dir.memberById.get(id)?.name,
    };
    return {
      names,
      agentName: (id: string) => names.agent(id) ?? t("channel.unknownAgent"),
      line: (r: QueueWorking | QueueWaiting) =>
        [queuePurposeText(t, r.purpose, names), queueWhereText(t, queuePlace(r.where, channels.data, dms.data))].join(
          " · ",
        ),
    };
  }, [t, meId, dir, channels.data, dms.data]);
}

type Words = ReturnType<typeof useQueueWords>;

function GroupHead({ title, aside }: { title: string; aside?: string | null }) {
  return (
    <View style={styles.head}>
      <Text variant="small" tone="ink" accessibilityRole="header" style={styles.headTitle}>
        {title}
      </Text>
      {aside ? (
        <Text variant="caption" tone="faint" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
          {aside}
        </Text>
      ) : null}
    </View>
  );
}

function WorkingRow({ row: w, words, now }: { row: QueueRow<QueueWorking>; words: Words; now: number }) {
  const { t } = useTranslation();
  const elapsed = durationText(t, Math.max(0, now - Date.parse(w.startedAt)));
  return (
    <QueueLine
      agentId={w.agentId}
      position={null}
      name={words.agentName(w.agentId)}
      line={`${words.line(w)} · ${elapsed}`}
      time={queueLeftText(t, w, now)}
      mine={w.mine}
    />
  );
}

function WaitingRow({ row: w, words, now }: { row: QueueRow<QueueWaiting>; words: Words; now: number }) {
  const { t } = useTranslation();
  return (
    <QueueLine
      agentId={w.agentId}
      position={w.position}
      name={words.agentName(w.agentId)}
      line={words.line(w)}
      time={queueStartText(t, w, words.names.agent, now)}
      mine={w.mine}
      first={w.mine && w.people}
    />
  );
}

/**
 * One turn, two lines: the agent's face and name, its place in line ("1º") and the time, then what for and where
 * (wrapping). `mine` highlights my own request; `first` (waiting, a person waits on it) also says "You go first".
 */
export function QueueLine({
  agentId,
  position,
  name,
  line,
  time,
  mine,
  first = false,
}: {
  agentId: string;
  position: number | null;
  name: string;
  line: string;
  time: string | null;
  mine: boolean;
  first?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const nth = position !== null ? nthText(t, i18n.language, position) : null;
  return (
    <View style={[styles.row, mine && { backgroundColor: c.sunken }]}>
      <OpensAgent agentId={agentId}>
        <AgentFace agentId={agentId} size={20} live={false} />
      </OpensAgent>
      <View
        style={styles.text}
        accessible
        accessibilityLabel={[name, nth, line, first ? t("queue.youFirst") : null, time].filter(Boolean).join(", ")}
      >
        <View style={styles.l1}>
          <Text variant="small" tone="ink" numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          {nth ? (
            <Text variant="caption" tone="faint" style={styles.nums} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
              {nth}
            </Text>
          ) : null}
          {time ? (
            <Text variant="caption" tone="faint" numberOfLines={1} style={[styles.nums, styles.time]}>
              {time}
            </Text>
          ) : null}
        </View>
        <Text variant="footnote" tone={mine ? "ink2" : "muted"}>
          {line}
        </Text>
        {first ? (
          <View style={styles.first}>
            <Chip icon="person" label={t("queue.youFirst")} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginVertical: 24 },
  button: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: 2, right: 0 },
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  headTitle: { fontWeight: "600", flexShrink: 1 },
  // 16 between groups, on each side of the line (the sheet's own gap is 12).
  group: { gap: 4 },
  nextGroup: { marginTop: 4, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth },
  // The rows' 8 of padding bleeds past the group's edge: faces line up with the group title.
  rows: { marginHorizontal: -8, gap: 2 },
  // The face (20) on the first line (small, 20 tall).
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 8, borderRadius: 12 },
  text: { flex: 1, minWidth: 0 },
  l1: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 20 },
  name: { fontWeight: "600", flexShrink: 1 },
  nums: { fontVariant: ["tabular-nums"] },
  time: { marginLeft: "auto", paddingLeft: 8, flexShrink: 0 },
  first: { flexDirection: "row", marginTop: 4 },
  rule: { marginTop: 4 },
});
