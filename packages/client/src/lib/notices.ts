import type { ConsultationStatus, MessageConsultation } from "../api/types";
import { routineReplyOf } from "./routines";

type Meta = Record<string, unknown> | undefined;

/** What reached the agent's conversation (packages/engine/src/notices.ts). */
export type NoticeKind =
  | "routine_handoff"
  | "consult_reply"
  | "agent_note"
  | "wait_result"
  | "talker_reply"
  | "follow_up";

/**
 * An event an agent's conversation got (`meta.notice`): its routine's report,
 * another agent's answer or note, the late result of a wait. The agent reads
 * it as an event, never as a person's words; people see one compact line,
 * the text on demand. `from` is written for the agent ("@infra"), so the app
 * prefers its own words.
 */
export interface MessageNotice {
  kind: NoticeKind | (string & {});
  text: string;
  from: string | null;
  refs: Record<string, string>;
}

/** The notice card of a message, or null (none, or a fast reply that shows as a normal message). */
export function noticeOf(meta: Meta): MessageNotice | null {
  const n = meta?.notice as { kind?: unknown; text?: unknown; from?: unknown; refs?: unknown } | undefined;
  if (!n || typeof n !== "object" || typeof n.kind !== "string" || typeof n.text !== "string") return null;
  if (n.kind === "talker_reply" || isTalkerReply(meta)) return null;
  const refs: Record<string, string> = {};
  if (n.refs && typeof n.refs === "object") {
    for (const [k, v] of Object.entries(n.refs)) if (typeof v === "string") refs[k] = v;
  }
  return { kind: n.kind, text: n.text, from: typeof n.from === "string" && n.from ? n.from : null, refs };
}

/**
 * A short reply the agent gave while its task kept working (`meta.talker`, or a `talker_reply`
 * notice): shown as its normal message, with a quiet "enquanto trabalha".
 */
export function isTalkerReply(meta: Meta): boolean {
  const talker = meta?.talker as { runId?: unknown } | undefined;
  if (talker && typeof talker === "object") return true;
  return (meta?.notice as { kind?: unknown } | undefined)?.kind === "talker_reply";
}

/** The routine a report came from: the notice's refs, or the «name» in `from`. */
export function noticeRoutineName(notice: MessageNotice): string | null {
  if (notice.refs.routineName) return notice.refs.routineName;
  return notice.from?.match(/«([^»]+)»/)?.[1] ?? null;
}

/** "@infra" in `from` (or `refs.agentHandle`): the other agent's handle, to show its name. */
export function noticeAgentHandle(notice: MessageNotice): string | null {
  const handle = notice.refs.agentHandle ?? notice.from?.match(/^@([\w.-]+)$/)?.[1];
  return handle ? handle.replace(/^@/, "") : null;
}

/** An automatic line in the conversation (a notice): nothing groups with it. */
export const isEventLine = (meta: Meta) => noticeOf(meta) !== null;

/**
 * An agent's follow-up (`follow_up`), as its line reads: the one it set ("Ari volta às 18:30 para ver o CI",
 * `pending` while it can still be canceled), the same once canceled, or at its time the one that woke it
 * ("Ari voltou para ver o CI"). `key`/`values` are the shared i18n; `time` formats its time for the reader.
 */
export function followUpLine(notice: MessageNotice, name: string, time: (iso: string) => string) {
  if (notice.kind !== "follow_up") return null;
  const { at = "", about = "", state, wake } = notice.refs;
  const values = { name, about, time: at ? time(at) : "" };
  if (wake) return { key: "chat.notice.followUpWake" as const, values, pending: false };
  if (state === "canceled") return { key: "chat.notice.followUpCanceled" as const, values, pending: false };
  return { key: "chat.notice.followUp" as const, values, pending: state === "pending" };
}

const CONSULTATION_STATUSES: ReadonlySet<string> = new Set<ConsultationStatus>(["answered", "expired", "failed"]);

/**
 * Another agent's answer that carries its consultation (`consult_reply` refs: who asked whom, the question and
 * the answer apart): the app shows it as the consultation card, not the text written for the asking agent.
 * Null for older notices without them.
 */
export function consultationOfNotice(meta: Meta): { askerId: string; consultation: MessageConsultation } | null {
  const notice = noticeOf(meta);
  const r = notice?.kind === "consult_reply" ? notice.refs : null;
  if (!r?.askerAgentId || !r.agentId || !r.question || !r.status || !CONSULTATION_STATUSES.has(r.status)) return null;
  return {
    askerId: r.askerAgentId,
    consultation: {
      agentId: r.agentId,
      consultationId: r.consultationId ?? "",
      status: r.status as ConsultationStatus,
      question: r.question,
      answer: r.answer ?? null,
    },
  };
}

type Said = { id: string; author: { type: string }; body: string; meta?: Record<string, unknown> };

/**
 * The routine reports the agent already told people about (ADR 0053 §7): the `noticeId` of every agent
 * message that answers one. Such a `routine_handoff` notice folds into that message (hidden in the
 * timeline); a report nobody answered still shows as its compact line.
 */
export function answeredNotices(messages: readonly Said[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    const noticeId = routineReplyOf(m)?.noticeId;
    if (noticeId) out.add(noticeId);
  }
  return out;
}

/** A routine report answered by an agent's message in `answered`: left out of the timeline. */
export const isAnsweredNotice = (m: Pick<Said, "id" | "meta">, answered: ReadonlySet<string>) =>
  answered.has(m.id) && noticeOf(m.meta)?.kind === "routine_handoff";

/** The report a routine's message answers (its notice's text), when that notice is loaded here. */
export function routineReportText(messages: readonly Said[], noticeId: string | null): string | null {
  if (!noticeId) return null;
  const found = messages.find((m) => m.id === noticeId);
  const notice = found ? noticeOf(found.meta) : null;
  if (!found || !notice) return null;
  return found.body.trim() || notice.text.trim() || null;
}
