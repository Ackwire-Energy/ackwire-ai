import {
  type AgentScope,
  BROWSER_LIMITS,
  type BrowserInputEvent,
  type BrowserStreamMode,
  type RunnerFrame,
} from "@agenteschat/adapters";
import { and, eq, inArray, schema } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { type MachineHub, MachineRequestError } from "../machine-hub";
import { getMachineById, machineOnline } from "../machines";
import {
  agentBrowserLink,
  agentUsesScreen,
  BROWSER_HANDOFF_TOPIC,
  type BrowserHandoffRow,
  type BrowserHandoffView,
  browserMachineOf,
  browserOnDesktop,
  CONTROL_GRACE_MS,
  expireControl,
  type HandoffDeps,
  type HandoffLiveHooks,
  handoffInfo,
  handoffView,
  openElsewhere,
  openHandoffOf,
  openHandoffsOfMachine,
  requireBrowserAccess,
  requireBrowserControl,
  setControlDeadline,
  touchControl,
  webAddress,
} from "./handoff";
import {
  getBrowserProfile,
  profileControlRow,
  profileIdOfKey,
  profileScope,
  requireProfileDriver,
  requireProfileWatcher,
  touchProfileControl,
} from "./profiles";
import type { BrowserFrame, BrowserPage, BrowserViewer, StreamRelay } from "./types";

/** A browser profile's ops carry it (ADR 0110): its live view is keyed `profile:<id>` where an agent's id would be. */
const profileOp = (key: string) => {
  const id = profileIdOfKey(key);
  return id ? { profile: { id } } : {};
};

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
 * This live view carries the browser alone: other screens' handoffs never switch its stream, and hide it
 * only while they show the same window (`shared`). An event naming no screen is the browser's
 * (`browser.opened`, and servers older than screens).
 */
const ofBrowser = (screen: unknown) => (screen ?? "browser") === "browser";

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
  /**
   * Who is in control and the open handoff, on watch and whenever it changes.
   * `hidden`: someone else is in control, so this viewer gets no frames until
   * they hand it back (what a person types in the agent's browser stays theirs).
   * The handoff may be of the agent's desktop (`handoff.screen`) when its
   * browser runs there: one window on both, so control there hides this view
   * too; it is driven from the desktop, not from here.
   */
  | {
      type: "browser.status";
      agentId: string;
      mode: BrowserStreamMode;
      controllerUserId: string | null;
      handoff: BrowserHandoffView | null;
      hidden: boolean;
    }
  /**
   * The browser can't be shown from here now: `reconnecting` (the computer is
   * held by another server or is coming back: retry with backoff), `offline`,
   * `no_computer`, `closed` (the agent's browser isn't open: retry with
   * backoff, it shows once something opens it), `unavailable` (the runner said
   * why in `message`), `forbidden` (this person may no longer see it: the
   * view stopped).
   */
  | {
      type: "browser.unavailable";
      agentId: string;
      reason: "reconnecting" | "offline" | "no_computer" | "closed" | "unavailable" | "forbidden";
      message?: string;
    }
  /**
   * The runner stopped the stream (the browser closed, an error), or a person pressed Parar
   * (`stopped`, with who and when: every viewer's card says so).
   */
  | {
      type: "browser.ended";
      agentId: string;
      reason: "stopped" | "closed" | "error";
      message?: string;
      byUserId?: string;
      at?: string;
    };

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
  /** The open handoff of the agent's desktop while its browser runs there (ADR 0058 §5). */
  shared: BrowserHandoffView | null;
  /** The page of the latest frame (address and title), for what the agent is told after a person's turn. */
  page: BrowserPage | null;
  /**
   * The newest frame of the running stream, in memory only: a viewer who joins (or whose view
   * is no longer hidden) sees the page at once, since a page that isn't repainting sends none.
   */
  frame: BrowserFrame | null;
  /** The person in control left: control ends when this fires, unless they come back. */
  grace: ReturnType<typeof setTimeout> | null;
  /** Stream changes run one after the other (a start never races a mode change or a stop). */
  syncing: Promise<void>;
  /** The last viewer left: the stream stops when this fires, unless someone watches again. */
  stopTimer: ReturnType<typeof setTimeout> | null;
}

/** Who is in control of what the view shows: of the browser, else of the desktop showing the same window. */
const controllerOf = (state: Pick<AgentLive, "controllerUserId" | "shared">) =>
  state.controllerUserId ?? (state.shared?.status === "active" ? state.shared.controllerUserId : null);

/** While a person is in control only they get the page: nobody else watches what they type there. */
const hiddenFrom = (state: Pick<AgentLive, "controllerUserId" | "shared">, userId: string) => {
  const controller = controllerOf(state);
  return controller !== null && controller !== userId;
};

export interface BrowserLiveDeps extends Omit<HandoffDeps, "live"> {
  hub: Pick<MachineHub, "call" | "isLocal"> & Partial<Pick<MachineHub, "sendBrowserHandoff">>;
  graceMs?: number;
  accessRecheckMs?: number;
  /** Tests: how long the stream outlives its last viewer (`STREAM_STOP_DELAY_MS`). */
  stopDelayMs?: number;
  /** Tests: how long input is gathered before it goes (`INPUT_BATCH_MS`). */
  inputBatchMs?: number;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
  /** Starts the agent's Chrome on that computer before its next command (ADR 0040 §11). Never waited on. */
  warm?(at: { orgId: string; agentId: string; machineId: string }): void;
}

/**
 * The live view of agents' browsers on this process (ADR 0040 §7): viewers
 * per agent, the runner's stream started with the first viewer (`watch`,
 * about 1 fps), switched to `control` while the person in control watches,
 * and stopped with the last; a person's input forwarded only for whoever is
 * in control, and while someone is in control only they get frames (the
 * others' status says `hidden`). The machine hub hands it the runner's
 * frames (`hubHooks`), the handoff tells it when control changes hands and
 * asks it for the page (`handoffHooks`).
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
  /** Agents whose browser `restart` closes and opens now: the runner's "stopped" for them isn't a Parar. */
  const restarting = new Set<string>();

  const broadcast = (state: AgentLive, message: BrowserLiveMessage) => {
    for (const v of state.viewers) {
      try {
        v.send(message);
      } catch {}
    }
  };

  const status = (agentId: string, state: AgentLive, userId: string): BrowserLiveMessage => ({
    type: "browser.status",
    agentId,
    mode: state.mode ?? "watch",
    controllerUserId: controllerOf(state),
    handoff: state.handoff ?? state.shared,
    hidden: hiddenFrom(state, userId),
  });

  /** Each viewer's own status: whether the page is hidden from them depends on who they are. */
  const broadcastStatus = (agentId: string, state: AgentLive) => {
    for (const v of state.viewers) {
      try {
        v.send(status(agentId, state, v.userId));
      } catch {}
    }
  };

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
    // A fresh stream (or none): the page is known again from its first frame.
    if (state.mode === null || mode === null) {
      state.page = null;
      state.frame = null;
    }
    state.mode = mode;
    try {
      if (mode === null)
        await deps.hub.call(state.machineId, { op: "browser.stream.stop", agent, ...profileOp(agentId) });
      else {
        await deps.hub.call(state.machineId, { op: "browser.stream.start", mode, agent, ...profileOp(agentId) });
        broadcastStatus(agentId, state);
      }
    } catch (error) {
      // Stopping a stream that is already gone is fine; a stream that can't start is told to the viewers.
      if (mode === null) return;
      state.mode = null;
      // An older runner says `bad_request` for a closed browser: still `unavailable`, with its message.
      const closed = error instanceof MachineRequestError && error.code === "browser_closed";
      // Closed by a restart that is opening it again: its end starts the stream, the views keep waiting.
      if (closed && restarting.has(agentId)) return;
      broadcast(state, {
        type: "browser.unavailable",
        agentId,
        reason: closed ? "closed" : "unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The stream the computer ran for this agent is gone or unknown (its runner came back, maybe a new one; the
   * browser restarted; a page opened): forgotten with its frame, and started again for the viewers here, so
   * their page comes back even when nothing repaints.
   */
  function restartStream(agentId: string, state: AgentLive): Promise<void> {
    state.syncing = state.syncing
      .then(() => {
        // With nobody watching, a stream still running stops as usual (forgetting it would leave it running).
        if (state.viewers.size > 0) {
          state.mode = null;
          state.page = null;
          state.frame = null;
        }
        return syncNow(agentId, state, false);
      })
      .catch(() => {})
      .finally(() => forget(agentId, state));
    return state.syncing;
  }

  /** The address the agent's browser shows, as its computer says (short: a person waits on it); null when it can't. */
  const askUrl = async (machineId: string, agent: AgentScope) => {
    try {
      const reply = await deps.hub.call<"browser.act">(
        machineId,
        { op: "browser.act", agent, command: "get", args: ["url"], timeoutSeconds: 3 },
        { timeoutMs: 4000 },
      );
      const data = reply.success ? (reply.data as { url?: unknown } | null) : null;
      return typeof data?.url === "string" && data.url ? data.url.slice(0, BROWSER_LIMITS.url) : null;
    } catch {
      return null;
    }
  };

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

  /** The newest frame to one viewer (joining, or no longer hidden), while the stream runs. */
  const sendLatest = (state: AgentLive, viewer: LiveViewer) => {
    if (state.mode === null || !state.frame || hiddenFrom(state, viewer.userId)) return;
    try {
      viewer.send({ type: "browser.frame", ...state.frame });
    } catch {}
  };

  /** Control changed: everyone hears who is in control, and views it no longer hides get the page now. */
  const announce = (agentId: string, state: AgentLive, apply: () => void) => {
    const wasHidden = [...state.viewers].filter((v) => hiddenFrom(state, v.userId));
    apply();
    broadcastStatus(agentId, state);
    for (const v of wasHidden) sendLatest(state, v);
  };

  const handoffChanged = (agentId: string, state: AgentLive, row: BrowserHandoffRow | null) => {
    announce(agentId, state, () => applyHandoff(state, row));
    void sync(agentId, state);
  };

  /** Another screen's handoff changed: it hides this view only while it shows the same window (its desktop). */
  const sharedChanged = async (agentId: string, state: AgentLive) => {
    const row = await openElsewhere(deps.db, state.orgId, agentId, "browser");
    if (live.get(agentId) !== state) return;
    announce(agentId, state, () => {
      state.shared = row ? handoffView(row) : null;
    });
  };
  const reloadShared = (agentId: string, state: AgentLive) =>
    void sharedChanged(agentId, state).catch((error) =>
      deps.log?.warn("shared screen reload failed", { agentId, error: String(error) }),
    );

  const handoffHooks: HandoffLiveHooks = {
    changed(row) {
      const state = live.get(row.agentId);
      if (!state) return;
      if (ofBrowser(row.screen)) handoffChanged(row.agentId, state, row);
      else reloadShared(row.agentId, state);
    },
    /** The latest frame's page while the stream runs here; otherwise the computer is asked for the address. */
    async page(row) {
      if (!ofBrowser(row.screen)) return null;
      const state = live.get(row.agentId);
      if (state && state.machineId === row.machineId && state.mode !== null && state.page) return state.page;
      const [agent] = await deps.db
        .select({ handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.id, row.agentId), eq(agents.orgId, row.orgId)));
      if (!agent) return null;
      // Short: a hand back waits on this answer before the agent is told.
      const url = await askUrl(row.machineId, { id: row.agentId, handle: agent.handle });
      return url ? { url } : null;
    },
  };

  const handoffDeps: HandoffDeps = { db: deps.db, pubsub: deps.pubsub, live: handoffHooks };

  /** The open handoff of an agent's browser, or a person's control of a profile in the same shape. */
  const controlRow = async (orgId: string, key: string): Promise<BrowserHandoffRow | null> => {
    const profileId = profileIdOfKey(key);
    if (!profileId) return openHandoffOf(deps.db, orgId, key);
    const row = await getBrowserProfile(deps.db, orgId, profileId);
    return row ? profileControlRow(row) : null;
  };

  /** The person in control is there: their control moves on (an agent's handoff, or the profile's hold). */
  const touchFor = (key: string, handoffId: string, userId: string, force = false) => {
    const profileId = profileIdOfKey(key);
    return profileId
      ? touchProfileControl(deps.db, profileId, userId)
      : touchControl(deps.db, handoffId, userId, new Date(), force);
  };

  /** Tells the computer (when its socket is here) the agent's open handoff, or that there is none: its tray shows it. */
  const tellComputer = async (machineId: string, orgId: string, agentId: string) => {
    if (!deps.hub.sendBrowserHandoff || !deps.hub.isLocal(machineId)) return;
    const row = await openHandoffOf(deps.db, orgId, agentId);
    const info = row && row.machineId === machineId ? await handoffInfo(deps.db, row) : null;
    deps.hub.sendBrowserHandoff(machineId, agentId, info);
  };

  // The computer's desktop app hears every change, from whichever replica made it.
  const unsubscribeComputers = deps.pubsub?.subscribe(BROWSER_HANDOFF_TOPIC, (event) => {
    if (event.type === "browser.stopped" || !ofBrowser(event.screen)) return;
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
    if (!ofBrowser(event.screen)) {
      if (event.type === "browser.handoff.changed") reloadShared(agentId, state);
      return;
    }
    // Someone pressed Parar (here or on another replica): everyone watching here hears who and when.
    if (event.type === "browser.stopped") {
      broadcast(state, {
        type: "browser.ended",
        agentId,
        reason: "stopped",
        ...(typeof event.byUserId === "string" ? { byUserId: event.byUserId } : {}),
        ...(typeof event.at === "string" ? { at: event.at } : {}),
      });
      return;
    }
    // `browser.opened` (a person opened a page, a restart): the stream starts again, from a closed browser too.
    void controlRow(state.orgId, agentId)
      .then((row) => {
        if (live.get(agentId) !== state) return;
        if (event.type !== "browser.opened") return handoffChanged(agentId, state, row);
        announce(agentId, state, () => applyHandoff(state, row));
        void restartStream(agentId, state);
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
        .call(old.machineId, {
          op: "browser.stream.stop",
          agent: { id: agentId, handle: old.handle },
          ...profileOp(agentId),
        })
        .catch(() => {});
    }
  }

  /** The person in control left: after the grace, control ends (expired) unless they watch again. */
  function startGrace(agentId: string, state: AgentLive, userId: string) {
    if (state.grace) clearTimeout(state.grace);
    const handoffId = state.handoff?.id;
    if (!handoffId) return;
    if (profileIdOfKey(agentId)) {
      // A profile's hold lapses by itself once its touches stop: the views here hear it then.
      state.grace = setTimeout(() => {
        state.grace = null;
        if ([...state.viewers].some((v) => v.userId === userId)) return;
        forget(agentId, state);
        void controlRow(state.orgId, agentId)
          .then((row) => handoffChanged(agentId, state, row))
          .catch(() => {});
      }, graceMs);
      return;
    }
    // Their deadline in the database: another server, or this one after a restart, ends it at the
    // same time, and coming back anywhere pushes it again. Only once their page showed: a view retrying on a
    // page that never came (leaving and watching again) never pushes it.
    const until = new Date(Date.now() + graceMs);
    const written = setControlDeadline(deps.db, handoffId, userId, until, Boolean(state.frame)).catch(() => {});
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
  /** The last batch sent per person and agent: the next waits for it, so a drag's press, moves and release reach the runner in order. */
  const sending = new Map<string, Promise<unknown>>();

  function flushInput(key: string, batch: InputBatch) {
    if (batches.get(key) === batch) batches.delete(key);
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    const events = coalesceInput(batch.events);
    const sent = (sending.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => api.sendInput(batch.userId, batch.orgId, batch.agentId, events))
      .then(
        (r) => {
          for (const w of batch.waiters) w.resolve(r);
        },
        (error) => {
          for (const w of batch.waiters) w.reject(error);
        },
      );
    sending.set(key, sent);
    void sent.finally(() => {
      if (sending.get(key) === sent) sending.delete(key);
    });
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
      const profileId = profileIdOfKey(agentId);
      let agent: { handle: string } | undefined;
      let machineId: string | null = null;
      if (profileId) {
        const row = await getBrowserProfile(deps.db, orgId, profileId);
        if (row) {
          agent = { handle: profileScope(profileId).handle };
          machineId = row.machineId;
        }
      } else {
        [agent] = await deps.db
          .select({ handle: agents.handle })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
        // The computer the browser runs on now (an open handoff's, a mission's, else the agent's).
        machineId = agent ? await browserMachineOf(deps.db, orgId, agentId) : null;
      }
      if (!agent || !machineId) {
        viewer.send({ type: "browser.unavailable", agentId, reason: "no_computer" });
        return () => {};
      }
      // Someone opened the agent's computer: its browser gets ready for the agent's next command meanwhile.
      if (!profileId) deps.warm?.({ orgId, agentId, machineId });
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
          shared: null,
          page: null,
          frame: null,
          grace: null,
          syncing: Promise.resolve(),
          stopTimer: null,
        };
        live.set(agentId, state);
      }
      const current = state;
      applyHandoff(current, await controlRow(orgId, agentId));
      const shared = profileId ? null : await openElsewhere(deps.db, orgId, agentId, "browser");
      current.shared = shared ? handoffView(shared) : null;
      current.viewers.add(viewer);
      current.unsubscribe.set(
        viewer,
        relay.subscribe(agentId, {
          send: (frame) => {
            if (!hiddenFrom(current, viewer.userId)) viewer.send({ type: "browser.frame", ...frame });
          },
          ...(viewer.busy ? { busy: viewer.busy } : {}),
        } as BrowserViewer),
      );
      // The person in control is here (back within the grace, maybe from another server): they keep it.
      if (current.grace && current.controllerUserId === viewer.userId) {
        clearTimeout(current.grace);
        current.grace = null;
      }
      // Watching keeps control only while the page shows: a view whose page never came lets it end, and the agent
      // goes on (its first frame keeps it then, `hubHooks.frame`).
      if (current.handoff && current.controllerUserId === viewer.userId && current.frame) {
        await touchFor(agentId, current.handoff.id, viewer.userId, true).catch(() => {});
      }
      viewer.send(status(agentId, current, viewer.userId));
      sendLatest(current, viewer);
      checked.set(`${viewer.userId}:${agentId}`, Date.now());
      // Access can end while watching (removed from the org, no longer the agent's owner…): checked again now and then.
      const recheck = setInterval(() => {
        const allowed = profileId
          ? requireProfileWatcher(deps.db, viewer.userId, orgId, profileId)
          : requireBrowserAccess(deps.db, viewer.userId, orgId, agentId);
        void allowed.then(
          () => {
            checked.set(`${viewer.userId}:${agentId}`, Date.now());
            // Watching the page keeps their control alive across servers and restarts (the grace in the database).
            const handoffId = current.handoff?.id;
            if (handoffId && current.controllerUserId === viewer.userId && current.frame) {
              void touchFor(agentId, handoffId, viewer.userId).catch(() => {});
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
      const profileId = profileIdOfKey(agentId);
      const open = await controlRow(orgId, agentId);
      if (open?.status !== "active" || open.controllerUserId !== userId) return { accepted: 0, refused: true };
      // Control changed where this process didn't hear it (another replica, a lost event): the others'
      // view is hidden here before any of the person's typing reaches the page.
      const state = live.get(agentId);
      if (state && state.controllerUserId !== open.controllerUserId) handoffChanged(agentId, state, open);
      // Its own key: watching's recheck says only that they may see it, not drive it.
      const key = `control:${userId}:${agentId}`;
      if (Date.now() - (checked.get(key) ?? 0) > recheckMs) {
        try {
          if (profileId) await requireProfileDriver(deps.db, userId, orgId, profileId);
          else await requireBrowserControl(deps.db, userId, orgId, agentId, open);
          checked.set(key, Date.now());
        } catch {
          checked.delete(key);
          return { accepted: 0, refused: true };
        }
      }
      // The person in control is here: their grace moves on (a write at most every 30 s).
      await touchFor(agentId, open.id, userId).catch(() => {});
      let scope: AgentScope;
      if (profileId) scope = profileScope(profileId);
      else {
        const [agent] = await deps.db
          .select({ handle: agents.handle })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
        if (!agent) return { accepted: 0, refused: true };
        scope = { id: agentId, handle: agent.handle };
      }
      const reply = await deps.hub.call(open.machineId, {
        op: "browser.input",
        events,
        agent: scope,
        ...profileOp(agentId),
      });
      return { accepted: reply.accepted, refused: false };
    },

    /**
     * Try again on a view whose page never came, by whoever may drive the agent's browser: it closes and opens
     * again on the page it showed, else it just starts (ADR 0040 §11, not while a person's turn is open: it
     * stays closed, and the views say so); its logins stay. Answers once it closed: opening again can take a
     * minute on a cold computer, longer than a request may wait behind a proxy. Every view of it then gets its
     * stream again, also when the close or the open failed. The person in control pressing it is there: their
     * control holds meanwhile.
     */
    async restart(userId: string, orgId: string, agentId: string) {
      await requireBrowserControl(deps.db, userId, orgId, agentId);
      if (!(await agentUsesScreen(deps.db, orgId, agentId)))
        throw new ForbiddenError("This agent can't use its browser");
      const machineId = await browserMachineOf(deps.db, orgId, agentId);
      if (!machineId) throw new ValidationError("This agent has no computer");
      const agent = await getAgentCached(deps.db, orgId, agentId);
      if (!agent) throw new NotFoundError("Agent not found");
      // Already restarting here: its end brings every view the page.
      if (restarting.has(agentId)) return;
      // ponytail: only this server's views miss the stop's "stopped"; with several replicas, an event of its own.
      restarting.add(agentId);
      const scope: AgentScope = { id: agentId, handle: agent.handle, ...(agent.name ? { name: agent.name } : {}) };
      const hold = () =>
        openHandoffOf(deps.db, orgId, agentId)
          .then((open) => open && touchControl(deps.db, open.id, userId, new Date(), true))
          .catch(() => {});
      // Every replica's views of it (the one holding the computer's socket among them) start their streams again.
      const streamsAgain = async () => {
        const told = await deps.pubsub
          ?.publish(BROWSER_HANDOFF_TOPIC, { type: "browser.opened", orgId, agentId })
          .then(() => true)
          .catch(() => false);
        const now = live.get(agentId);
        if (!told && now) await restartStream(agentId, now);
      };
      await hold();
      const state = live.get(agentId);
      const shown = state?.machineId === machineId ? state.page?.url : undefined;
      const page = webAddress(shown ?? (await askUrl(machineId, scope)) ?? "");
      try {
        await deps.hub.call<"browser.stop">(machineId, { op: "browser.stop", agent: scope }, { timeoutMs: 30_000 });
      } catch (error) {
        restarting.delete(agentId);
        await streamsAgain();
        throw error;
      }
      void (async () => {
        try {
          const desktop = (await browserOnDesktop(deps.db, orgId, agentId, machineId)) ? { desktop: true } : {};
          if (page) {
            await deps.hub.call<"browser.act">(
              machineId,
              {
                op: "browser.act",
                agent: scope,
                command: "open",
                args: [page],
                timeoutSeconds: 60,
                ...(agent.browserAllowedDomains ? { allowedDomains: agent.browserAllowedDomains } : {}),
                link: agentBrowserLink(orgId, agentId),
                ...desktop,
              },
              { timeoutMs: 90_000 },
            );
          } else await deps.hub.call<"browser.warm">(machineId, { op: "browser.warm", agent: scope, ...desktop });
        } catch (error) {
          // Not opened again (a site no longer allowed, an older computer): it stays closed, and the views say so.
          deps.log?.warn("browser restart didn't open it again", { agentId, error: String(error) });
        } finally {
          restarting.delete(agentId);
          await hold();
          await streamsAgain();
        }
      })();
    },

    /** What the machine hub hands over: frames and the end of a stream, from the machine holding them. */
    hubHooks: {
      frame(machineId: string, frame: Extract<RunnerFrame, { type: "browser.frame" }>) {
        const state = live.get(frame.agentId);
        // Only from the agent's own computer.
        if (!state || state.machineId !== machineId) return;
        const first = !state.frame;
        const { url, title } = frame.metadata;
        if (url) state.page = { url, ...(title ? { title } : {}) };
        state.frame = { agentId: frame.agentId, seq: frame.seq, data: frame.data, metadata: frame.metadata };
        if (state.viewers.size > 0) relay.publish(frame.agentId, state.frame);
        // The page shows at last for the person in control watching it: their control holds from now.
        const controller = state.controllerUserId;
        if (first && state.handoff && controller && [...state.viewers].some((v) => v.userId === controller)) {
          void touchFor(frame.agentId, state.handoff.id, controller, true).catch(() => {});
        }
      },
      streamEnded(machineId: string, frame: Extract<RunnerFrame, { type: "browser.stream.ended" }>) {
        const state = live.get(frame.agentId);
        if (!state || state.machineId !== machineId) return;
        cancelStop(state);
        state.mode = null;
        // A restart's own stop: its views keep waiting for the page, it isn't a Parar.
        if (frame.reason === "stopped" && restarting.has(frame.agentId)) return;
        broadcast(state, {
          type: "browser.ended",
          agentId: frame.agentId,
          reason: frame.reason,
          ...(frame.message ? { message: frame.message } : {}),
        });
      },
      /**
       * A computer came back here: the views of its agents' browsers get their streams again (its runner may be
       * a new one, whose hello came before the old socket's close), and it hears its open handoffs again (it
       * forgot them while offline).
       */
      connected(machineId: string) {
        for (const [agentId, state] of live) if (state.machineId === machineId) void restartStream(agentId, state);
        void openHandoffsOfMachine(deps.db, machineId)
          .then(async (rows) => {
            for (const row of rows) {
              if (!ofBrowser(row.screen)) continue;
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
        .where(and(eq(browserHandoffs.screen, "browser"), inArray(browserHandoffs.status, ["pending", "active"])));
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
