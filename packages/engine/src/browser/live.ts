import {
  BROWSER_LIMITS,
  type BrowserInputEvent,
  type BrowserStreamMode,
  type RunnerFrame,
} from "@agenteschat/adapters";
import { and, eq, inArray, schema } from "@agenteschat/db";
import type { MachineHub } from "../machine-hub";
import { getMachineById, machineOnline } from "../machines";
import {
  BROWSER_HANDOFF_TOPIC,
  type BrowserHandoffRow,
  type BrowserHandoffView,
  browserMachineOf,
  CONTROL_GRACE_MS,
  expireControl,
  type HandoffDeps,
  type HandoffLiveHooks,
  handoffInfo,
  handoffView,
  openHandoffOf,
  openHandoffsOfMachine,
  requireBrowserAccess,
  setControlDeadline,
  touchControl,
} from "./handoff";
import type { BrowserFrame, BrowserViewer, StreamRelay } from "./types";

const { agents, browserHandoffs } = schema;

/** Viewers' access is checked again this often (and before input, at most this often). */
const ACCESS_RECHECK_MS = 30_000;
/** While a handoff is open, the agent's browser is touched this often so its idle shutdown (15 min) never closes it. */
export const HANDOFF_KEEPALIVE_MS = 5 * 60_000;
/** Keep-alive pings sent at once (each may wait on a slow computer). */
const KEEPALIVE_PARALLEL = 5;
/**
 * The stream keeps running this long after the last viewer leaves: a page
 * re-rendering, a reconnect or a person switching screens comes right back,
 * and a stop/start on the computer each time made the view flap.
 */
export const STREAM_STOP_DELAY_MS = 10_000;
/** A person's input is gathered this long and sent to the computer as one batch. */
export const INPUT_BATCH_MS = 25;

/**
 * One batch of a person's input, smaller: a run of plain mouse moves (no
 * button held) keeps only its last one; moves while dragging and everything
 * else stay, in order.
 */
export function coalesceInput(events: BrowserInputEvent[]): BrowserInputEvent[] {
  const out: BrowserInputEvent[] = [];
  let dragging = false;
  const plainMove = (e: BrowserInputEvent | undefined, held: boolean) =>
    e?.kind === "mouse" && e.type === "mouseMoved" && !held && (e.button === undefined || e.button === "none");
  for (const e of events) {
    if (plainMove(e, dragging) && plainMove(out.at(-1), dragging)) out[out.length - 1] = e;
    else out.push(e);
    if (e.kind === "mouse" && e.type === "mousePressed") dragging = true;
    if (e.kind === "mouse" && e.type === "mouseReleased") dragging = false;
  }
  return out;
}

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
   * `no_computer`, `unavailable` (the runner said why in `message`),
   * `forbidden` (this person may no longer see it: the view stopped).
   */
  | {
      type: "browser.unavailable";
      agentId: string;
      reason: "reconnecting" | "offline" | "no_computer" | "unavailable" | "forbidden";
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
  /** Stream changes run one after the other (a start never races a mode change or a stop). */
  syncing: Promise<void>;
  /** The last viewer left: the stream stops when this fires, unless someone watches again. */
  stopTimer: ReturnType<typeof setTimeout> | null;
}

export interface BrowserLiveDeps extends Omit<HandoffDeps, "live"> {
  hub: Pick<MachineHub, "call" | "isLocal"> & Partial<Pick<MachineHub, "sendBrowserHandoff">>;
  graceMs?: number;
  accessRecheckMs?: number;
  /** Tests: how long the stream outlives its last viewer (`STREAM_STOP_DELAY_MS`). */
  stopDelayMs?: number;
  /** Tests: how long input is gathered before it goes (`INPUT_BATCH_MS`). */
  inputBatchMs?: number;
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
  const recheckMs = deps.accessRecheckMs ?? ACCESS_RECHECK_MS;
  const stopDelayMs = deps.stopDelayMs ?? STREAM_STOP_DELAY_MS;
  const inputBatchMs = deps.inputBatchMs ?? INPUT_BATCH_MS;
  /** Last access check passed per person and agent (`userId:agentId` → time). */
  const checked = new Map<string, number>();
  /** Last keep-alive per open handoff. */
  const touched = new Map<string, number>();

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

  /**
   * Asks the runner for the stream the viewers need (start, mode change,
   * stop), one change at a time. A stop waits `stopDelayMs` first, and is
   * dropped when someone watches again meanwhile.
   */
  function sync(agentId: string, state: AgentLive, stopNow = false): Promise<void> {
    state.syncing = state.syncing.then(() => syncNow(agentId, state, stopNow)).catch(() => {});
    return state.syncing;
  }

  const cancelStop = (state: AgentLive) => {
    if (!state.stopTimer) return;
    clearTimeout(state.stopTimer);
    state.stopTimer = null;
  };

  /** Nothing left to keep for this agent here: no viewer, no grace, no stream, no pending stop. */
  const forget = (agentId: string, state: AgentLive) => {
    if (state.viewers.size > 0 || state.grace || state.stopTimer || state.mode !== null) return;
    if (live.get(agentId) === state) live.delete(agentId);
  };

  async function syncNow(agentId: string, state: AgentLive, stopNow: boolean) {
    const mode = wanted(state);
    if (mode !== null) cancelStop(state);
    if (mode === state.mode) return;
    if (mode === null && !stopNow) {
      state.stopTimer ??= setTimeout(() => {
        state.stopTimer = null;
        void sync(agentId, state, true).finally(() => forget(agentId, state));
      }, stopDelayMs);
      return;
    }
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

  /** Tells the computer (when its socket is here) the agent's open handoff, or that there is none: its tray shows it. */
  const tellComputer = async (machineId: string, orgId: string, agentId: string) => {
    if (!deps.hub.sendBrowserHandoff || !deps.hub.isLocal(machineId)) return;
    const row = await openHandoffOf(deps.db, orgId, agentId);
    const info = row && row.machineId === machineId ? await handoffInfo(deps.db, row) : null;
    deps.hub.sendBrowserHandoff(machineId, agentId, info);
  };

  // The computer's desktop app hears every change, from whichever replica made it.
  const unsubscribeComputers = deps.pubsub?.subscribe(BROWSER_HANDOFF_TOPIC, (event) => {
    const { machineId, orgId, agentId } = event;
    if (typeof machineId !== "string" || typeof orgId !== "string" || typeof agentId !== "string") return;
    void tellComputer(machineId, orgId, agentId).catch((error) =>
      deps.log?.warn("browser handoff to computer failed", { agentId, error: String(error) }),
    );
  });

  // A handoff changed on another replica (a person claimed it there, handed it back…): the state
  // here, where the computer's socket may be, is read again from the database.
  const unsubscribeHandoffs = deps.pubsub?.subscribe(BROWSER_HANDOFF_TOPIC, (event) => {
    const agentId = typeof event.agentId === "string" ? event.agentId : null;
    const state = agentId ? live.get(agentId) : undefined;
    if (!agentId || !state || event.orgId !== state.orgId) return;
    void openHandoffOf(deps.db, state.orgId, agentId)
      .then((row) => {
        if (live.get(agentId) !== state) return;
        applyHandoff(state, row);
        broadcast(state, status(agentId, state));
        void sync(agentId, state);
      })
      .catch((error) => deps.log?.warn("browser handoff reload failed", { agentId, error: String(error) }));
  });

  /**
   * The agent's browser moved to another computer (a mission's, or back to
   * its own): the old stream stops and its viewers are told to reconnect, so
   * they watch the new one (`browser.watch` again).
   */
  function retire(agentId: string, old: AgentLive) {
    if (old.grace) clearTimeout(old.grace);
    old.grace = null;
    cancelStop(old);
    broadcast(old, { type: "browser.unavailable", agentId, reason: "reconnecting" });
    for (const unsubscribe of old.unsubscribe.values()) unsubscribe();
    old.unsubscribe.clear();
    old.viewers.clear();
    if (old.mode !== null) {
      old.mode = null;
      void deps.hub
        .call(old.machineId, { op: "browser.stream.stop", agent: { id: agentId, handle: old.handle } })
        .catch(() => {});
    }
  }

  /** The person in control left: after the grace, control ends (expired) unless they watch again. */
  function startGrace(agentId: string, state: AgentLive, userId: string) {
    if (state.grace) clearTimeout(state.grace);
    const handoffId = state.handoff?.id;
    if (!handoffId) return;
    // Their deadline in the database: another server, or this one after a restart, ends it at the
    // same time, and coming back anywhere pushes it again.
    const written = setControlDeadline(deps.db, handoffId, userId, new Date(Date.now() + graceMs)).catch(() => {});
    state.grace = setTimeout(() => {
      state.grace = null;
      if ([...state.viewers].some((v) => v.userId === userId)) return;
      // Nobody left watching: forget this agent here (a later watch starts fresh) once its stream stopped.
      forget(agentId, state);
      void written
        .then(() => expireControl(handoffDeps, handoffId, userId))
        .catch((error) => deps.log?.warn("browser control expiry failed", { agentId, error: String(error) }));
    }, graceMs);
  }

  interface InputBatch {
    userId: string;
    orgId: string;
    agentId: string;
    events: BrowserInputEvent[];
    waiters: { resolve(r: { accepted: number; refused: boolean }): void; reject(e: unknown): void }[];
    timer: ReturnType<typeof setTimeout> | null;
  }
  /** Input being gathered, per person and agent. */
  const batches = new Map<string, InputBatch>();

  function flushInput(key: string, batch: InputBatch) {
    if (batches.get(key) === batch) batches.delete(key);
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    const events = coalesceInput(batch.events);
    api.sendInput(batch.userId, batch.orgId, batch.agentId, events).then(
      (r) => {
        for (const w of batch.waiters) w.resolve(r);
      },
      (error) => {
        for (const w of batch.waiters) w.reject(error);
      },
    );
  }

  const api = {
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
        .select({ handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
      // The computer the browser runs on now (an open handoff's, a mission's, else the agent's).
      const machineId = agent ? await browserMachineOf(deps.db, orgId, agentId) : null;
      if (!agent || !machineId) {
        viewer.send({ type: "browser.unavailable", agentId, reason: "no_computer" });
        return () => {};
      }
      if (!deps.hub.isLocal(machineId)) {
        // Held by another replica (or not connected): frames only flow where the socket is.
        const machine = await getMachineById(deps.db, machineId);
        const online = machine && !machine.deletedAt && machineOnline(machine);
        viewer.send({ type: "browser.unavailable", agentId, reason: online ? "reconnecting" : "offline" });
        return () => {};
      }
      let state = live.get(agentId);
      if (state && state.machineId !== machineId) {
        retire(agentId, state);
        state = undefined;
      }
      if (!state) {
        state = {
          orgId,
          machineId,
          handle: agent.handle,
          viewers: new Set(),
          unsubscribe: new Map(),
          mode: null,
          controllerUserId: null,
          handoff: null,
          grace: null,
          syncing: Promise.resolve(),
          stopTimer: null,
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
      // The person in control is here (back within the grace, maybe from another server): they keep it.
      if (current.grace && current.controllerUserId === viewer.userId) {
        clearTimeout(current.grace);
        current.grace = null;
      }
      if (current.handoff && current.controllerUserId === viewer.userId) {
        await touchControl(deps.db, current.handoff.id, viewer.userId, new Date(), true).catch(() => {});
      }
      viewer.send(status(agentId, current));
      checked.set(`${viewer.userId}:${agentId}`, Date.now());
      // Access can end while watching (removed from the org, no longer the agent's owner…): checked again now and then.
      const recheck = setInterval(() => {
        void requireBrowserAccess(deps.db, viewer.userId, orgId, agentId).then(
          () => {
            checked.set(`${viewer.userId}:${agentId}`, Date.now());
            // Watching keeps their control alive across servers and restarts (the grace in the database).
            const handoffId = current.handoff?.id;
            if (handoffId && current.controllerUserId === viewer.userId) {
              void touchControl(deps.db, handoffId, viewer.userId).catch(() => {});
            }
          },
          () => {
            checked.delete(`${viewer.userId}:${agentId}`);
            try {
              viewer.send({ type: "browser.unavailable", agentId, reason: "forbidden" });
            } catch {}
            stop();
          },
        );
      }, recheckMs);
      const stop = () => {
        clearInterval(recheck);
        if (!current.viewers.delete(viewer)) return;
        current.unsubscribe.get(viewer)?.();
        current.unsubscribe.delete(viewer);
        const controller = current.controllerUserId;
        if (controller === viewer.userId && ![...current.viewers].some((v) => v.userId === controller)) {
          startGrace(agentId, current, controller);
        }
        void sync(agentId, current).finally(() => forget(agentId, current));
      };
      await sync(agentId, current);
      return stop;
    },

    /**
     * A person's input on the live view, gathered for `inputBatchMs` and sent
     * to the computer as one smaller batch (a mouse sends dozens of moves a
     * second; each used to be its own request). Every caller of the batch gets
     * its answer.
     */
    input(userId: string, orgId: string, agentId: string, events: BrowserInputEvent[]) {
      const key = `${userId}:${agentId}`;
      let batch = batches.get(key);
      if (batch && batch.events.length + events.length > BROWSER_LIMITS.inputEvents) {
        flushInput(key, batch);
        batch = undefined;
      }
      if (!batch) {
        const created: InputBatch = { userId, orgId, agentId, events: [], waiters: [], timer: null };
        created.timer = setTimeout(() => flushInput(key, created), inputBatchMs);
        batches.set(key, created);
        batch = created;
      }
      batch.events.push(...events);
      const current = batch;
      return new Promise<{ accepted: number; refused: boolean }>((resolve, reject) => {
        current.waiters.push({ resolve, reject });
      });
    },

    /** Sends one gathered batch now (it filled up, or its time came). */
    flushInput: (key: string) => {
      const batch = batches.get(key);
      if (batch) flushInput(key, batch);
    },

    /**
     * Forwarded to the runner only when the person is in control of the open
     * handoff (checked against the database).
     */
    async sendInput(userId: string, orgId: string, agentId: string, events: BrowserInputEvent[]) {
      const open = await openHandoffOf(deps.db, orgId, agentId);
      if (open?.status !== "active" || open.controllerUserId !== userId) return { accepted: 0, refused: true };
      const key = `${userId}:${agentId}`;
      if (Date.now() - (checked.get(key) ?? 0) > recheckMs) {
        try {
          await requireBrowserAccess(deps.db, userId, orgId, agentId, open);
          checked.set(key, Date.now());
        } catch {
          checked.delete(key);
          return { accepted: 0, refused: true };
        }
      }
      // The person in control is here: their grace moves on (a write at most every 30 s).
      await touchControl(deps.db, open.id, userId).catch(() => {});
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
        cancelStop(state);
        state.mode = null;
        broadcast(state, {
          type: "browser.ended",
          agentId: frame.agentId,
          reason: frame.reason,
          ...(frame.message ? { message: frame.message } : {}),
        });
      },
      /** A computer came back here: it hears its open handoffs again (it forgot them while offline). */
      connected(machineId: string) {
        void openHandoffsOfMachine(deps.db, machineId)
          .then(async (rows) => {
            for (const row of rows) {
              const info = await handoffInfo(deps.db, row);
              deps.hub.sendBrowserHandoff?.(machineId, row.agentId, info);
            }
          })
          .catch((error) => deps.log?.warn("browser handoffs resync failed", { machineId, error: String(error) }));
      },
      /** The machine's socket closed here: viewers retry (it may come back on any replica). */
      closed(machineId: string) {
        for (const [agentId, state] of live) {
          if (state.machineId !== machineId) continue;
          cancelStop(state);
          state.mode = null;
          broadcast(state, { type: "browser.unavailable", agentId, reason: "reconnecting" });
        }
      },
    },

    /**
     * Keeps the browsers of open handoffs alive (worker, every minute): a
     * cheap read every `HANDOFF_KEEPALIVE_MS` counts as use, so the runner's
     * idle shutdown never closes a page a person was asked to work in.
     */
    async keepAlive(now = Date.now()) {
      const open = await deps.db
        .select({
          id: browserHandoffs.id,
          agentId: browserHandoffs.agentId,
          machineId: browserHandoffs.machineId,
          handle: agents.handle,
        })
        .from(browserHandoffs)
        .innerJoin(agents, eq(agents.id, browserHandoffs.agentId))
        .where(inArray(browserHandoffs.status, ["pending", "active"]));
      const ids = new Set(open.map((h) => h.id));
      for (const id of touched.keys()) if (!ids.has(id)) touched.delete(id);
      // Only computers held here (each replica pings its own), a few at a time.
      const due = open.filter(
        (h) => deps.hub.isLocal(h.machineId) && now - (touched.get(h.id) ?? 0) >= HANDOFF_KEEPALIVE_MS,
      );
      for (const h of due) touched.set(h.id, now);
      for (let i = 0; i < due.length; i += KEEPALIVE_PARALLEL) {
        await Promise.all(
          due.slice(i, i + KEEPALIVE_PARALLEL).map((h) =>
            deps.hub
              .call(h.machineId, {
                op: "browser.act",
                agent: { id: h.agentId, handle: h.handle },
                command: "get",
                args: ["url"],
                timeoutSeconds: 10,
              })
              .catch(() => {}),
          ),
        );
      }
      return due.length;
    },

    /** Whether anyone watches this agent's browser here. */
    watching: (agentId: string) => (live.get(agentId)?.viewers.size ?? 0) > 0,

    /** Stops hearing handoff changes from other replicas (shutdown, tests). */
    close() {
      unsubscribeHandoffs?.();
      unsubscribeComputers?.();
      for (const state of live.values()) cancelStop(state);
      for (const [key, batch] of batches) flushInput(key, batch);
    },
  };
  return api;
}

export type BrowserLive = ReturnType<typeof createBrowserLive>;
