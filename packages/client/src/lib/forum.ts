/**
 * The forum's pure rules (telas/Forum.html, D45): what the round track draws,
 * which list a topic goes to, what needs me, where each agent stands, posts by
 * round, the synthesis' issues. No React, no i18n: components turn these into
 * words and pixels.
 */
import type {
  ForumFilter,
  ForumPost,
  ForumSeat,
  ForumStanceKind,
  ForumSuggestedIssue,
  ForumSynthesis,
  ForumTopic,
  ForumTopicDetail,
  ForumTrackEntry,
} from "../api/types";

/**
 * One column of the round track, as `RoundTrack` in `@agenteschat/ui` draws it
 * (same shape as its `ForumTrackItem`; data only, so the phone app can use it).
 */
export type ForumTrackKind =
  | "spoke"
  | "person"
  | "seat"
  | "passed"
  | "waiting"
  | "seatPending"
  | "synthesis"
  | "live"
  | "sleep"
  | "skipped"
  | "budget"
  | "pending";

export interface ForumTrackItem {
  kind: ForumTrackKind;
  round: number;
  agentId?: string;
  userId?: string;
  postId: string | null;
  /** Characters (column height). */
  length: number;
  /** The agent's look (agents' items). */
  color?: string;
  eyes?: string;
  /** The synthesis' item (live, done or stopped). */
  synthesis?: boolean;
}

export const MIN_AGENTS = 2;
export const MAX_AGENTS = 8;
export const MAX_ROUNDS = 10;
export const ROUND_CHOICES = [2, 3, 4, 5, 10] as const;

export const isEnded = (t: Pick<ForumTopic, "status">) => t.status === "done" || t.status === "canceled";
/** Still going (open or stalled): "Em discussão". */
export const isGoing = (t: Pick<ForumTopic, "status">) => !isEnded(t);
/** Who writes the synthesis: the chosen agent, else the first one. */
export const ownerOf = (t: Pick<ForumTopic, "ownerAgentId" | "agentIds">) => t.ownerAgentId ?? t.agentIds[0] ?? null;
export const seatKey = (s: ForumSeat) => `${s.type}:${s.id}`;
/** The table in speaking order (older topics without seats: the agents). */
export const seatsOf = (t: Pick<ForumTopic, "seats" | "agentIds">): ForumSeat[] =>
  t.seats.length > 0 ? t.seats : t.agentIds.map((id) => ({ type: "agent" as const, id }));

/** "Reaberto": a person asked for a new round from a comment and it is still going. */
export const isReopened = (t: Pick<ForumTopic, "status" | "reopened">) => !!t.reopened && isGoing(t);

export type ForumStatusShown = "open" | "stalled" | "reopened" | "done" | "canceled";
export const statusShown = (t: Pick<ForumTopic, "status" | "reopened">): ForumStatusShown =>
  isReopened(t) && t.status === "open" ? "reopened" : t.status;

// ── Lists ────────────────────────────────────────────────────────────────────

/** I'm in it: I opened it, I'm responsible, it was asked by me, or I'm notified. */
export function isMine(t: ForumTopic, me: string) {
  return (
    (t.createdBy.type === "person" && t.createdBy.id === me) ||
    t.responsibleUserId === me ||
    t.requestedByUserId === me ||
    t.userIds.includes(me) ||
    t.seats.some((s) => s.type === "person" && s.id === me)
  );
}

/** Em discussão (open or stalled) / Concluídos (done or canceled) / Meus. */
export function filterTopics(topics: ForumTopic[], filter: ForumFilter, me: string) {
  if (filter === "open") return topics.filter(isGoing);
  if (filter === "done") return topics.filter(isEnded);
  return topics.filter((t) => isMine(t, me));
}

/** Search (title, goal, decision, agents' names) and the agent filter. */
export function matchTopic(t: ForumTopic, q: string, agentIds: string[], agentName: (id: string) => string) {
  if (agentIds.length > 0 && !t.agentIds.some((a) => agentIds.includes(a))) return false;
  const query = q.trim().toLowerCase();
  if (!query) return true;
  const hay = [t.title, t.goal, decisionLine(t) ?? "", ...t.agentIds.map(agentName)].join(" ").toLowerCase();
  return hay.includes(query);
}

/** Concluded topics: the decision (or the plan's objective) in one line. */
export function decisionLine(t: Pick<ForumTopic, "synthesis">): string | null {
  const s = t.synthesis?.structured;
  if (!s) return null;
  return (s.format === "plan" ? s.objective : s.decision) || null;
}

export const byActivity = (a: ForumTopic, b: ForumTopic) => b.lastActivityAt.localeCompare(a.lastActivityAt);

// ── Turns ────────────────────────────────────────────────────────────────────

export type TurnNow =
  | { kind: "agent"; agentId: string; round: number; writing: boolean }
  | { kind: "person"; userId: string; round: number }
  | { kind: "synthesis"; agentId: string | null; round: number }
  | { kind: "stalled"; agentId: string | null; round: number; synthesis: boolean }
  | null;

/**
 * Whose turn it is now: the agent writing (`live`), or the one the server
 * runs (active, not streaming yet); a seated person ("Sua vez"); the
 * synthesis; or the turn that stopped (stalled).
 */
export function turnNow(t: ForumTopic, active: string[] = t.activeAgentIds): TurnNow {
  if (t.status === "stalled") {
    return {
      kind: "stalled",
      agentId: t.stall?.agentId ?? (t.stall?.synthesis ? ownerOf(t) : null),
      round: t.stall?.round ?? t.round,
      synthesis: !!t.stall?.synthesis,
    };
  }
  if (t.status !== "open") return null;
  if (t.phase === "synthesizing" || t.track.synthesis?.status === "live")
    return { kind: "synthesis", agentId: t.track.synthesis?.agentId ?? ownerOf(t), round: t.round };
  const round = t.track.rounds.find((r) => r.round === t.round);
  const live = round?.entries.find((e) => e.status === "live");
  if (live) return { kind: "agent", agentId: live.seat.id, round: t.round, writing: true };
  const waiting = round?.entries.find((e) => e.status === "waiting");
  if (waiting || (t.phase === "waiting_person" && t.waitingUserId))
    return { kind: "person", userId: waiting?.seat.id ?? t.waitingUserId ?? "", round: t.round };
  const pending = round?.entries.find(
    (e) => e.status === "pending" && e.seat.type === "agent" && active.includes(e.seat.id),
  );
  if (pending) return { kind: "agent", agentId: pending.seat.id, round: t.round, writing: false };
  const any = active[0];
  return any ? { kind: "agent", agentId: any, round: t.round, writing: false } : null;
}

/** Who speaks after the current turn: the next pending seat of this round, else the first of the next; null → the synthesis. */
export function nextSeat(t: ForumTopic, active: string[] = t.activeAgentIds): ForumSeat | null {
  if (t.status !== "open") return null;
  const now = turnNow(t, active);
  if (!now || now.kind === "synthesis" || now.kind === "stalled") return null;
  const nowKey = now.kind === "agent" ? `agent:${now.agentId}` : `person:${now.userId}`;
  for (const r of t.track.rounds.filter((x) => x.round >= t.round)) {
    const at = r.round === t.round ? r.entries.findIndex((e) => seatKey(e.seat) === nowKey) + 1 : 0;
    const next = r.entries.slice(at).find((e) => e.status === "pending" && seatKey(e.seat) !== nowKey);
    if (next) return next.seat;
  }
  return null;
}

/** Agents whose latest turn in this round (or the last one) was skipped for their own budget. */
export function outOfBudget(t: ForumTopic): string[] {
  if (!isGoing(t)) return [];
  const recent = [...t.track.rounds].filter((r) => r.round <= t.round).reverse();
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const r of recent)
    for (const e of r.entries) {
      if (e.seat.type !== "agent" || seen.has(e.seat.id) || e.status === "pending") continue;
      seen.add(e.seat.id);
      if (e.status === "skipped_budget") out.add(e.seat.id);
    }
  return [...out];
}

// ── The synthesis' issues ────────────────────────────────────────────────────

/** Suggested issues still to approve (the created ones are matched by title). */
export function pendingIssues(
  s: Pick<ForumSynthesis, "suggestedIssues" | "createdIssues"> | null,
): ForumSuggestedIssue[] {
  if (!s) return [];
  const made = new Set(s.createdIssues.map((c) => c.title.trim().toLowerCase()));
  return s.suggestedIssues.filter((i) => !made.has(i.title.trim().toLowerCase()));
}

/** Each suggested issue with the issue it became, when it was created. */
export function issuesWithState(s: Pick<ForumSynthesis, "suggestedIssues" | "createdIssues">) {
  const made = new Map(s.createdIssues.map((c) => [c.title.trim().toLowerCase(), c]));
  return s.suggestedIssues.map((issue) => ({ issue, created: made.get(issue.title.trim().toLowerCase()) ?? null }));
}

// ── "Precisa de você" ────────────────────────────────────────────────────────

export type ForumNeed =
  | { kind: "turn"; topic: ForumTopic }
  | { kind: "issues"; topic: ForumTopic; count: number }
  | { kind: "budget"; topic: ForumTopic; agentId: string }
  | { kind: "stalled"; topic: ForumTopic };

/**
 * What waits on me: my seated turn; a concluded topic of mine with issues to
 * approve; a stalled topic of mine; an agent of an ongoing topic of mine out
 * of its own budget.
 */
export function needsOf(t: ForumTopic, me: string): ForumNeed | null {
  if (t.status === "open" && t.phase === "waiting_person" && t.waitingUserId === me) return { kind: "turn", topic: t };
  const mine = isMine(t, me);
  if (!mine) return null;
  if (t.status === "done") {
    const count = pendingIssues(t.synthesis).length;
    return count > 0 ? { kind: "issues", topic: t, count } : null;
  }
  if (t.status === "stalled") return { kind: "stalled", topic: t };
  const broke = outOfBudget(t)[0];
  return broke ? { kind: "budget", topic: t, agentId: broke } : null;
}

/** "Discutindo agora": open topics with nothing waiting on me (those go to "Precisa de você"). */
export const liveNow = (topics: ForumTopic[], me: string) =>
  topics.filter((t) => t.status === "open" && !needsOf(t, me));

// ── The round track (drawn by `RoundTrack` in @agenteschat/ui) ───────────────

const agentEntryKind = (t: ForumTopic, round: number, e: ForumTrackEntry, now: TurnNow): ForumTrackItem["kind"] => {
  switch (e.status) {
    case "spoke":
      return "spoke";
    case "skipped_budget":
      return "budget";
    case "live":
      return "live";
    case "stopped":
    case "failed":
      if (now?.kind === "stalled" && !now.synthesis && now.agentId === e.seat.id && now.round === round) return "sleep";
      return e.postId && e.length > 0 ? "spoke" : "skipped";
    case "pending":
      if (now?.kind === "agent" && now.agentId === e.seat.id && now.round === round) return "live";
      return isEnded(t) ? "skipped" : "pending";
    default:
      return "skipped";
  }
};

const personEntryKind = (e: ForumTrackEntry): ForumTrackItem["kind"] => {
  switch (e.status) {
    case "spoke":
      return "seat";
    case "waiting":
      return "waiting";
    case "pending":
      return "seatPending";
    default:
      return "passed";
  }
};

export interface TrackGroupData {
  round: number;
  items: ForumTrackItem[];
}

/**
 * The track's columns, round by round: people's free posts lead their round,
 * then each seat in order; the synthesis closes the last round. `color` is
 * the agent's (the caller knows the looks).
 */
export function trackGroups(
  t: ForumTopic,
  look: (agentId: string) => { color?: string; eyes?: string },
  active: string[] = t.activeAgentIds,
): TrackGroupData[] {
  const now = turnNow(t, active);
  const rounds = isEnded(t) ? t.track.rounds.filter((r) => r.round <= Math.max(1, t.round)) : t.track.rounds;
  const groups: TrackGroupData[] = rounds.map((r) => {
    const items: ForumTrackItem[] = [];
    for (const p of r.personPosts)
      items.push({ kind: "person", round: r.round, userId: p.userId, postId: p.postId, length: p.length });
    for (const e of r.entries) {
      if (e.seat.type === "person") {
        items.push({ kind: personEntryKind(e), round: r.round, userId: e.seat.id, postId: e.postId, length: e.length });
        continue;
      }
      const l = look(e.seat.id);
      items.push({
        kind: agentEntryKind(t, r.round, e, now),
        round: r.round,
        agentId: e.seat.id,
        postId: e.postId,
        length: e.length,
        color: l.color,
        eyes: l.eyes,
      });
    }
    return { round: r.round, items };
  });
  const syn = t.track.synthesis;
  const last = groups.at(-1);
  if (syn && last) {
    const agentId = syn.agentId ?? ownerOf(t) ?? undefined;
    const l = agentId ? look(agentId) : {};
    last.items.push({
      kind: syn.status === "done" ? "synthesis" : syn.status === "live" ? "live" : "sleep",
      synthesis: true,
      round: last.round,
      agentId,
      postId: null,
      length: 0,
      color: l.color,
      eyes: l.eyes,
    });
  }
  return groups;
}

/** How many agents' turns were spoken (the track's label). */
export const spokenCount = (t: ForumTopic) =>
  t.track.rounds.reduce(
    (n, r) => n + r.entries.filter((e) => e.seat.type === "agent" && e.status === "spoke").length,
    0,
  );

// ── Posts ────────────────────────────────────────────────────────────────────

/** Which round each person's free post leads (from the track); other posts keep their own round. */
export function postRounds(t: Pick<ForumTopicDetail, "track" | "posts">) {
  const leads = new Map<string, number>();
  for (const r of t.track.rounds) for (const p of r.personPosts) if (p.postId) leads.set(p.postId, r.round);
  const round = (p: ForumPost) => (p.kind === "free" ? (leads.get(p.id) ?? p.round + 1) : p.round);
  return round;
}

export interface RoundPosts {
  round: number;
  posts: ForumPost[];
}

/**
 * Posts by round, from round 1 up to the current one (empty rounds too); the
 * synthesis posts stay out (the synthesis card shows them) and comments made
 * after the synthesis come apart, in order.
 */
export function postsByRound(t: Pick<ForumTopicDetail, "track" | "posts" | "round">) {
  const roundOf = postRounds(t);
  const sorted = [...t.posts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const map = new Map<number, ForumPost[]>();
  for (let r = 1; r <= Math.max(1, t.round); r++) map.set(r, []);
  const comments: ForumPost[] = [];
  for (const p of sorted) {
    if (p.kind === "synthesis" || p.meta?.synthesis === true) continue;
    if (p.kind === "comment") {
      comments.push(p);
      continue;
    }
    const r = Math.max(1, roundOf(p));
    map.set(r, [...(map.get(r) ?? []), p]);
  }
  const rounds: RoundPosts[] = [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, posts]) => ({ round, posts }));
  return { rounds, comments };
}

// ── Where each one stands ────────────────────────────────────────────────────

/** Up = for the proposal on the table; middle = a question; down = against. */
export const STANCE_LEVEL: Record<ForumStanceKind, 0 | 1 | 2> = {
  propose: 0,
  agree: 0,
  shift: 0,
  reply: 0,
  ask: 1,
  disagree: 2,
};
export const isFor = (k: ForumStanceKind | null | undefined) =>
  k === "propose" || k === "agree" || k === "shift" || k === "reply";

export interface Standing {
  agentId: string;
  /** Their latest post (its position line and stance). */
  last: ForumPost | null;
  /** One cell per round: a level, "live" (writing now) or null (no post). */
  lane: (0 | 1 | 2 | "live" | null)[];
}

const turnsOf = (t: Pick<ForumTopicDetail, "posts">, agentId: string) =>
  t.posts
    .filter((p) => p.author.type === "agent" && p.author.id === agentId && p.kind === "turn")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function standings(t: ForumTopicDetail, active: string[] = t.activeAgentIds): Standing[] {
  const n = isEnded(t) ? Math.max(1, t.round) : Math.max(t.rounds, t.round, 1);
  const now = turnNow(t, active);
  return t.agentIds.map((agentId) => {
    const posts = turnsOf(t, agentId);
    const lane: Standing["lane"] = [];
    for (let r = 1; r <= n; r++) {
      const post = [...posts].reverse().find((p) => p.round === r);
      if (post) lane.push(post.stance ? STANCE_LEVEL[post.stance.kind] : 1);
      else if (now?.kind === "agent" && now.writing && now.agentId === agentId && now.round === r) lane.push("live");
      else lane.push(null);
    }
    return { agentId, last: posts.at(-1) ?? null, lane };
  });
}

/** "2 de 3 concordam": agents whose latest stance is for the proposal, and those left with a question. */
export function convergence(t: ForumTopicDetail) {
  const list = standings(t);
  const agree = list.filter((s) => isFor(s.last?.stance?.kind)).map((s) => s.agentId);
  const askers = list.filter((s) => s.last?.stance?.kind === "ask").map((s) => s.agentId);
  return { agree, askers, total: list.length };
}

// ── Streaming text ───────────────────────────────────────────────────────────

/** The live text without the stance header the server strips on save ("Stance: …", "Position: …"). */
export function stripStanceHeader(text: string) {
  const lines = text.split("\n");
  let consumed = 0;
  for (let i = 0; i < lines.length && i < 10; i++) {
    const line = (lines[i] ?? "").replace(/[*_>`]/g, "").trim();
    if (!line) {
      if (consumed > 0) consumed = i + 1;
      continue;
    }
    if (!/^(stance|position|replying to|reply to|in reply to)\s*:/i.test(line)) break;
    consumed = i + 1;
  }
  // A header still arriving ("Stan…", "Stance: agrees @ad") isn't shown either.
  const rest = lines.slice(consumed).join("\n");
  const head = rest.trim().toLowerCase();
  if (
    consumed === 0 &&
    !rest.includes("\n") &&
    ["stance:", "position:", "replying to:"].some((k) => k.startsWith(head) || head.startsWith(k))
  )
    return "";
  return rest.trimStart();
}

// ── New topic ────────────────────────────────────────────────────────────────

/** Moves a seat in the speaking order (arrows, drag). */
export function moveSeat<T>(order: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order;
  const next = [...order];
  const [x] = next.splice(from, 1);
  if (x !== undefined) next.splice(to, 0, x);
  return next;
}

/** An agent joins after the last agent (seated people keep their places). */
export function addAgentSeat(order: ForumSeat[], agentId: string): ForumSeat[] {
  if (order.some((s) => s.type === "agent" && s.id === agentId)) return order;
  const lastAgent = order.map((s) => s.type).lastIndexOf("agent");
  const next = [...order];
  next.splice(lastAgent + 1, 0, { type: "agent", id: agentId });
  return next;
}

/** A person sits down at the end, or stands up. */
export function toggleSeat(order: ForumSeat[], userId: string): ForumSeat[] {
  return order.some((s) => s.type === "person" && s.id === userId)
    ? order.filter((s) => !(s.type === "person" && s.id === userId))
    : [...order, { type: "person", id: userId }];
}

/** The create input's table: agents in order, and the seats only when people sat down. */
export function tableInput(order: ForumSeat[]) {
  const agentIds = order.filter((s) => s.type === "agent").map((s) => s.id);
  const seated = order.some((s) => s.type === "person");
  return { agentIds, ...(seated ? { seats: order } : {}) };
}

export type DeadlineChoice = "none" | "today" | "tomorrow" | "friday";

/** The deadline presets at 18:00 local ("Hoje, 18h" only before 17:00); Friday is the coming one. */
export function deadlineChoices(now = new Date()): { key: DeadlineChoice; at: Date | null }[] {
  const at18 = (d: Date) => {
    const x = new Date(d);
    x.setHours(18, 0, 0, 0);
    return x;
  };
  const today = at18(now);
  const tomorrow = at18(new Date(now.getTime() + 86_400_000));
  const toFriday = (5 - now.getDay() + 7) % 7 || 7;
  const friday = at18(new Date(now.getTime() + toFriday * 86_400_000));
  const out: { key: DeadlineChoice; at: Date | null }[] = [{ key: "none", at: null }];
  if (now.getHours() < 17) out.push({ key: "today", at: today });
  out.push({ key: "tomorrow", at: tomorrow });
  if (toFriday > 1) out.push({ key: "friday", at: friday });
  return out;
}
