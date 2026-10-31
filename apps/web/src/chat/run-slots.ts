import type { LiveRun } from "@agenteschat/client";
import { isMediaAfterReply } from "@agenteschat/client/lib/media";

/**
 * One block per agent answer, from "pensando" to the final message:
 * the live blocks sit at the end of the conversation (your new messages go above them), each under a key
 * that never changes while it lives. A "pensando…" guessed on send hands its key to the real run that
 * replaces it, and the final message is rendered under the same key, so React keeps the element: no
 * remount, no flash, no height jump.
 */
export interface RunSlot {
  key: string;
  runId: string;
  agentId: string;
  provisional: boolean;
  /** When its run left the live store (it waits there for its message to land). */
  goneAt: number | null;
}

export interface SlotRun {
  runId: string;
  agentId: string;
  provisional?: boolean;
}

/** How long a finished block waits for its message (normally a frame or two). */
export const SLOT_HOLD_MS = 4000;

export const slotKeyOf = (runId: string) => `run:${runId}`;

/**
 * The next blocks, in order. `live` are the runs on screen now (oldest first); `landed(runId)`: its
 * final message is in the timeline (it takes the block's place); `expected(runId)`: its message is on
 * its way (the block holds until it lands). A run that ends with nothing to show goes at once.
 */
export function nextSlots(
  prev: RunSlot[],
  live: SlotRun[],
  opts: { landed: (runId: string) => boolean; expected: (runId: string) => boolean; now: number },
): RunSlot[] {
  const byRun = new Map(live.map((r) => [r.runId, r]));
  const placed = new Set(prev.filter((s) => byRun.has(s.runId)).map((s) => s.runId));
  // A new run takes over the block of a "pensando…" of the same agent that just went (the server's run
  // replaced the guess, or the guess moved to the message's server id).
  const takeover = new Map<string, SlotRun>();
  for (const r of live) {
    if (placed.has(r.runId)) continue;
    const orphan = prev.find(
      (s) => s.provisional && s.agentId === r.agentId && !byRun.has(s.runId) && !takeover.has(s.key),
    );
    if (!orphan) continue;
    takeover.set(orphan.key, r);
    placed.add(r.runId);
  }
  const out: RunSlot[] = [];
  for (const s of prev) {
    const r = byRun.get(s.runId) ?? takeover.get(s.key);
    // Gone, and its final message is in the timeline: the message takes the block's place (same key).
    // A run still live keeps its block even if a message of it landed (text before an approval card or a
    // question, then resumed after the answer).
    if (!r && opts.landed(s.runId)) continue;
    if (r) {
      out.push({ key: s.key, runId: r.runId, agentId: r.agentId, provisional: Boolean(r.provisional), goneAt: null });
      continue;
    }
    const goneAt = s.goneAt ?? opts.now;
    if (!s.provisional && opts.expected(s.runId) && opts.now - goneAt < SLOT_HOLD_MS) out.push({ ...s, goneAt });
  }
  for (const r of live) {
    if (placed.has(r.runId)) continue;
    out.push({
      key: slotKeyOf(r.runId),
      runId: r.runId,
      agentId: r.agentId,
      provisional: Boolean(r.provisional),
      goneAt: null,
    });
  }
  return out;
}

/**
 * Which timeline row is drawn under its run's block key: a run can post more than one message (text
 * before an approval, the card, the final reply), and only its last one takes the block's place (keys
 * stay unique). A run still live keeps the key for its block, so none of its messages take it. The sticker
 * or GIF an agent adds after its reply (ADR 0091) is never the run's row: the reply keeps it.
 */
export function blockRowByRun(
  items: readonly {
    kind: string;
    key: string;
    message?: { agentRunId?: string | null; meta?: Record<string, unknown> };
  }[],
  liveRunIds: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    const runId = item.kind === "message" ? item.message?.agentRunId : null;
    if (runId && !liveRunIds.has(runId) && !isMediaAfterReply(item.message?.meta)) out.set(runId, item.key);
  }
  return out;
}

/** Same blocks (keys and runs) in the same order. */
export const sameSlots = (a: RunSlot[], b: RunSlot[]) =>
  a.length === b.length &&
  a.every((s, i) => s.key === b[i]?.key && s.runId === b[i]?.runId && s.goneAt === b[i]?.goneAt);

/**
 * One block at a time: only the first at work draws, so what is on screen never changes order (who
 * finishes first can't be known). The others are in the bar above the composer and come in as their
 * final message, like any new one, or as the block once the first is done. Stopped or failed still show.
 */
export const drawsBehind = (r: Pick<LiveRun, "status">) => r.status === "canceled" || r.status === "failed";

/** How many generic openers there are (`run.opener0`…): one per run, always the same. */
export const OPENERS = 3;

/**
 * What the block opens with, as if it had answered at once (the bar above the composer says it works):
 * the first thing it said (out of its work list), or a generic phrase with an ellipsis until then
 * (`opener`, which of `OPENERS`). Nothing when its words already arrive or it stopped or failed first.
 */
/**
 * How long after it starts the block waits before it shows anything of its own (1.2–2 s, one per run):
 * a reply in the same instant reads as a machine; the bar above the composer already says it works.
 */
export function openerDelayMs(runId: string) {
  return 1200 + (hashOf(runId) % 800);
}

/** Nothing of its own yet: no words, no steps, still at work (the block waits for its opener's delay). */
export const saysNothingYet = (r: Pick<LiveRun, "status" | "text" | "work">) =>
  r.text.length === 0 &&
  (r.work ?? []).length === 0 &&
  (r.status === "thinking" || r.status === "queued" || r.status === "running");

function hashOf(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function openerOf(r: Pick<LiveRun, "runId" | "status" | "text" | "work">): {
  said: string | null;
  opener: number | null;
  work: NonNullable<LiveRun["work"]>;
} {
  const work = r.work ?? [];
  const first = work.find((w) => w.kind === "say");
  if (first?.kind === "say") return { said: first.text, opener: null, work: work.filter((w) => w !== first) };
  const generic = r.text.length === 0 && r.status !== "canceled" && r.status !== "failed";
  return { said: null, opener: generic ? hashOf(r.runId) % OPENERS : null, work };
}

/** " · 4 s" shows from 2 s on: minutes and seconds past a minute. */
export function elapsedParts(ms: number): { m: number; s: number } | null {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (secs < 2) return null;
  return { m: Math.floor(secs / 60), s: secs % 60 };
}
