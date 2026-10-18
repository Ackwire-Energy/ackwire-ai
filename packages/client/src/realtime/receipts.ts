import type { ChannelEvent, Message, RunStatus } from "../api/types";
import type { RunSteeredEvent } from "./streams";

/**
 * Agent receipts under a person's message: who saw it and who is answering.
 * Built from `message.receipts` (list API) and live events: the expected
 * `message.routed` / `message.claimed` / `message.handled`, plus the run
 * events. Run events land on the messages that run answers (its trigger, and
 * messages steered into it), known from `message.routed` / `message.claimed`
 * / the list receipts; only an unknown run falls back to the event's `threadId`.
 */
export type ReceiptPhase = "seen" | "picked" | "claimed" | "waiting" | "asking" | "handled" | "failed";

export interface MessageReceipt {
  /** The router decided (so "nobody picked it" is final). */
  routed: boolean;
  /** Something came from the server (event or list receipts). False = only the client's guess after a mention. */
  confirmed?: boolean;
  /** Agent id → phase, in the order they appeared. */
  agents: [agentId: string, phase: ReceiptPhase][];
  /** Runs answering this message (its own, the task it was steered into, the run its answer resumed). */
  runs?: string[];
  /** Agents the message mentions: they answer unless the server says they can't (`blocked`). */
  mentioned?: string[];
  /** Mentioned agents that won't answer (they don't reply to this person). */
  blocked?: string[];
  /** Mentioned agents the message only references (part of the request to another agent): no answer expected. */
  referenced?: string[];
}

export type ReceiptsState = Record<string, MessageReceipt>;

const phaseOf = (
  status: RunStatus | "done" | "failed" | "waiting_approval" | "waiting_input" | "canceled",
): ReceiptPhase =>
  status === "queued"
    ? "picked"
    : status === "running"
      ? "claimed"
      : status === "waiting_approval"
        ? "waiting"
        : status === "waiting_input"
          ? "asking"
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

/** Remembers that `runId` answers `messageId` (so its events land there, not on the thread's root). */
function linkRun(state: ReceiptsState, messageId: string, runId: string | null | undefined): ReceiptsState {
  if (!runId) return state;
  const base = state[messageId] ?? { routed: false, agents: [] };
  if (base.runs?.includes(runId)) return state;
  return { ...state, [messageId]: { ...base, runs: [...(base.runs ?? []), runId] } };
}

/** A run's event: on every message that run answers; an unknown run falls back to `threadId`. */
function setForRun(
  state: ReceiptsState,
  runId: string | null | undefined,
  threadId: string | null | undefined,
  agentId: string,
  phase: ReceiptPhase,
  force = false,
): ReceiptsState {
  const targets = runId
    ? Object.entries(state)
        .filter(([, r]) => r.runs?.includes(runId))
        .map(([id]) => id)
    : [];
  if (targets.length === 0) return threadId ? set(state, threadId, agentId, phase, force) : state;
  let next = state;
  for (const id of targets) next = set(next, id, agentId, phase, force);
  return next;
}

/** Seeds a person's message: server receipts, else the agents it mentions (they will answer). */
export function seedReceipt(state: ReceiptsState, message: Message): ReceiptsState {
  if (message.author?.type !== "person") return state;
  const existing = state[message.id];
  const r = message.receipts;
  const metaReferenced = message.meta?.referencedAgentIds;
  const referenced = r?.referenced ?? (Array.isArray(metaReferenced) ? (metaReferenced as string[]) : []);
  const mentioned = message.mentionedAgentIds ?? [];
  // The mentions stay on the receipt: "nobody will answer" needs the server to say they can't.
  const withMentions = (s: ReceiptsState): ReceiptsState => {
    const current = s[message.id];
    if (!current || mentioned.length === 0) return s;
    const next = {
      ...current,
      ...(current.mentioned ? {} : { mentioned }),
      ...(referenced.length > 0 && !current.referenced ? { referenced } : {}),
    };
    return next.mentioned === current.mentioned && next.referenced === current.referenced
      ? s
      : { ...s, [message.id]: next };
  };
  // Server receipts replace a local guess; otherwise keep what we have.
  if (existing && (existing.confirmed || !r)) return withMentions(state);
  let next: ReceiptsState = existing
    ? { ...state, [message.id]: { routed: false, agents: [], ...(existing.runs ? { runs: existing.runs } : {}) } }
    : state;
  if (r) {
    for (const id of r.seenBy) next = set(next, message.id, id, "seen");
    for (const id of r.pickedBy) next = set(next, message.id, id, "picked");
    for (const h of r.handled) {
      next = set(next, message.id, h.agentId, phaseOf(h.status));
      next = linkRun(next, message.id, h.runId);
    }
    // Receipts come from the router's decision: "nobody picked it" is final.
    const current = next[message.id] ?? { routed: false, agents: [] };
    return withMentions({ ...next, [message.id]: { ...current, routed: true, blocked: r.blocked ?? [] } });
  }
  // A mention: the server resolved it, so that agent will answer (unless the message only references it).
  for (const id of mentioned)
    next = set(next, message.id, id, referenced.includes(id) ? "seen" : "picked", false, false);
  return withMentions(next);
}

/** The client's guess right after an explicit @mention or an agent DM (not confirmed; times out). */
export function guessReceipt(state: ReceiptsState, messageId: string, agentIds: string[]): ReceiptsState {
  let next = state;
  for (const id of agentIds) next = set(next, messageId, id, "picked", false, false);
  return next;
}

export function applyReceiptEvent(
  state: ReceiptsState,
  event: ChannelEvent | (RunSteeredEvent & { agentId?: string }),
): ReceiptsState {
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
      for (const r of event.runs ?? []) next = linkRun(next, event.messageId, r.runId);
      const current = next[event.messageId] ?? { routed: false, agents: [] };
      // Mentioned agents that got nothing: said explicitly, or the whole decision was "nobody".
      const blocked = event.blocked ?? (event.strategy === "none" ? event.seenBy : current.blocked);
      const referenced = event.referenced ?? current.referenced;
      return {
        ...next,
        [event.messageId]: {
          ...current,
          routed: true,
          confirmed: true,
          ...(blocked ? { blocked } : {}),
          ...(referenced ? { referenced } : {}),
        },
      };
    }
    case "message.claimed":
      return set(linkRun(state, event.messageId, event.runId), event.messageId, event.agentId, "claimed");
    case "message.handled":
      return set(
        linkRun(state, event.messageId, event.runId),
        event.messageId,
        event.agentId,
        event.status ? phaseOf(event.status) : "handled",
      );
    case "agent.run.steered": {
      // Went into the agent's task in progress: that agent is on it (a "stop" ends it).
      const linked = linkRun(state, event.messageId, event.runId);
      return event.agentId ? set(linked, event.messageId, event.agentId, event.stop ? "handled" : "claimed") : linked;
    }
    case "agent.run":
      return setForRun(
        state,
        event.runId,
        event.triggerMessageId ?? event.threadId,
        event.agentId,
        phaseOf(event.status),
        event.status === "running",
      );
    case "agent.thinking":
      // Announced at post time = picked; a run thinking = answering.
      return event.runId === null
        ? set(state, event.threadId, event.agentId, "picked")
        : setForRun(state, event.runId, event.threadId, event.agentId, "claimed", true);
    case "agent.typing":
      return setForRun(state, event.runId, event.threadId, event.agentId, "claimed", true);
    case "run.finished":
      return setForRun(
        state,
        event.runId,
        event.threadId,
        event.agentId,
        phaseOf(event.status),
        event.status === "waiting_approval",
      );
    case "question.asked":
      // The agent waits for the person: "Theo está esperando sua resposta".
      return event.threadId ? set(state, event.threadId, event.question.agentId, "asking", true) : state;
    case "question.answered":
      return event.threadId ? set(state, event.threadId, event.question.agentId, "claimed", true) : state;
    case "message.created": {
      const m = event.message;
      if (m?.author?.type === "agent" && m.author.id && m.threadId && !m.meta?.approvalId) {
        return setForRun(state, m.agentRunId, m.threadId, m.author.id, "handled");
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
  /** Agents the message only references (no answer expected from them). */
  referenced: string[];
}

export function receiptView(receipt: MessageReceipt | undefined): ReceiptView {
  if (!receipt || receipt.agents.length === 0) return { seen: [], status: null, done: false, referenced: [] };
  const seen = receipt.agents.map(([id]) => id);
  const referenced = (receipt.referenced ?? []).filter((id) => seen.includes(id));
  const with_ = (phase: ReceiptPhase) => receipt.agents.filter(([, p]) => p === phase).map(([id]) => id);
  for (const kind of ["failed", "asking", "waiting", "claimed", "picked"] as const) {
    const agents = with_(kind);
    if (agents.length) return { seen, status: { kind, agents }, done: false, referenced };
  }
  const handled = with_("handled");
  if (handled.length) return { seen, status: { kind: "handled", agents: handled }, done: true, referenced };
  // A mention always gets an answer unless the server said that agent can't, or that the message only
  // references it (never "nobody" on a guess).
  const blocked = new Set([...(receipt.blocked ?? []), ...(receipt.referenced ?? [])]);
  const unanswered = (receipt.mentioned ?? []).some((id) => !blocked.has(id));
  return { seen, status: receipt.routed && !unanswered ? { kind: "nobody" } : null, done: false, referenced };
}
