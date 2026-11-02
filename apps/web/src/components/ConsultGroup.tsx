import {
  keys,
  type Message,
  type MessageConsultation,
  type RunConsultation,
  useConsultations,
} from "@agenteschat/client";
import {
  type ConsultLineState,
  type ConsultNoticeFold,
  type ConsultRow,
  consultAskedKey,
  consultBlocksNearEnd,
  consultLineKey,
  consultLineState,
  consultNoticeFolds,
  consultSeconds,
  groupsByRun,
  openableConsultation,
  talkState,
  talkStateOf,
  talkStatus,
} from "@agenteschat/client/lib/consult-group";
import { withoutRelayLine } from "@agenteschat/client/lib/consultations";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatLineTime } from "@agenteschat/client/lib/work";
import { cx, Icon } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { createContext, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { AgentAvatar, withAgentFace } from "@/components/AgentAvatar";
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
/** The question open in the panel beside the conversation, if any (a card or a line that opens it shows pressed). */
export const useOpenConsultation = () => useContext(ConsultGroupsContext).open;

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

/** A question's state in words, the same in the panel ("A Iris espera uma aprovação"). */
export const consultLineLabel = (
  t: TFunction,
  state: ConsultLineState,
  c: RunConsultation,
  to: ReturnType<typeof agentGrammar>,
) => t(consultLineKey(state, c), { name: to.name, context: to.context });

/** The conversation's question by its id, as the list loaded it (null when it isn't there). */
const consultationById = (groups: ConsultGroups, id: string | null) =>
  id ? ([...groups.byRun.values()].flat().find((c) => c.id === id) ?? null) : null;

/**
 * Two agents talking, as one pill: the asker's face, the arrows, the other's face, then "Caio ⇄ Theo · respondeu em
 * 8 s" (still out it counts the time; no answer says so). A click opens their conversation in the panel beside the
 * channel, as a thread opens; where there is no panel (a thread view) it opens what was asked and answered under it.
 * The live state comes from the conversation's questions (`useConsultGroups`); a stored card gives the rest.
 */
export function AgentTalkPill({
  consultationId,
  fromId,
  toId,
  stored,
}: {
  consultationId?: string | null;
  fromId: string;
  toId: string;
  /** What a stored card knows of it (`meta.consulted`, a `consult_reply` notice), when the list lacks it. */
  stored?: Pick<MessageConsultation, "status" | "question" | "answer" | "kind">;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const groups = useContext(ConsultGroupsContext);
  const openPanel = useChannelActions()?.openConsultation;
  const id = openableConsultation(consultationId);
  const run = consultationById(groups, id);
  const now = useNow(run?.status === "open");
  const [open, setOpen] = useState(false);
  const from = dir.agentById.get(fromId)?.name ?? t("channel.unknownAgent");
  const to = dir.agentById.get(toId)?.name ?? t("channel.unknownAgent");
  const state = run ? talkState(consultLineState(run, now)) : stored ? talkStateOf(stored.status, stored.answer) : null;
  const status = state
    ? talkStatus(state, run ? formatLineTime(i18n.language, consultSeconds(run, now) * 1000) : null)
    : null;
  const names = t("chat.consultPanel.title", { from, to });
  const said = status ? t(status.key, status.values) : null;
  const talk = run ?? stored;
  const inPanel = Boolean(id && openPanel);
  return (
    <>
      <button
        type="button"
        className={cx("ac-talk", state && `ac-talk--${state}`)}
        aria-label={[t("chat.consultPanel.label", { from, to }), said].filter(Boolean).join(" · ")}
        aria-pressed={inPanel && groups.open === id ? true : undefined}
        aria-expanded={inPanel || !talk ? undefined : open}
        disabled={!inPanel && !talk}
        onClick={() => (inPanel && id ? openPanel?.(id) : setOpen((o) => !o))}
      >
        <span className="ac-talk__faces" aria-hidden="true">
          <AgentAvatar agentId={fromId} size="xs" name={from} state="idle" />
          <Icon name="swap" size={14} />
          <AgentAvatar agentId={toId} size="xs" name={to} state={state === "waiting" ? "thinking" : "idle"} />
        </span>
        <span className="ac-talk__text" aria-hidden="true">
          <span className="ac-talk__names">{names}</span>
          {said && <span className="ac-talk__state"> · {said}</span>}
        </span>
      </button>
      {open && !inPanel && talk && (
        <div className="ac-talk-detail ac-consult__body ac-consult__body--inline">
          <small>{withAgentFace(t(consultAskedKey(talk), { name: from }), from, fromId)}</small>
          <div className="ac-consult__text ac-consult__text--q">
            <MessageBody body={withoutRelayLine(talk.question)} resolveMention={dir.mentionName} />
          </div>
          {state === "answered" && talk.answer && (
            <>
              <small>{t("chat.consultation.answerOf", agentGrammar(to))}</small>
              <div className="ac-consult__text">
                <MessageBody body={talk.answer} resolveMention={dir.mentionName} />
              </div>
            </>
          )}
          <p className="ac-consult__foot ac-iconline">
            <Icon name="eyeOff" size={14} />
            {t("chat.consultation.private", { from, to })}
          </p>
        </div>
      )}
    </>
  );
}

/**
 * The questions the agent asked other agents in this turn (`ask_agent`) and the work it handed them (`tell_agent`),
 * inside its reply: one pill per agent (`AgentTalkPill`), each opening the two agents' conversation.
 */
export function ConsultGroup({
  runId,
  askerId,
  saved = false,
}: {
  runId: string;
  askerId: string;
  /** On a message the run posted: while the run still works, its live block below draws the questions. */
  saved?: boolean;
}) {
  const groups = useContext(ConsultGroupsContext);
  const group = saved && groups.live.has(runId) ? undefined : groups.byRun.get(runId);
  if (!group || group.length === 0) return null;
  return (
    <div className="ac-talks ac-consult-group">
      {group.map((c) => (
        <AgentTalkPill key={c.id} consultationId={c.id} fromId={askerId} toId={c.consultedAgentId} />
      ))}
    </div>
  );
}

/**
 * An answer to a question asked in a reply farther up (`consultNoticeFolds`): the two agents' pill where the answer
 * arrived, opening their conversation. The words of the answer stay there, not here.
 */
export function ConsultAnswerLine({
  message,
  fold,
}: {
  message: Message;
  fold: Extract<ConsultNoticeFold, { fold: "line" }>;
}) {
  const c = fold.consultation;
  return (
    <div className="ac-talks" data-message-id={message.id}>
      <AgentTalkPill consultationId={c.id} fromId={c.agentId} toId={c.consultedAgentId} />
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
  const from = agentGrammar(dir.agentById.get(c.agentId)?.name ?? t("channel.unknownAgent"));
  return (
    <span className="msg-reminder msg-talker">
      {withAgentFace(t("chat.consultPanel.helping", { name: from.name, context: from.context }), from.name, c.agentId)}
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
