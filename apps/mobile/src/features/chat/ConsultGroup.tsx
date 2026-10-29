import { keys, type Message, type RunConsultation, useConsultations } from "@agenteschat/client";
import {
  type ConsultLineState,
  consultGroupSummary,
  consultLineState,
  consultSeconds,
  firstOfRun,
  groupsByRun,
} from "@agenteschat/client/lib/consult-group";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatLineTime, type ToolState } from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { MessageText } from "./MessageText";
import { type BlockItem, ToolBlock } from "./ToolCalls";

const BLOCK_STATE: Record<ConsultLineState, ToolState> = {
  working: "run",
  waiting: "run",
  answered: "done",
  failed: "fail",
  expired: "fail",
};

function lineLabel(t: TFunction, state: ConsultLineState, c: RunConsultation, to: ReturnType<typeof agentGrammar>) {
  switch (state) {
    case "working":
      return t("chat.consultGroup.working", { name: to.name, The: to.The });
    case "waiting":
      return t(c.waiting === "approval" ? "chat.consultGroup.waitingApproval" : "chat.consultGroup.waitingInput", {
        name: to.name,
        The: to.The,
      });
    case "answered":
      return t("chat.consultation.answered", { name: to.name });
    case "expired":
      return t("chat.consultation.expired", { name: to.name, The: to.The });
    default:
      return t("chat.consultation.failed", { name: to.name, The: to.The });
  }
}

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
 * The questions the agent asked other agents in this turn, inside its reply, as on the web (`ConsultGroup.tsx`):
 * the tool block's card, "Perguntou a 3 colegas" (open while answers are out), a line per agent opening to the
 * question and the answer. The run's first message shows it when the run posted several.
 */
export function ConsultGroup({ message: m, color }: { message: Message; color: AgentColorName }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const list = useConsultations(orgId, m.channelId, Boolean(m.agentRunId));
  const runId = m.agentRunId ?? "";
  const group = useMemo(() => groupsByRun(list.data ?? []).get(runId), [list.data, runId]);
  const live = group?.some((c) => c.status === "open") ?? false;
  const now = useTick(live);
  if (!group || group.length === 0 || !m.author.id) return null;
  const loaded = [
    ...(qc.getQueryData<Message[]>(keys.messages(orgId, m.channelId)) ?? []),
    ...((m.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, m.channelId, m.threadId))) || []),
  ];
  const first = firstOfRun(loaded, runId);
  if (first && first !== m.id) return null;
  const summary = consultGroupSummary(group, now);
  const from = agentGrammar(t, dir.agentById.get(m.author.id)?.name ?? t("mobile.chat.someone"));
  const items: BlockItem[] = group.map((c) => {
    const state = consultLineState(c, now);
    const to = agentGrammar(t, dir.agentById.get(c.consultedAgentId)?.name ?? t("mobile.chat.someone"));
    const answer = state === "answered" ? (c.answer ?? "") : null;
    return {
      kind: "line",
      line: {
        key: c.id,
        state: BLOCK_STATE[state],
        logo: <AgentFace agentId={c.consultedAgentId} size={18} mode={state === "working" ? "run" : "idle"} />,
        label: lineLabel(t, state, c, to),
        hint: null,
        time: formatLineTime(i18n.language, consultSeconds(c, now) * 1000),
        detail: (
          <View style={styles.detail}>
            <Text variant="caption" tone="faint" style={styles.bold}>
              {t("chat.consultation.asked", { name: from.name })}
            </Text>
            <Text variant="small" tone="muted">
              {c.question}
            </Text>
            {answer !== null ? (
              <>
                <Text variant="caption" tone="faint" style={[styles.bold, styles.gap]}>
                  {t("chat.consultation.answerOf", { name: to.name, of: to.of })}
                </Text>
                <MessageText body={answer} />
              </>
            ) : null}
            <Text variant="caption" tone="faint" style={styles.gap}>
              {t("chat.consultation.private", {
                from: from.name,
                articleFrom: from.article,
                to: to.name,
                articleTo: to.article,
              })}
            </Text>
          </View>
        ),
      },
    };
  });
  return (
    <ToolBlock
      // Open while answers are out; it folds by itself once the last one is in (a tap opens it again).
      key={summary.open ? "out" : "in"}
      logos={group.map((c) => ({
        key: c.id,
        node: <AgentFace agentId={c.consultedAgentId} size={18} live={false} />,
      }))}
      head={{
        // The phone's head has no room for a separate count: "Perguntou a 3 colegas · 1 de 3" in its words.
        text: summary.open
          ? `${t("chat.consultGroup.asked", { count: summary.total })} · ${t("chat.consultGroup.progress", { done: summary.closed, total: summary.total })}`
          : t("chat.consultGroup.asked", { count: summary.total }),
        textKey: `consult-${summary.closed}`,
        state: summary.open ? "run" : undefined,
      }}
      items={items}
      color={color}
      label={t("chat.consultGroup.label", { name: from.name, of: from.of })}
      defaultOpen={summary.open}
    />
  );
}

const styles = StyleSheet.create({
  detail: { gap: 2 },
  bold: { fontWeight: "600" },
  gap: { marginTop: 8 },
});
