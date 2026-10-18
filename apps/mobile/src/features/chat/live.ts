import {
  type AgentQuestion,
  ApiError,
  applyChannelEvent,
  applyConsultEvent,
  type ChannelEvent,
  type ConsultsState,
  cacheApproval,
  cacheMessage,
  consultsIn,
  dismissRun,
  emptyStreams,
  expectReply,
  keys,
  type LiveConsult,
  type LiveRun,
  type Message,
  markStopping,
  type ReactionCount,
  reconcileRuns,
  runsInChannel,
  type StreamsState,
  unmarkStopping,
  useApi,
} from "@agenteschat/client";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { useConnection } from "../shared/hooks";

/**
 * A conversation, live: subscribes to its channel while the screen is open,
 * keeps the message caches current (new messages, reactions, approvals,
 * agents' questions, threads, missions) and holds the runs in progress (streaming text, who is
 * working, agents asking agents). The database stays the truth: on open and
 * after a reconnect the active runs come from the server.
 */

interface LiveState {
  streams: StreamsState;
  consults: ConsultsState;
}

type Action =
  | { type: "event"; event: ChannelEvent; at: number }
  | { type: "reconcile"; channelId: string; active: Parameters<typeof reconcileRuns>[2]; at: number; askedAt: number }
  | { type: "expect"; channelId: string; threadId: string; agentIds: string[]; at: number }
  | { type: "stopping"; runId: string; byUserId: string }
  | { type: "unstopping"; runId: string }
  | { type: "dismiss"; runId: string };

function reduce(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "event": {
      const streams = applyChannelEvent(state.streams, action.event, action.at);
      const consults = applyConsultEvent(state.consults, action.event, action.at);
      // Most events (typing, receipts) change neither: no re-render.
      return streams === state.streams && consults === state.consults ? state : { streams, consults };
    }
    case "reconcile":
      return {
        ...state,
        streams: reconcileRuns(state.streams, action.channelId, action.active, action.at, action.askedAt),
      };
    case "expect": {
      let streams = state.streams;
      for (const agentId of action.agentIds)
        streams = expectReply(streams, { channelId: action.channelId, threadId: action.threadId, agentId }, action.at);
      return { ...state, streams };
    }
    case "stopping":
      return { ...state, streams: markStopping(state.streams, action.runId, action.byUserId) };
    case "unstopping":
      return { ...state, streams: unmarkStopping(state.streams, action.runId) };
    case "dismiss":
      return { ...state, streams: dismissRun(state.streams, action.runId) };
  }
}

/** Reactions changed for everyone: the message's pills in every loaded list, and the reactions cache. */
function cacheReactions(
  qc: QueryClient,
  orgId: string,
  channelId: string,
  messageId: string,
  reactions: ReactionCount[],
) {
  qc.setQueryData(keys.reactions(orgId, messageId), reactions);
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === messageId)) return data;
    return list.map((m) => (m.id === messageId ? { ...m, reactions } : m));
  });
}

/**
 * A message was pinned or unpinned: its mark in every loaded list of the
 * channel (the pins list itself is refetched). Also used optimistically by
 * "Fixar" / "Desafixar".
 */
export function cachePinned(qc: QueryClient, orgId: string, channelId: string, messageId: string, pinned: boolean) {
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === messageId)) return data;
    return list.map((m) => (m.id === messageId ? { ...m, pinned } : m));
  });
}

/** A question was asked or answered: its card (`meta.question`) in every loaded list of the channel. */
function cacheQuestion(qc: QueryClient, orgId: string, channelId: string, question: AgentQuestion) {
  if (!question.messageId) return;
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === question.messageId)) return data;
    return list.map((m) => (m.id === question.messageId ? { ...m, meta: { ...m.meta, question } } : m));
  });
}

/** What each event changes in the caches (the run rows are the reducer's). */
function applyToCache(qc: QueryClient, orgId: string, channelId: string, event: ChannelEvent) {
  switch (event.type) {
    case "message.created":
      if (event.message) cacheMessage(qc, orgId, event.message);
      else void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
      // A new top-level message may get agent replies in its thread: start that list.
      if (event.message && !event.message.threadId)
        qc.setQueryData(keys.thread(orgId, channelId, event.message.id), (list: unknown) => list ?? []);
      // The conversation list's last line and unread.
      void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
      void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      break;
    case "message.pinned":
    case "message.unpinned":
      cachePinned(qc, orgId, channelId, event.messageId, event.type === "message.pinned");
      void qc.invalidateQueries({ queryKey: keys.pins(orgId, channelId) });
      break;
    case "agent.run":
    case "run.finished":
      // "Trabalhando agora" on Início.
      void qc.invalidateQueries({ queryKey: keys.working(orgId) });
      break;
    case "message.reactions":
      cacheReactions(qc, orgId, channelId, event.messageId, event.reactions);
      break;
    case "approval.created":
    case "approval.decided":
      cacheApproval(qc, orgId, event.approval);
      break;
    case "thread.updated":
      void qc.invalidateQueries({ queryKey: keys.threads(orgId) });
      if (["created", "context", "moved", "returned", "deleted"].includes(event.change))
        void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", event.channelId] });
      break;
    case "mission.updated":
      void qc.invalidateQueries({ queryKey: keys.missions(orgId) });
      if (event.change === "suggestion" || event.change === "closed" || event.change === "done")
        void qc.invalidateQueries({ queryKey: keys.thread(orgId, event.channelId, event.threadId) });
      break;
    case "question.asked":
    case "question.answered":
      cacheQuestion(qc, orgId, channelId, event.question);
      break;
    case "machine.task":
      if (event.task.threadId) void qc.invalidateQueries({ queryKey: keys.threadTasks(orgId, event.task.threadId) });
      if (event.task.missionId) void qc.invalidateQueries({ queryKey: keys.mission(orgId, event.task.missionId) });
      break;
    default:
      break;
  }
}

export interface ChatLive {
  /** Runs in this channel, oldest first. */
  runs: LiveRun[];
  /** Agents asking agents right now. */
  consults: LiveConsult[];
  /** Right after sending: "pensando…" for the agents that will answer (an agent DM). */
  expect: (threadId: string, agentIds: string[]) => void;
  /** "Parar" (as on the web): "Parando…" until the run's event; a run that already ended just leaves. */
  stop: (runId: string, byUserId: string) => void;
}

export function useChatLive(orgId: string, channelId: string, enabled: boolean): ChatLive {
  const connection = useConnection();
  const qc = useQueryClient();
  const api = useApi();
  const [state, dispatch] = useReducer(reduce, { streams: emptyStreams, consults: {} });

  // On open and after every reconnect: the server's active runs replace what we guessed.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const check = () => {
      const askedAt = Date.now();
      api.agents
        .activeRuns(orgId, channelId)
        .then((active) => {
          if (alive && active) dispatch({ type: "reconcile", channelId, active, at: Date.now(), askedAt });
        })
        .catch(() => {});
    };
    check();
    const off = connection?.onReconnect(() => {
      check();
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [api, connection, enabled, orgId, channelId, qc]);

  useEffect(() => {
    if (!connection || !enabled) return;
    return connection.subscribe(channelId, (event) => {
      dispatch({ type: "event", event, at: Date.now() });
      applyToCache(qc, orgId, channelId, event);
    });
  }, [connection, enabled, orgId, channelId, qc]);

  const expect = useCallback(
    (threadId: string, agentIds: string[]) => {
      if (agentIds.length > 0) dispatch({ type: "expect", channelId, threadId, agentIds, at: Date.now() });
    },
    [channelId],
  );

  const stop = useCallback(
    (runId: string, byUserId: string) => {
      dispatch({ type: "stopping", runId, byUserId });
      api.agents.cancelRun(orgId, runId).catch((err: unknown) => {
        // 409 `run_finished`: it ended on its own meanwhile; its message is on the way (or already here).
        if (err instanceof ApiError && err.status === 409) {
          dispatch({ type: "dismiss", runId });
          void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
        } else dispatch({ type: "unstopping", runId });
      });
    },
    [api, orgId, channelId, qc],
  );

  return useMemo(
    () => ({
      runs: runsInChannel(state.streams, channelId),
      consults: consultsIn(state.consults, channelId),
      expect,
      stop,
    }),
    [state, channelId, expect, stop],
  );
}
