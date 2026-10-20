import type { LiveRun } from "@agenteschat/client";

/**
 * One block per agent answer, from "pensando" to the final message (telas/Mensagens.html, "Um bloco só"):
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
    // Its final message is in the timeline: the message takes the block's place (same key).
    if (opts.landed(r?.runId ?? s.runId)) continue;
    if (r) {
      out.push({ key: s.key, runId: r.runId, agentId: r.agentId, provisional: Boolean(r.provisional), goneAt: null });
      continue;
    }
    const goneAt = s.goneAt ?? opts.now;
    if (!s.provisional && opts.expected(s.runId) && opts.now - goneAt < SLOT_HOLD_MS) out.push({ ...s, goneAt });
  }
  for (const r of live) {
    if (placed.has(r.runId) || opts.landed(r.runId)) continue;
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

/** Same blocks (keys and runs) in the same order. */
export const sameSlots = (a: RunSlot[], b: RunSlot[]) =>
  a.length === b.length &&
  a.every((s, i) => s.key === b[i]?.key && s.runId === b[i]?.runId && s.goneAt === b[i]?.goneAt);

/** The block's header word: "pensando" (nothing yet), "trabalhando" (steps), "escrevendo" (words). */
export type RunPhase = "thinking" | "working" | "writing";

export function runPhase(r: Pick<LiveRun, "text" | "status" | "work" | "tool">): RunPhase {
  if (r.text.trim().length > 0 && r.status === "running") return "writing";
  if (r.tool || (r.work ?? []).some((w) => w.kind === "call")) return "working";
  return "thinking";
}

/** " · 4 s" shows from 2 s on: minutes and seconds past a minute. */
export function elapsedParts(ms: number): { m: number; s: number } | null {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (secs < 2) return null;
  return { m: Math.floor(secs / 60), s: secs % 60 };
}
