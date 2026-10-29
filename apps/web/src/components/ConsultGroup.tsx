import { keys, type Message, type RunConsultation, useConsultations } from "@agenteschat/client";
import {
  type ConsultLineState,
  type ConsultNoticeFold,
  type ConsultRow,
  consultBlocksNearEnd,
  consultGroupSummary,
  consultLineState,
  consultNoticeFolds,
  consultSeconds,
  groupsByRun,
  requestConsultBlock,
  useConsultBlockRequest,
} from "@agenteschat/client/lib/consult-group";
import { previewOf } from "@agenteschat/client/lib/consultations";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatLineTime } from "@agenteschat/client/lib/work";
import { type AgentColor, Icon, ToolBlock, type ToolBlockItem, type ToolBlockState } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useChannelActions } from "@/components/channel-actions";
import { useNow } from "@/components/missions/MissionBits";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useChannelEvents } from "@/realtime/context";

export interface ConsultGroups {
  byRun: Map<string, RunConsultation[]>;
  /** How each answer's notice draws: hidden under a reply close by, one line to a reply farther up, its card. */
  folds: ReadonlyMap<string, ConsultNoticeFold>;
  /** Runs whose block shows their questions near the end: the working line doesn't say them again. */
  nearEnd: ReadonlySet<string>;
  /** Runs drawn as live blocks: a message the run already posted leaves the block to the live one. */
  live: ReadonlySet<string>;
}

const EMPTY: ConsultGroups = { byRun: new Map(), folds: new Map(), nearEnd: new Set(), live: new Set() };
const ConsultGroupsContext = createContext<ConsultGroups>(EMPTY);
export const ConsultGroupsProvider = ConsultGroupsContext.Provider;

const RELOAD_ON = new Set(["agent.consulting", "agent.consulted", "agent.consultation"]);

/**
 * The conversation's questions to other agents, by the run that asked; reloaded when one changes. `rows`: the
 * messages drawn here, in order; `live`: the runs drawn as live blocks after them. Both show their questions:
 * the answers' notices close to them fold, and the working line leaves out the ones near the end.
 */
export function useConsultGroups(
  channelId: string,
  rows: readonly ConsultRow[],
  live: ReadonlySet<string>,
): ConsultGroups {
  const { org } = useOrg();
  const qc = useQueryClient();
  const list = useConsultations(org.id, channelId);
  useChannelEvents(channelId, true, (event) => {
    if (RELOAD_ON.has(event.type)) void qc.invalidateQueries({ queryKey: keys.consultations(org.id, channelId) });
  });
  return useMemo(() => {
    const all = list.data ?? [];
    if (all.length === 0) return EMPTY;
    return {
      byRun: groupsByRun(all),
      folds: consultNoticeFolds(rows, all, live),
      nearEnd: consultBlocksNearEnd(rows, all, live),
      live,
    };
  }, [list.data, rows, live]);
}

const BLOCK_STATE: Record<ConsultLineState, ToolBlockState> = {
  working: "run",
  waiting: "run",
  // Paused until its computer comes back, still out: the same mark as at work.
  offline: "run",
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
    case "offline":
      return t("chat.consultGroup.waitingComputer", { name: to.name, The: to.The });
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
 * person or for its computer, answered with the start of the answer, couldn't), each opening to the question and
 * the full answer.
 */
export function ConsultGroup({
  runId,
  askerId,
  color,
  saved = false,
}: {
  runId: string;
  askerId: string;
  color?: AgentColor;
  /** On a message the run posted: while the run still works, its live block below draws the questions. */
  saved?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const groups = useContext(ConsultGroupsContext);
  const group = saved && groups.live.has(runId) ? undefined : groups.byRun.get(runId);
  // "Ver" on an answer's line farther down: the block opens at that answer.
  const asked = useConsultBlockRequest(group && group.length > 0 ? runId : null);
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
        defaultOpen: asked?.consultationId === c.id,
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
      // Open while answers are out; it folds by itself once the last one is in (a click opens it again). Asked
      // to open from an answer's line: open again, at that answer.
      key={`${summary.open ? "out" : "in"}${asked ? `:${asked.at}` : ""}`}
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
      defaultOpen={summary.open || asked !== null}
    />
  );
}

/**
 * An answer to a question asked in a reply farther up (`consultNoticeFolds`): one quiet line where the answer
 * arrived, "Atlas respondeu à pergunta da Ada · Ver", that goes to that reply (as a quote does) and opens its
 * block at the answer. The words of the answer stay in the block, not here.
 */
export function ConsultAnswerLine({
  message,
  fold,
}: {
  message: Message;
  fold: Extract<ConsultNoticeFold, { fold: "line" }>;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const c = fold.consultation;
  const from = agentGrammar(t, dir.agentById.get(c.agentId)?.name ?? t("channel.unknownAgent"));
  const to = dir.agentById.get(c.consultedAgentId)?.name ?? t("channel.unknownAgent");
  return (
    <div className="cn-line ac-iconline" data-message-id={message.id}>
      <Icon name="agent" size={14} />
      <span className="cn-line__text">
        {t("chat.consultGroup.answeredFar", { to, from: from.name, of: from.of })} ·{" "}
        {formatTime(i18n.language, message.createdAt)}
        {" · "}
        <button
          type="button"
          className="cn-line__toggle"
          onClick={() => {
            requestConsultBlock(c.runId, c.id);
            actions?.jumpTo?.(fold.messageId);
          }}
        >
          {t("chat.consultGroup.see")}
        </button>
      </span>
    </div>
  );
}
