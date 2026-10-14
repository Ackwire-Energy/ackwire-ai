import type { ChannelEvent, RunStatus } from "@/api/types";

/**
 * Live agent runs per channel, from `agent.run`, `agent.delta` and (expected
 * from the backend) `agent.thinking` / `agent.typing` / `agent.idle` /
 * `run.finished`. Deltas are ordered by `seq` and never persisted: the final
 * `message.created` (with `agentRunId`) replaces the streaming text.
 *
 * A row can also start *before* the server says anything: right after you
 * mention an agent, `expectReply` adds a provisional "thinking" row that the
 * first real event for that agent and thread replaces.
 */
export type LiveStatus = RunStatus | "thinking";

export interface LiveRun {
  /** When a provisional row was added (for the safety timeout). */
  since?: number;
  runId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  status: LiveStatus;
  text: string;
  lastSeq: number;
  error?: string;
  /** Added by the client on send; no server event yet. */
  provisional?: boolean;
}

export interface StreamsState {
  runs: Record<string, LiveRun>;
  /** Runs whose final message arrived: late deltas for them are ignored. */
  finished: Record<string, true>;
}

export const emptyStreams: StreamsState = { runs: {}, finished: {} };

const provisionalId = (agentId: string, threadId: string) => `pending:${agentId}:${threadId}`;

/** Shows "Ada está pensando…" right away for an agent that was mentioned or picked. */
export function expectReply(
  state: StreamsState,
  event: { channelId: string; threadId: string; agentId: string },
  now = Date.now(),
) {
  const input = { channelId: event.channelId, threadId: event.threadId, agentId: event.agentId };
  const runId = provisionalId(input.agentId, input.threadId);
  const alreadyLive = Object.values(state.runs).some(
    (r) => !r.provisional && r.agentId === input.agentId && r.threadId === input.threadId,
  );
  if (alreadyLive || state.runs[runId]) return state;
  const run: LiveRun = { ...input, runId, status: "thinking", text: "", lastSeq: 0, provisional: true, since: now };
  return { ...state, runs: { ...state.runs, [runId]: run } };
}

/** Drops the provisional row of an agent/thread once the server reports on it. */
function settleProvisional(state: StreamsState, agentId: string, threadId: string): StreamsState {
  const id = provisionalId(agentId, threadId);
  if (!state.runs[id]) return state;
  const { [id]: _p, ...runs } = state.runs;
  return { ...state, runs };
}

function upsert(
  state: StreamsState,
  event: { runId: string; agentId: string; channelId: string; threadId: string },
  patch: Partial<LiveRun>,
) {
  const base = settleProvisional(state, event.agentId, event.threadId);
  const current = base.runs[event.runId];
  const next: LiveRun = {
    runId: event.runId,
    agentId: event.agentId,
    channelId: event.channelId,
    threadId: event.threadId,
    status: "running",
    text: "",
    lastSeq: 0,
    ...current,
    ...patch,
  };
  return { ...base, runs: { ...base.runs, [event.runId]: next } };
}

/** A run resumed after an approval streams again, from a fresh text. */
function reopen(state: StreamsState, runId: string): StreamsState {
  if (!state.finished[runId]) return state;
  const { [runId]: _f, ...finished } = state.finished;
  return { ...state, finished };
}

export function applyChannelEvent(state: StreamsState, event: ChannelEvent): StreamsState {
  switch (event.type) {
    case "message.created": {
      const m = event.message;
      if (!m?.agentRunId) return state;
      const next = finish(state, m.agentRunId);
      return m.author?.type === "agent" && m.author.id && m.threadId
        ? settleProvisional(next, m.author.id, m.threadId)
        : next;
    }
    case "agent.run": {
      let s = state;
      if (s.finished[event.runId]) {
        if (event.status !== "running") return state;
        s = reopen(s, event.runId);
      }
      if (event.status === "done") {
        const settled = settleProvisional(s, event.agentId, event.threadId);
        return settled.runs[event.runId] ? finish(settled, event.runId) : settled;
      }
      // Started but nothing written yet: thinking.
      const current = s.runs[event.runId];
      const status: LiveStatus =
        (event.status === "running" || event.status === "queued") && !current?.text ? "thinking" : event.status;
      return upsert(s, event, { status, error: event.error });
    }
    case "agent.thinking": {
      // Announced at post time, before the run exists.
      if (event.runId === null) return expectReply(state, event);
      const s = reopen(state, event.runId);
      return upsert(s, { ...event, runId: event.runId }, { status: "thinking" });
    }
    case "agent.typing": {
      const s = reopen(state, event.runId);
      if (s.finished[event.runId]) return state;
      return upsert(s, event, { status: "running" });
    }
    case "agent.idle": {
      const settled = settleProvisional(state, event.agentId, event.threadId);
      // A failure is reported by run.finished; keep a failed row visible.
      if (settled.runs[event.runId]?.status === "failed") return settled;
      return settled.runs[event.runId] ? finish(settled, event.runId) : settled;
    }
    case "run.finished": {
      const settled = settleProvisional(state, event.agentId, event.threadId);
      if (event.status === "failed") return upsert(settled, event, { status: "failed", error: event.error });
      // done: the message replaces the row; waiting_approval: the approval card does.
      return settled.runs[event.runId] ? finish(settled, event.runId) : settled;
    }
    case "message.routed": {
      // Agents the router didn't pick won't answer: drop their "pensando…".
      const picked = new Set(event.pickedBy);
      const runs = Object.fromEntries(
        Object.entries(state.runs).filter(
          ([, r]) => !(r.provisional && r.threadId === event.messageId && !picked.has(r.agentId)),
        ),
      );
      return Object.keys(runs).length === Object.keys(state.runs).length ? state : { ...state, runs };
    }
    case "agent.delta": {
      if (state.finished[event.runId]) return state;
      const current = state.runs[event.runId];
      if (current && event.seq <= current.lastSeq) return state;
      return upsert(state, event, { status: "running", text: (current?.text ?? "") + event.text, lastSeq: event.seq });
    }
    default:
      return state;
  }
}

function finish(state: StreamsState, runId: string): StreamsState {
  const { [runId]: _done, ...runs } = state.runs;
  return { runs, finished: { ...state.finished, [runId]: true } };
}

/** Forget a failed run after the person has seen it. */
export function dismissRun(state: StreamsState, runId: string): StreamsState {
  return finish(state, runId);
}

/** Runs to show in a channel, oldest first. */
export const runsInChannel = (state: StreamsState, channelId: string) =>
  Object.values(state.runs).filter((r) => r.channelId === channelId);

/** Agents currently executing anywhere we listen to (sidebar ring). */
export const runningAgents = (state: StreamsState) =>
  new Set(
    Object.values(state.runs)
      .filter((r) => r.status === "running" || r.status === "queued" || r.status === "thinking")
      .map((r) => r.agentId),
  );

/** Provisional rows older than `maxAgeMs` (no server event since): their message ids, to resync. */
export function staleProvisional(state: StreamsState, now: number, maxAgeMs: number) {
  return Object.values(state.runs).filter((r) => r.provisional && now - (r.since ?? now) >= maxAgeMs);
}

/** Drops provisional rows of these threads. */
export function dropProvisional(state: StreamsState, threadIds: Set<string>): StreamsState {
  const runs = Object.fromEntries(
    Object.entries(state.runs).filter(([, r]) => !(r.provisional && threadIds.has(r.threadId))),
  );
  return { ...state, runs };
}
