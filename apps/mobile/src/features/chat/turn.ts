import type { LiveRun } from "@agenteschat/client";
import { type Activity, toolActivity } from "@agenteschat/client/lib/activity";
import { foldLiveWork } from "@agenteschat/client/lib/work";

/**
 * An agent's turn in the conversation as one block (Mensagens.html, the base rules): from "pensando" through
 * its steps and the words it writes to the saved reply, in the same place. Pure, so it is tested: what the
 * header says, the lines of its work, which runs draw as a block, and how the words fade in as they arrive.
 */

/** What the header says next to the agent's name. */
export type TurnPhase = "thinking" | "working" | "writing" | "stopped";

export function turnPhase(r: Pick<LiveRun, "status" | "text" | "tool" | "work">): TurnPhase {
  if (r.status === "canceled") return "stopped";
  if (r.text.length > 0) return "writing";
  if (r.tool || (r.work ?? []).some((w) => w.kind === "call")) return "working";
  return "thinking";
}

/** One line of the work above the words: a step (running, done), what it said between steps, a message it read. */
export type TurnItem =
  | { kind: "step"; key: string; activity: Activity; tool: string; running: boolean }
  | { kind: "say"; key: string; text: string }
  | { kind: "read"; key: string; messageId: string; now: boolean };

/** The run's work in order, repeats folded (five browser steps are one line), as lines of the block. */
export function turnItems(r: Pick<LiveRun, "work" | "status">): TurnItem[] {
  const live = r.status !== "canceled";
  return foldLiveWork(r.work ?? []).map((w, i): TurnItem => {
    if (w.kind === "say") return { kind: "say", key: `say-${w.turn ?? i}`, text: w.text };
    if (w.kind === "steer")
      return { kind: "read", key: `read-${w.messageId}`, messageId: w.messageId, now: Boolean(w.now) };
    return {
      kind: "step",
      key: `step-${w.id}`,
      activity: toolActivity(w.tool, w.connector, w.detail),
      tool: w.tool,
      running: live && w.running,
    };
  });
}

/** How many steps the block folds into when it is done ("3 passos"). */
export const turnSteps = (items: readonly TurnItem[]) => items.filter((x) => x.kind === "step").length;

const TURN_STATUSES: ReadonlySet<string> = new Set(["thinking", "queued", "running", "canceled"]);

/**
 * The runs that draw as a block in the conversation: everything at work (a "pensando…" guessed on send
 * too), and a stopped one that wrote something. A run at work in its browser has its browser card instead,
 * until it writes.
 */
export function turnRuns<R extends Pick<LiveRun, "runId" | "status" | "text">>(
  runs: readonly R[],
  browsing: ReadonlySet<string> = new Set(),
): R[] {
  return runs.filter(
    (r) => TURN_STATUSES.has(r.status) && !(browsing.has(r.runId) && r.text.length === 0 && r.status !== "canceled"),
  );
}

// ── Words fading in ───────────────────────────────────────────────────────────

/** A word fades in over this long as it is revealed (opacity only). */
export const WORD_FADE_MS = 280;

/** How much text was shown (`at`) since when (`t`, ms). */
export interface RevealMark {
  at: number;
  t: number;
}

/** The marks still fading, plus the last settled one (where the solid text ends). */
export function pruneMarks(marks: readonly RevealMark[], now: number, fadeMs = WORD_FADE_MS): RevealMark[] {
  let keep = 0;
  for (let i = 0; i < marks.length; i++) if (now - (marks[i] as RevealMark).t >= fadeMs) keep = i;
  return marks.slice(keep);
}

/** Text the tail can't fade: a line break or Markdown marks would draw differently once parsed. */
const UNSAFE = /[\n*_`#>[\]]/;

/**
 * The shown text split into the solid part (drawn as Markdown) and the tail still fading in, each piece
 * with its opacity, oldest first. The tail falls back to solid when fading it would change how it reads.
 */
export function fadeTail(
  text: string,
  shown: number,
  marks: readonly RevealMark[],
  now: number,
  fadeMs = WORD_FADE_MS,
): { solid: number; tail: { text: string; opacity: number }[] } {
  const end = Math.min(shown, text.length);
  const first = marks.findIndex((m) => now - m.t < fadeMs && m.at > 0);
  if (first < 0) return { solid: end, tail: [] };
  const start = first > 0 ? Math.min((marks[first - 1] as RevealMark).at, end) : 0;
  const tail: { text: string; opacity: number }[] = [];
  let from = start;
  for (const m of marks.slice(first)) {
    const to = Math.min(m.at, end);
    if (to <= from) continue;
    tail.push({ text: text.slice(from, to), opacity: Math.max(0.05, Math.min(1, (now - m.t) / fadeMs)) });
    from = to;
  }
  if (from < end) tail.push({ text: text.slice(from, end), opacity: 1 });
  const all = tail.map((p) => p.text).join("");
  if (!all || UNSAFE.test(all) || text.slice(0, start).endsWith("\n")) return { solid: end, tail: [] };
  return { solid: start, tail };
}

/** A color at `opacity` (hex or rgba; anything else as it is): the fading words' ink. */
export function withOpacity(color: string, opacity: number): string {
  const a = Math.max(0, Math.min(1, opacity));
  if (/^#[0-9a-f]{6}$/i.test(color))
    return `${color}${Math.round(a * 255)
      .toString(16)
      .padStart(2, "0")}`;
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color);
  if (rgba) {
    const base = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${Number((base * a).toFixed(3))})`;
  }
  return color;
}

// ── The block's work, handed to the saved reply ──────────────────────────────

/** The work a block showed last, so its saved reply can fold it into "N passos" in place. */
export interface TurnSnapshot {
  items: TurnItem[];
  /** The text of each message it read (the "Leu seu recado" wells). */
  quotes: Record<string, string>;
  at: number;
}

const SNAPSHOTS = new Map<string, TurnSnapshot>();
const SNAPSHOT_MAX = 24;

/** The block of `runId` shows this work now. */
export function rememberTurn(runId: string, snapshot: TurnSnapshot) {
  SNAPSHOTS.delete(runId);
  SNAPSHOTS.set(runId, snapshot);
  while (SNAPSHOTS.size > SNAPSHOT_MAX) {
    const oldest = SNAPSHOTS.keys().next().value;
    if (oldest === undefined) break;
    SNAPSHOTS.delete(oldest);
  }
}

/** The work the block of `runId` showed a moment ago (it just became its saved reply), or null. */
export function recentTurn(runId: string, now: number, maxAgeMs = 8000): TurnSnapshot | null {
  const s = SNAPSHOTS.get(runId);
  return s && now - s.at <= maxAgeMs && s.items.length > 0 ? s : null;
}

// ── A stopped reply ──────────────────────────────────────────────────────────

/**
 * `meta.canceled` of a stopped reply: who stopped it, and the run that continued it ("Continuar" goes
 * away then). Null when it wasn't stopped.
 */
export function stoppedOf(
  meta: Record<string, unknown> | undefined,
): { byUserId: string | null; continuedRunId: string | null } | null {
  const c = meta?.canceled;
  if (!c) return null;
  const o = typeof c === "object" ? (c as Record<string, unknown>) : {};
  return {
    byUserId: typeof o.byUserId === "string" ? o.byUserId : null,
    continuedRunId: typeof o.continuedRunId === "string" ? o.continuedRunId : null,
  };
}

/** `meta.canceled` once the stopped reply was continued (the `run.continued` event; also optimistic). */
export function withContinued(meta: Record<string, unknown> | undefined, newRunId: string): Record<string, unknown> {
  const c = meta?.canceled;
  const base = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  return { ...(meta ?? {}), canceled: { ...base, continuedRunId: newRunId } };
}
