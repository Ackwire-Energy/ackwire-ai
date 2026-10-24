import type { ActiveRun, ChannelEvent, RunStatus } from "../api/types";

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
/** `canceled`: someone pressed "Parar" (the row keeps the text so far). */
export type LiveStatus = RunStatus | "thinking" | "canceled";

/** `agent.run.steered`: a new message went into this run (one active run per agent and conversation). */
export interface RunSteeredEvent {
  type: "agent.run.steered";
  channelId: string;
  runId: string;
  /** The run's agent (receipts: it is on this message now). */
  agentId?: string;
  messageId: string;
  /** Sent with "Parar e mandar": the run stops its current step and reads it now. */
  now?: boolean;
  /** The new message asked it to stop: the run is wrapping up (may come in a second event). */
  stop?: boolean;
}

/** `agent.run.read`: the run read these messages sent while it worked ("Leu seu recado"). */
export interface RunReadEvent {
  type: "agent.run.read";
  channelId: string;
  threadId: string | null;
  runId: string;
  agentId: string;
  messageIds: string[];
}

/** `run.continued`: "Continuar" under the stopped reply `messageId`; `newRunId` picks up where `runId` stopped. */
export interface RunContinuedEvent {
  type: "run.continued";
  channelId: string;
  threadId: string | null;
  agentId?: string;
  runId: string;
  newRunId: string;
  messageId: string;
}

/** `agent.narration`: the text of model call `turn` was narration (said before tool calls), not the answer. */
export interface AgentNarrationEvent {
  type: "agent.narration";
  channelId: string;
  threadId: string;
  runId: string;
  agentId: string;
  turn: number;
  text: string;
}

/** `run.canceled` (expected from the backend with `POST …/runs/{id}/cancel`). */
export interface RunCanceledEvent {
  type: "run.canceled";
  channelId: string;
  threadId: string | null;
  runId: string;
  agentId: string;
  /** Who stopped it. */
  byUserId?: string | null;
}

/** Pressed "Parar": "Parando…" until the event, and who stopped it ("Interrompido por Walter"). */
export function markStopping(state: StreamsState, runId: string, byUserId: string): StreamsState {
  const r = state.runs[runId];
  if (!r) return state;
  return { ...state, runs: { ...state.runs, [runId]: { ...r, stopping: true, canceledBy: byUserId } } };
}

/** The cancel failed: back to running. */
export function unmarkStopping(state: StreamsState, runId: string): StreamsState {
  const r = state.runs[runId];
  if (!r) return state;
  return { ...state, runs: { ...state.runs, [runId]: { ...r, stopping: false, canceledBy: null } } };
}

/** Stopped: a row with text stays (muted "Interrompido por…"); one with nothing written goes away. */
function cancel(state: StreamsState, runId: string, byUserId?: string | null): StreamsState {
  const r = state.runs[runId];
  if (!r) return state;
  if (!r.text) {
    const { [runId]: _gone, ...runs } = state.runs;
    return { ...state, runs };
  }
  const work = (r.work ?? []).map((w) => (w.kind === "call" && w.running ? { ...w, running: false } : w));
  return {
    ...state,
    runs: {
      ...state.runs,
      [runId]: {
        ...r,
        status: "canceled",
        stopping: false,
        canceledBy: byUserId ?? r.canceledBy ?? null,
        work,
        tool: null,
      },
    },
  };
}

export interface LiveRun {
  /** When a provisional row was added (for the safety timeout). */
  since?: number;
  /** When this client first saw the run (places the live row by time in the timeline). */
  startedAt?: number;
  /** The message that started it (its live row goes right after it). */
  triggerMessageId?: string | null;
  /** The model call the streaming text belongs to (`agent.delta.turn`). */
  turn?: number;
  /** Last event seen for this run (a run silent for minutes may be orphaned on the server). */
  lastEventAt?: number;
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
  /** The tool it is calling right now ("github_list_prs"), from `agent.tool`. */
  tool?: string | null;
  /** The app of that tool, when the event names it ("GitHub"). */
  connector?: string | null;
  /** What the tool works on, when the event says (the skill name for `load_skill`). */
  toolDetail?: string | null;
  /** "Parar" was pressed and the server hasn't confirmed yet. */
  stopping?: boolean;
  /** Who stopped it (user id). */
  canceledBy?: string | null;
  /** The code the agent is running (`run_code`, a skill script), from `agent.tool`. */
  code?: LiveCode | null;
  /**
   * The run's live work, in order: what it said between tool calls ("Go não
   * está instalado; vou tentar…") and each tool call (with its code and
   * output). Text before a tool call moves here when the tool starts, so the
   * answer that streams next starts fresh instead of being glued to it.
   */
  work?: LiveWork[];
  /** That call's output so far (`agent.tool.output`), in order. */
  output?: LiveOutput[];
  /** Messages sent with "Parar e mandar" it hasn't read yet. */
  steerNow?: string[];
}

export type LiveWork =
  | { kind: "say"; text: string; turn?: number }
  /**
   * The running task read a message sent while it worked ("Leu seu recado"); `now`: it stopped
   * to read it ("Parou para ler seu recado").
   */
  | { kind: "steer"; messageId: string; now?: boolean }
  | {
      kind: "call";
      id: string;
      tool: string;
      connector: string | null;
      detail: string | null;
      code: LiveCode | null;
      output: LiveOutput[];
      running: boolean;
      /** When the call started (the stop confirmation says "rodando código há 2 min"). */
      since?: number;
    };

/** The narration lines of a run (what it said between tool calls). */
export const narrationOf = (r: Pick<LiveRun, "work">) =>
  (r.work ?? []).flatMap((w) => (w.kind === "say" ? [w.text] : []));

export interface LiveCode {
  language: string;
  source: string;
}

export interface LiveOutput {
  stream: "stdout" | "stderr";
  text: string;
}

/** Kept per call: the newest characters of the output (older ones scroll away). */
export const OUTPUT_LIMIT = 20_000;

/** The PC's output while code runs (expected from the backend). */
export interface AgentToolOutputEvent {
  type: "agent.tool.output";
  channelId: string;
  threadId: string | null;
  runId: string;
  agentId: string;
  toolUseId?: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** Appends output, merging with the last chunk of the same stream and keeping the last OUTPUT_LIMIT chars. */
export function appendOutput(list: LiveOutput[], chunk: LiveOutput, limit = OUTPUT_LIMIT): LiveOutput[] {
  const last = list[list.length - 1];
  const next =
    last && last.stream === chunk.stream
      ? [...list.slice(0, -1), { stream: last.stream, text: last.text + chunk.text }]
      : [...list, chunk];
  let total = next.reduce((n, o) => n + o.text.length, 0);
  while (total > limit && next.length > 0) {
    const first = next[0] as LiveOutput;
    const over = total - limit;
    if (first.text.length <= over) {
      next.shift();
      total -= first.text.length;
    } else {
      next[0] = { stream: first.stream, text: first.text.slice(over) };
      total = limit;
    }
  }
  return next;
}

/**
 * "Theo está consultando o GitHub…": the tool an agent is calling. Not sent
 * by the backend yet (packages/engine/src/events.ts has no tool event); the
 * client handles it as soon as it exists. `tool: null` = the call ended.
 */
export interface AgentToolEvent {
  type: "agent.tool";
  channelId: string;
  threadId: string;
  runId: string;
  agentId: string;
  tool: string | null;
  connector?: string | null;
  /** E.g. the skill being opened by `load_skill`. */
  detail?: string | null;
  /** The code it runs (`run_code`, skill scripts), expected from the backend. */
  code?: LiveCode | null;
  toolUseId?: string;
}

export interface StreamsState {
  runs: Record<string, LiveRun>;
  /** Runs whose final message arrived: late deltas for them are ignored. */
  finished: Record<string, true>;
  /** A routine's runs working in the background: never a row, never "trabalhando" (`isBackgroundEvent`). */
  background?: Record<string, true>;
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
  const run: LiveRun = {
    ...input,
    runId,
    status: "thinking",
    text: "",
    lastSeq: -1,
    provisional: true,
    since: now,
    startedAt: now,
  };
  return { ...state, runs: { ...state.runs, [runId]: run } };
}

/** Drops the provisional row of an agent/thread once the server reports on it. */
function settleProvisional(state: StreamsState, agentId: string, threadId: string): StreamsState {
  const id = provisionalId(agentId, threadId);
  if (!state.runs[id]) return state;
  const { [id]: _p, ...runs } = state.runs;
  return { ...state, runs };
}

/**
 * A run of this agent stopped (idle, finished): its "pensando…" goes too. A
 * flat reply (DMs: no thread) answers the latest messages, whatever thread we
 * guessed, so every provisional row of the agent in that channel goes.
 */
function settleAfterRun(
  state: StreamsState,
  event: { agentId: string; channelId: string; threadId: string | null },
): StreamsState {
  if (event.threadId) return settleProvisional(state, event.agentId, event.threadId);
  const runs = Object.fromEntries(
    Object.entries(state.runs).filter(
      ([, r]) => !(r.provisional && r.agentId === event.agentId && r.channelId === event.channelId),
    ),
  );
  return Object.keys(runs).length === Object.keys(state.runs).length ? state : { ...state, runs };
}

function upsert(
  state: StreamsState,
  event: { runId: string; agentId: string; channelId: string; threadId: string },
  patch: Partial<LiveRun>,
) {
  // A flat run (DMs: thread null) answers whatever message we guessed: any "pensando…" of the agent
  // there is its own. Kept, it held the first block and hid this run's (its browser card) all run long.
  const provisional = event.threadId
    ? state.runs[provisionalId(event.agentId, event.threadId)]
    : Object.values(state.runs).find(
        (r) => r.provisional && r.agentId === event.agentId && r.channelId === event.channelId,
      );
  let base = settleAfterRun(state, event);
  // A new run of the same agent in the channel: its earlier failure is old news, not the latest word.
  if (!base.runs[event.runId] && patch.status !== "failed") {
    for (const r of Object.values(base.runs)) {
      if (r.status === "failed" && r.agentId === event.agentId && r.channelId === event.channelId) {
        base = finish(base, r.runId);
      }
    }
  }
  // Partial: under some tsconfigs the index type isn't `| undefined`, and the spread below must stay optional.
  const current: Partial<LiveRun> | undefined = base.runs[event.runId];
  const next: LiveRun = {
    runId: event.runId,
    agentId: event.agentId,
    channelId: event.channelId,
    threadId: event.threadId,
    status: "running",
    text: "",
    // No delta yet: the backend's first delta is seq 0, so "seen" starts below it.
    lastSeq: -1,
    startedAt: provisional?.startedAt ?? Date.now(),
    // A "pensando…" row hangs off the message I sent: that message started the run.
    ...(provisional ? { triggerMessageId: provisional.threadId } : {}),
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

type StreamEvent =
  | ChannelEvent
  | AgentToolEvent
  | AgentToolOutputEvent
  | RunCanceledEvent
  | RunSteeredEvent
  | RunReadEvent
  | RunContinuedEvent
  | AgentNarrationEvent;

/** Adds what the agent said (or replaces the line of the same turn: `agent.narration` is the final word). */
function say(work: LiveWork[], text: string, turn: number | undefined): LiveWork[] {
  if (turn !== undefined) {
    const at = work.findIndex((w) => w.kind === "say" && w.turn === turn);
    if (at >= 0) return work.map((w, i) => (i === at ? { kind: "say" as const, text, turn } : w));
  }
  return [...work, { kind: "say" as const, text, ...(turn !== undefined ? { turn } : {}) }];
}

/**
 * A routine's background run holds no conversation: the events that say so (`background: true`)
 * mark its run, and nothing about a marked run makes or keeps a row. Null: not a background run's.
 */
function backgroundRun(state: StreamsState, event: StreamEvent): StreamsState | null {
  const runId = "runId" in event && typeof event.runId === "string" ? event.runId : null;
  if ((event as { background?: unknown }).background !== true) {
    return runId && state.background?.[runId] ? state : null;
  }
  // Announced at post time (no run yet): no "pensando…" for it either.
  if (!runId || state.background?.[runId]) return state;
  const { [runId]: _row, ...runs } = state.runs;
  return { ...state, runs, background: { ...state.background, [runId]: true } };
}

export function applyChannelEvent(state: StreamsState, event: StreamEvent, now = Date.now()): StreamsState {
  const quiet = backgroundRun(state, event);
  if (quiet) return quiet;
  const next = applyEvent(state, event);
  // Any news about a run keeps it "alive" (see `isQuiet`).
  const runId = "runId" in event && typeof event.runId === "string" ? event.runId : null;
  const r = runId ? next.runs[runId] : undefined;
  if (!runId || !r || r.provisional || (next === state && r.lastEventAt !== undefined)) return next;
  return { ...next, runs: { ...next.runs, [runId]: { ...r, lastEventAt: now } } };
}

function applyEvent(state: StreamsState, event: StreamEvent): StreamsState {
  switch (event.type) {
    case "agent.run.steered": {
      // Only noted here: it shows in the work once read (`agent.run.read`), under the message until then.
      const r = state.runs[event.runId];
      if (!r) return state;
      if (event.stop) return { ...state, runs: { ...state.runs, [event.runId]: { ...r, stopping: true } } };
      if (!event.now || r.steerNow?.includes(event.messageId)) return state;
      const steerNow = [...(r.steerNow ?? []), event.messageId];
      return { ...state, runs: { ...state.runs, [event.runId]: { ...r, steerNow } } };
    }
    case "agent.run.read": {
      const r = state.runs[event.runId];
      if (!r) return state;
      const seen = new Set((r.work ?? []).flatMap((w) => (w.kind === "steer" ? [w.messageId] : [])));
      const fresh = event.messageIds.filter((id) => !seen.has(id));
      if (fresh.length === 0) return state;
      // Text so far is narration: the answer continues after the message it read.
      const said = r.text.trim();
      const work: LiveWork[] = [
        ...(said ? say(r.work ?? [], said, r.turn) : (r.work ?? [])),
        ...fresh.map((messageId) => ({
          kind: "steer" as const,
          messageId,
          ...(r.steerNow?.includes(messageId) ? { now: true } : {}),
        })),
      ];
      const steerNow = (r.steerNow ?? []).filter((id) => !fresh.includes(id));
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.runId]: {
            ...r,
            work,
            steerNow,
            ...(said ? { text: "", status: "thinking" as const } : {}),
          },
        },
      };
    }
    case "run.continued": {
      // The stopped row (if still here) gives way to the run that picks up, a normal live run.
      const s = state.runs[event.runId] ? finish(state, event.runId) : state;
      if (s.runs[event.newRunId] || s.finished[event.newRunId] || !event.agentId) return s;
      // Flat conversations (DMs) have no thread: `null`, like the run's other events.
      const where = { channelId: event.channelId, threadId: event.threadId as string, agentId: event.agentId };
      return upsert(s, { ...where, runId: event.newRunId }, { status: "thinking", triggerMessageId: event.messageId });
    }
    case "agent.narration": {
      if (state.finished[event.runId]) return state;
      const r = state.runs[event.runId];
      const text = event.text.trim();
      if (!text) return state;
      // The streaming text is this turn's: it moves to the narration.
      const current = r && r.turn === event.turn;
      return upsert(state, event, {
        work: say(r?.work ?? [], text, event.turn),
        ...(current ? { text: "", status: "thinking" as const } : {}),
      });
    }
    case "run.canceled":
      return cancel(state, event.runId, event.byUserId);
    case "agent.tool": {
      if (state.finished[event.runId]) return state;
      const current = state.runs[event.runId];
      // A new call starts fresh; `tool: null` (the call ended) keeps the last code and output on screen.
      const newCall = event.tool !== null;
      // Text before a tool call is narration: it leaves the body (which starts over for the next call).
      const said = newCall ? (current?.text ?? "").trim() : "";
      const status: LiveStatus = said ? "thinking" : current?.text ? current.status : "thinking";
      let work = current?.work ?? [];
      if (said) work = say(work, said, current?.turn);
      if (newCall) {
        // A new call means the previous ones ended.
        work = [
          ...work.map((w) => (w.kind === "call" && w.running ? { ...w, running: false } : w)),
          {
            kind: "call" as const,
            since: Date.now(),
            id: event.toolUseId ?? `call-${work.length}`,
            tool: event.tool ?? "",
            connector: event.connector ?? null,
            detail: event.detail ?? null,
            code: event.code ?? null,
            output: [],
            running: true,
          },
        ];
      } else {
        // The call ended: the last running one stops.
        let done = false;
        work = [...work].reverse().map((w) => {
          if (!done && w.kind === "call" && w.running) {
            done = true;
            return { ...w, running: false };
          }
          return w;
        });
        work.reverse();
      }
      return upsert(state, event, {
        status,
        work,
        ...(said ? { text: "" } : {}),
        tool: event.tool,
        connector: event.connector ?? null,
        toolDetail: event.detail ?? null,
        ...(newCall ? { code: event.code ?? null, output: [] } : {}),
      });
    }
    case "agent.tool.output": {
      if (state.finished[event.runId]) return state;
      const current = state.runs[event.runId];
      if (!current) return state;
      const chunk = { stream: event.stream, text: event.text };
      const output = appendOutput(current.output ?? [], chunk);
      // Into its call (by id, else the last running one).
      const work = [...(current.work ?? [])];
      let at = -1;
      for (let i = work.length - 1; i >= 0; i--) {
        const w = work[i];
        if (w?.kind === "call" && (event.toolUseId ? w.id === event.toolUseId : w.running)) {
          at = i;
          break;
        }
      }
      const call = work[at];
      if (call?.kind === "call") work[at] = { ...call, output: appendOutput(call.output, chunk) };
      return { ...state, runs: { ...state.runs, [event.runId]: { ...current, output, work } } };
    }
    case "message.created": {
      const m = event.message;
      // A fast reply while the task works (`meta.talker`): the task's row goes on.
      if (!m?.agentRunId || m.meta?.talker) return state;
      const next = finish(state, m.agentRunId);
      if (m.author?.type !== "agent" || !m.author.id) return next;
      if (m.threadId) return settleProvisional(next, m.author.id, m.threadId);
      // Flat reply (DMs): it answers the latest message, whatever thread we guessed.
      const agentId = m.author.id;
      const runs = Object.fromEntries(
        Object.entries(next.runs).filter(
          ([, r]) => !(r.provisional && r.agentId === agentId && r.channelId === m.channelId),
        ),
      );
      return { ...next, runs };
    }
    case "agent.run": {
      // A status update that says canceled works like `run.canceled`.
      if ((event.status as string) === "canceled") return cancel(state, event.runId);
      let s = state;
      if (s.finished[event.runId]) {
        if (event.status !== "running") return state;
        s = reopen(s, event.runId);
      }
      // Waiting (an answer, or its computer to come back) isn't working: the row goes, the avatar rests.
      if ((event.status as string) === "waiting_input") return s.runs[event.runId] ? finish(s, event.runId) : s;
      if (event.status === "done") {
        const settled = settleProvisional(s, event.agentId, event.threadId);
        return settled.runs[event.runId] ? finish(settled, event.runId) : settled;
      }
      // Started but nothing written yet: thinking.
      const current = s.runs[event.runId];
      const status: LiveStatus =
        (event.status === "running" || event.status === "queued") && !current?.text ? "thinking" : event.status;
      return upsert(s, event, {
        status,
        error: event.error,
        ...(event.triggerMessageId ? { triggerMessageId: event.triggerMessageId } : {}),
        ...(event.startedAt ? { startedAt: Date.parse(event.startedAt) } : {}),
      });
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
      const settled = settleAfterRun(state, event);
      // A failure is reported by run.finished; keep a failed row visible.
      if (settled.runs[event.runId]?.status === "failed") return settled;
      return settled.runs[event.runId] ? finish(settled, event.runId) : settled;
    }
    case "agent.passed":
      // It had nothing to add: its "pensando…" goes at once, and nothing of it comes after.
      return finish(settleAfterRun(state, event), event.runId);
    case "run.finished": {
      const settled = settleAfterRun(state, event);
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
      // A new model call: what the previous one wrote (and no tool call moved) was narration.
      const prev = current?.text.trim() ?? "";
      if (current && event.turn !== undefined && current.turn !== undefined && event.turn > current.turn && prev) {
        return upsert(state, event, {
          status: "running",
          work: say(current.work ?? [], prev, current.turn),
          text: event.text,
          lastSeq: event.seq,
          turn: event.turn,
        });
      }
      return upsert(state, event, {
        status: "running",
        text: (current?.text ?? "") + event.text,
        lastSeq: event.seq,
        ...(event.turn !== undefined ? { turn: event.turn } : {}),
      });
    }
    default:
      return state;
  }
}

function finish(state: StreamsState, runId: string): StreamsState {
  const { [runId]: _done, ...runs } = state.runs;
  return { ...state, runs, finished: { ...state.finished, [runId]: true } };
}

/** No event for this long: the row says "sem notícias há 3 min · Atualizar". */
export const QUIET_AFTER_MS = 3 * 60_000;

/** A live run that went silent (orphaned by a server restart, a lost socket…). */
export const isQuiet = (r: LiveRun, now = Date.now()) =>
  !r.provisional &&
  r.status !== "failed" &&
  r.status !== "canceled" &&
  now - (r.lastEventAt ?? r.startedAt ?? now) >= QUIET_AFTER_MS;

/** "Atualizar" found the run still active: quiet again for another while. */
export function touchRun(state: StreamsState, runId: string, now = Date.now()): StreamsState {
  const r = state.runs[runId];
  return r ? { ...state, runs: { ...state.runs, [runId]: { ...r, lastEventAt: now } } } : state;
}

const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "waiting_approval"]);
export const isActiveStatus = (status: string) => ACTIVE.has(status);

/**
 * The server's list of active runs in a channel is the truth: live rows it
 * doesn't know are dropped (a failed or canceled row stays until seen), and
 * active runs we never heard of get a "pensando…" row.
 */
export function reconcileRuns(
  state: StreamsState,
  channelId: string,
  active: ActiveRun[],
  now = Date.now(),
  askedAt = now,
): StreamsState {
  // A routine's background runs show nowhere in the conversation.
  const known = new Set(active.filter((a) => isActiveStatus(a.status) && !a.background).map((a) => a.runId));
  let s = state;
  for (const r of runsInChannel(state, channelId)) {
    if (r.provisional || r.status === "failed" || r.status === "canceled" || known.has(r.runId)) continue;
    // News after we asked: the list may be older than this run.
    if ((r.lastEventAt ?? 0) > askedAt) continue;
    s = finish(s, r.runId);
  }
  for (const a of active) {
    if (!known.has(a.runId) || a.channelId !== channelId || s.finished[a.runId]) continue;
    const startedAt = a.startedAt ? Date.parse(a.startedAt) : undefined;
    const heartbeat = a.heartbeatAt ? Date.parse(a.heartbeatAt) : undefined;
    const r = s.runs[a.runId];
    if (r) {
      // What the server knows better: where it started, and that it's alive.
      const lastEventAt = Math.max(r.lastEventAt ?? 0, heartbeat ?? 0) || r.lastEventAt;
      s = {
        ...s,
        runs: {
          ...s.runs,
          [a.runId]: {
            ...r,
            ...(a.triggerMessageId ? { triggerMessageId: a.triggerMessageId } : {}),
            ...(startedAt ? { startedAt } : {}),
            ...(lastEventAt ? { lastEventAt } : {}),
          },
        },
      };
      continue;
    }
    // Waiting for an approval: the card shows it, not a live row.
    if (a.status === "waiting_approval") continue;
    s = upsert(s, a, {
      status: "thinking",
      startedAt: startedAt ?? now,
      lastEventAt: now,
      ...(a.triggerMessageId ? { triggerMessageId: a.triggerMessageId } : {}),
    });
  }
  return s;
}

/** Forget a failed run after the person has seen it. */
export function dismissRun(state: StreamsState, runId: string): StreamsState {
  return finish(state, runId);
}

/**
 * Shown in the channel itself, not in a thread: a run asked there (it answers
 * there: its events carry no thread), or a "pensando…" the app guessed
 * for a message sent there (`topLevelIds`: the channel's own messages).
 */
export const inMainTimeline = (
  r: { threadId: string | null; provisional?: boolean },
  topLevelIds: ReadonlySet<string>,
) => r.threadId === null || Boolean(r.provisional && topLevelIds.has(r.threadId));

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

/**
 * The optimistic message got its server id: its "pensando…" rows move there. The server's run can be
 * faster than the POST answer (the run starts with the insert); then the real run already shows and the
 * guess just goes, or the conversation would show the agent twice.
 */
export function retargetProvisional(state: StreamsState, fromId: string, toId: string): StreamsState {
  const runs: Record<string, LiveRun> = {};
  for (const [id, r] of Object.entries(state.runs)) {
    if (!(r.provisional && r.threadId === fromId)) {
      runs[id] = r;
      continue;
    }
    const answered = Object.values(state.runs).some(
      (o) =>
        !o.provisional &&
        o.agentId === r.agentId &&
        o.channelId === r.channelId &&
        (o.triggerMessageId === toId || o.threadId === toId || (o.startedAt ?? 0) >= (r.since ?? 0) - 2000),
    );
    if (answered) continue;
    const moved = { ...r, threadId: toId, runId: provisionalId(r.agentId, toId) };
    runs[moved.runId] = moved;
  }
  return { ...state, runs };
}

/**
 * The living avatar of one run: words arriving → writing; queued/thinking/running → thinking; else idle.
 * Waiting (an approval, an answer, or its computer to come back) is not working: idle.
 */
export function agentStateOfRun(r: LiveRun): "idle" | "thinking" | "writing" {
  const status = r.status as string;
  if (
    status === "failed" ||
    status === "done" ||
    status === "waiting_approval" ||
    status === "waiting_input" ||
    status === "canceled"
  )
    return "idle";
  if (r.text.length > 0 && r.status === "running") return "writing";
  if (r.status === "running" || r.status === "queued" || r.status === "thinking") return "thinking";
  return "idle";
}

/** An agent's state across its live runs (optionally in one channel): writing beats thinking beats idle. */
export function agentStateIn(
  state: StreamsState,
  agentId: string,
  channelId?: string,
): "idle" | "thinking" | "writing" {
  let best: "idle" | "thinking" | "writing" = "idle";
  for (const r of Object.values(state.runs)) {
    if (r.agentId !== agentId || (channelId && r.channelId !== channelId)) continue;
    const s = agentStateOfRun(r);
    if (s === "writing") return "writing";
    if (s === "thinking") best = "thinking";
  }
  return best;
}
