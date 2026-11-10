import { isMediaAfterReply } from "@agenteschat/client/lib/media";

/**
 * The conversation list's scroll rules, kept pure so they can be tested: when the list follows new
 * content, which rows just arrived at the bottom (they animate in), what sits below the person while
 * they read older ones (the round button's count and the "Novas" line), how a finished reply's block waits
 * for its saved message so the swap never leaves an empty frame, the keys that keep an agent's
 * block the same row from "pensando" to its saved reply, and where the person was while something
 * covered the list.
 */

/**
 * The list follows new content only while the person is this close to the end, as a fraction of the
 * visible height (Legend List's `maintainScrollAtEndThreshold`, measured from the physical end since 3.7:
 * about Bluesky's 100 points). Farther up, they are reading: nothing moves and the round button counts what arrived.
 */
export const STICK_TO_END_THRESHOLD = 0.15;

/** How long a finished reply's streaming row waits for its saved message before it goes anyway. */
export const HOLD_FINISHED_RUN_MS = 2500;

/**
 * Keys added at the bottom since the previous rows: after the last row both lists share, and new.
 * An older page prepended above, the first load (no previous rows) and a replaced list give none.
 */
export function appendedKeys(prev: readonly string[], next: readonly string[]): string[] {
  if (prev.length === 0) return [];
  const before = new Set(prev);
  let last = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (before.has(next[i] as string)) {
      last = i;
      break;
    }
  }
  if (last < 0) return [];
  return next.slice(last + 1).filter((k) => !before.has(k));
}

export interface ScrollRow {
  key: string;
  /** A message or an agent at work (day dividers and markers never count). */
  kind: "message" | "run" | "other";
  /** A message row's message id, in the order the server posted them (its key can be its block's, `turnKeys`). */
  id?: string;
  /** Written by the person reading (never counts as new for them). */
  mine?: boolean;
  /** Who wrote it or is working ("agent:<id>", "person:<id>"): the pill's faces and names. */
  who?: string;
  /** The sticker or GIF an agent adds after its reply (ADR 0091): never news of its own (no count, no "Novas"). */
  silent?: boolean;
  /** Someone else's message that @mentions the person reading: the round button's count turns red. */
  mentionsMe?: boolean;
}

/** The last message row: where the person has read up to when they are at the end. */
export function lastSeenKey(rows: readonly ScrollRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as ScrollRow;
    if (r.kind === "message") return r.key;
  }
  return null;
}

export interface Unseen {
  /** New messages below (an agent still at work isn't one yet). */
  messages: number;
  /** Where the "Novas" line goes: the first new row (message or agent at work). */
  firstKey: string | null;
  /** Who wrote the new messages, in order, once each. */
  authors: string[];
  /** Who is at work below ("Theo escrevendo"), once each. */
  working: string[];
  /** One of the new messages @mentions the person reading. */
  mentionsMe: boolean;
}

/**
 * What arrived below the last row the person saw, theirs left out ("↓ 2 novas · Marina e Ada · Atlas escrevendo"), and
 * the messages posted after `seenPostedId` (the one posted last when they were at the end, `lastPostedId`) in a place
 * above that row: a reply keeps the place where its first words showed, so it can land there and still be new.
 */
export function unseenBelow(rows: readonly ScrollRow[], seenKey: string | null, seenPostedId?: string): Unseen {
  const none: Unseen = { messages: 0, firstKey: null, authors: [], working: [], mentionsMe: false };
  if (!seenKey) return none;
  const at = rows.findIndex((r) => r.key === seenKey);
  if (at < 0) return none;
  const out: Unseen = { ...none, authors: [], working: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as ScrollRow;
    const postedSince = seenPostedId !== undefined && r.id !== undefined && r.id > seenPostedId;
    if (i <= at && !(r.kind === "message" && postedSince)) continue;
    if ((r.kind !== "message" && r.kind !== "run") || r.mine || r.silent) continue;
    out.firstKey ??= r.key;
    if (r.kind === "message") out.messages++;
    if (r.mentionsMe) out.mentionsMe = true;
    const list = r.kind === "message" ? out.authors : out.working;
    if (r.who && !list.includes(r.who)) list.push(r.who);
  }
  return out;
}

/**
 * Where the person is in the conversation, kept while something covers it (a sheet, the agent's computer): at the
 * end, or reading, with the scroll, a row on screen and where that row was (rows above can change size meanwhile).
 */
export type Place = { end: true } | { end: false; scroll: number; key: string | null; position: number | null };

/** How far the list may drift from a kept place before it is put back (points). */
export const PLACE_SLACK = 40;

/**
 * What puts a kept place back on screen, or null when it is still there: the end (`"end"`), or the scroll that
 * shows the row where it was, either way the list moved (toward older messages or toward the end).
 */
export function placeCorrection(
  place: Place,
  now: { scroll: number; distanceFromEnd: number; positionOf: (key: string) => number | undefined },
): "end" | number | null {
  if (place.end) return now.distanceFromEnd > PLACE_SLACK ? "end" : null;
  const at = place.key !== null ? now.positionOf(place.key) : undefined;
  const moved = at !== undefined && place.position !== null ? at - place.position : 0;
  const target = place.scroll + moved;
  return Math.abs(now.scroll - target) > PLACE_SLACK ? target : null;
}

/** An agent's block key, and what lets a guessed "pensando…" hand it to the real run. */
export interface TurnKey {
  key: string;
  agentId: string;
  channelId: string;
  threadId: string;
  provisional: boolean;
}

/** Each guessed "pensando…" gets a fresh key (the same agent asked again in the same thread is a new block). */
let guessSeq = 0;

/**
 * Keys for the agents' blocks, kept across renders: a run keeps its key; a real run takes the key of the
 * "pensando…" guessed on send for the same agent there (the same thread, else the same conversation) once
 * that guess is gone, so the block doesn't remount; the saved reply then takes its run's key.
 */
export function turnKeys(
  prev: ReadonlyMap<string, TurnKey>,
  runs: readonly { runId: string; agentId: string; channelId: string; threadId: string; provisional?: boolean }[],
): Map<string, TurnKey> {
  const next = new Map(prev);
  const live = new Set(runs.map((r) => r.runId));
  for (const r of runs) {
    if (next.has(r.runId)) continue;
    // A guess's id repeats (`pending:<agent>:<thread>`) and the key it hands over stays with that reply.
    let key = r.provisional ? `turn-${r.runId}:${++guessSeq}` : `turn-${r.runId}`;
    if (!r.provisional) {
      const guesses = [...next].filter(
        ([id, k]) => k.provisional && !live.has(id) && k.agentId === r.agentId && k.channelId === r.channelId,
      );
      const pick = guesses.find(([, k]) => k.threadId === r.threadId) ?? guesses[0];
      if (pick) {
        key = pick[1].key;
        next.delete(pick[0]);
      }
    }
    next.set(r.runId, {
      key,
      agentId: r.agentId,
      channelId: r.channelId,
      threadId: r.threadId,
      provisional: Boolean(r.provisional),
    });
  }
  return next;
}

/**
 * Which saved message takes its run's block key: a run can post more than one (text before an approval,
 * the card, the reply), and only its last one does (keys stay unique). None while the run still draws its
 * own block. The sticker or GIF an agent adds after its reply (ADR 0091) carries the reply's run but never takes
 * its key: the reply keeps it (no remount).
 */
export function turnRowByRun(
  rows: readonly {
    kind: string;
    key: string;
    message?: { agentRunId?: string | null; meta?: Record<string, unknown> | null };
  }[],
  drawn: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const runId = r.kind === "message" ? r.message?.agentRunId : null;
    if (runId && !drawn.has(runId) && !isMediaAfterReply(r.message?.meta)) out.set(runId, r.key);
  }
  return out;
}

export interface HeldRun<R> {
  run: R;
  until: number;
}

export interface RunsShown<R> {
  /** The streaming rows to draw, the held ones (older) first. */
  shown: R[];
  held: Map<string, HeldRun<R>>;
  /** When the next held row expires (to re-check then), or null. */
  nextExpiry: number | null;
}

/**
 * The agents' blocks to draw. A run that leaves the list usually has its saved message a moment later
 * (separate updates), so its block stays, with its last words, until a message with that run arrives or
 * `holdMs` passes (only the runs `holds` keeps: one that wrote nothing just goes). A run still in the live
 * store always draws, even if a message of it is listed: the store drops a run when its message comes, so
 * one that is there again was resumed (after an approval or a question) and works on under its card.
 */
export function runsToShow<R extends { runId: string }>(
  held: ReadonlyMap<string, HeldRun<R>>,
  prevShown: readonly R[],
  writing: readonly R[],
  arrived: ReadonlySet<string>,
  now: number,
  holdMs = HOLD_FINISHED_RUN_MS,
  holds: (run: R) => boolean = () => true,
): RunsShown<R> {
  const live = writing;
  const writingIds = new Set(writing.map((r) => r.runId));
  const next = new Map<string, HeldRun<R>>();
  for (const [id, h] of held) {
    if (h.until > now && !arrived.has(id) && !writingIds.has(id)) next.set(id, h);
  }
  for (const r of prevShown) {
    // Stopped writing just now (not held before): hold it.
    if (!writingIds.has(r.runId) && !arrived.has(r.runId) && !held.has(r.runId) && holds(r)) {
      next.set(r.runId, { run: r, until: now + holdMs });
    }
  }
  let nextExpiry: number | null = null;
  for (const h of next.values()) {
    if (nextExpiry === null || h.until < nextExpiry) nextExpiry = h.until;
  }
  return { shown: [...[...next.values()].map((h) => h.run), ...live], held: next, nextExpiry };
}
