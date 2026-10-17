import type { ChannelEvent, ConsultationStatus } from "@/api/types";

/**
 * An agent asking another agent, live (`agent.consulting` → `agent.consulted`):
 * the working line says "Dev está perguntando ao Infra… 0:12", then "Infra
 * respondeu. Dev está escrevendo…". Kept apart from the runs: the asking run
 * pauses while it waits (`run.finished` waiting_input) and leaves the run
 * store, but the question is still out.
 */
export type LiveConsultStatus = "asking" | ConsultationStatus;

export interface LiveConsult {
  runId: string;
  /** The agent that asked. */
  agentId: string;
  /** The agent it asked. */
  consultedAgentId: string;
  channelId: string;
  threadId: string;
  status: LiveConsultStatus;
  /** When the question went out (the line's clock). */
  since: number;
  /** When the status last changed (old entries are hidden if an event was missed). */
  at: number;
}

/** By the asking run's id. */
export type ConsultsState = Record<string, LiveConsult>;

/** The server gives up after 15 min; a question still "out" well past that missed its event. */
export const CONSULT_ASKING_MAX_MS = 20 * 60_000;
/** "Infra respondeu. Dev está escrevendo…" until the first words; gone if nothing came for this long. */
export const CONSULT_BACK_MAX_MS = 3 * 60_000;

const drop = (state: ConsultsState, runId: string) => {
  if (!state[runId]) return state;
  const { [runId]: _gone, ...rest } = state;
  return rest;
};

/** Drops the entry once the question is back (the run moved on: it writes, calls another tool, waits). */
const dropIfBack = (state: ConsultsState, runId: string) =>
  state[runId] && state[runId].status !== "asking" ? drop(state, runId) : state;

export function applyConsultEvent(
  state: ConsultsState,
  event: ChannelEvent | { type: string },
  now = Date.now(),
): ConsultsState {
  // Some run events (`agent.tool`, `run.canceled`) live outside `ChannelEvent`: read them loosely.
  const e = event as unknown as { type: string; runId?: unknown; status?: unknown; tool?: unknown };
  switch (e.type) {
    case "agent.consulting": {
      const ev = event as Extract<ChannelEvent, { type: "agent.consulting" }>;
      return {
        ...state,
        [ev.runId]: {
          runId: ev.runId,
          agentId: ev.agentId,
          consultedAgentId: ev.consultedAgentId,
          channelId: ev.channelId,
          threadId: ev.threadId,
          status: "asking",
          since: now,
          at: now,
        },
      };
    }
    case "agent.consulted": {
      const ev = event as Extract<ChannelEvent, { type: "agent.consulted" }>;
      const before = state[ev.runId];
      return {
        ...state,
        [ev.runId]: {
          runId: ev.runId,
          agentId: ev.agentId,
          consultedAgentId: ev.consultedAgentId,
          channelId: ev.channelId,
          threadId: ev.threadId,
          status: ev.status,
          since: before?.since ?? now,
          at: now,
        },
      };
    }
    case "message.created": {
      const runId = (event as Extract<ChannelEvent, { type: "message.created" }>).message?.agentRunId;
      return runId ? drop(state, runId) : state;
    }
    // Its words are arriving: the reply's own row takes over.
    case "agent.delta":
    case "agent.typing":
      return typeof e.runId === "string" ? dropIfBack(state, e.runId) : state;
    case "agent.tool":
      // Another tool after the answer: the line says that tool now.
      return typeof e.runId === "string" && e.tool && e.tool !== "ask_agent" ? dropIfBack(state, e.runId) : state;
    case "run.canceled":
      return typeof e.runId === "string" ? drop(state, e.runId) : state;
    case "agent.run":
    case "run.finished": {
      if (typeof e.runId !== "string") return state;
      // Pausing to wait for the answer (waiting_input) is the consultation itself.
      if (e.status === "failed" || e.status === "done" || e.status === "canceled") return drop(state, e.runId);
      if (e.status === "waiting_input" || e.status === "waiting_approval") return dropIfBack(state, e.runId);
      return state;
    }
    default:
      return state;
  }
}

/** The consultations to show in a channel now, oldest first (stale ones left out). */
export function consultsIn(state: ConsultsState, channelId: string, now = Date.now()): LiveConsult[] {
  return Object.values(state)
    .filter(
      (c) =>
        c.channelId === channelId && now - c.at < (c.status === "asking" ? CONSULT_ASKING_MAX_MS : CONSULT_BACK_MAX_MS),
    )
    .sort((a, b) => a.since - b.since);
}

/** "0:41", "15:00": the clock next to a question that is out. */
export function elapsedClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
