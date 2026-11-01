import type { Approval } from "../api/types";

/**
 * The requests on one approval card, oldest first: the card's own (`first`) and every request of the agent
 * that joined it in that conversation (same `messageId`, server side `openApprovalCard`).
 */
export function approvalCardItems(list: readonly Approval[] | undefined, messageId: string, first?: Approval) {
  const items = (list ?? []).filter((a) => a.messageId === messageId);
  if (first && !items.some((a) => a.id === first.id)) items.push(first);
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * What "Aprovar tudo" covers: the items still waiting that this person may decide, as listed now (the ids
 * sent, so one joining during the click is never approved unseen), and how many waiting ones they can't.
 */
export function approveAllScope(items: readonly Approval[], now = Date.now()) {
  const waiting = items.filter((a) => a.status === "pending" && new Date(a.expiresAt).getTime() > now);
  const ids = waiting.filter((a) => a.canDecide).map((a) => a.id);
  return { ids, waiting: waiting.length, blocked: waiting.length - ids.length };
}

/** A request past its deadline reads as expired, before the server's event says so. */
export const asOfNow = (a: Approval, now = Date.now()): Approval =>
  a.status === "pending" && Date.parse(a.expiresAt) <= now ? { ...a, status: "expired" } : a;

/** The card's shared deadline: the earliest of its waiting items (null: nothing waits). */
export function cardDeadline(items: readonly Approval[]): string | null {
  const pending = items.filter((a) => a.status === "pending").map((a) => a.expiresAt);
  return pending.length ? pending.reduce((a, b) => (a < b ? a : b)) : null;
}

/**
 * A list of approvals as their cards (Aprovações, the phone's list): requests sharing a card come together,
 * at the place of its newest one; one without a card stands alone.
 */
export function approvalCards(list: readonly Approval[]): Approval[][] {
  const cards = new Map<string, Approval[]>();
  for (const a of list) {
    const key = a.messageId ?? a.id;
    const card = cards.get(key);
    if (card) card.push(a);
    else cards.set(key, [a]);
  }
  return [...cards.values()].map((items) => items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}
