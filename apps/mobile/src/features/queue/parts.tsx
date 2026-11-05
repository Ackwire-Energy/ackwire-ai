import type { Message, MessageReceipt, QueueWaiting } from "@agenteschat/client";
import {
  fanChipText,
  fanOutOf,
  fanOutText,
  fanShows,
  queueLiveText,
  waitingFor,
} from "@agenteschat/client/lib/computer-queue";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, Chip, LineIcon, Text } from "@/ui";
import { MSG_AVATAR, MSG_GAP, MSG_INSET, MSG_TEXT } from "../chat/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow } from "../shared/hooks";
import { useAgentsQueue, useOpenQueue } from "./QueueSheet";

/**
 * Where "thinking" shows otherwise, for each agent of a message that waits in line for its computer: its face and
 * name, "Waiting for the computer. Next up, in about 1 min" or "In line, 4th. After Ada, Kai and Ravi", "You go
 * first" on my own request, and "See queue". `fallback` (the receipt's plain line) while the line doesn't know it.
 */
export function QueueWaitRows({
  channelId,
  receipt,
  agents,
  fallback,
}: {
  channelId: string;
  receipt: MessageReceipt | undefined;
  agents: string[];
  fallback: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const meId = useMeId();
  const now = useNow(30_000);
  const openQueue = useOpenQueue();
  const { machineId, queue } = useAgentsQueue(agents);
  const name = (id: string) => dir.anyAgent(id)?.name;
  const rows = agents.flatMap((agentId) => {
    const w = waitingFor(queue, receipt, agentId, channelId);
    const text = w ? queueLiveText(t, i18n.language, queue, w.runId, name, now) : null;
    return w && text ? [{ w, text }] : [];
  });
  if (!machineId || rows.length === 0) return <>{fallback}</>;
  return (
    <>
      {rows.map(({ w, text }) => (
        <WaitRow
          key={w.runId}
          waiting={w}
          name={name(w.agentId) ?? t("channel.unknownAgent")}
          text={text}
          first={w.people && w.purpose.kind === "person" && w.purpose.userId === meId}
          onSee={() => openQueue(machineId)}
        />
      ))}
    </>
  );
}

function WaitRow({
  waiting: w,
  name,
  text,
  first,
  onSee,
}: {
  waiting: QueueWaiting;
  name: string;
  text: string;
  first: boolean;
  onSee: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.turn} accessibilityLiveRegion="polite">
      <View style={styles.avslot}>
        <AgentFace agentId={w.agentId} size={MSG_AVATAR} mode="rest" />
      </View>
      <View style={styles.body}>
        <Text variant="footnote" tone="ink2" style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.say}>
          <LineIcon name="wait" size={13} color={c.muted} variant="footnote" />
          <Text variant="footnote" tone="muted" style={styles.grow}>
            {text}
          </Text>
        </View>
        <View style={styles.acts}>
          {first ? <Chip icon="person" label={t("queue.youFirst")} /> : null}
          <Button variant="ghost" size="sm" label={t("queue.see")} onPress={onSee} />
        </View>
      </View>
    </View>
  );
}

/**
 * Under an agent's message that called several agents: one strip instead of a "busy" line each. "12 agents called ·
 * 2 answered · 2 working · 8 in line", a chip per agent (answered, working, its place in line), live, and "See
 * queue". It goes once none works or waits: each reply is its own message.
 */
export function FanStrip({ message: m, receipt }: { message: Message; receipt: MessageReceipt | undefined }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const openQueue = useOpenQueue();
  const { machineId, queue } = useAgentsQueue(m.mentionedAgentIds);
  const fan = fanOutOf(receipt, queue);
  if (!fanShows(m, fan, receipt)) return null;
  const summary = fanOutText(t, fan);
  return (
    <View style={[styles.fan, { borderColor: c.line2 }]} accessibilityLiveRegion="polite">
      <View style={styles.fanHead}>
        <Text variant="footnote" tone="ink2" style={[styles.grow, styles.name]}>
          {summary}
        </Text>
        {machineId ? (
          <Button variant="ghost" size="sm" label={t("queue.see")} onPress={() => openQueue(machineId)} />
        ) : null}
      </View>
      <View style={styles.chips}>
        {fan.agents.map((a) => (
          <Chip
            key={a.agentId}
            leading={<AgentFace agentId={a.agentId} size={14} live={false} framed={false} />}
            label={dir.anyAgent(a.agentId)?.name ?? t("channel.unknownAgent")}
            trailing={`· ${fanChipText(t, i18n.language, a)}`}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The turn a live row takes (MessageRow, LiveRows): its reply takes the same place.
  turn: {
    flexDirection: "row",
    gap: MSG_GAP,
    paddingLeft: MSG_INSET,
    paddingRight: 16,
    paddingVertical: 10,
    marginTop: 4,
  },
  avslot: { width: MSG_AVATAR, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0, gap: 4 },
  name: { fontWeight: "600" },
  say: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  acts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 2 },
  // Under the message's text, in its column.
  fan: {
    marginLeft: MSG_TEXT,
    marginRight: 16,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderWidth: 1,
    borderRadius: 14,
  },
  fanHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
