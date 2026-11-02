import { keys, type Message, type RunConsultation, useConsultations } from "@agenteschat/client";
import {
  type ConsultLineState,
  consultGroupKeys,
  consultGroupSummary,
  consultLineKey,
  consultLineState,
  consultProgress,
  consultSeconds,
  firstOfRun,
  groupsByRun,
} from "@agenteschat/client/lib/consult-group";
import { previewOf } from "@agenteschat/client/lib/consultations";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatLineTime, type ToolState } from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { consultationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { type BlockItem, ToolBlock } from "./ToolCalls";

const BLOCK_STATE: Record<ConsultLineState, ToolState> = {
  working: "run",
  waiting: "run",
  // Paused until its computer comes back, or on what it handed on, still out: the same mark as at work.
  offline: "run",
  handedOn: "run",
  answered: "done",
  failed: "fail",
  expired: "fail",
};

/** A question's state in words, the same in the reply's block and on the conversation's screen. */
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
 * The questions the agent asked other agents in this turn, and the work it handed them, inside its reply, as on the
 * web (`ConsultGroup.tsx`): the tool block's card, "Perguntou a 3 colegas" or "Passou para 1 colega" (open while
 * answers are out), a line per agent that opens the two agents' conversation on a screen of its own, read only
 * (`ConsultationScreen`). The run's first message shows it when the run posted several.
 */
export function ConsultGroup({ message: m, color }: { message: Message; color: AgentColorName }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
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
  const live = group?.some((c) => c.status === "open") ?? false;
  const now = useTick(live);
  if (!draws || !group || !m.author.id) return null;
  const summary = consultGroupSummary(group, now);
  const words = consultGroupKeys(group);
  const from = agentGrammar(dir.agentById.get(m.author.id)?.name ?? t("mobile.chat.someone"));
  const items: BlockItem[] = group.map((c) => {
    const state = consultLineState(c, now);
    const to = agentGrammar(dir.agentById.get(c.consultedAgentId)?.name ?? t("mobile.chat.someone"));
    const answer = state === "answered" ? (c.answer ?? "") : null;
    const progress = consultProgress(c);
    return {
      kind: "line",
      line: {
        key: c.id,
        state: BLOCK_STATE[state],
        logo: <AgentFace agentId={c.consultedAgentId} size={18} mode={state === "working" ? "run" : "idle"} />,
        label: consultLineLabel(t, state, c, to),
        hint: null,
        // The start of the answer, as the web shows it next to the phrase: no tap needed to know what came back.
        preview: answer ? previewOf(answer) : progress ? t(progress.key, progress.values) : null,
        time: formatLineTime(i18n.language, consultSeconds(c, now) * 1000),
        onOpen: () => router.push(consultationHref(c.id, m.channelId)),
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
          ? `${t(words.head, { count: summary.total })} · ${t("chat.consultGroup.progress", { done: summary.closed, total: summary.total })}`
          : t(words.head, { count: summary.total }),
        textKey: `consult-${summary.closed}`,
        state: summary.open ? "run" : undefined,
      }}
      items={items}
      color={color}
      label={t(words.label, { name: from.name, context: from.context })}
      defaultOpen={summary.open}
      // One question: its own line ("Atlas respondeu"), with no "Perguntou a 1 colega" to open.
      one={group.length === 1}
    />
  );
}
