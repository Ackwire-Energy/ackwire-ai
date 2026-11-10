import type { LiveRun, Message } from "@agenteschat/client";
import { waitsForWords } from "@agenteschat/client/lib/activity";
import { holdsText } from "@agenteschat/client/lib/text";
import { blockPlaces } from "@agenteschat/client/lib/timeline";
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
 * browser steps are one line), what it said between them and the messages it read. `over`: nothing more comes, so a
 * call that was running shows as stopped.
 */
export function turnItems(
  r: Pick<LiveRun, "work" | "status">,
  over = r.status === "canceled" || r.status === "failed",
): ToolItem[] {
  return toolItemsLive(r.work ?? [], over);
}

/** What a saved reply's kept work depends on: a line's state and count, and how much of a line said has arrived. */
export const turnSignature = (items: readonly ToolItem[]) =>
  items
    .map((x) =>
      x.kind === "call"
        ? `${x.key}:${x.line.state}${x.line.count}`
        : `${x.key}:${x.kind === "say" ? x.text.length : ""}`,
    )
    .join("|");

/**
 * Its block is in the conversation (as `TurnRow` draws it): words of its own. Until then there is no row, and the
 * line above the box speaks for it (its face, what it does now, its time and its stop).
 */
export const turnShows = (r: Pick<LiveRun, "status" | "text" | "work">) => !waitsForWords(r);

/** The first thing it said, out of the lines below (the line its block opens with, above its tools). */
export function turnOpener(items: readonly ToolItem[], posted = ""): { said: string | null; lines: ToolItem[] } {
  const first = items.find((x) => x.kind === "say");
  // Said before a call and then posted as the saved reply (`posted`, the lead before a card): the reply shows it.
  if (first)
    return {
      said: posted && holdsText(posted, first.text) ? null : first.text,
      lines: items.filter((x) => x !== first),
    };
  return { said: null, lines: [...items] };
}

/**
 * The blocks in the order they draw: every agent at work has its own, and the ones still waiting for their first
 * words (`waitsForWords`) stay last, so an answer that starts goes above them; each group keeps its order.
 */
export function turnOrder<R extends Pick<LiveRun, "status" | "text" | "work">>(runs: readonly R[]): R[] {
  return [...runs.filter((r) => !waitsForWords(r)), ...runs.filter((r) => waitsForWords(r))];
}

/** A conversation row as `turnsInPlace` reads it: its moment, and how it groups with the row above. */
interface PlacedRow {
  kind: string;
  iso?: string;
  message?: Pick<Message, "createdAt" | "local">;
  grouped?: boolean;
  continued?: boolean;
  above?: unknown;
}

/**
 * The rows with each block at work where its words first showed (`blockPlaces`), so what people sent meanwhile reads
 * below it, as its message will once posted there; `last`: the other blocks, for the end (`turnOrder`). A block between
 * two rows of one author ends their run: the row under it shows its name again.
 */
export function turnsInPlace<R extends PlacedRow, T>(
  rows: readonly R[],
  runs: readonly LiveRun[],
  rowOf: (run: LiveRun) => T,
): { rows: (R | T)[]; last: T[] } {
  const { before, after } = blockPlaces(rows, turnOrder(runs), (r) => r.shownAt);
  const out: (R | T)[] = [];
  for (const [i, row] of rows.entries()) {
    const turns = before.get(i);
    if (turns) {
      // The row above is the last one in (blocks go before their row).
      const above = out.at(-1) as R | undefined;
      if (above?.continued) out[out.length - 1] = { ...above, continued: false };
      out.push(...turns.map(rowOf));
    }
    out.push(turns && row.grouped ? ({ ...row, grouped: false, above: undefined } as R) : row);
  }
  return { rows: out, last: after.map(rowOf) };
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

/**
 * `meta.stepLimit` of the reply of a run that reached its step limit, or stopped because it got stuck (`stuck`):
 * the run that continued it ("Continuar" goes away then). Null for any other reply.
 */
export function stepLimitOf(
  meta: Record<string, unknown> | undefined,
): { continuedRunId: string | null; stuck: boolean } | null {
  const c = meta?.stepLimit;
  if (!c || typeof c !== "object") return null;
  const { continuedRunId: id, stuck } = c as Record<string, unknown>;
  return { continuedRunId: typeof id === "string" ? id : null, stuck: stuck === true };
}

/**
 * The reply's meta once it was continued (the `run.continued` event; also optimistic): `meta.canceled`,
 * `meta.stepLimit` on a reply at the step limit, or `meta.workEnd` on a long work's end.
 */
export function withContinued(meta: Record<string, unknown> | undefined, newRunId: string): Record<string, unknown> {
  const key = meta?.canceled ? "canceled" : meta?.stepLimit ? "stepLimit" : meta?.workEnd ? "workEnd" : "canceled";
  const c = meta?.[key];
  const base = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  return { ...(meta ?? {}), [key]: { ...base, continuedRunId: newRunId } };
}

// ── A tool line's open view ──────────────────────────────────────────────────

/** What a call printed, as one text: its end when long (the open line shows the newest output). */
export function outputTail(output: readonly { text: string }[], max = 2000): string {
  const text = output.map((o) => o.text).join("");
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}
