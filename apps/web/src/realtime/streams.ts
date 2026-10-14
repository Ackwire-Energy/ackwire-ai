import type { ChannelEvent, RunStatus } from "@/api/types";

/**
 * Live agent runs per channel, built from `agent.run` and `agent.delta`
 * events. Deltas are ordered by `seq` and never persisted: the final
 * `message.created` (with `agentRunId`) replaces the streaming text.
 */
export interface LiveRun {
  runId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  status: RunStatus;
  text: string;
  lastSeq: number;
  error?: string;
}

export interface StreamsState {
  runs: Record<string, LiveRun>;
  /** Runs whose final message arrived: late deltas for them are ignored. */
  finished: Record<string, true>;
}

export const emptyStreams: StreamsState = { runs: {}, finished: {} };

export function applyChannelEvent(state: StreamsState, event: ChannelEvent): StreamsState {
  switch (event.type) {
    case "message.created": {
      const runId = event.message?.agentRunId;
      if (!runId) return state;
      return finish(state, runId);
    }
    case "agent.run": {
      if (state.finished[event.runId]) {
        // A run resumed after an approval streams again, from a fresh text.
        if (event.status !== "running") return state;
        const { [event.runId]: _f, ...finished } = state.finished;
        state = { ...state, finished };
      }
      const current = state.runs[event.runId];
      if (event.status === "done") {
        // The message event normally comes first; either way the run is over.
        return current ? finish(state, event.runId) : state;
      }
      const next: LiveRun = current
        ? { ...current, status: event.status, error: event.error }
        : {
            runId: event.runId,
            agentId: event.agentId,
            channelId: event.channelId,
            threadId: event.threadId,
            status: event.status,
            text: "",
            lastSeq: 0,
            error: event.error,
          };
      return { ...state, runs: { ...state.runs, [event.runId]: next } };
    }
    case "agent.delta": {
      if (state.finished[event.runId]) return state;
      const current = state.runs[event.runId];
      if (current && event.seq <= current.lastSeq) return state;
      const base: LiveRun = current ?? {
        runId: event.runId,
        agentId: event.agentId,
        channelId: event.channelId,
        threadId: event.threadId,
        status: "running",
        text: "",
        lastSeq: 0,
      };
      return {
        ...state,
        runs: { ...state.runs, [event.runId]: { ...base, text: base.text + event.text, lastSeq: event.seq } },
      };
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
      .filter((r) => r.status === "running" || r.status === "queued")
      .map((r) => r.agentId),
  );
