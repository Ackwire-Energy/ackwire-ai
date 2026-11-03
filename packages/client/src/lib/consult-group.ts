import { useEffect, useState } from "react";
import type { RunConsultation } from "../api/types";
import { previewOf } from "./consultations";
import { noticeOf } from "./notices";

/**
 * The questions an agent asked other agents in one turn, and the work it handed them, drawn inside the reply of
 * that turn ("Perguntou a 3 colegas", "Passou para 1 colega"): one line per agent with where it is, and the answer
 * under it (ADR 0034, ADR 0095). The answers also arrive as `consult_reply` notices; the ones a reply close by
 * already shows fold away (`consultNoticeFolds`), and the working line leaves out what such a block already says
 * (`consultsForLine`).
 */

/**
 * Where one question is, for its line. `waiting`: the consulted agent waits on a person; `offline`: for its
 * computer or its AI provider to come back (still out, paused, on no one); `handedOn`: its part done, it waits on
 * agents it handed some to.
 */
export type ConsultLineState = "working" | "waiting" | "offline" | "handedOn" | "answered" | "failed" | "expired";

/**
 * Reloads the list this often while a question is out (a consulted agent that stops waiting sends no event), so the
 * work handed off shows moving (`progress`).
 */
export const CONSULT_GROUP_POLL_MS = 10_000;

/**
 * What an open line shows of the work so far (ADR 0097): how many messages the consulted agent posted in the agents'
 * DM and the start of the latest ("12 mensagens · Gerei a imagem 40"), or null. Answered lines show the answer.
 */
export function consultProgress(c: Pick<RunConsultation, "status" | "progress">) {
  return c.status === "open" && c.progress && c.progress.posts > 0
    ? {
        key: "chat.consultGroup.posted" as const,
        values: { count: c.progress.posts, latest: previewOf(c.progress.latest) },
      }
    : null;
}

/** An opened question reloads this often while it's out: its agents' DM sends the page no events. */
export const CONSULT_CONVERSATION_POLL_MS = 4_000;

export function consultLineState(c: RunConsultation, now: number): ConsultLineState {
  if (c.status === "answered") return c.answer?.trim() ? "answered" : "failed";
  if (c.status === "failed") return "failed";
  if (c.status === "expired") return "expired";
  // Past its deadline the worker closes it within a minute: show it as it will be.
  if (Date.parse(c.expiresAt) < now) return "expired";
  if (c.waiting === "computer" || c.waiting === "outage") return "offline";
  if (c.waiting === "agents") return "handedOn";
  return c.waiting ? "waiting" : "working";
}

const isNote = (c: Pick<RunConsultation, "kind">) => c.kind === "note";

/** A line's words by its state, the same in the reply's block, the panel and the phone's screen. */
export function consultLineKey(state: ConsultLineState, c: Pick<RunConsultation, "waiting" | "kind">) {
  switch (state) {
    case "working":
      return "chat.consultGroup.working" as const;
    case "waiting":
      return c.waiting === "approval"
        ? ("chat.consultGroup.waitingApproval" as const)
        : ("chat.consultGroup.waitingInput" as const);
    case "offline":
      return c.waiting === "outage"
        ? ("chat.consultGroup.waitingProvider" as const)
        : ("chat.consultGroup.waitingComputer" as const);
    case "handedOn":
      return "chat.consultGroup.waitingAgents" as const;
    case "answered":
      return "chat.consultation.answered" as const;
    case "expired":
      return "chat.consultation.expired" as const;
    default:
      return isNote(c) ? ("chat.consultation.failedNote" as const) : ("chat.consultation.failed" as const);
  }
}

/**
 * A block's head and label by what its run did: only questions "Perguntou a 3 colegas", only work handed off
 * "Passou para 2 colegas", both "Chamou 3 colegas"; with any work in it, the label says requests.
 */
export function consultGroupKeys(group: readonly Pick<RunConsultation, "kind">[]) {
  const notes = group.filter(isNote).length;
  if (notes === 0) return { head: "chat.consultGroup.asked", label: "chat.consultGroup.label" } as const;
  return {
    head: notes === group.length ? "chat.consultGroup.handed" : "chat.consultGroup.brought",
    label: "chat.consultGroup.labelRequests",
  } as const;
}

/** Over the asking agent's words: what it asked, or what it handed off ("Theo escreveu"). */
export const consultAskedKey = (c: Pick<RunConsultation, "kind">) =>
  isNote(c) ? ("chat.consultation.wrote" as const) : ("chat.consultation.asked" as const);

/** Where the opened conversation came from, in a channel or a DM. */
export const consultOriginKey = (c: Pick<RunConsultation, "kind">, inChannel: boolean) =>
  isNote(c)
    ? inChannel
      ? ("chat.consultPanel.originNote" as const)
      : ("chat.consultPanel.originNoteDm" as const)
    : inChannel
      ? ("chat.consultPanel.origin" as const)
      : ("chat.consultPanel.originDm" as const);

/** The quiet line of an answer whose reply is farther up. */
export const consultFarKey = (c: Pick<RunConsultation, "kind">) =>
  isNote(c) ? ("chat.consultGroup.answeredRequestFar" as const) : ("chat.consultGroup.answeredFar" as const);

/** The conversation's questions by the run that asked them, each run's oldest first. */
export function groupsByRun(list: readonly RunConsultation[]): Map<string, RunConsultation[]> {
  const out = new Map<string, RunConsultation[]>();
  for (const c of list) {
    const group = out.get(c.runId);
    if (group) group.push(c);
    else out.set(c.runId, [c]);
  }
  for (const group of out.values()) group.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return out;
}

export interface ConsultGroupSummary {
  total: number;
  /** Answered, failed or expired. */
  closed: number;
  answered: number;
  /** Some question is still out: the block opens and the count shows. */
  open: boolean;
  /** Some consulted agent waits on a person (one waiting for its computer doesn't count). */
  waiting: boolean;
}

export function consultGroupSummary(group: readonly RunConsultation[], now: number): ConsultGroupSummary {
  let closed = 0;
  let answered = 0;
  let waiting = false;
  for (const c of group) {
    const s = consultLineState(c, now);
    if (s === "answered") answered++;
    if (s === "answered" || s === "failed" || s === "expired") closed++;
    if (s === "waiting") waiting = true;
  }
  return { total: group.length, closed, answered, open: closed < group.length, waiting };
}

/**
 * The questions a reply in view shows: those of runs with a message (or a live block) loaded here. A notice
 * whose asking reply isn't loaded (further up, not paged in yet) keeps its card, so no answer goes unseen.
 */
export function shownConsultations(
  list: readonly RunConsultation[],
  runsInView: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(list.flatMap((c) => (runsInView.has(c.runId) ? [c.id] : [])));
}

/** A `consult_reply` notice whose question a reply here already shows with its answer: not drawn again. */
export function foldsNotice(meta: Record<string, unknown> | undefined, shown: ReadonlySet<string>): boolean {
  const notice = noticeOf(meta);
  if (notice?.kind !== "consult_reply") return false;
  const id = notice.refs.consultationId;
  return Boolean(id && shown.has(id));
}

/**
 * How many rows away the reply that asked may sit and still stand in for the rest: an answer's notice that close
 * to it folds away, and with it among the last rows the working line doesn't repeat its questions. About what a
 * phone shows above the box: farther up, a person reading the newest messages doesn't see the block.
 */
export const CONSULT_NEAR_ROWS = 3;

/** A row of the conversation as drawn, in order: a message (a notice too). */
export interface ConsultRow {
  id: string;
  agentRunId?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * How an answer's `consult_reply` notice draws: not at all (the reply that asked is close and shows the answer),
 * one line leading to that reply when it is farther up ("Atlas respondeu à pergunta da Ada · Ver": the answer
 * arriving still leaves a sign where the person reads), or its own card when that reply isn't here.
 */
export type ConsultNoticeFold =
  | { fold: "hide" }
  | { fold: "card" }
  | {
      fold: "line";
      consultation: RunConsultation;
      /** The asking run's message nearest the notice: "Ver" goes there and opens the block. */
      messageId: string;
    };

const NO_RUNS: ReadonlySet<string> = new Set();

/**
 * Where each asking run sits among the rows people see. A notice whose answer a reply here shows takes no row
 * (hidden, or one line): answers to several questions in a row don't push their reply away.
 */
/**
 * Which of a run's messages draws its block: the web draws it on the run's last message, the phone on its first
 * (its rows don't know their neighbours, `firstOfRun`). Distances and "Ver" go to that one message.
 */
export type ConsultAnchor = "first" | "last";

function consultLayout(
  rows: readonly ConsultRow[],
  list: readonly RunConsultation[],
  live: ReadonlySet<string>,
  anchor: ConsultAnchor,
) {
  const byId = new Map(list.map((c) => [c.id, c] as const));
  const shown = shownConsultations(list, new Set([...live, ...rows.flatMap((r) => r.agentRunId ?? [])]));
  /** Each run's rows: its place among the rows people see, and the message. */
  const places = new Map<string, { at: number; id: string }[]>();
  /** Answers' notices, each between the rows `at - 1` and `at`; `consultation` null: it draws its card. */
  const notices: { id: string; at: number; consultation: RunConsultation | null }[] = [];
  let count = 0;
  for (const row of rows) {
    const notice = noticeOf(row.meta);
    if (notice?.kind === "consult_reply") {
      const consultation = byId.get(notice.refs.consultationId ?? "") ?? null;
      const folds = consultation !== null && foldsNotice(row.meta, shown);
      notices.push({ id: row.id, at: count, consultation: folds ? consultation : null });
      if (folds) continue;
    }
    if (row.agentRunId) {
      const own = places.get(row.agentRunId);
      if (own) own.push({ at: count, id: row.id });
      else places.set(row.agentRunId, [{ at: count, id: row.id }]);
    }
    count++;
  }
  // Only the message that draws the block counts: a run that posted several shows its questions on one of them.
  for (const [runId, own] of places) {
    const one = anchor === "first" ? own[0] : own.at(-1);
    if (one) places.set(runId, [one]);
  }
  return { count, places, notices };
}

/**
 * How each answer's notice draws here (every `consult_reply` row, by message id). `rows`: the conversation's
 * messages in order; `live`: the runs drawn as live blocks under them (at the end, where the newest answers land:
 * their notices fold); `anchor`: the run's message that draws its block. Close is `CONSULT_NEAR_ROWS` rows at most,
 * on either side.
 */
export function consultNoticeFolds(
  rows: readonly ConsultRow[],
  list: readonly RunConsultation[],
  live: ReadonlySet<string> = NO_RUNS,
  anchor: ConsultAnchor = "last",
): Map<string, ConsultNoticeFold> {
  const out = new Map<string, ConsultNoticeFold>();
  const { places, notices } = consultLayout(rows, list, live, anchor);
  for (const n of notices) {
    const c = n.consultation;
    if (!c) {
      out.set(n.id, { fold: "card" });
      continue;
    }
    if (live.has(c.runId)) {
      out.set(n.id, { fold: "hide" });
      continue;
    }
    let near: { distance: number; id: string } | null = null;
    for (const p of places.get(c.runId) ?? []) {
      const distance = p.at < n.at ? n.at - p.at : p.at - n.at + 1;
      if (!near || distance < near.distance) near = { distance, id: p.id };
    }
    if (!near) out.set(n.id, { fold: "card" });
    else if (near.distance <= CONSULT_NEAR_ROWS) out.set(n.id, { fold: "hide" });
    else out.set(n.id, { fold: "line", consultation: c, messageId: near.id });
  }
  return out;
}

/**
 * The asking runs whose block shows their questions near the end of the conversation, right above the working
 * line: a reply among the last `CONSULT_NEAR_ROWS` rows, or a live block.
 */
export function consultBlocksNearEnd(
  rows: readonly ConsultRow[],
  list: readonly RunConsultation[],
  live: ReadonlySet<string> = NO_RUNS,
  anchor: ConsultAnchor = "last",
): Set<string> {
  const asked = new Set(list.map((c) => c.runId));
  const out = new Set([...live].filter((runId) => asked.has(runId)));
  const { count, places } = consultLayout(rows, list, live, anchor);
  for (const [runId, own] of places) {
    const last = own.at(-1);
    if (asked.has(runId) && last && count - last.at <= CONSULT_NEAR_ROWS) out.add(runId);
  }
  return out;
}

/**
 * The live questions the working line still says ("Dev está perguntando ao Infra… 0:41"): not those of a run whose
 * block, near the end, shows every question with where it is and its clock. The asker's own work stays on the
 * line. With the reply farther up or not loaded, the line is the only sign that a question is out.
 */
export function consultsForLine<T extends { runId: string }>(live: T[], blocks: ReadonlySet<string>): T[] {
  return blocks.size === 0 ? live : live.filter((c) => !blocks.has(c.runId));
}

/**
 * "Ver" on an answer's line: the reply that asked opens its block at that answer. A request waits for the block
 * it names (the reply may not be drawn yet: the phone draws rows as they scroll in) and is used once.
 */
export interface ConsultBlockRequest {
  runId: string;
  consultationId: string;
  at: number;
}

/** A request older than this is stale (the reply never came into view): it opens nothing later. */
export const CONSULT_REQUEST_FRESH_MS = 10_000;

let pendingRequest: ConsultBlockRequest | null = null;
const requestListeners = new Set<() => void>();

export function requestConsultBlock(runId: string, consultationId: string, now = Date.now()) {
  pendingRequest = { runId, consultationId, at: now };
  for (const listener of requestListeners) listener();
}

/** The request waiting for this run's block, once (it is then used up); a stale one goes. */
export function takeConsultBlockRequest(runId: string, now = Date.now()): ConsultBlockRequest | null {
  const r = pendingRequest;
  if (!r) return null;
  if (now - r.at > CONSULT_REQUEST_FRESH_MS) {
    pendingRequest = null;
    return null;
  }
  if (r.runId !== runId) return null;
  pendingRequest = null;
  return r;
}

/** The last request for this run's block (it opens at that answer), else null. `runId` null: not listening. */
export function useConsultBlockRequest(runId: string | null): ConsultBlockRequest | null {
  const [hit, setHit] = useState<ConsultBlockRequest | null>(null);
  useEffect(() => {
    if (!runId) return;
    const check = () => {
      const r = takeConsultBlockRequest(runId);
      if (r) setHit(r);
    };
    check();
    requestListeners.add(check);
    return () => {
      requestListeners.delete(check);
    };
  }, [runId]);
  // A row drawn again for another run keeps no request of the one before.
  return hit?.runId === runId ? hit : null;
}

/**
 * Two agents talking (a question, work handed off, its answer) as one pill: "Caio ⇄ Theo · respondeu em 8 s". Its
 * state: still out, answered, or no answer (failed or expired).
 */
export type TalkState = "waiting" | "answered" | "failed";

export const talkState = (state: ConsultLineState): TalkState =>
  state === "answered" ? "answered" : state === "failed" || state === "expired" ? "failed" : "waiting";

/** What a stored card knows (`meta.consulted`, a `consult_reply` notice): how it ended. */
export const talkStateOf = (status: string, answer: string | null | undefined): TalkState =>
  status === "answered" && answer?.trim() ? "answered" : status === "open" ? "waiting" : "failed";

/** The pill's words after the names, with the time (`formatLineTime`) when it is known. */
export function talkStatus(state: TalkState, time: string | null) {
  if (state === "failed") return { key: "chat.agentTalk.failed" as const, values: {} };
  if (state === "answered")
    return time
      ? { key: "chat.agentTalk.answeredIn" as const, values: { time } }
      : { key: "chat.agentTalk.answered" as const, values: {} };
  return time
    ? { key: "chat.agentTalk.waitingFor" as const, values: { time } }
    : { key: "chat.agentTalk.waiting" as const, values: {} };
}

/** A stored card's id that opens the two agents' conversation: not the stand-in `consultationsOf` makes for none. */
export const openableConsultation = (id: string | null | undefined) => (id && !id.includes(":") ? id : null);

/** Seconds since the question went out (while open) or until it closed. */
export function consultSeconds(c: RunConsultation, now: number): number {
  const end = c.answeredAt ? Date.parse(c.answeredAt) : now;
  return Math.max(0, Math.round((end - Date.parse(c.createdAt)) / 1000));
}

/**
 * The reply that shows its run's questions when a run posted several (the phone's rows don't know their
 * neighbours): the run's first message, which stays first as later ones arrive.
 */
export function firstOfRun(
  messages: readonly { id: string; agentRunId?: string | null; createdAt: string }[],
  runId: string,
): string | null {
  let first: { id: string; createdAt: string } | null = null;
  for (const m of messages)
    if (m.agentRunId === runId && (!first || Date.parse(m.createdAt) < Date.parse(first.createdAt))) first = m;
  return first?.id ?? null;
}

/**
 * Where "Ver" on an answer's line goes on the phone: the message that draws the asking run's block (its first,
 * `firstOfRun`), not the run's message nearest the notice when the run posted several; that one if none of the
 * run's messages is among `messages`.
 */
export function consultLineTarget(
  messages: readonly { id: string; agentRunId?: string | null; createdAt: string }[],
  fold: Extract<ConsultNoticeFold, { fold: "line" }>,
): string {
  return firstOfRun(messages, fold.consultation.runId) ?? fold.messageId;
}
