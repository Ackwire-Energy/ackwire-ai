import { useMemo, useSyncExternalStore } from "react";
import type { ActiveRun, Message } from "../api/types";

/**
 * What became of a message a person sent while an agent worked (it went into
 * the agent's task in progress): "Ada lê na próxima pausa" (`waiting`),
 * "Ada parou para ler" (`now`: sent with "Parar e mandar", until it is read),
 * "Ada leu" (`read`).
 *
 * Live from `agent.run.steered` (with `now`), `agent.run.read` and the run's
 * end; on load and reconnect from the messages' `meta.steeredRunIds` and the
 * channel's active runs (`pendingMessageIds`): a run that isn't active anymore,
 * or is active without the message among its pending ones, read it.
 *
 * One store per app, fed by `RealtimeConnection` (events) and the HTTP client
 * (message lists, active runs), so web and phone read it the same way:
 * `useSteerState(orgId, channelId, messageId)`.
 */
export type SteerPhase = "waiting" | "now" | "read";

export interface SteerState {
  runId: string;
  agentId: string;
  state: SteerPhase;
}

interface LiveSteer extends SteerState {
  channelId: string;
  /** When we heard it (an active-runs list asked earlier can't undo it). */
  at: number;
}

export interface SteerStoreState {
  /** From events, by message id. */
  live: Record<string, LiveSteer>;
  /** From message lists: the runs each message went into (agent from its receipts, when known). */
  seeded: Record<string, { channelId: string; runs: { runId: string; agentId: string | null }[] }>;
  /** The active runs of each channel as last listed: run id → its agent and unread messages. */
  active: Record<string, Record<string, { agentId: string; pending: string[] }>>;
  /** Stopped replies someone continued ("Continuar"): message id → the new run. */
  continued: Record<string, string>;
}

export const emptySteer: SteerStoreState = { live: {}, seeded: {}, active: {}, continued: {} };

/** The events this store reads (the rest pass through unchanged). */
export type SteerEvent =
  | {
      type: "agent.run.steered";
      channelId: string;
      runId: string;
      agentId?: string;
      messageId: string;
      now?: boolean;
      stop?: boolean;
    }
  | { type: "agent.run.read"; channelId: string; runId: string; agentId: string; messageIds: string[] }
  | { type: "run.continued"; channelId: string; runId: string; newRunId: string; messageId: string }
  | { type: "run.finished"; channelId: string; runId: string; status: string }
  | { type: "run.canceled"; channelId: string; runId: string }
  | { type: string };

/** The run ended: what it hadn't read goes to a run of its own (done) or nowhere (stopped, failed). */
function endRun(state: SteerStoreState, runId: string, read: boolean): SteerStoreState {
  let live = state.live;
  for (const [id, s] of Object.entries(state.live)) {
    if (s.runId !== runId || s.state === "read") continue;
    if (live === state.live) live = { ...state.live };
    if (read) live[id] = { ...s, state: "read" };
    else delete live[id];
  }
  return live === state.live ? state : { ...state, live };
}

export function applySteerEvent(state: SteerStoreState, event: SteerEvent, now = Date.now()): SteerStoreState {
  switch (event.type) {
    case "agent.run.steered": {
      const e = event as Extract<SteerEvent, { type: "agent.run.steered" }>;
      // A "stop": the run is being canceled; the receipt says so, not this.
      if (e.stop) {
        if (!state.live[e.messageId]) return state;
        const { [e.messageId]: _gone, ...live } = state.live;
        return { ...state, live };
      }
      const current = state.live[e.messageId];
      // Already read (events can cross): never back to waiting.
      if (current && current.runId === e.runId && current.state === "read") return state;
      const agentId = e.agentId ?? current?.agentId;
      if (!agentId) return state;
      const next: LiveSteer = {
        runId: e.runId,
        agentId,
        channelId: e.channelId,
        state: e.now ? "now" : "waiting",
        at: now,
      };
      return { ...state, live: { ...state.live, [e.messageId]: next } };
    }
    case "agent.run.read": {
      const e = event as Extract<SteerEvent, { type: "agent.run.read" }>;
      if (e.messageIds.length === 0) return state;
      const live = { ...state.live };
      for (const id of e.messageIds) {
        live[id] = { runId: e.runId, agentId: e.agentId, channelId: e.channelId, state: "read", at: now };
      }
      return { ...state, live };
    }
    case "run.finished": {
      const e = event as Extract<SteerEvent, { type: "run.finished" }>;
      if (e.status === "done") return endRun(state, e.runId, true);
      if (e.status === "failed" || e.status === "canceled") return endRun(state, e.runId, false);
      return state;
    }
    case "run.canceled":
      return endRun(state, (event as Extract<SteerEvent, { type: "run.canceled" }>).runId, false);
    case "run.continued": {
      const e = event as Extract<SteerEvent, { type: "run.continued" }>;
      if (state.continued[e.messageId] === e.newRunId) return state;
      return { ...state, continued: { ...state.continued, [e.messageId]: e.newRunId } };
    }
    default:
      return state;
  }
}

/** A message list arrived: which runs each person's message went into, and stopped replies already continued. */
export function seedSteerMessages(state: SteerStoreState, channelId: string, list: Message[]): SteerStoreState {
  let seeded = state.seeded;
  let continued = state.continued;
  for (const m of list) {
    const runIds = m.meta?.steeredRunIds;
    if (m.author?.type === "person" && Array.isArray(runIds) && runIds.length > 0 && !seeded[m.id]) {
      const runs = runIds
        .filter((id): id is string => typeof id === "string")
        .map((runId) => ({
          runId,
          agentId: m.receipts?.handled.find((h) => h.runId === runId)?.agentId ?? null,
        }));
      if (seeded === state.seeded) seeded = { ...state.seeded };
      seeded[m.id] = { channelId, runs };
    }
    const next = continuedRunIdOf(m);
    if (next && continued[m.id] !== next) {
      if (continued === state.continued) continued = { ...state.continued };
      continued[m.id] = next;
    }
  }
  return seeded === state.seeded && continued === state.continued ? state : { ...state, seeded, continued };
}

/**
 * The channel's active runs as the server lists them (`GET …/active-runs`, asked at `askedAt`):
 * the truth for messages heard about before the question (missed events after a reconnect).
 */
export function reconcileSteer(
  state: SteerStoreState,
  channelId: string,
  runs: ActiveRun[],
  askedAt = Date.now(),
): SteerStoreState {
  const active: Record<string, { agentId: string; pending: string[] }> = {};
  for (const r of runs) active[r.runId] = { agentId: r.agentId, pending: r.pendingMessageIds ?? [] };
  let live = state.live;
  for (const [id, s] of Object.entries(state.live)) {
    if (s.channelId !== channelId || s.state === "read" || s.at > askedAt) continue;
    if (active[s.runId]?.pending.includes(id)) continue;
    if (live === state.live) live = { ...state.live };
    live[id] = { ...s, state: "read" };
  }
  return { ...state, live, active: { ...state.active, [channelId]: active } };
}

/** The steer state of a message, or null (not sent into a task, or not known yet). */
export function steerStateIn(state: SteerStoreState, messageId: string): SteerState | null {
  const live = state.live[messageId];
  if (live) return { runId: live.runId, agentId: live.agentId, state: live.state };
  const seeded = state.seeded[messageId];
  const listed = seeded ? state.active[seeded.channelId] : undefined;
  if (!seeded || !listed) return null;
  let read: SteerState | null = null;
  for (const r of seeded.runs) {
    const a = listed[r.runId];
    if (a?.pending.includes(messageId)) return { runId: r.runId, agentId: a.agentId, state: "waiting" };
    const agentId = r.agentId ?? a?.agentId;
    if (!read && agentId) read = { runId: r.runId, agentId, state: "read" };
  }
  return read;
}

/** The run that continues this stopped reply (`meta.canceled.continuedRunId`), if any. */
export function continuedRunIdOf(message: Pick<Message, "meta">): string | null {
  const canceled = message.meta?.canceled as { continuedRunId?: unknown } | undefined;
  return typeof canceled?.continuedRunId === "string" ? canceled.continuedRunId : null;
}

// ── The app's one store ───────────────────────────────────────────────────────

let current: SteerStoreState = emptySteer;
const listeners = new Set<() => void>();

function update(next: SteerStoreState) {
  if (next === current) return;
  current = next;
  for (const l of [...listeners]) l();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Fed by `RealtimeConnection` and the HTTP client; tests may feed and reset it by hand. */
export const steerStore = {
  get: () => current,
  apply: (event: SteerEvent, now = Date.now()) => update(applySteerEvent(current, event, now)),
  seed: (channelId: string, list: Message[]) => update(seedSteerMessages(current, channelId, list)),
  reconcile: (channelId: string, runs: ActiveRun[], askedAt?: number) =>
    update(reconcileSteer(current, channelId, runs, askedAt)),
  subscribe,
  reset: () => update(emptySteer),
};

/** The steer state of a message right now (outside React). */
export const steerStateOf = (messageId: string) => steerStateIn(current, messageId);

/** The run that continues this stopped reply, heard live or from its meta. */
export const continuedRunOf = (messageId: string) => current.continued[messageId] ?? null;

const keyOf = (s: SteerState | null) => (s ? `${s.state}|${s.runId}|${s.agentId}` : "");

/**
 * Under a person's message: "lê na próxima pausa" / "parou para ler" / "leu", or null.
 * `orgId` and `channelId` name where the message is (ids are unique; the store is the app's).
 */
export function useSteerState(_orgId: string, _channelId: string, messageId: string): SteerState | null {
  const key = useSyncExternalStore(
    subscribe,
    () => keyOf(steerStateOf(messageId)),
    () => "",
  );
  return useMemo(() => {
    if (!key) return null;
    const [state, runId, agentId] = key.split("|") as [SteerPhase, string, string];
    return { runId, agentId, state };
  }, [key]);
}

/** "Continuar" was used on this stopped reply (here or on another device): the new run's id, or null. */
export function useContinuedRun(messageId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => continuedRunOf(messageId),
    () => null,
  );
}
