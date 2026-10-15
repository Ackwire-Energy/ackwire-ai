import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { keys } from "@/api/keys";
import { cacheApproval, cacheMessage } from "@/api/queries";
import type {
  Agent,
  AgentComputer,
  AgentQuestion,
  BudgetEvent,
  ChannelEvent,
  MemoryUpdate,
  Message,
} from "@/api/types";
import { formatUsd } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { type ConnectionStatus, RealtimeConnection, realtimeUrl, type SocketFactory } from "./connection";
import { applyReceiptEvent, guessReceipt, type ReceiptsState, seedReceipt } from "./receipts";
import {
  applyChannelEvent,
  dismissRun,
  dropProvisional,
  emptyStreams,
  expectReply,
  type LiveRun,
  type StreamsState,
  staleProvisional,
} from "./streams";
import { applyTyping, stopTyping, type TypingState, typingThrottle } from "./typing";

/** Live state shared by the channel and the sidebar: runs, receipts and who is typing. */
export interface LiveState {
  streams: StreamsState;
  receipts: ReceiptsState;
  typing: TypingState;
  /** Latest state of agent questions (answered elsewhere, or by us). */
  questions: Record<string, AgentQuestion>;
  /** `memory.updated` cards per channel (live; they aren't in the message list). */
  memory: Record<string, LiveMemoryCard[]>;
  /** "O Theo só responde a Walter." per channel: only for me, never stored. */
  notices: Record<string, LiveNotice[]>;
}

export interface LiveNotice {
  key: string;
  agentId: string;
  threadId: string | null;
  messageId: string;
  text: string;
}

/** `agent.unavailable` (user scope): my message mentioned an agent that doesn't answer me. */
export interface AgentUnavailableEvent {
  type: "agent.unavailable";
  agentId: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
  text: string;
}

export const isAgentUnavailable = (e: { type: string }): e is AgentUnavailableEvent =>
  e.type === "agent.unavailable" &&
  typeof (e as AgentUnavailableEvent).agentId === "string" &&
  typeof (e as AgentUnavailableEvent).channelId === "string";

export interface LiveMemoryCard {
  key: string;
  agentId: string;
  threadId: string;
  update: MemoryUpdate;
}

/** A small external store; components subscribe to slices of it (`useLive`). */
export const PROVISIONAL_TTL_MS = 20_000;

/** The agent's message now carries its memory cards (`meta.memoryUpdates`): drop the live ones. */
function dropMemoryOfRun(memory: LiveState["memory"], channelId: string, runId: string) {
  const list = memory[channelId];
  if (!list) return memory;
  return { ...memory, [channelId]: list.filter((c) => !c.key.startsWith(`${runId}:`)) };
}

export function createStreamsStore(
  initial: StreamsState = emptyStreams,
  now: () => number = () => Date.now(),
  provisionalTtlMs = PROVISIONAL_TTL_MS,
) {
  let state: LiveState = { streams: initial, receipts: {}, typing: {}, memory: {}, questions: {}, notices: {} };
  const listeners = new Set<() => void>();
  const set = (next: LiveState) => {
    if (
      next.streams === state.streams &&
      next.receipts === state.receipts &&
      next.typing === state.typing &&
      next.memory === state.memory &&
      next.questions === state.questions &&
      next.notices === state.notices
    )
      return;
    state = next;
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    apply: (event: ChannelEvent) => {
      let typing = state.typing;
      if (event.type === "user.typing") typing = applyTyping(typing, event.channelId, event.userId, now(), event.ttlMs);
      const memory =
        event.type === "memory.updated"
          ? {
              ...state.memory,
              [event.channelId]: [
                ...(state.memory[event.channelId] ?? []).filter(
                  (m) => m.key !== `${event.runId}:${event.update.itemId}`,
                ),
                {
                  key: `${event.runId}:${event.update.itemId}`,
                  agentId: event.agentId,
                  threadId: event.threadId,
                  update: event.update,
                },
              ],
            }
          : event.type === "message.created" &&
              event.message?.agentRunId &&
              Array.isArray(event.message.meta?.memoryUpdates)
            ? dropMemoryOfRun(state.memory, event.channelId, event.message.agentRunId)
            : state.memory;
      if (event.type === "message.created" && event.message?.author?.type === "person" && event.message.author.id) {
        typing = stopTyping(typing, event.channelId, event.message.author.id);
      }
      const questions =
        event.type === "question.asked" || event.type === "question.answered"
          ? { ...state.questions, [event.question.id]: event.question }
          : state.questions;
      set({
        ...state,
        questions,
        memory,
        streams: applyChannelEvent(state.streams, event),
        receipts: applyReceiptEvent(
          event.type === "message.created" && event.message
            ? seedReceipt(state.receipts, event.message)
            : state.receipts,
          event,
        ),
        typing,
      });
    },
    /** Person messages loaded over HTTP: start their receipts. */
    seed: (messages: Message[]) => {
      let receipts = state.receipts;
      for (const m of messages) receipts = seedReceipt(receipts, m);
      set({ ...state, receipts });
    },
    /** Right after sending: provisional "pensando…" rows and receipts for the agents we mentioned. */
    expect: (channelId: string, messageId: string, agentIds: string[]) => {
      let streams = state.streams;
      let receipts = state.receipts;
      for (const agentId of agentIds)
        streams = expectReply(streams, { channelId, threadId: messageId, agentId }, now());
      receipts = guessReceipt(receipts, messageId, agentIds);
      set({ ...state, streams, receipts });
    },
    /** The optimistic message got its server id: move its "pensando…" rows and receipts there. */
    retarget: (fromId: string, toId: string) => {
      const runs: Record<string, LiveRun> = {};
      for (const [id, r] of Object.entries(state.streams.runs)) {
        if (r.provisional && r.threadId === fromId) {
          const moved = { ...r, threadId: toId, runId: `pending:${r.agentId}:${toId}` };
          runs[moved.runId] = moved;
        } else runs[id] = r;
      }
      const { [fromId]: moving, ...receipts } = state.receipts;
      set({
        ...state,
        streams: { ...state.streams, runs },
        receipts: moving && !receipts[toId] ? { ...receipts, [toId]: moving } : receipts,
      });
    },
    /**
     * Safety net: a "pensando…" the server never confirmed (no event for
     * `PROVISIONAL_TTL_MS`) is dropped, with its unconfirmed receipt. Returns
     * the channels to resync over HTTP.
     */
    sweep: (at = now()): string[] => {
      const stale = staleProvisional(state.streams, at, provisionalTtlMs);
      if (stale.length === 0) return [];
      const threads = new Set(stale.map((r) => r.threadId));
      const receipts = Object.fromEntries(
        Object.entries(state.receipts).filter(([id, r]) => !(threads.has(id) && !r.confirmed)),
      );
      set({ ...state, streams: dropProvisional(state.streams, threads), receipts });
      return [...new Set(stale.map((r) => r.channelId))];
    },
    /** The agent won't answer me: show the notice and drop its "pensando…" on that message. */
    unavailable: (e: AgentUnavailableEvent) => {
      const key = `${e.messageId}:${e.agentId}`;
      const list = (state.notices[e.channelId] ?? []).filter((n) => n.key !== key);
      const notice = { key, agentId: e.agentId, threadId: e.threadId, messageId: e.messageId, text: e.text };
      set({
        ...state,
        streams: dismissRun(state.streams, `pending:${e.agentId}:${e.messageId}`),
        notices: { ...state.notices, [e.channelId]: [...list, notice] },
      });
    },
    /** Our own answer, before (or instead of) the server's event. */
    answered: (question: AgentQuestion) =>
      set({ ...state, questions: { ...state.questions, [question.id]: question } }),
    dismiss: (runId: string) => set({ ...state, streams: dismissRun(state.streams, runId) }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type StreamsStore = ReturnType<typeof createStreamsStore>;

interface RealtimeValue {
  connection: RealtimeConnection | null;
  streams: StreamsStore;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

const browserSocket: SocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<SocketFactory>;

/** Which WebSocket to open (tests provide a fake; the app uses the browser's). */
export const SocketFactoryContext = createContext<SocketFactory>(browserSocket);

/** One WebSocket per organization, opened while the org shell is mounted. */
/** Text of a budget alert for the agent's owner. */
export function budgetAlert(t: TFunction, locale: string, event: BudgetEvent, agentName: string) {
  const spent = formatUsd(t, locale, event.spentNanoUsd / 1e9);
  const budget = formatUsd(t, locale, event.budgetNanoUsd / 1e9);
  return event.type === "budget.exhausted"
    ? t("budget.exhausted", { name: agentName, budget })
    : t("budget.warning", { name: agentName, spent, budget });
}

export function RealtimeProvider({
  orgId,
  createSocket: explicit,
  children,
}: {
  orgId: string;
  createSocket?: SocketFactory;
  children: ReactNode;
}) {
  const fromContext = useContext(SocketFactoryContext);
  const createSocket = explicit ?? fromContext;
  const qc = useQueryClient();
  const toast = useToast();
  const { t, i18n } = useTranslation();
  const streams = useMemo(() => createStreamsStore(), []);
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);
  // Latest `t` without reconnecting when the language changes.
  const tRef = useRef(t);
  tRef.current = t;

  // biome-ignore lint/correctness/useExhaustiveDependencies: one socket per org; toast and language are read live
  useEffect(() => {
    const conn = new RealtimeConnection({ url: realtimeUrl(window.location, orgId), createSocket });
    // Catch up over HTTP after a reconnect: events sent while offline are gone.
    const offReconnect = conn.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel"] });
    });
    // Approvals I can decide arrive here even when I'm not in that channel (sidebar badge, Aprovações).
    const offUser = conn.onUserEvent((event) => {
      if ((event.type === "approval.created" || event.type === "approval.decided") && "approval" in event) {
        cacheApproval(qc, orgId, event.approval);
        void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
        void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
      }
      if (isAgentUnavailable(event)) streams.unavailable(event);
      // The forum (org broadcasts): the list and the open topic refresh.
      if ((event.type === "forum.topic.updated" || event.type === "forum.post.created") && "topicId" in event) {
        const topicId = String(event.topicId);
        void qc.invalidateQueries({ queryKey: keys.forum(orgId), exact: true });
        void qc.invalidateQueries({ queryKey: keys.forumTopic(orgId, topicId) });
      }
      // The agent's PC changed (started, stopped, deleted): no more polling needed.
      if (event.type === "agent.computer" && "agentId" in event && typeof event.agentId === "string") {
        const computer = (event as { computer?: AgentComputer }).computer;
        if (computer && typeof computer.status === "string") {
          qc.setQueryData(keys.computer(orgId, event.agentId), computer);
        } else void qc.invalidateQueries({ queryKey: keys.computer(orgId, event.agentId) });
      }
      if ((event.type === "budget.warning" || event.type === "budget.exhausted") && "agentId" in event) {
        const budgetEvent = event as BudgetEvent;
        const agent = qc.getQueryData<Agent[]>(keys.agents(orgId))?.find((a) => a.id === budgetEvent.agentId);
        toast.show(budgetAlert(tRef.current, i18n.language, budgetEvent, agent?.name ?? ""), "error");
        void qc.invalidateQueries({ queryKey: keys.agentDetail(orgId, budgetEvent.agentId) });
        void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
      }
    });
    conn.start();
    setConnection(conn);
    return () => {
      offReconnect();
      offUser();
      conn.stop();
      setConnection(null);
    };
  }, [orgId, createSocket, qc]);

  // Resync what the server never confirmed instead of spinning forever.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const channelId of streams.sweep()) {
        void qc.invalidateQueries({ queryKey: keys.messages(orgId, channelId) });
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [streams, qc, orgId]);

  return <RealtimeContext.Provider value={{ connection, streams }}>{children}</RealtimeContext.Provider>;
}

function useRealtime() {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error("useRealtime must be used inside RealtimeProvider");
  return value;
}

/** Subscribes to a channel while mounted: live runs + message cache updates. */
export function useChannelRealtime(orgId: string, channelId: string, enabled: boolean) {
  const { connection, streams } = useRealtime();
  const qc = useQueryClient();
  useEffect(() => {
    if (!connection || !enabled) return;
    return connection.subscribe(channelId, (event) => {
      streams.apply(event);
      if (event.type === "approval.created" || event.type === "approval.decided") {
        cacheApproval(qc, orgId, event.approval);
      }
      if (event.type === "artifact.created" || event.type === "artifact.updated") {
        // Cards, the open viewer and Drive refetch: the new version is the latest.
        void qc.invalidateQueries({ queryKey: keys.artifacts(orgId) });
      }
      if (event.type === "message.created") {
        if (event.message) cacheMessage(qc, orgId, event.message);
        else void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
        // A new top-level message may get agent replies in its thread: start watching it.
        if (event.message && !event.message.threadId) {
          qc.setQueryData(keys.thread(orgId, channelId, event.message.id), (list: unknown) => list ?? []);
        }
      }
    });
  }, [connection, enabled, orgId, channelId, qc, streams]);
}

/**
 * Subscribes to a slice of the live store; re-renders only when that slice
 * changes (`isEqual`), so a streaming delta re-renders the streaming row, not
 * the whole timeline.
 */
export function useLive<T>(select: (state: LiveState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const { streams: store } = useRealtime();
  const selectRef = useRef(select);
  selectRef.current = select;
  const [value, setValue] = useState(() => select(store.get()));
  const valueRef = useRef(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selector and isEqual are read through refs
  useEffect(() => {
    const check = () => {
      const next = selectRef.current(store.get());
      if (!isEqual(valueRef.current, next)) {
        valueRef.current = next;
        setValue(() => next);
      }
    };
    check();
    return store.subscribe(check);
  }, [store]);
  return value;
}

export function useStreams<T>(select: (state: StreamsState) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useLive((s) => select(s.streams), isEqual);
}

export function useLiveStore() {
  return useRealtime().streams;
}

/** Throttled "I'm typing" for a channel. */
export function useTypingSender(channelId: string) {
  const { connection } = useRealtime();
  const throttle = useMemo(() => typingThrottle(), []);
  return () => {
    if (connection && throttle(Date.now())) connection.sendTyping(channelId);
  };
}

export function useDismissRun() {
  return useRealtime().streams.dismiss;
}

export function useConnectionStatus(): ConnectionStatus {
  const { connection } = useRealtime();
  const [status, setStatus] = useState<ConnectionStatus>(connection?.status ?? "idle");
  useEffect(() => {
    if (!connection) return;
    setStatus(connection.status);
    return connection.onStatus(setStatus);
  }, [connection]);
  return status;
}
