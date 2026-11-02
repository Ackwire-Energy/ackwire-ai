import type { TFunction } from "i18next";
import type { AgentStatusLine, WorkView } from "../api/types";
import { formatTime } from "./format";

/**
 * Long work (ADR 0121), the same on every app: the line under the agent's "Vou cuidar disso" (WorkLine on web, its
 * counterpart on the phone), the card's block and the agent's status line. Plain text, never cut: lines wrap.
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
  const over = w.status === "done" || w.status === "failed" || w.status === "canceled";
  const stop = !over && c.canStop && w.runId ? { runId: w.runId } : null;
  const base = { task, stop, threadId: w.threadId, update: w.lastUpdate?.text ?? null };
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
  return `${head} ${say("work.autoUpdateNow", { now: now.charAt(0).toLocaleLowerCase() + now.slice(1) })}`;
}

/** A card's blocked badge (background work stopped on something, ADR 0121 §4): in its stage, not a column. */
export function blockedText(
  t: TFunction,
  blocked: { reason: string; text?: string } | null | undefined,
): string | null {
  const say = loose(t);
  if (!blocked) return null;
  if (blocked.reason === "failed") {
    const code = blocked.text?.replace(/^run\./, "");
    const why: string = code ? say(`agentPage.activity.errors.${code}`, { defaultValue: "" }) : "";
    return why ? say("work.blocked.failedWhy", { why: why.replace(/\.$/, "") }) : say("work.blocked.failed");
  }
  const known = ["waiting_approval", "waiting_input", "waiting_computer", "paused"];
  return say(`work.blocked.${known.includes(blocked.reason) ? blocked.reason : "waiting_approval"}`);
}
