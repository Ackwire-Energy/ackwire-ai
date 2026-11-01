import { keys, type Message, type RunConsultation, useConsultations } from "@agenteschat/client";
import {
  type ConsultLineState,
  type ConsultNoticeFold,
  type ConsultRow,
  consultAskedKey,
  consultBlocksNearEnd,
  consultFarKey,
  consultGroupKeys,
  consultGroupSummary,
  consultLineKey,
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
  /** The question open in the panel beside the conversation: its line shows pressed. */
  open: string | null;
  /** By the consulted agent's run: the question it answers, so its cards here say whom it helps. */
  helping: ReadonlyMap<string, RunConsultation>;
}

const EMPTY: ConsultGroups = {
  byRun: new Map(),
  folds: new Map(),
  nearEnd: new Set(),
  live: new Set(),
  open: null,
  helping: new Map(),
};
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
  open: string | null = null,
): ConsultGroups {
  const { org } = useOrg();
  const qc = useQueryClient();
  const list = useConsultations(org.id, channelId);
  useChannelEvents(channelId, true, (event) => {
    if (RELOAD_ON.has(event.type)) void qc.invalidateQueries({ queryKey: keys.consultations(org.id, channelId) });
  });
  // Its own memo: opening a question doesn't hand every row a new map.
  const helping = useMemo(() => {
    const out = new Map<string, RunConsultation>();
    // Latest first: a run answering two questions says the latest.
    for (const c of list.data ?? []) if (c.consultedRunId && !out.has(c.consultedRunId)) out.set(c.consultedRunId, c);
    return out;
  }, [list.data]);
  return useMemo(() => {
    const all = list.data ?? [];
    if (all.length === 0) return EMPTY;
    return {
      byRun: groupsByRun(all),
      folds: consultNoticeFolds(rows, all, live),
      nearEnd: consultBlocksNearEnd(rows, all, live),
      live,
      open,
      helping,
    };
  }, [list.data, rows, live, open, helping]);
}

const BLOCK_STATE: Record<ConsultLineState, ToolBlockState> = {
  working: "run",
  waiting: "run",
  // Paused until its computer comes back, or on what it handed on, still out: the same mark as at work.
  offline: "run",
  handedOn: "run",
  answered: "done",
  failed: "fail",
  expired: "fail",
};

/** A question's state in words, the same in the reply's block and in the panel ("A Iris espera uma aprovação"). */
export const consultLineLabel = (
  t: TFunction,
  state: ConsultLineState,
  c: RunConsultation,
  to: ReturnType<typeof agentGrammar>,
) => t(consultLineKey(state, c), { name: to.name, The: to.The });

/**
 * The questions the agent asked other agents in this turn (`ask_agent`) and the work it handed them (`tell_agent`),
 * inside its reply, as one more step of its work: "Perguntou a 3 colegas · 1 de 3" (or "Passou para 1 colega",
 * "Chamou 3 colegas") while answers are out, a line per agent (working, waiting on a person, for its computer or on
 * what it handed on, answered with the start of the answer, couldn't), each opening to what was asked or handed and
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
  // In a channel each line opens the two agents' conversation in the panel; in a thread view, in place.
  const openConsultation = useChannelActions()?.openConsultation;
  const group = saved && groups.live.has(runId) ? undefined : groups.byRun.get(runId);
  // "Ver" on an answer's line farther down: the block opens at that answer.
  const asked = useConsultBlockRequest(group && group.length > 0 ? runId : null);
  const live = group?.some((c) => c.status === "open") ?? false;
  const now = useNow(live);
  if (!group || group.length === 0) return null;
  const summary = consultGroupSummary(group, now);
  const words = consultGroupKeys(group);
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
        label: consultLineLabel(t, state, c, to),
        hint: answer ? previewOf(answer) : null,
        time: formatLineTime(i18n.language, consultSeconds(c, now) * 1000),
        defaultOpen: asked?.consultationId === c.id,
        onOpen: openConsultation ? () => openConsultation(c.id) : undefined,
        pressed: groups.open === c.id,
        // The consultation card's words and type (prose, never the tools' mono): the question, the answer, who saw it.
        detail: openConsultation ? undefined : (
          <div className="ac-consult__body ac-consult__body--inline">
            <small>{t(consultAskedKey(c), { name: from.name })}</small>
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
        text: t(words.head, { count: summary.total }),
        state: summary.open ? "run" : undefined,
        count: summary.open
          ? t("chat.consultGroup.progress", { done: summary.closed, total: summary.total })
          : undefined,
      }}
      items={items}
      color={color}
      label={t(words.label, { name: from.name, of: from.of })}
      defaultOpen={summary.open || asked !== null}
    />
  );
}

/**
 * An answer to a question asked in a reply farther up (`consultNoticeFolds`): one quiet line where the answer
 * arrived, "Atlas respondeu à pergunta da Ada · Ver", that opens the two agents' conversation over the channel (in
 * a thread view: goes to that reply, as a quote does, and opens its block at the answer). The words of the answer
 * stay there, not here.
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
        {t(consultFarKey(c), { to, from: from.name, of: from.of })} · {formatTime(i18n.language, message.createdAt)}
        {" · "}
        <button
          type="button"
          className="cn-line__toggle"
          onClick={() => {
            // In a channel: the two agents' conversation, beside it. In a thread view: the reply's block, there.
            if (actions?.openConsultation) {
              actions.openConsultation(c.id);
              return;
            }
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

/**
 * On a card the consulted agent posted here (its approval, question or secret request): whom it is helping, and
 * "Ver conversa" opening the two agents' conversation over the channel ("ajudando o Theo · Ver conversa").
 */
export function ConsultHelpingTag({ consultation: c }: { consultation: RunConsultation }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const from = agentGrammar(t, dir.agentById.get(c.agentId)?.name ?? t("channel.unknownAgent"));
  return (
    <span className="msg-reminder msg-talker">
      {t("chat.consultPanel.helping", { name: from.name, article: from.article })}
      {actions?.openConsultation && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="cn-line__toggle" onClick={() => actions.openConsultation?.(c.id)}>
            {t("chat.consultPanel.see")}
          </button>
        </>
      )}
    </span>
  );
}
