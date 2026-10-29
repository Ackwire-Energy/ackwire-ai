import type { RunConsultation } from "../api/types";
import { noticeOf } from "./notices";

/**
 * The questions an agent asked other agents in one turn, drawn inside the reply of that turn ("Perguntou a 3
 * colegas"): one line per agent with where it is, and the answer under it. The answers also arrive as
 * `consult_reply` notices; the ones a reply already shows fold away (`foldsNotice`).
 */

/** Where one question is, for its line. */
export type ConsultLineState = "working" | "waiting" | "answered" | "failed" | "expired";

/** Reloads the list this often while a question is out (a consulted agent that stops waiting sends no event). */
export const CONSULT_GROUP_POLL_MS = 20_000;

export function consultLineState(c: RunConsultation, now: number): ConsultLineState {
  if (c.status === "answered") return c.answer?.trim() ? "answered" : "failed";
  if (c.status === "failed") return "failed";
  if (c.status === "expired") return "expired";
  // Past its deadline the worker closes it within a minute: show it as it will be.
  if (Date.parse(c.expiresAt) < now) return "expired";
  return c.waiting ? "waiting" : "working";
}

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
  /** Some consulted agent waits on a person. */
  waiting: boolean;
}

export function consultGroupSummary(group: readonly RunConsultation[], now: number): ConsultGroupSummary {
  let closed = 0;
  let answered = 0;
  let waiting = false;
  for (const c of group) {
    const s = consultLineState(c, now);
    if (s === "answered") answered++;
    if (s !== "working" && s !== "waiting") closed++;
    if (s === "waiting") waiting = true;
  }
  return { total: group.length, closed, answered, open: closed < group.length, waiting };
}

/** A `consult_reply` notice whose question a reply here already shows with its answer: not drawn again. */
export function foldsNotice(meta: Record<string, unknown> | undefined, shown: ReadonlySet<string>): boolean {
  const notice = noticeOf(meta);
  if (notice?.kind !== "consult_reply") return false;
  const id = notice.refs.consultationId;
  return Boolean(id && shown.has(id));
}

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
