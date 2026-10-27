import type { LiveRun } from "@agenteschat/client";
import { type ToolItem, toolItemsLive } from "@agenteschat/client/lib/work";

/**
 * An agent's turn in the conversation as one block: from "pensando" through
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

/**
 * The run's work in order, as the tool block's items (the shared model): its calls, repeats folded (five
 * browser steps are one line), what it said between them and the messages it read. A stopped run's call
 * that was running shows as stopped.
 */
export function turnItems(r: Pick<LiveRun, "work" | "status">): ToolItem[] {
  return toolItemsLive(r.work ?? [], r.status === "canceled");
}

/**
 * How long after it starts the block waits before it shows anything of its own (1.2–2 s, one per run):
 * a reply in the same instant reads as a machine; the line above the box already says it works.
 */
export function openerDelayMs(runId: string) {
  let h = 0;
  for (const ch of runId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 1200 + (h % 800);
}

/** How many generic openers there are (`mobile.chat.turn.opener0`…): one per run, always the same. */
export const OPENERS = 3;

/**
 * What the block opens with, as if it had answered at once: the first thing it said (out of the lines
 * below), or a generic phrase with an ellipsis until then (`opener`, which of `OPENERS`). Nothing when
 * its words already arrive or it was stopped before saying anything.
 */
export function turnOpener(
  run: Pick<LiveRun, "runId" | "status" | "text">,
  items: readonly ToolItem[],
): { said: string | null; opener: number | null; lines: ToolItem[] } {
  const first = items.find((x) => x.kind === "say");
  if (first) return { said: first.text, opener: null, lines: items.filter((x) => x !== first) };
  const generic = run.text.length === 0 && run.status !== "canceled";
  let h = 0;
  for (const ch of run.runId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { said: null, opener: generic ? h % OPENERS : null, lines: [...items] };
}

/**
 * The blocks drawn now: one at a time, the first at work, so what is on screen never changes order (who
 * finishes first can't be known). The others are in the line above the box and come in as their saved
 * reply, like any new message, or as the block once the first is done. A stopped one still shows.
 */
export function openingRuns<R extends Pick<LiveRun, "status">>(runs: readonly R[]): R[] {
  return runs.filter((r, i) => i === 0 || r.status === "canceled");
}

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

/**
 * The work a block showed last, so its saved reply keeps the same tool block in place ("Usou 4 ferramentas")
 * and the messages it read, instead of loading the run's steps again.
 */
export interface TurnSnapshot {
  items: ToolItem[];
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

// ── A tool line's open view ──────────────────────────────────────────────────

/** What a call printed, as one text: its end when long (the open line shows the newest output). */
export function outputTail(output: readonly { text: string }[], max = 2000): string {
  const text = output.map((o) => o.text).join("");
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}
