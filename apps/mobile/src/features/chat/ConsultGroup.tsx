import {
  keys,
  type Message,
  type MessageConsultation,
  type RunConsultation,
  useConsultations,
} from "@agenteschat/client";
import {
  type ConsultLineState,
  consultLineKey,
  consultLineState,
  consultSeconds,
  firstOfRun,
  groupsByRun,
  talkState,
  talkStateOf,
  talkStatus,
} from "@agenteschat/client/lib/consult-group";
import type { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatLineTime } from "@agenteschat/client/lib/work";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { consultationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { useSurface } from "../shared/parts";

/** A question's state in words, on the conversation's screen. */
export const consultLineLabel = (
  t: TFunction,
  state: ConsultLineState,
  c: RunConsultation,
  to: ReturnType<typeof agentGrammar>,
) => t(consultLineKey(state, c), { name: to.name, context: to.context });

/** A clock for the open questions' times; still once none is out. */
function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Two agents talking, as one pill (the web's `AgentTalkPill`): the asker's face, the arrows, the other's face, then
 * "Caio ⇄ Theo · respondeu em 8 s". A tap opens their conversation on a screen of its own (`ConsultationScreen`).
 * The live state comes from the conversation's questions; a stored card (`stored`) gives how it ended.
 */
export function AgentTalkPill({
  consultationId,
  channelId,
  fromId,
  toId,
  stored,
}: {
  consultationId: string;
  channelId: string;
  fromId: string;
  toId: string;
  stored?: Pick<MessageConsultation, "status" | "answer">;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const run = useConsultations(orgId, channelId).data?.find((q) => q.id === consultationId);
  const now = useTick(run?.status === "open");
  const from = dir.agentById.get(fromId)?.name ?? t("mobile.chat.someone");
  const to = dir.agentById.get(toId)?.name ?? t("mobile.chat.someone");
  const state = run ? talkState(consultLineState(run, now)) : stored ? talkStateOf(stored.status, stored.answer) : null;
  const status = state
    ? talkStatus(state, run ? formatLineTime(i18n.language, consultSeconds(run, now) * 1000) : null)
    : null;
  const names = t("chat.consultPanel.title", { from, to });
  const said = status ? t(status.key, status.values) : null;
  return (
    <Pressable
      onPress={() => router.push(consultationHref(consultationId, channelId))}
      accessibilityRole="button"
      accessibilityLabel={[t("chat.consultPanel.label", { from, to }), said].filter(Boolean).join(" · ")}
      style={[styles.pill, surface]}
    >
      <View style={styles.faces}>
        <AgentFace agentId={fromId} size={18} live={false} />
        <Icon name="swap" size={14} color={c.faint} />
        <AgentFace agentId={toId} size={18} mode={state === "waiting" ? "run" : "idle"} live={state === "waiting"} />
      </View>
      <Text variant="small" tone="ink" style={styles.text}>
        <Text variant="small" tone="ink" style={styles.bold}>
          {names}
        </Text>
        {said ? (
          <Text variant="small" tone={state === "failed" ? "muted" : "faint"}>
            {` · ${said}`}
          </Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

/**
 * The questions the agent asked other agents in this turn, and the work it handed them, inside its reply, as on the
 * web: one pill per agent (`AgentTalkPill`). The run's first message shows them when the run posted several.
 */
export function ConsultGroup({ message: m }: { message: Message }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const list = useConsultations(orgId, m.channelId, Boolean(m.agentRunId));
  const runId = m.agentRunId ?? "";
  const group = useMemo(() => groupsByRun(list.data ?? []).get(runId), [list.data, runId]);
  const asks = Boolean(group && group.length > 0 && m.author.id);
  const loaded = asks
    ? [
        ...(qc.getQueryData<Message[]>(keys.messages(orgId, m.channelId)) ?? []),
        ...((m.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, m.channelId, m.threadId))) || []),
      ]
    : [];
  const first = asks ? firstOfRun(loaded, runId) : null;
  const draws = asks && (!first || first === m.id);
  if (!draws || !group || !m.author.id) return null;
  const askerId = m.author.id;
  return (
    <TalkPills>
      {group.map((c) => (
        <AgentTalkPill
          key={c.id}
          consultationId={c.id}
          channelId={m.channelId}
          fromId={askerId}
          toId={c.consultedAgentId}
        />
      ))}
    </TalkPills>
  );
}

/** Pills of agents talking, side by side, wrapping. */
export function TalkPills({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginVertical: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    minHeight: 30,
    paddingVertical: 4,
    paddingLeft: 6,
    paddingRight: 12,
    borderRadius: 15,
  },
  faces: { flexDirection: "row", alignItems: "center", gap: 3 },
  text: { flexShrink: 1 },
  bold: { fontWeight: "600" },
});
