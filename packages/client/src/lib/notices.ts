import { routineOfMessage } from "./routines";

type Meta = Record<string, unknown> | undefined;

/** What reached the agent's conversation (packages/engine/src/notices.ts). */
export type NoticeKind = "routine_handoff" | "consult_reply" | "agent_note" | "wait_result" | "talker_reply";

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

/**
 * The message that started a routine's background run (`meta.background` with `meta.routine`):
 * one line, "Rotina «Sentry diário» rodou", never shown as the person's message.
 */
export function backgroundRoutineOf(meta: Meta): { id: string; name: string } | null {
  return meta?.background === true ? routineOfMessage(meta) : null;
}

/** The routine a report came from: the message's `meta.routine`, the notice's refs, or the «name» in `from`. */
export function noticeRoutineName(meta: Meta, notice: MessageNotice): string | null {
  const own = routineOfMessage(meta)?.name ?? notice.refs.routineName;
  if (own) return own;
  return notice.from?.match(/«([^»]+)»/)?.[1] ?? null;
}

/** "@infra" in `from` (or `refs.agentHandle`): the other agent's handle, to show its name. */
export function noticeAgentHandle(notice: MessageNotice): string | null {
  const handle = notice.refs.agentHandle ?? notice.from?.match(/^@([\w.-]+)$/)?.[1];
  return handle ? handle.replace(/^@/, "") : null;
}

/** An automatic line in the conversation (a notice, a background routine's start): nothing groups with it. */
export const isEventLine = (meta: Meta) => noticeOf(meta) !== null || backgroundRoutineOf(meta) !== null;
