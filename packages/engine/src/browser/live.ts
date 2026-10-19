import type { BrowserInputEvent, BrowserStreamMode, RunnerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import type { MachineHub } from "../machine-hub";
import { getMachineById, machineOnline } from "../machines";
import {
  type BrowserHandoffRow,
  type BrowserHandoffView,
  CONTROL_GRACE_MS,
  expireControl,
  type HandoffDeps,
  type HandoffLiveHooks,
  handoffView,
  openHandoffOf,
} from "./handoff";
import type { BrowserFrame, BrowserViewer, StreamRelay } from "./types";

const { agents } = schema;

/**
 * Frames to viewers, in this process's memory (ADR 0040 §7): nothing is
 * stored. A viewer whose socket is backed up (`busy`) skips frames; the next
 * one it gets is the newest. Swap point for a cross-replica relay later.
 */
export function createMemoryStreamRelay(): StreamRelay {
  const viewers = new Map<string, Set<BrowserViewer & { busy?(): boolean }>>();
  return {
    publish(agentId, frame) {
      for (const v of viewers.get(agentId) ?? []) {
        if (v.busy?.()) continue;
        try {
          v.send(frame);
        } catch {
          // A broken socket is cleaned up by its close.
        }
      }
    },
    subscribe(agentId, viewer) {
      let set = viewers.get(agentId);
      if (!set) {
        set = new Set();
        viewers.set(agentId, set);
      }
      set.add(viewer);
      return () => {
        const current = viewers.get(agentId);
        current?.delete(viewer);
        if (current && current.size === 0) viewers.delete(agentId);
      };
    },
    hasViewers: (agentId) => (viewers.get(agentId)?.size ?? 0) > 0,
  };
}

/** What a viewer's socket receives (`/api/ws`, wrapped by the realtime layer). */
export type BrowserLiveMessage =
  | ({ type: "browser.frame" } & BrowserFrame)
  /** Who is in control and the open handoff, on watch and whenever it changes. */
  | {
      type: "browser.status";
      agentId: string;
      mode: BrowserStreamMode;
      controllerUserId: string | null;
      handoff: BrowserHandoffView | null;
    }
  /**
   * The browser can't be shown from here now: `reconnecting` (the computer is
   * held by another server or is coming back: retry with backoff), `offline`,
   * `no_computer`, `unavailable` (the runner said why in `message`).
   */
  | {
      type: "browser.unavailable";
      agentId: string;
      reason: "reconnecting" | "offline" | "no_computer" | "unavailable";
      message?: string;
    }
  /** The runner stopped the stream (the browser closed, an error). */
  | { type: "browser.ended"; agentId: string; reason: "stopped" | "closed" | "error"; message?: string };

export interface LiveViewer {
  userId: string;
  send(message: BrowserLiveMessage): void;
  /** The socket is backed up: frames are skipped (newest wins). */
  busy?(): boolean;
}

interface AgentLive {
  orgId: string;
  machineId: string;
  handle: string;
  viewers: Set<LiveViewer>;
  unsubscribe: Map<LiveViewer, () => void>;
  /** The mode the runner was last asked for; null = not streaming. */
  mode: BrowserStreamMode | null;
  controllerUserId: string | null;
  handoff: BrowserHandoffView | null;
  /** The person in control left: control ends when this fires, unless they come back. */
  grace: ReturnType<typeof setTimeout> | null;
}

export interface BrowserLiveDeps extends Omit<HandoffDeps, "live"> {
  hub: Pick<MachineHub, "call" | "isLocal">;
  graceMs?: number;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * The live view of agents' browsers on this process (ADR 0040 §7): viewers
 * per agent, the runner's stream started with the first viewer (`watch`,
 * about 1 fps), switched to `control` while the person in control watches,
 * and stopped with the last; a person's input forwarded only for whoever is
 * in control. The machine hub hands it the runner's frames (`hubHooks`), the
 * handoff tells it when control changes hands (`handoffHooks`).
 */
export function createBrowserLive(deps: BrowserLiveDeps) {
  const relay = createMemoryStreamRelay();
  const live = new Map<string, AgentLive>();
  const graceMs = deps.graceMs ?? CONTROL_GRACE_MS;

  const broadcast = (state: AgentLive, message: BrowserLiveMessage) => {
    for (const v of state.viewers) {
      try {
        v.send(message);
      } catch {}
    }
  };

  const status = (agentId: string, state: AgentLive): BrowserLiveMessage => ({
    type: "browser.status",
    agentId,
    mode: state.mode ?? "watch",
    controllerUserId: state.controllerUserId,
    handoff: state.handoff,
  });

  /** The mode the stream should run in now: control while the person in control watches. */
  const wanted = (state: AgentLive): BrowserStreamMode | null => {
    if (state.viewers.size === 0) return null;
    const driving = state.controllerUserId && [...state.viewers].some((v) => v.userId === state.controllerUserId);
    return driving ? "control" : "watch";
  };

  /** Asks the runner for the stream the viewers need (start, mode change, stop). */
  async function sync(agentId: string, state: AgentLive) {
    const mode = wanted(state);
    if (mode === state.mode) return;
    const agent = { id: agentId, handle: state.handle };
    state.mode = mode;
    try {
      if (mode === null) await deps.hub.call(state.machineId, { op: "browser.stream.stop", agent });
      else {
        await deps.hub.call(state.machineId, { op: "browser.stream.start", mode, agent });
        broadcast(state, status(agentId, state));
      }
    } catch (error) {
      // Stopping a stream that is already gone is fine; a stream that can't start is told to the viewers.
      if (mode === null) return;
      state.mode = null;
      broadcast(state, {
        type: "browser.unavailable",
        agentId,
        reason: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const applyHandoff = (state: AgentLive, row: BrowserHandoffRow | null) => {
    const open = row && (row.status === "pending" || row.status === "active") ? row : null;
    state.handoff = open ? handoffView(open) : null;
    state.controllerUserId = open?.status === "active" ? open.controllerUserId : null;
    // Control ended or nobody holds it: an old grace no longer applies.
    if (state.grace && !state.controllerUserId) {
      clearTimeout(state.grace);
      state.grace = null;
    }
  };

  const handoffHooks: HandoffLiveHooks = {
    changed(row) {
      const state = live.get(row.agentId);
      if (!state) return;
      applyHandoff(state, row);
      broadcast(state, status(row.agentId, state));
      void sync(row.agentId, state);
    },
  };

  const handoffDeps: HandoffDeps = { db: deps.db, pubsub: deps.pubsub, live: handoffHooks };

  /** The person in control left: after the grace, control ends (expired) unless they watch again. */
  function startGrace(agentId: string, state: AgentLive, userId: string) {
    if (state.grace) clearTimeout(state.grace);
    const handoffId = state.handoff?.id;
    if (!handoffId) return;
    state.grace = setTimeout(() => {
      state.grace = null;
      if ([...state.viewers].some((v) => v.userId === userId)) return;
      void expireControl(handoffDeps, handoffId, userId).catch((error) =>
        deps.log?.warn("browser control expiry failed", { agentId, error: String(error) }),
      );
    }, graceMs);
  }

  return {
    relay,
    handoffHooks,
    /** Deps for the handoff functions, so the live view hears about changes. */
    handoffDeps,

    /**
     * Starts sending an agent's browser to a viewer. The caller checked the
     * person may see it (`requireBrowserAccess`). Returns the stop function.
     */
    async watch(viewer: LiveViewer, orgId: string, agentId: string): Promise<() => void> {
      const [agent] = await deps.db
        .select({ machineId: agents.machineId, handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
      if (!agent?.machineId) {
        viewer.send({ type: "browser.unavailable", agentId, reason: "no_computer" });
        return () => {};
      }
      if (!deps.hub.isLocal(agent.machineId)) {
        // Held by another replica (or not connected): frames only flow where the socket is.
        const machine = await getMachineById(deps.db, agent.machineId);
        const online = machine && !machine.deletedAt && machineOnline(machine);
        viewer.send({ type: "browser.unavailable", agentId, reason: online ? "reconnecting" : "offline" });
        return () => {};
      }
      let state = live.get(agentId);
      if (!state || state.machineId !== agent.machineId) {
        state = {
          orgId,
          machineId: agent.machineId,
          handle: agent.handle,
          viewers: new Set(),
          unsubscribe: new Map(),
          mode: null,
          controllerUserId: null,
          handoff: null,
          grace: null,
        };
        live.set(agentId, state);
      }
      const current = state;
      applyHandoff(current, await openHandoffOf(deps.db, orgId, agentId));
      current.viewers.add(viewer);
      current.unsubscribe.set(
        viewer,
        relay.subscribe(agentId, {
          send: (frame) => viewer.send({ type: "browser.frame", ...frame }),
          ...(viewer.busy ? { busy: viewer.busy } : {}),
        } as BrowserViewer),
      );
      // The person in control came back within the grace: they keep it.
      if (current.grace && current.controllerUserId === viewer.userId) {
        clearTimeout(current.grace);
        current.grace = null;
      }
      viewer.send(status(agentId, current));
      await sync(agentId, current);
      return () => {
        if (!current.viewers.delete(viewer)) return;
        current.unsubscribe.get(viewer)?.();
        current.unsubscribe.delete(viewer);
        const controller = current.controllerUserId;
        if (controller === viewer.userId && ![...current.viewers].some((v) => v.userId === controller)) {
          startGrace(agentId, current, controller);
        }
        void sync(agentId, current).finally(() => {
          if (current.viewers.size === 0 && !current.grace && live.get(agentId) === current) live.delete(agentId);
        });
      };
    },

    /**
     * A person's input on the live view: forwarded to the runner only when
     * they are in control of the open handoff (checked against the database).
     */
    async input(userId: string, orgId: string, agentId: string, events: BrowserInputEvent[]) {
      const open = await openHandoffOf(deps.db, orgId, agentId);
      if (open?.status !== "active" || open.controllerUserId !== userId) return { accepted: 0, refused: true };
      const [agent] = await deps.db
        .select({ handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
      if (!agent) return { accepted: 0, refused: true };
      const reply = await deps.hub.call(open.machineId, {
        op: "browser.input",
        events,
        agent: { id: agentId, handle: agent.handle },
      });
      return { accepted: reply.accepted, refused: false };
    },

    /** What the machine hub hands over: frames and the end of a stream, from the machine holding them. */
    hubHooks: {
      frame(machineId: string, frame: Extract<RunnerFrame, { type: "browser.frame" }>) {
        const state = live.get(frame.agentId);
        // Only from the agent's own computer, and only while someone watches.
        if (!state || state.machineId !== machineId || state.viewers.size === 0) return;
        relay.publish(frame.agentId, {
          agentId: frame.agentId,
          seq: frame.seq,
          data: frame.data,
          metadata: frame.metadata,
        });
      },
      streamEnded(machineId: string, frame: Extract<RunnerFrame, { type: "browser.stream.ended" }>) {
        const state = live.get(frame.agentId);
        if (!state || state.machineId !== machineId) return;
        state.mode = null;
        broadcast(state, {
          type: "browser.ended",
          agentId: frame.agentId,
          reason: frame.reason,
          ...(frame.message ? { message: frame.message } : {}),
        });
      },
      /** The machine's socket closed here: viewers retry (it may come back on any replica). */
      closed(machineId: string) {
        for (const [agentId, state] of live) {
          if (state.machineId !== machineId) continue;
          state.mode = null;
          broadcast(state, { type: "browser.unavailable", agentId, reason: "reconnecting" });
        }
      },
    },

    /** Whether anyone watches this agent's browser here. */
    watching: (agentId: string) => (live.get(agentId)?.viewers.size ?? 0) > 0,
  };
}

export type BrowserLive = ReturnType<typeof createBrowserLive>;
