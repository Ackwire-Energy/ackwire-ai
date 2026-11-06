import type { TFunction } from "i18next";
import type { AgentStatusLine, WorkView } from "../api/types";
import { runErrorText } from "./errors";
import { formatTime, lowerFirst } from "./format";

/**
 * Long work (ADR 0121), the same on every app: the line under the agent's "Vou cuidar disso" (WorkLine on web, its
 * counterpart on the phone), the card's block and the agent's status line. Plain text, never cut: lines wrap, but for
 * the question it waits on, kept to two lines (its card, one tap away, has all of it).
 */

/** `t` with keys built at run time (a state's, a code's): the typed `t` of the web only takes literal keys. */
type Say = (key: string, options?: Record<string, unknown>) => string;
const loose = (t: TFunction) => t as unknown as Say;

/** Minutes as people say them: "12 min", "1 h 20 min". */
export function workDuration(t: TFunction, ms: number): string {
  const say = loose(t);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return say("work.duration.minutes", { count: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? say("work.duration.hoursMinutes", { h, m }) : say("work.duration.hours", { count: h });
}

export type WorkTone = "working" | "waiting" | "queued" | "done" | "failed" | "stopped";

export interface WorkLineView {
  tone: WorkTone;
  /** The line itself. */
  text: string;
  /** The latest update, as a second line (the agent's words, or the server's in the reader's language). */
  update: string | null;
  /** What it waits to hear, in place of that update: the question it asked. */
  question: { text: string; messageId: string | null } | null;
  /** "Tarefa #42", when it has a card. */
  task: { id: string; number: number; label: string } | null;
  /** Parar: while it isn't over, for who may stop it. */
  stop: { runId: string } | null;
  /** Ver resultado / Ver o que aconteceu: its end message. */
  result: { messageId: string; label: string } | null;
  /** Abrir conversa: where its updates are. */
  threadId: string | null;
}

export interface WorkLineContext {
  locale: string;
  now?: Date;
  /** The reader: "sua aprovação" when they asked for it. */
  meId?: string | null;
  agentName: string;
  /** Who stopped it, by id (null: unknown). */
  nameOf?: (userId: string) => string | null;
  /** Who may stop it (`mayStopRun`: who asked, the agent's owner, an admin). */
  canStop: boolean;
}

/** The line under a work's anchor, in the reader's language. */
export function workLine(t: TFunction, w: WorkView, c: WorkLineContext): WorkLineView {
  const say = loose(t);
  const now = c.now ?? new Date();
  const since = Date.parse(w.startedAt);
  const mine = Boolean(c.meId && w.requestedByUserId === c.meId);
  const task = w.issue ? { ...w.issue, label: say("work.task", { number: w.issue.number }) } : null;
  const over = workIsOver(w);
  const stop = !over && c.canStop && w.runId ? { runId: w.runId } : null;
  const question = (w.state === "waiting_input" && w.question) || null;
  // The last update is news only while it works: once over, the report says where it ended.
  const update = over || question ? null : (w.lastUpdate?.text ?? null);
  const base = { task, stop, threadId: w.threadId, update, question };
  const took = workDuration(t, (w.finishedAt ? Date.parse(w.finishedAt) : now.getTime()) - since);
  if (w.status === "done")
    return {
      ...base,
      tone: "done",
      text: say("work.line.done", { duration: took }),
      result: w.resultMessageId ? { messageId: w.resultMessageId, label: say("work.result") } : null,
    };
  if (w.status === "failed")
    return {
      ...base,
      tone: "failed",
      text: say("work.line.failed"),
      result: w.resultMessageId ? { messageId: w.resultMessageId, label: say("work.whatHappened") } : null,
    };
  if (w.status === "canceled") {
    const name = w.canceledByUserId ? c.nameOf?.(w.canceledByUserId) : null;
    return {
      ...base,
      tone: "stopped",
      text: name
        ? say("work.line.canceled", { name, duration: took })
        : say("work.line.canceledAnon", { duration: took }),
      result: null,
    };
  }
  if (w.state === "queued" || w.status === "queued")
    return {
      ...base,
      tone: "queued",
      text: say("work.line.queued", { agent: c.agentName, position: w.queuePosition ?? 1 }),
      result: null,
    };
  const waits: Partial<Record<NonNullable<WorkView["state"]>, string>> = {
    waiting_approval: mine ? "work.line.waitingApprovalYou" : "work.line.waitingApproval",
    waiting_input: mine ? "work.line.waitingAnswerYou" : "work.line.waitingAnswer",
    waiting_computer: "work.line.waitingComputer",
  };
  if (w.state === "paused")
    return {
      ...base,
      tone: "waiting",
      text: w.pausedUntil
        ? say("work.line.pausedUntil", { time: formatTime(c.locale, w.pausedUntil) })
        : say("work.line.paused"),
      result: null,
    };
  const wait = w.state ? waits[w.state] : undefined;
  if (wait) return { ...base, tone: "waiting", text: say(wait), result: null };
  const next = w.nextUpdateAt ? Date.parse(w.nextUpdateAt) - now.getTime() : null;
  const parts = [say("work.line.working", { duration: workDuration(t, now.getTime() - since) })];
  if (next !== null)
    parts.push(
      next > 60_000 ? say("work.line.next", { minutes: Math.round(next / 60_000) }) : say("work.line.nextSoon"),
    );
  return { ...base, tone: "working", text: parts.join(" · "), result: null };
}

/** Held on a person's answer or approval, whose card is in its thread: its line opens the thread, whatever else does. */
export const workWaitsOnPerson = (w: Pick<WorkView, "state">) =>
  w.state === "waiting_input" || w.state === "waiting_approval";

/** A work that ended (done, failed or stopped): its anchor is dimmed and keeps no promise. */
export const workIsOver = (w: Pick<WorkView, "status">) =>
  w.status === "done" || w.status === "failed" || w.status === "canceled";

/**
 * The anchor's words once the work is over: the promise of the next update goes, since the line under it now says how
 * it ended ("Terminou em 38 min"). The server's own anchor has a version without it; an agent's keeps all but a last
 * sentence that promises a time ("O próximo update deve sair em ~10 min.").
 */
export function workAnchorBody(t: TFunction, body: string, meta: Record<string, unknown> | undefined, w: WorkView) {
  if (!workIsOver(w)) return body;
  if (meta?.bodyCode === "work_auto_moved") return loose(t)("chat.body.work_auto_movedOver", { defaultValue: body });
  const kept = body.replace(/(^|[.!?…]\s+)[^.!?…\n]*~\s?\d+\s?min[^.!?…\n]*[.!?…]?\s*$/i, "$1").trim();
  return kept || body;
}

/** The AI provider's errors (`run.provider_error`, `run.provider_unavailable`): mirrors `PROVIDER_ERRORS` in the engine. */
const PROVIDER_ERRORS = new Set(["run.provider_error", "run.provider_account", "run.provider_unavailable"]);

/**
 * A work's end posted home after its AI provider failed (`meta.workEnd`): Continuar goes on from there, once (ADR 0121).
 * Null for any other message or once it was continued.
 */
export function workContinuable(meta: Record<string, unknown> | undefined): { continuedRunId: string | null } | null {
  const end = meta?.workEnd as { status?: unknown; errorCode?: unknown; continuedRunId?: unknown } | undefined;
  if (end?.status !== "failed" || typeof end.errorCode !== "string" || !PROVIDER_ERRORS.has(end.errorCode)) return null;
  return { continuedRunId: typeof end.continuedRunId === "string" ? end.continuedRunId : null };
}

/** How far along its plan is: "2 de 5". Null without a plan. */
export function workPlanProgress(w: Pick<WorkView, "plan">) {
  if (w.plan.length === 0) return null;
  return { done: w.plan.filter((p) => p.state === "done").length, total: w.plan.length };
}

/** The agent's status line on background work: "Trabalhando em: X · 20 min", "Em 2 trabalhos: A e B"… */
export function workStatusText(t: TFunction, line: AgentStatusLine, now = new Date()): string {
  const say = loose(t);
  const count = line.count ?? 1;
  const duration = line.since ? workDuration(t, now.getTime() - Date.parse(line.since)) : null;
  if (count === 1 && line.wait) {
    const key = `work.status.wait.${line.wait}`;
    return line.subject ? say(`${key}Titled`, { subject: line.subject }) : say(key);
  }
  if (count === 1) {
    const head = line.subject ? say("work.status.one", { subject: line.subject }) : say("work.status.oneUntitled");
    return duration ? `${head} · ${duration}` : head;
  }
  if (count === 2 && line.subject && line.second)
    return say("work.status.two", { first: line.subject, second: line.second });
  return line.subject
    ? say("work.status.many", { count, subject: line.subject, more: count - 1 })
    : say("work.status.manyUntitled", { count });
}

/** The server's own update of a silent work ("Ainda trabalhando nisso (22 min). Agora: rodando os testes."). */
export function autoUpdateText(t: TFunction, params: Record<string, unknown>): string {
  const say = loose(t);
  const minutes = Number(params.minutes ?? 0);
  const head = say("work.autoUpdate", { duration: workDuration(t, minutes * 60_000) });
  const kind = typeof params.kind === "string" ? params.kind : null;
  if (!kind) return head;
  const now = say(`presence.agent.${kind}`, { subject: typeof params.subject === "string" ? params.subject : "" });
  return `${head} ${say("work.autoUpdateNow", { now: lowerFirst(now) })}`;
}

/**
 * The server's own status line for a working agent a person wrote to (ADR 0131 §2, `talker_status`): how long it has
 * worked, what it does now, and that it reads them after this step.
 */
export function talkerStatusText(t: TFunction, params: Record<string, unknown>): string {
  const say = loose(t);
  const minutes = Number(params.minutes ?? 0);
  const head = say("work.statusReply", { duration: workDuration(t, minutes * 60_000) });
  const kind = typeof params.kind === "string" ? params.kind : null;
  if (!kind) return head;
  const now = say(`presence.agent.${kind}`, { subject: typeof params.subject === "string" ? params.subject : "" });
  return `${head} ${say("work.autoUpdateNow", { now: lowerFirst(now) })}`;
}

/** A card's blocked badge (background work stopped on something, ADR 0121 §4): in its stage, not a column. */
export function blockedText(
  t: TFunction,
  blocked: { reason: string; text?: string } | null | undefined,
): string | null {
  const say = loose(t);
  if (!blocked) return null;
  if (blocked.reason === "failed") {
    const why = errorWords(t, blocked.text);
    return why ? say("work.blocked.failedWhy", { why }) : say("work.blocked.failed");
  }
  const known = ["waiting_approval", "waiting_input", "waiting_computer", "paused"];
  return say(`work.blocked.${known.includes(blocked.reason) ? blocked.reason : "waiting_approval"}`);
}

/** A run error's code ("run.stuck") in the reader's words, mid-sentence: no capital, no final period; empty if unknown. */
function errorWords(t: TFunction, code: unknown, params?: unknown) {
  if (typeof code !== "string" || !code) return "";
  const values = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  return lowerFirst((runErrorText(t, code, values) ?? "").replace(/\.$/, ""));
}

/**
 * The end the server posts home for a work that didn't finish or was stopped (`work_end_failed`, `work_end_canceled`):
 * why (`meta.workEnd.errorCode`) or by whom (`bodyParams.byName`), and the last update it posted.
 */
export function workEndBody(
  t: TFunction,
  code: "work_end_failed" | "work_end_canceled",
  params: Record<string, unknown>,
  end: unknown,
  fallback: string,
): string {
  const say = loose(t);
  const e = (end && typeof end === "object" ? end : {}) as {
    errorCode?: unknown;
    errorParams?: unknown;
    lastUpdate?: unknown;
  };
  const why = errorWords(t, e.errorCode, e.errorParams);
  const name = typeof params.byName === "string" ? params.byName : "";
  const key =
    code === "work_end_failed"
      ? why
        ? "chat.body.work_end_failedWhy"
        : "chat.body.work_end_failed"
      : name
        ? "chat.body.work_end_canceledBy"
        : "chat.body.work_end_canceled";
  const head = say(key, { ...params, why, name, defaultValue: fallback });
  const last = typeof e.lastUpdate === "string" && e.lastUpdate ? `${say("work.lastUpdate")}: ${e.lastUpdate}` : "";
  return [head, last].filter(Boolean).join("\n\n");
}
