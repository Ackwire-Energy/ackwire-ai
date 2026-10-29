import { keys, type RunConsultation, useConsultations } from "@agenteschat/client";
import {
  type ConsultLineState,
  consultGroupSummary,
  consultLineState,
  consultSeconds,
  groupsByRun,
  shownConsultations,
} from "@agenteschat/client/lib/consult-group";
import { previewOf } from "@agenteschat/client/lib/consultations";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatLineTime } from "@agenteschat/client/lib/work";
import { type AgentColor, Icon, ToolBlock, type ToolBlockItem, type ToolBlockState } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useNow } from "@/components/missions/MissionBits";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useChannelEvents } from "@/realtime/context";

interface ConsultGroups {
  byRun: Map<string, RunConsultation[]>;
  /** Questions a reply here shows: their `consult_reply` notices fold away. */
  shown: ReadonlySet<string>;
}

const EMPTY: ConsultGroups = { byRun: new Map(), shown: new Set() };
const ConsultGroupsContext = createContext<ConsultGroups>(EMPTY);
export const ConsultGroupsProvider = ConsultGroupsContext.Provider;

const RELOAD_ON = new Set(["agent.consulting", "agent.consulted", "agent.consultation"]);

/**
 * The conversation's questions to other agents, by the run that asked; reloaded when one changes. `runsInView`:
 * the runs with a reply (or a live block) loaded here, whose questions fold their notices away.
 */
export function useConsultGroups(channelId: string, runsInView: ReadonlySet<string>): ConsultGroups {
  const { org } = useOrg();
  const qc = useQueryClient();
  const list = useConsultations(org.id, channelId);
  useChannelEvents(channelId, true, (event) => {
    if (RELOAD_ON.has(event.type)) void qc.invalidateQueries({ queryKey: keys.consultations(org.id, channelId) });
  });
  return useMemo(() => {
    const all = list.data ?? [];
    if (all.length === 0) return EMPTY;
    return { byRun: groupsByRun(all), shown: shownConsultations(all, runsInView) };
  }, [list.data, runsInView]);
}

const BLOCK_STATE: Record<ConsultLineState, ToolBlockState> = {
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

/**
 * The questions the agent asked other agents in this turn (`ask_agent`), inside its reply, as one more step of
 * its work: "Perguntou a 3 colegas · 1 de 3" while answers are out, a line per agent (working, waiting on a
 * person, answered with the start of the answer, couldn't), each opening to the question and the full answer.
 */
export function ConsultGroup({ runId, askerId, color }: { runId: string; askerId: string; color?: AgentColor }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const group = useContext(ConsultGroupsContext).byRun.get(runId);
  const live = group?.some((c) => c.status === "open") ?? false;
  const now = useNow(live);
  if (!group || group.length === 0) return null;
  const summary = consultGroupSummary(group, now);
  const from = agentGrammar(t, dir.agentById.get(askerId)?.name ?? t("channel.unknownAgent"));
  const items: ToolBlockItem[] = group.map((c) => {
    const state = consultLineState(c, now);
    const to = agentGrammar(t, dir.agentById.get(c.consultedAgentId)?.name ?? t("channel.unknownAgent"));
    const answer = state === "answered" ? (c.answer ?? "") : null;
    return {
      kind: "line",
      line: {
        key: c.id,
        state: BLOCK_STATE[state],
        logo: (
          <AgentAvatar
            agentId={c.consultedAgentId}
            size="xs"
            name={to.name}
            state={state === "working" ? "thinking" : "idle"}
          />
        ),
        label: lineLabel(t, state, c, to),
        hint: answer ? previewOf(answer) : null,
        time: formatLineTime(i18n.language, consultSeconds(c, now) * 1000),
        // The consultation card's words and type (prose, never the tools' mono): the question, the answer, who saw it.
        detail: (
          <div className="ac-consult__body ac-consult__body--inline">
            <small>{t("chat.consultation.asked", { name: from.name })}</small>
            <div className="ac-consult__text ac-consult__text--q">
              <MessageBody body={c.question} resolveMention={dir.mentionName} />
            </div>
            {answer !== null && (
              <>
                <small>{t("chat.consultation.answerOf", { name: to.name, of: to.of })}</small>
                <div className="ac-consult__text">
                  <MessageBody body={answer} resolveMention={dir.mentionName} />
                </div>
              </>
            )}
            <p className="ac-consult__foot ac-iconline">
              <Icon name="eyeOff" size={14} />
              {t("chat.consultation.private", {
                from: from.name,
                articleFrom: from.article,
                to: to.name,
                articleTo: to.article,
              })}
            </p>
          </div>
        ),
      },
    };
  });
  return (
    <ToolBlock
      // Open while answers are out; it folds by itself once the last one is in (a click opens it again).
      key={summary.open ? "out" : "in"}
      className="ac-consult-group"
      logos={group.map((c) => (
        <AgentAvatar
          key={c.id}
          agentId={c.consultedAgentId}
          size="xs"
          name={dir.agentById.get(c.consultedAgentId)?.name ?? ""}
          state="idle"
        />
      ))}
      head={{
        text: t("chat.consultGroup.asked", { count: summary.total }),
        state: summary.open ? "run" : undefined,
        count: summary.open ? t("chat.consultGroup.progress", { done: summary.closed, total: summary.total }) : undefined,
      }}
      items={items}
      color={color}
      label={t("chat.consultGroup.label", { name: from.name, of: from.of })}
      defaultOpen={summary.open}
    />
  );
}
