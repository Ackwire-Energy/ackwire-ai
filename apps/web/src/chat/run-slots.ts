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
 * The blocks in the order they draw: every agent at work has its own, and the ones still waiting for their first
 * words (`waiting`) stay last, so an answer that starts goes above them; each group keeps its order.
 */
export function waitingLast<S extends Pick<RunSlot, "runId">>(
  slots: readonly S[],
  waiting: (runId: string) => boolean,
) {
  return [...slots.filter((s) => !waiting(s.runId)), ...slots.filter((s) => waiting(s.runId))];
}

/**
 * How long after it starts the block waits before its waiting row shows (1.2–2 s, one per run): the bar above the
 * composer says it works at once, and a row in the same instant reads as a machine.
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

/** The first thing it said, out of its work list (the line its block opens with, above its tools). */
export function openerOf(r: Pick<LiveRun, "work">): { said: string | null; work: NonNullable<LiveRun["work"]> } {
  const work = r.work ?? [];
  const first = work.find((w) => w.kind === "say");
  if (first?.kind === "say") return { said: first.text, work: work.filter((w) => w !== first) };
  return { said: null, work };
}
