import type { TFunction } from "i18next";
import type { UsageQueue, UsageQueueRow } from "../api/types";
import { joinNames, relativeTime } from "./format";
import { usageWhen } from "./plan-usage";

/**
 * An agent's line of work waiting on its plan or budget (ADR 0118), worded for the web's dialog and the phone's sheet:
 * one row per conversation in the order it picks them up, what happened in each since, and who may say not to run it.
 */

const say = (t: TFunction) => t as unknown as (key: string, o?: Record<string, unknown>) => string;

/** "Theo tem 4 conversas para retomar". */
export const usageQueueTitle = (t: TFunction, agent: string, q: Pick<UsageQueue, "rows" | "hidden">) =>
  say(t)("usageQueue.title", { agent, count: q.rows.length + q.hidden });

/** "Retoma hoje às 15:00, quando o plano do Claude renovar. Uma de cada vez, nesta ordem." */
export function usageQueueLine(t: TFunction, locale: string, q: UsageQueue, now = new Date()) {
  const when = q.resetsAt ? usageWhen(t, locale, q.resetsAt, now) : null;
  if (q.reason === "budget") return say(t)("usageQueue.lineBudget", { when: when ?? "" });
  return when
    ? say(t)("usageQueue.line", { when, plan: q.plan ?? "" })
    : say(t)("usageQueue.lineUnknown", { plan: q.plan ?? "" });
}

/** "A fila é do plano: Ada e Theo dividem a mesma conta." Null when it is the agent's alone. */
export const usageQueueShared = (t: TFunction, agent: string, others: string[]) =>
  others.length > 0 ? say(t)("usageQueue.shared", { agents: joinNames([...others, agent], t) }) : null;

/** Where it waits: "DM com Ana", "Sua DM", "#suporte", "Conversa em #suporte", "Rotina Resumo diário". */
export function usageQueueWhere(t: TFunction, row: UsageQueueRow, viewerId: string, person: (id: string) => string) {
  if (row.kind === "routine") return say(t)("usageQueue.routine", { name: row.title ?? "" });
  if (row.kind === "work") return say(t)("usageQueue.work", { name: row.title ?? "" });
  if (row.channelKind === "dm") {
    const asker = row.askers[0];
    return !asker || asker === viewerId
      ? say(t)("usageQueue.yourDm")
      : say(t)("usageQueue.dm", { name: person(asker) });
  }
  const channel = row.channelName ?? "";
  return row.threadId ? say(t)("usageQueue.thread", { channel }) : `#${channel}`;
}

/** "Pedido por Ana e Bruno · há 3 dias" (a routine or long work: "Pausado há 3 h"). */
export function usageQueueMeta(
  t: TFunction,
  locale: string,
  row: UsageQueueRow,
  person: (id: string) => string,
  now = new Date(),
) {
  const ago = relativeTime(t, locale, row.since, now);
  if (row.askers.length === 0) return say(t)("usageQueue.paused", { ago });
  return say(t)("usageQueue.askedBy", { names: joinNames(row.askers.map(person), t), ago });
}

/** "12 mensagens depois · Nina e Ada escreveram depois", or "Nada depois"; `you`: the viewer's name, said "você". */
export function usageQueueFacts(t: TFunction, row: UsageQueueRow, you?: string) {
  if (row.after.count === 0) return say(t)("usageQueue.nothingAfter");
  const count = say(t)("usageQueue.after", { count: row.after.count });
  if (row.after.names.length === 0) return count;
  const names = row.after.names.map((n) => (n === you ? say(t)("common.you") : n));
  return `${count} · ${say(t)("usageQueue.wrote", { names: joinNames(names, t), count: names.length })}`;
}

/** "Na fila" or "Respondendo agora". */
export const usageQueueState = (t: TFunction, row: UsageQueueRow) =>
  say(t)(row.state === "answering" ? "usageQueue.answering" : "usageQueue.queued");

/** The status line's tail on an agent out of office with conversations waiting: "· 7 conversas esperando". */
export const usageWaitingText = (t: TFunction, count: number) => say(t)("usageQueue.waiting", { count });
