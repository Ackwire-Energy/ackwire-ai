import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type { Message, ReplyChips, TeamPlan, TeamProposalCard } from "../api/types";
import { teamProposalOf } from "./action-cards";
import { errorText } from "./errors";

/**
 * The right hand's team setup (ADR 0137 §10), platform-neutral: the start card's business types, the answers tapped
 * under its questions (each one the person's own message), and what the team card counts and lists.
 */

/** The start card's first question: what the business does. `other` writes in the composer instead of sending. */
export const BUSINESS_TYPES = ["agency", "store", "clinic", "software", "support", "services", "other"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Several answers tapped together go as one message, in this order. */
export const ANSWER_JOINER = " · ";

export function replyChipsOf(meta: Record<string, unknown> | null | undefined): ReplyChips | null {
  const raw = meta?.replyChips as Partial<ReplyChips> | undefined;
  if (!raw || !Array.isArray(raw.choices)) return null;
  const of = typeof raw.of === "number" && raw.of > 0 ? raw.of : 1;
  return {
    choices: raw.choices.filter((c): c is string => typeof c === "string" && c.length > 0),
    multiple: raw.multiple === true,
    step: typeof raw.step === "number" ? Math.min(of, Math.max(1, raw.step)) : 1,
    of,
  };
}

const byTime = (a: Pick<Message, "createdAt">, b: Pick<Message, "createdAt">) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt);

/**
 * The person's answer to a question: their first message after it (`afterId`; none: the conversation's first, for the
 * start card the app draws). Null while nobody answered.
 */
export function answerAfter(
  messages: readonly Pick<Message, "id" | "createdAt" | "author" | "body" | "local">[] | undefined,
  afterId: string | null,
): string | null {
  if (!messages) return null;
  const sorted = [...messages].sort(byTime);
  const from = afterId === null ? 0 : sorted.findIndex((m) => m.id === afterId) + 1;
  if (afterId !== null && from === 0) return null;
  return sorted.slice(from).find((m) => m.author.type === "person" && m.local !== "failed")?.body ?? null;
}

/** The answers of `choices` an answer holds: what the card shows checked once it was answered. */
export const answerPicks = (choices: readonly string[], answer: string | null) => {
  if (answer === null) return [];
  const parts = new Set(answer.split(ANSWER_JOINER).map((p) => p.trim()));
  return choices.filter((c) => parts.has(c));
};

/**
 * The start card's answer: the person's first message that is one of its `choices`, wherever it came, or, once the
 * interview or a team card followed, what they wrote first ("" with nothing written: a template's card). Anything else
 * ("oi", or something written before an AI was connected) answered nothing: the card keeps asking.
 */
export function startCardAnswer(
  messages: readonly Pick<Message, "id" | "createdAt" | "author" | "body" | "local" | "meta">[] | undefined,
  choices: readonly string[],
): string | null {
  const said = [...(messages ?? [])]
    .sort(byTime)
    .filter((m) => m.author.type === "person" && m.local !== "failed")
    .map((m) => m.body);
  const pick = said.find((body) => answerPicks(choices, body).length > 0);
  if (pick !== undefined) return pick;
  return messages?.some((m) => replyChipsOf(m.meta) || teamProposalOf(m.meta)) ? (said[0] ?? "") : null;
}

/** Taps put together in the order the answers are listed. */
export const answerText = (choices: readonly string[], picked: ReadonlySet<string>) =>
  choices.filter((c) => picked.has(c)).join(ANSWER_JOINER);

/** "3 agentes · 2 canais novos · 3 rotinas": what the card's footer counts. */
export const teamCounts = (plan: TeamPlan) => ({
  agents: plan.agents.length,
  newChannels: plan.newChannels.length,
  routines: plan.agents.reduce((n, a) => n + a.routines.length, 0) + (plan.weekly ? 1 : 0),
});

/** Every routine on the card, each with its agent and channel; the right hand's weekly check last (`agent` null). */
export const teamRoutines = (plan: TeamPlan) => [
  ...plan.agents.flatMap((a) => a.routines.map((routine) => ({ agent: a, routine }))),
  ...(plan.weekly ? [{ agent: null, routine: plan.weekly }] : []),
];

/** Where a team card stands for its viewer. `open` includes a failed try (its `error`). */
export function teamStatus(card: TeamProposalCard, now = Date.now()) {
  if (card.state === "pending" || card.state === "creating") {
    return Date.parse(card.expiresAt) <= now ? ("expired" as const) : ("open" as const);
  }
  return card.state;
}

/** Desfazer on the receipt: whoever created it, or an admin, within a day. */
export const TEAM_UNDO_MS = 24 * 3600_000;
export const teamUndoable = (card: TeamProposalCard, viewer: { userId: string; admin: boolean }, now = Date.now()) =>
  card.state === "created" &&
  !!card.decidedAt &&
  Date.parse(card.decidedAt) + TEAM_UNDO_MS > now &&
  (viewer.admin || card.decidedByUserId === viewer.userId);

/** The agents the receipt offers a first task for, once created: each with its new id. */
export const firstTasks = (card: TeamProposalCard) =>
  card.params.agents.flatMap((a, i) => {
    const agentId = card.created?.agentIds[i];
    return agentId && a.firstTask ? [{ agentId, name: a.name, appearance: a.appearance, task: a.firstTask }] : [];
  });

/** The team as a map ("Ver como mapa"): one column per channel, its agents and their routines. */
export function teamColumns(plan: TeamPlan) {
  const columns = new Map<string, { channel: string; fresh: boolean; agents: TeamPlan["agents"] }>();
  for (const a of plan.agents) {
    const col = columns.get(a.channel) ?? {
      channel: a.channel,
      fresh: plan.newChannels.includes(a.channel),
      agents: [],
    };
    col.agents.push(a);
    columns.set(a.channel, col);
  }
  return [...columns.values()];
}

/** "O time não foi criado: … deu erro (…)": the failed step, with its reason in the reader's language when known. */
export function teamFailureText(t: TFunction, error: NonNullable<TeamProposalCard["error"]>, locale?: string) {
  const reason = errorText(t, new ApiError(error.status ?? 500, error.code ?? "", error.reason, error.params), locale);
  return t("teamPlan.card.failed", { step: error.step, reason });
}
