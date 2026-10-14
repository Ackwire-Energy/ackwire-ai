import type { ChannelEvent, Message, RunStatus } from "@/api/types";

/**
 * Agent receipts under a person's message: who saw it and who is answering.
 * Built from `message.receipts` (list API) and live events: the expected
 * `message.routed` / `message.claimed` / `message.handled`, plus the run
 * events we already get (a run's `threadId` is the message it answers).
 */
export type ReceiptPhase = "seen" | "picked" | "claimed" | "waiting" | "asking" | "handled" | "failed";

export interface MessageReceipt {
  /** The router decided (so "nobody picked it" is final). */
  routed: boolean;
  /** Something came from the server (event or list receipts). False = only the client's guess after a mention. */
  confirmed?: boolean;
  /** Agent id → phase, in the order they appeared. */
  agents: [agentId: string, phase: ReceiptPhase][];
}

export type ReceiptsState = Record<string, MessageReceipt>;

const phaseOf = (status: RunStatus | "done" | "failed" | "waiting_approval"): ReceiptPhase =>
  status === "queued"
    ? "picked"
    : status === "running"
      ? "claimed"
      : status === "waiting_approval"
        ? "waiting"
        : status === "failed"
          ? "failed"
          : "handled";

const RANK: Record<ReceiptPhase, number> = {
  seen: 0,
  picked: 1,
  claimed: 2,
  waiting: 2,
  asking: 2,
  handled: 3,
  failed: 3,
};

function set(
  state: ReceiptsState,
  messageId: string,
  agentId: string,
  phase: ReceiptPhase,
  force = false,
  confirmed = true,
): ReceiptsState {
  const base = state[messageId] ?? { routed: false, agents: [] };
  const current = { ...base, confirmed: Boolean(base.confirmed || confirmed) };
  const existing = current.agents.find(([id]) => id === agentId);
  // Never move back (a late "seen" doesn't undo "respondeu"), except a new run starting again.
  if (existing && !force && RANK[phase] < RANK[existing[1]]) {
    return current.confirmed === base.confirmed ? state : { ...state, [messageId]: current };
  }
  const agents = existing
    ? current.agents.map(([id, p]) => [id, id === agentId ? phase : p] as [string, ReceiptPhase])
    : [...current.agents, [agentId, phase] as [string, ReceiptPhase]];
  return { ...state, [messageId]: { ...current, agents } };
}

/** Seeds a person's message: server receipts, else the agents it mentions (they will answer). */
export function seedReceipt(state: ReceiptsState, message: Message): ReceiptsState {
  if (message.author?.type !== "person") return state;
  const existing = state[message.id];
  const r = message.receipts;
  // Server receipts replace a local guess; otherwise keep what we have.
  if (existing && (existing.confirmed || !r)) return state;
  let next: ReceiptsState = existing ? { ...state, [message.id]: { routed: false, agents: [] } } : state;
  if (r) {
    for (const id of r.seenBy) next = set(next, message.id, id, "seen");
    for (const id of r.pickedBy) next = set(next, message.id, id, "picked");
    for (const h of r.handled) next = set(next, message.id, h.agentId, phaseOf(h.status));
    // Receipts come from the router's decision: "nobody picked it" is final.
    const current = next[message.id] ?? { routed: false, agents: [] };
    return { ...next, [message.id]: { ...current, routed: true } };
  }
  // A mention: the server resolved it, so that agent will answer.
  for (const id of message.mentionedAgentIds) next = set(next, message.id, id, "picked", false, false);
  return next;
}

/** The client's guess right after an explicit @mention or an agent DM (not confirmed; times out). */
export function guessReceipt(state: ReceiptsState, messageId: string, agentIds: string[]): ReceiptsState {
  let next = state;
  for (const id of agentIds) next = set(next, messageId, id, "picked", false, false);
  return next;
}

export function applyReceiptEvent(state: ReceiptsState, event: ChannelEvent): ReceiptsState {
  switch (event.type) {
    case "message.routed": {
      // The router's decision wins over any guess: agents not picked only "saw" it.
      const picked = new Set(event.pickedBy);
      const before = state[event.messageId];
      let next: ReceiptsState = before
        ? {
            ...state,
            [event.messageId]: {
              ...before,
              agents: before.agents.map(([id, p]) => [id, p === "picked" && !picked.has(id) ? "seen" : p]),
            },
          }
        : state;
      for (const id of event.seenBy) next = set(next, event.messageId, id, "seen");
      for (const id of event.pickedBy) next = set(next, event.messageId, id, "picked");
      const current = next[event.messageId] ?? { routed: false, agents: [] };
      return { ...next, [event.messageId]: { ...current, routed: true, confirmed: true } };
    }
    case "message.claimed":
      return set(state, event.messageId, event.agentId, "claimed");
    case "message.handled":
      return set(state, event.messageId, event.agentId, event.status ? phaseOf(event.status) : "handled");
    case "agent.run":
      return set(state, event.threadId, event.agentId, phaseOf(event.status), event.status === "running");
    case "agent.thinking":
      // Announced at post time = picked; a run thinking = answering.
      return event.runId === null
        ? set(state, event.threadId, event.agentId, "picked")
        : set(state, event.threadId, event.agentId, "claimed", true);
    case "agent.typing":
      return set(state, event.threadId, event.agentId, "claimed", true);
    case "run.finished":
      return set(state, event.threadId, event.agentId, phaseOf(event.status), event.status === "waiting_approval");
    case "question.asked":
      // The agent waits for the person: "Theo está esperando sua resposta".
      return event.threadId ? set(state, event.threadId, event.question.agentId, "asking", true) : state;
    case "question.answered":
      return event.threadId ? set(state, event.threadId, event.question.agentId, "claimed", true) : state;
    case "message.created": {
      const m = event.message;
      if (m?.author?.type === "agent" && m.author.id && m.threadId && !m.meta?.approvalId) {
        return set(state, m.threadId, m.author.id, "handled");
      }
      return state;
    }
    default:
      return state;
  }
}

/** The receipt row's words, e.g. "Ada vai responder" / "Nenhum agente vai responder". */
export interface ReceiptView {
  seen: string[];
  /** Main status, or null when there is nothing to say yet. */
  status:
    | { kind: "picked" | "claimed" | "waiting" | "asking" | "handled" | "failed"; agents: string[] }
    | { kind: "nobody" }
    | null;
  /** Everyone who answered answered: the row can shrink to avatars. */
  done: boolean;
}

export function receiptView(receipt: MessageReceipt | undefined): ReceiptView {
  if (!receipt || receipt.agents.length === 0) return { seen: [], status: null, done: false };
  const seen = receipt.agents.map(([id]) => id);
  const with_ = (phase: ReceiptPhase) => receipt.agents.filter(([, p]) => p === phase).map(([id]) => id);
  for (const kind of ["failed", "asking", "waiting", "claimed", "picked"] as const) {
    const agents = with_(kind);
    if (agents.length) return { seen, status: { kind, agents }, done: false };
  }
  const handled = with_("handled");
  if (handled.length) return { seen, status: { kind: "handled", agents: handled }, done: true };
  return { seen, status: receipt.routed ? { kind: "nobody" } : null, done: false };
}
