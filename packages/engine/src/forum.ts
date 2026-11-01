import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { type ArtifactDeps, createArtifact, updateArtifact } from "./artifacts";
import { audienceError, canTalkTo, talksToAgents } from "./audience";
import { recordAudit } from "./audit";
import { runBrainOf } from "./brains/select";
import { caches } from "./cache";
import { requireChannelAccess } from "./channels";
import { createAgentRuns } from "./dispatch";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated, publishOrgEvent, publishUserEvent } from "./events";
import {
  FORUM_FORMATS,
  type ForumFormat,
  type ForumStance,
  type ForumSuggestedIssue,
  type ForumSynthesis,
  type OwnerResolver,
  parseSynthesis,
  splitStance,
  synthesisPrompt,
  synthesisSummary,
  turnPrompt,
} from "./forum-synthesis";
import { agentBudgetState } from "./gateway";
import { createIssue, getIssue, recordIssueForumEvent } from "./issues";
import { getMessage, insertMessageWithRuns, type Message, messageView } from "./messages";
import { notifyForumSynthesis, notifyForumTurn, resolveForumTurns } from "./notification-producers";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { agentSpendThisMonth, effectiveAgentBudget } from "./usage";

export {
  type ForumFormat,
  type ForumOwner,
  type ForumStance,
  type ForumSuggestedIssue,
  type ForumSynthesis,
  parseSuggestedIssues,
  parseSynthesis,
  splitStance,
} from "./forum-synthesis";

import { cutText } from "./format";

const { forumTopics, forumParticipants, forumTurns, channels, channelMembers, messages, agentRuns, agents } = schema;

export type ForumStatus = "open" | "stalled" | "done" | "canceled";
export type ForumPhase = "discussing" | "waiting_person" | "synthesizing" | "finished";
type TopicRow = typeof forumTopics.$inferSelect;
type ParticipantRow = typeof forumParticipants.$inferSelect;
type TurnRow = typeof forumTurns.$inferSelect;

export const FORUM_LIMITS = { maxAgents: 8, maxRounds: 10, defaultRounds: 3, postChars: 20_000, maxSeatedPeople: 8 };

export interface ForumDeps {
  db: Database;
  pubsub?: PubSub;
  /** For the synthesis document. */
  artifacts?: ArtifactDeps;
}

/** A place at the table: agents and the people who sat down, in speaking order. */
export interface ForumSeat {
  type: "agent" | "person";
  id: string;
}

/**
 * How a seat's turn in a round went (the round track):
 * `spoke`, `skipped_budget` (the agent's own budget was out), `passed` (a
 * seated person passed), `skipped` (the round ended early, the deadline, or
 * not chosen for a new round), `stopped` / `failed` (the turn that left the
 * topic stalled), `live` (writing now), `waiting` (a seated person's turn)
 * and `pending` (to come).
 */
export type ForumTrackStatus =
  | "spoke"
  | "skipped_budget"
  | "passed"
  | "skipped"
  | "stopped"
  | "failed"
  | "live"
  | "waiting"
  | "pending";

export interface ForumTrack {
  rounds: {
    round: number;
    /** People's free posts that lead this round (not seated turns). */
    personPosts: { userId: string; postId: string | null; length: number }[];
    entries: { seat: ForumSeat; status: ForumTrackStatus; postId: string | null; length: number }[];
  }[];
  /** The synthesis at the end: being written, written, or stopped. */
  synthesis: { agentId: string | null; status: "live" | "done" | "stalled"; revision: number } | null;
}

export type ForumOriginKind = "direct" | "channel" | "agent" | "suggestion" | "issue" | "routine";

export interface ForumOriginView {
  kind: ForumOriginKind;
  channelId: string | null;
  messageId: string | null;
  issueId: string | null;
  issueNumber: number | null;
  routineId: string | null;
  /** The agent that opened it when asked (`agent`) or suggested it (`suggestion`). */
  agentId: string | null;
}

/** One synthesis written (version 2+ after a new round asked from a comment). */
export interface ForumSynthesisVersion {
  revision: number;
  artifactId: string | null;
  artifactVersion: number | null;
  agentId: string;
  format: ForumFormat;
  afterRound: number;
  createdAt: string;
  structured: ForumSynthesis;
  markdown: string;
}

export interface ForumSynthesisView {
  /** The Drive document (null when it couldn't be written). */
  artifactId: string | null;
  /** The document's version. */
  version: number;
  /** Which synthesis this is: 1, then 2… after each reopening. */
  revision: number;
  format: ForumFormat;
  suggestedIssues: ForumSuggestedIssue[];
  /** The cards: decision (decision, pros/cons, open questions, next steps) or plan (objective, steps…). */
  structured: ForumSynthesis | null;
  /** The synthesis file was deleted (the app shows "File removed"). */
  deleted?: boolean;
  versions: {
    revision: number;
    artifactVersion: number | null;
    createdAt: string;
    afterRound: number;
    changes: string[];
  }[];
  createdIssues: { id: string; number: number; title: string }[];
}

/** The app's `ForumTopic`. No money: everyone in the org reads the forum (ADR 0026). */
export interface ForumTopicView {
  id: string;
  title: string;
  goal: string;
  status: ForumStatus;
  phase: ForumPhase;
  format: ForumFormat;
  round: number;
  rounds: number;
  agentIds: string[];
  userIds: string[];
  /** The speaking order: agents and seated people. */
  seats: ForumSeat[];
  createdBy: { type: "person" | "agent"; id: string };
  origin: ForumOriginView;
  originChannelId: string | null;
  /** "Responsável": who set up the table; runs run on their behalf. */
  responsibleUserId: string | null;
  /** "Pedido de": who asked for it (e.g. the origin issue's author). */
  requestedByUserId: string | null;
  /** Writes the synthesis. */
  ownerAgentId: string | null;
  deadline: string | null;
  /** The seated person whose turn it is ("Sua vez"). */
  waitingUserId: string | null;
  stall: {
    reason: "stopped" | "failed";
    byUserId: string | null;
    agentId: string | null;
    round: number;
    synthesis: boolean;
    at: string;
  } | null;
  reopened: { byUserId: string; at: string } | null;
  /** The topic's own channel: subscribe to it for live runs. */
  channelId: string;
  createdAt: string;
  lastActivityAt: string;
  activeAgentIds: string[];
  track: ForumTrack;
  synthesis: ForumSynthesisView | null;
}

export type ForumPostKind = "turn" | "free" | "seat" | "comment" | "synthesis";

export interface ForumPostView {
  id: string;
  topicId: string;
  round: number;
  author: { type: "person" | "agent"; id: string };
  body: string;
  agentRunId: string | null;
  /** `turn` (an agent's turn), `free` (an agent outside its turn, or a person's post that leads the next round), `seat` (a seated person's turn), `comment` (on a concluded topic) or `synthesis`. */
  kind: ForumPostKind;
  stance: ForumStance | null;
  replyTo: string | null;
  position: string | null;
  /** A person's post asked for one more round (these agents, or all). */
  requestRound?: { agentIds: string[] | null };
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface ForumTopicDetail extends ForumTopicView {
  posts: ForumPostView[];
  /** Every synthesis written, oldest first. */
  syntheses: ForumSynthesisVersion[];
}

/** What each message of a topic's channel carries in `meta.forum`. */
interface ForumMeta {
  topicId: string;
  round: number;
  /** The worker's "your turn" message (hidden from posts). */
  kickoff?: boolean;
  synthesis?: boolean;
  /** A seated person's turn. */
  seat?: boolean;
  /** A comment on a concluded topic (no new round). */
  after?: boolean;
  requestRound?: { agentIds: string[] | null };
  stance?: ForumStance | null;
  replyTo?: string | null;
  position?: string | null;
}

const forumMeta = (m: { meta: Record<string, unknown> }) => m.meta.forum as ForumMeta | undefined;
const asFormat = (f: string): ForumFormat => (f === "plan" ? "plan" : "decision");
const canceledByUser = (error: string | null | undefined) =>
  error?.startsWith("canceled_by:") ? error.slice("canceled_by:".length) : null;

// ── Seats ────────────────────────────────────────────────────────────────────

/** The speaking order: agents by seat (else position), mixed with the people who sat down. */
export function seatsOf(parts: ParticipantRow[]): ForumSeat[] {
  const placed: { seat: ForumSeat; key: number; at: number }[] = [];
  for (const p of parts) {
    if (p.agentId)
      placed.push({ seat: { type: "agent", id: p.agentId }, key: p.seat ?? p.position, at: p.createdAt.getTime() });
    else if (p.userId && p.seat !== null)
      placed.push({ seat: { type: "person", id: p.userId }, key: p.seat, at: p.createdAt.getTime() });
  }
  return placed.sort((a, b) => a.key - b.key || a.at - b.at).map((s) => s.seat);
}

const sameSeat = (a: ForumSeat, t: { seatType: string; seatId: string }) => a.type === t.seatType && a.id === t.seatId;

/**
 * Agents whose own monthly budget is used up (the same counter the gateway
 * reserves against). An agent whose runs think with a computer brain (Claude
 * Code, Codex) runs on the person's plan, not the budget: it keeps its turn.
 * The brain is the one its latest run thought with (`agent_runs.brain`, ADR
 * 0053 §10): while its computer is away its runs fall back to the model, and
 * then the budget counts.
 */
async function agentsOutOfBudget(db: Database, orgId: string, agentIds: string[], now: Date) {
  const out = new Set<string>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({
      agent: agents,
      lastBrain: sql<string | null>`(select r.brain from ${agentRuns} r
        where r.org_id = ${agents.orgId} and r.agent_id = ${agents.id} and r.brain is not null
        order by r.created_at desc limit 1)`,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)));
  for (const { agent: a, lastBrain } of rows) {
    if (runBrainOf({ brain: lastBrain }, a) !== "model") continue;
    const budget = await effectiveAgentBudget(db, a);
    const state = await agentBudgetState(db, orgId, a.id, now);
    // No counter row yet this month: the gateway starts it from the recorded usage.
    const spent = state.spentNanoUsd || (await agentSpendThisMonth(db, orgId, a.id, now));
    if (spent + state.reservedNanoUsd >= budget) out.add(a.id);
  }
  return out;
}

// ── Reading ──────────────────────────────────────────────────────────────────

async function participantsOf(db: Executor, topicIds: string[]): Promise<ParticipantRow[]> {
  if (topicIds.length === 0) return [];
  return db
    .select()
    .from(forumParticipants)
    .where(inArray(forumParticipants.topicId, topicIds))
    .orderBy(asc(forumParticipants.position), asc(forumParticipants.createdAt));
}

async function turnsOf(db: Executor, topicIds: string[]): Promise<TurnRow[]> {
  if (topicIds.length === 0) return [];
  return db
    .select()
    .from(forumTurns)
    .where(inArray(forumTurns.topicId, topicIds))
    .orderBy(asc(forumTurns.createdAt), asc(forumTurns.id));
}

const ended = (r: TopicRow) => r.status === "done" || r.status === "canceled";

/** The round track: for each round, how each seat's turn went (from the turn log and the topic's state). */
export function buildTrack(
  r: TopicRow,
  seats: ForumSeat[],
  turns: TurnRow[],
  posts: ForumPostView[] = [],
  liveRunActive = false,
): ForumTrack {
  const lastRound = ended(r) ? Math.max(1, r.round) : Math.max(1, r.maxRounds, r.round);
  const rounds: ForumTrack["rounds"] = [];
  const stall = r.stall as { synthesis?: boolean } | null;
  for (let round = 1; round <= lastRound; round++) {
    const personPosts = turns
      .filter((t) => t.kind === "person_post" && Math.min(t.round, lastRound) === round)
      .map((t) => ({ userId: t.seatId, postId: t.messageId, length: t.length }));
    const only = r.roundSpeakers && r.roundSpeakers.round === round ? r.roundSpeakers.agentIds : null;
    const entries = seats.map((seat, i) => {
      const logged = turns.filter(
        (t) => t.round === round && sameSeat(seat, t) && t.kind !== "person_post" && t.kind !== "synthesis",
      );
      const last = logged.at(-1);
      const current = r.status === "open" && round === r.round && i === r.turn;
      // The turn in progress wins over an earlier stopped attempt of it (resumed).
      if (current && r.phase === "discussing" && r.currentRunId && liveRunActive)
        return { seat, status: "live" as const, postId: null, length: 0 };
      if (current && r.phase === "waiting_person" && r.waitingUserId === seat.id)
        return { seat, status: "waiting" as const, postId: null, length: 0 };
      if (last) return { seat, status: last.kind as ForumTrackStatus, postId: last.messageId, length: last.length };
      // Topics from before the turn log: an agent's post in that round counts as its turn.
      const post = posts.find(
        (p) => p.round === round && p.kind === "turn" && p.author.type === seat.type && p.author.id === seat.id,
      );
      if (post) return { seat, status: "spoke" as const, postId: post.id, length: post.body.length };
      const passed = ended(r) || round < r.round || (round === r.round && i < r.turn);
      const status: ForumTrackStatus =
        (only && (seat.type === "person" || !only.includes(seat.id))) || passed ? "skipped" : "pending";
      return { seat, status, postId: null, length: 0 };
    });
    rounds.push({ round, personPosts, entries });
  }
  const written = turns.filter((t) => t.kind === "synthesis");
  const synthesis: ForumTrack["synthesis"] =
    r.phase === "synthesizing" && r.status === "open"
      ? { agentId: null, status: "live", revision: written.length + 1 }
      : r.status === "stalled" && stall?.synthesis
        ? { agentId: null, status: "stalled", revision: written.length + 1 }
        : written.length > 0 && r.status === "done"
          ? { agentId: written.at(-1)?.seatId ?? null, status: "done", revision: written.length }
          : null;
  return { rounds, synthesis };
}

function synthesisView(r: TopicRow, deleted: boolean): ForumSynthesisView | null {
  const history = r.syntheses as unknown as ForumSynthesisVersion[];
  const last = history.at(-1);
  if (!last && !r.synthesisArtifactId) return null;
  return {
    artifactId: last?.artifactId ?? r.synthesisArtifactId,
    version: last?.artifactVersion ?? r.synthesisVersion ?? 1,
    revision: last?.revision ?? 1,
    format: last?.format ?? asFormat(r.format),
    suggestedIssues: r.suggestedIssues as unknown as ForumSuggestedIssue[],
    structured: last?.structured ?? null,
    ...(deleted ? { deleted: true } : { deleted: false }),
    versions: history.map((h) => ({
      revision: h.revision,
      artifactVersion: h.artifactVersion,
      createdAt: h.createdAt,
      afterRound: h.afterRound,
      changes: h.structured.changes ?? [],
    })),
    createdIssues: r.createdIssues,
  };
}

async function views(db: Database, rows: TopicRow[], postsByTopic?: Map<string, ForumPostView[]>) {
  const ids = rows.map((r) => r.id);
  const [parts, turns] = await Promise.all([participantsOf(db, ids), turnsOf(db, ids)]);
  const running = rows.flatMap((r) => (r.currentRunId ? [r.currentRunId] : []));
  const active = running.length
    ? await db
        .select({ id: agentRuns.id, agentId: agentRuns.agentId })
        .from(agentRuns)
        .where(
          and(inArray(agentRuns.id, running), inArray(agentRuns.status, ["queued", "running", "waiting_approval"])),
        )
    : [];
  const fileIds = rows.flatMap((r) => (r.synthesisArtifactId ? [r.synthesisArtifactId] : []));
  const deletedFiles = new Set(
    fileIds.length
      ? (
          await db
            .select({ id: schema.artifacts.id })
            .from(schema.artifacts)
            .where(and(inArray(schema.artifacts.id, fileIds), sql`${schema.artifacts.deletedAt} is not null`))
        ).map((a) => a.id)
      : [],
  );
  const issueIds = rows.flatMap((r) => (r.originIssueId ? [r.originIssueId] : []));
  const issueNumbers = new Map(
    issueIds.length
      ? (
          await db
            .select({ id: schema.issues.id, number: schema.issues.number })
            .from(schema.issues)
            .where(inArray(schema.issues.id, issueIds))
        ).map((i) => [i.id, i.number])
      : [],
  );
  return rows.map((r): ForumTopicView => {
    const mine = parts.filter((p) => p.topicId === r.id);
    const seats = seatsOf(mine);
    const agentIds = seats.flatMap((s) => (s.type === "agent" ? [s.id] : []));
    const live = active.filter((a) => a.id === r.currentRunId);
    const stall = r.stall as {
      reason?: string;
      byUserId?: string | null;
      agentId?: string | null;
      round?: number;
      synthesis?: boolean;
      at?: string;
    } | null;
    return {
      id: r.id,
      title: r.title,
      goal: r.goal,
      status: r.status as ForumStatus,
      phase: r.phase as ForumPhase,
      format: asFormat(r.format),
      round: Math.max(1, Math.min(r.round, r.maxRounds)),
      rounds: r.maxRounds,
      agentIds,
      userIds: mine.flatMap((p) => (p.userId ? [p.userId] : [])),
      seats,
      createdBy: { type: r.createdByType as "person" | "agent", id: r.createdById },
      origin: {
        kind: r.originKind as ForumOriginKind,
        channelId: r.originChannelId,
        messageId: r.originMessageId,
        issueId: r.originIssueId,
        issueNumber: r.originIssueId ? (issueNumbers.get(r.originIssueId) ?? null) : null,
        routineId: r.originRoutineId,
        agentId: r.suggestedByAgentId ?? (r.createdByType === "agent" ? r.createdById : null),
      },
      originChannelId: r.originChannelId,
      responsibleUserId: r.requesterUserId,
      requestedByUserId: r.requestedByUserId ?? r.requesterUserId,
      ownerAgentId: r.ownerAgentId && agentIds.includes(r.ownerAgentId) ? r.ownerAgentId : (agentIds[0] ?? null),
      deadline: r.deadline?.toISOString() ?? null,
      waitingUserId: r.phase === "waiting_person" ? r.waitingUserId : null,
      stall:
        r.status === "stalled" && stall
          ? {
              reason: stall.reason === "failed" ? "failed" : "stopped",
              byUserId: stall.byUserId ?? null,
              agentId: stall.agentId ?? null,
              round: stall.round ?? r.round,
              synthesis: stall.synthesis === true,
              at: stall.at ?? r.updatedAt.toISOString(),
            }
          : null,
      reopened:
        r.reopenedByUserId && r.reopenedAt ? { byUserId: r.reopenedByUserId, at: r.reopenedAt.toISOString() } : null,
      channelId: r.channelId,
      createdAt: r.createdAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      activeAgentIds: live.map((a) => a.agentId),
      track: buildTrack(
        r,
        seats,
        turns.filter((t) => t.topicId === r.id),
        postsByTopic?.get(r.id),
        live.length > 0,
      ),
      synthesis: synthesisView(r, r.synthesisArtifactId ? deletedFiles.has(r.synthesisArtifactId) : false),
    };
  });
}

/** Messages of the topic's channel as posts: one per agent run (its messages joined), kickoffs hidden. */
export function postsOf(topicId: string, rows: Message[]): ForumPostView[] {
  const posts: ForumPostView[] = [];
  const byRun = new Map<string, ForumPostView>();
  // Agents' replies belong to the turn (kickoff) before them.
  let current = 0;
  let synthesis = false;
  for (const m of rows) {
    const meta = forumMeta(m);
    if (meta?.kickoff) {
      current = meta.round;
      synthesis = meta.synthesis === true;
      continue;
    }
    const round = meta?.round ?? current;
    if (m.authorType === "agent" && m.agentRunId) {
      const existing = byRun.get(m.agentRunId);
      if (existing) {
        existing.body = `${existing.body}\n\n${m.body}`.trim();
        if (m.meta.work) existing.meta = { ...existing.meta, work: m.meta.work };
        continue;
      }
    }
    const isAgent = m.authorType === "agent";
    const kind: ForumPostKind = isAgent
      ? m.agentRunId
        ? synthesis
          ? "synthesis"
          : "turn"
        : "free"
      : meta?.seat
        ? "seat"
        : meta?.after
          ? "comment"
          : "free";
    // The stance header: parsed when the turn ended (meta), or here for older posts.
    const header =
      kind === "turn" && meta?.stance === undefined
        ? splitStance(m.body)
        : { body: m.body, stance: null, replyTo: null, position: null };
    const stance: ForumStance | null =
      meta?.stance ??
      (header.stance
        ? {
            kind: header.stance.kind,
            ...(header.stance.handle
              ? { target: { type: "agent" as const, handle: header.stance.handle } }
              : header.stance.people
                ? { target: { type: "people" as const } }
                : {}),
          }
        : null);
    const post: ForumPostView = {
      id: m.id,
      topicId,
      round,
      author: {
        type: m.authorType,
        id: (m.authorType === "person" ? m.authorUserId : m.authorAgentId) ?? "",
      },
      body: header.body,
      agentRunId: m.agentRunId,
      kind,
      stance,
      replyTo: meta?.replyTo ?? (header.replyTo && !header.replyTo.startsWith("@") ? header.replyTo : null),
      position: meta?.position ?? header.position,
      ...(meta?.requestRound ? { requestRound: meta.requestRound } : {}),
      // `work`: the run's tool work (`meta.work`), for the post's "Usou N ferramentas" block.
      ...(kind === "synthesis" || m.meta.work
        ? {
            meta: {
              ...(kind === "synthesis" ? { synthesis: true } : {}),
              ...(m.meta.work ? { work: m.meta.work } : {}),
            },
          }
        : {}),
      createdAt: m.createdAt.toISOString(),
    };
    if (isAgent && m.agentRunId) byRun.set(m.agentRunId, post);
    posts.push(post);
  }
  return posts;
}

async function loadTopic(db: Executor, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(forumTopics)
    .where(and(eq(forumTopics.id, id), eq(forumTopics.orgId, orgId)));
  if (!row) throw new NotFoundError("Topic not found");
  return row;
}

async function channelMessages(db: Executor, orgId: string, channelId: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(2000);
  return rows as unknown as Message[];
}

/** Topics of the organization (every member reads the forum). */
export async function listForumTopics(
  db: Database,
  actorId: string,
  orgId: string,
  filters: { status?: ForumStatus; mine?: boolean; agentId?: string } = {},
) {
  await requirePermission(db, actorId, orgId, "read");
  const conditions: (SQL | undefined)[] = [
    eq(forumTopics.orgId, orgId),
    filters.status ? eq(forumTopics.status, filters.status) : undefined,
    filters.mine
      ? sql`(${forumTopics.requesterUserId} = ${actorId} or ${forumTopics.requestedByUserId} = ${actorId}
          or exists (select 1 from ${forumParticipants} p where p.topic_id = ${forumTopics.id} and p.user_id = ${actorId}))`
      : undefined,
    filters.agentId
      ? sql`exists (select 1 from ${forumParticipants} p where p.topic_id = ${forumTopics.id} and p.agent_id = ${filters.agentId}::uuid)`
      : undefined,
  ];
  const rows = await db
    .select()
    .from(forumTopics)
    .where(and(...conditions))
    .orderBy(desc(forumTopics.lastActivityAt))
    .limit(200);
  return views(db, rows);
}

export async function getForumTopic(
  db: Database,
  actorId: string,
  orgId: string,
  id: string,
): Promise<ForumTopicDetail> {
  await requirePermission(db, actorId, orgId, "read");
  return forumTopicDetail(db, orgId, id);
}

/** A topic with its posts, no permission check (callers: the API after its check, agents' tools). */
export async function forumTopicDetail(db: Database, orgId: string, id: string): Promise<ForumTopicDetail> {
  const row = await loadTopic(db, orgId, id);
  const posts = postsOf(row.id, await channelMessages(db, orgId, row.channelId));
  const [view] = await views(db, [row], new Map([[row.id, posts]]));
  return { ...(view as ForumTopicView), posts, syntheses: row.syntheses as unknown as ForumSynthesisVersion[] };
}

// ── Creating ─────────────────────────────────────────────────────────────────

export type ForumOriginInput =
  /** "Avaliar no fórum" from an issue: its author is "Pedido de"; the result comes back to it. */
  | { kind: "issue"; issueId: string }
  /** From a thread ("Levar ao fórum"): the synthesis comes back to that thread. */
  | { kind: "channel"; messageId: string }
  | { kind: "routine"; routineId: string }
  /** An agent's suggestion card a person accepted. */
  | { kind: "suggestion"; agentId: string; channelId: string; messageId: string };

export interface ForumTopicInput {
  title: string;
  goal: string;
  agentIds: string[];
  userIds?: string[];
  rounds?: number;
  deadline?: Date | null;
  ownerAgentId?: string | null;
  /** `decision` (default) or `plan`. */
  format?: ForumFormat;
  /** The speaking order, agents and seated people mixed (default: the agents in `agentIds` order). */
  seats?: ForumSeat[];
  origin?: ForumOriginInput;
}

export type ForumCreator =
  | { type: "person"; userId: string }
  /** An agent from a conversation (a person asked it): `requesterUserId` is the person behind it. */
  | {
      type: "agent";
      agentId: string;
      requesterUserId: string;
      originChannelId?: string | null;
      originMessageId?: string | null;
    };

const topicEvent = (deps: ForumDeps, orgId: string, event: Record<string, unknown> & { type: string }) =>
  publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event });

/** The full table order: the given seats (agents and people), then any agent not placed. */
function tableOrder(agentIds: string[], seats: ForumSeat[] | undefined): ForumSeat[] {
  const out: ForumSeat[] = [];
  const seen = new Set<string>();
  for (const s of seats ?? []) {
    const key = `${s.type}:${s.id}`;
    if (seen.has(key)) continue;
    if (s.type === "agent" && !agentIds.includes(s.id))
      throw new ValidationError("A seat is for an agent not in the topic", "forum.unknown_agent");
    seen.add(key);
    out.push(s);
  }
  for (const a of agentIds) if (!seen.has(`agent:${a}`)) out.push({ type: "agent", id: a });
  return out;
}

/**
 * Opens a topic: its channel (kind `forum`, everyone in the org reads it),
 * participants and seats, and round 1 (queued). Agents must answer the
 * responsible person; at most 8 agents and 10 rounds. No spend cap of
 * its own: each agent runs on its own budget.
 */
export async function createForumTopic(
  deps: ForumDeps,
  creator: ForumCreator,
  orgId: string,
  input: ForumTopicInput,
): Promise<ForumTopicDetail> {
  const { db } = deps;
  const requester = creator.type === "person" ? creator.userId : creator.requesterUserId;
  await requirePermission(db, requester, orgId, "post");
  const title = input.title.trim().slice(0, 200);
  const goal = input.goal.trim().slice(0, 5000);
  if (!title) throw new ValidationError("Give the topic a title", "forum.title_required");
  if (!goal) throw new ValidationError("Say what the forum should decide or answer", "forum.goal_required");
  const format = input.format ?? "decision";
  if (!FORUM_FORMATS.includes(format)) throw new ValidationError("Unknown format", "forum.invalid_format");
  const agentIds = [
    ...new Set([...input.agentIds, ...(input.seats ?? []).flatMap((s) => (s.type === "agent" ? [s.id] : []))]),
  ];
  if (agentIds.length === 0) throw new ValidationError("Pick at least one agent", "forum.agents_required");
  if (agentIds.length > FORUM_LIMITS.maxAgents)
    throw new ValidationError("At most 8 agents per topic", "forum.too_many_agents", { max: 8 });
  const rounds = Math.min(FORUM_LIMITS.maxRounds, Math.max(1, Math.round(input.rounds ?? FORUM_LIMITS.defaultRounds)));
  const order = tableOrder(agentIds, input.seats);
  const seatedPeople = order.flatMap((s) => (s.type === "person" ? [s.id] : []));
  if (seatedPeople.length > FORUM_LIMITS.maxSeatedPeople)
    throw new ValidationError("At most 8 people at the table", "forum.too_many_seats", { max: 8 });
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds), isNull(agents.archivedAt)));
  if (rows.length !== agentIds.length)
    throw new ValidationError("An agent isn't in this organization", "forum.unknown_agent");
  const talks = await talksToAgents(db, orgId, requester);
  for (const a of rows) {
    if (!canTalkTo(a, requester, talks)) throw await audienceError(db, a);
  }
  const userIds = [...new Set([requester, ...(input.userIds ?? []), ...seatedPeople])];
  const members = await db
    .select({ userId: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), inArray(schema.organizationMembers.userId, userIds)));
  if (members.length !== userIds.length)
    throw new ValidationError("Everyone must be in the organization", "forum.unknown_person");
  const ownerAgentId = input.ownerAgentId && agentIds.includes(input.ownerAgentId) ? input.ownerAgentId : null;

  // Where it came from: the issue, the thread, the routine or the suggestion card.
  let originKind: ForumOriginKind = creator.type === "agent" ? "agent" : "direct";
  let originChannelId = creator.type === "agent" ? (creator.originChannelId ?? null) : null;
  let originMessageId = creator.type === "agent" ? (creator.originMessageId ?? null) : null;
  let originIssueId: string | null = null;
  let originRoutineId: string | null = null;
  let suggestedByAgentId: string | null = null;
  let requestedByUserId: string | null = null;
  let issueNumber: number | null = null;
  const origin = input.origin;
  if (origin?.kind === "issue") {
    const issue = await getIssue(db, { type: "person", userId: requester }, orgId, { id: origin.issueId });
    originKind = "issue";
    originIssueId = issue.id;
    issueNumber = issue.number;
    requestedByUserId = issue.createdBy.type === "person" ? issue.createdBy.id : null;
  } else if (origin?.kind === "channel") {
    const message = await getMessage(db, orgId, origin.messageId);
    if (!message || message.deletedAt) throw new NotFoundError("Message not found");
    await requireChannelAccess(db, requester, orgId, message.channelId);
    originKind = "channel";
    originChannelId = message.channelId;
    originMessageId = message.threadId ?? message.id;
    requestedByUserId = message.authorType === "person" ? message.authorUserId : null;
  } else if (origin?.kind === "routine") {
    originKind = "routine";
    originRoutineId = origin.routineId;
  } else if (origin?.kind === "suggestion") {
    originKind = "suggestion";
    suggestedByAgentId = origin.agentId;
    originChannelId = origin.channelId;
    originMessageId = origin.messageId;
  }
  if (requestedByUserId === requester) requestedByUserId = null;

  const topic = await db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        orgId,
        name: `forum-${crypto.randomUUID().slice(0, 12)}`,
        topic: title,
        visibility: "public",
        kind: "forum",
        createdByUserId: requester,
      })
      .returning();
    if (!channel) throw new Error("forum channel insert returned nothing");
    await tx
      .insert(channelMembers)
      .values([
        ...userIds.map((userId) => ({ orgId, channelId: channel.id, userId })),
        ...agentIds.map((agentId) => ({ orgId, channelId: channel.id, agentId })),
      ]);
    const [row] = await tx
      .insert(forumTopics)
      .values({
        orgId,
        channelId: channel.id,
        title,
        goal,
        maxRounds: rounds,
        deadline: input.deadline ?? null,
        format,
        createdByType: creator.type,
        createdById: creator.type === "person" ? creator.userId : creator.agentId,
        requesterUserId: requester,
        requestedByUserId,
        ownerAgentId,
        originKind,
        originChannelId,
        originMessageId,
        originIssueId,
        originRoutineId,
        suggestedByAgentId,
      })
      .returning();
    if (!row) throw new Error("forum topic insert returned nothing");
    const agentOrder = order.flatMap((s) => (s.type === "agent" ? [s.id] : []));
    await tx.insert(forumParticipants).values([
      ...agentOrder.map((agentId, position) => ({
        orgId,
        topicId: row.id,
        agentId,
        position,
        seat: order.findIndex((s) => s.type === "agent" && s.id === agentId),
      })),
      ...userIds.map((userId) => {
        const seat = order.findIndex((s) => s.type === "person" && s.id === userId);
        return { orgId, topicId: row.id, userId, seat: seat >= 0 ? seat : null };
      }),
    ]);
    await enqueue(tx, {
      orgId,
      kind: "forum.advance",
      payload: { topicId: row.id },
      dedupeKey: `forum.advance:${row.id}:start`,
    });
    if (row.deadline) await enqueueDeadline(tx, row);
    await recordAudit(tx, {
      orgId,
      actor: creator.type === "person" ? { type: "person", id: requester } : { type: "agent", id: creator.agentId },
      action: "forum.topic_created",
      target: { type: "forum_topic", id: row.id },
      details: { agents: agentIds, rounds, format, seats: order, origin: originKind },
    });
    return row;
  });
  caches.channels.delete(`${orgId}:${topic.channelId}`);
  if (originIssueId) {
    await recordIssueForumEvent(
      { db, pubsub: deps.pubsub },
      orgId,
      originIssueId,
      { type: "person", id: requester },
      "forum_opened",
      {
        topicId: topic.id,
        title,
      },
    ).catch(() => null);
  }
  if (requestedByUserId) {
    await publishUserEvent(deps.pubsub, orgId, requestedByUserId, {
      type: "forum.requested",
      topicId: topic.id,
      title,
      byUserId: requester,
      ...(issueNumber ? { issueNumber } : {}),
    });
  }
  await topicEvent(deps, orgId, { type: "forum.topic.updated", topicId: topic.id, status: "open", round: 0 });
  return getForumTopic(db, requester, orgId, topic.id);
}

/** The deadline moves the topic on by itself (a seated person's turn is skipped, then the synthesis). */
async function enqueueDeadline(db: Executor, topic: Pick<TopicRow, "id" | "orgId" | "deadline">) {
  if (!topic.deadline) return;
  await enqueue(db, {
    orgId: topic.orgId,
    kind: "forum.advance",
    payload: { topicId: topic.id },
    dedupeKey: `forum.advance:${topic.id}:deadline:${topic.deadline.getTime()}`,
    runAt: topic.deadline,
  });
}

// ── People in a topic ────────────────────────────────────────────────────────

async function requireTopicManager(db: Database, actorId: string, orgId: string, topic: TopicRow) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  if (can(membership, "manage_agents") || topic.requesterUserId === actorId) return;
  const [p] = await db
    .select({ id: forumParticipants.id })
    .from(forumParticipants)
    .where(and(eq(forumParticipants.topicId, topic.id), eq(forumParticipants.userId, actorId)));
  if (!p) throw new ForbiddenError("Only who opened it, a participant or an admin can do this", "forum.manager_only");
}

export interface ForumPostOptions {
  /** One more round from this post (these agents, or all); reopens a concluded topic. */
  requestRound?: { agentIds?: string[] | null } | null;
  /** The post this one answers. */
  replyTo?: string | null;
}

async function postMessage(deps: ForumDeps, topic: TopicRow, userId: string, text: string, meta: ForumMeta) {
  const { message } = await insertMessageWithRuns(
    deps.db,
    {
      orgId: topic.orgId,
      channelId: topic.channelId,
      author: { type: "person", userId },
      body: text,
      meta: { forum: meta },
    },
    { startRuns: false },
  );
  return message;
}

async function announcePost(deps: ForumDeps, topicId: string, orgId: string, message: Message) {
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  const [post] = postsOf(topicId, [message]);
  await topicEvent(deps, orgId, { type: "forum.post.created", topicId, post });
  return post as ForumPostView;
}

/**
 * A person writes in the topic.
 * - A seated person in their turn ("Sua vez"): the post is their turn.
 * - Anyone else, any time: it takes priority. The round in progress ends
 *   after the current turn, and the next round starts from it.
 * - `requestRound`: at the last round, one more round instead of the
 *   synthesis; on a concluded topic, it reopens with one round (only the
 *   chosen agents speak) and the synthesis is rewritten as version 2.
 * - On a concluded topic without `requestRound`: a comment (no new round).
 */
export async function postInForumAsPerson(
  deps: ForumDeps,
  userId: string,
  orgId: string,
  topicId: string,
  body: string,
  options: ForumPostOptions = {},
): Promise<ForumPostView> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "post");
  const topic = await loadTopic(db, orgId, topicId);
  if (topic.status === "canceled") throw new ValidationError("This topic has ended", "forum.topic_ended");
  const text = body.trim().slice(0, FORUM_LIMITS.postChars);
  if (!text) throw new ValidationError("Write something first", "forum.empty_post");
  const replyTo = options.replyTo ?? null;
  const parts = await participantsOf(db, [topicId]);
  const topicAgents = parts.flatMap((p) => (p.agentId ? [p.agentId] : []));
  const request = options.requestRound
    ? { agentIds: options.requestRound.agentIds?.length ? [...new Set(options.requestRound.agentIds)] : null }
    : null;
  if (request?.agentIds?.some((a) => !topicAgents.includes(a)))
    throw new ValidationError("Pick agents of this topic", "forum.unknown_agent");
  // Reading the forum is open to the org; posting adds the person to the topic.
  await db.insert(channelMembers).values({ orgId, channelId: topic.channelId, userId }).onConflictDoNothing();
  await db.insert(forumParticipants).values({ orgId, topicId, userId }).onConflictDoNothing();

  if (topic.status === "done") {
    if (!request) {
      const message = await postMessage(deps, topic, userId, text, {
        topicId,
        round: Math.max(1, topic.round),
        after: true,
        replyTo,
      });
      await db.update(forumTopics).set({ lastActivityAt: new Date() }).where(eq(forumTopics.id, topicId));
      return announcePost(deps, topicId, orgId, message);
    }
    return reopenFromPost(deps, topic, userId, text, request, replyTo);
  }

  // A seated person's turn: the post is their turn.
  if (topic.status === "open" && topic.phase === "waiting_person" && topic.waitingUserId === userId) {
    const message = await postMessage(deps, topic, userId, text, {
      topicId,
      round: Math.max(1, topic.round),
      seat: true,
      replyTo,
      ...(request ? { requestRound: request } : {}),
    });
    const took = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(forumTopics).where(eq(forumTopics.id, topicId)).for("update");
      if (locked?.phase !== "waiting_person" || locked.waitingUserId !== userId) return false;
      await tx.insert(forumTurns).values({
        orgId,
        topicId,
        round: locked.round,
        seatType: "person",
        seatId: userId,
        kind: "spoke",
        messageId: message.id,
        length: text.length,
      });
      await tx
        .update(forumTopics)
        .set({
          phase: "discussing",
          waitingUserId: null,
          turn: locked.turn + 1,
          ...roundRequestPatch(locked, request),
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(forumTopics.id, topicId));
      return true;
    });
    if (took) {
      await resolveForumTurns(deps, orgId, topicId, [userId]).catch(() => {});
      await enqueue(db, {
        orgId,
        kind: "forum.advance",
        payload: { topicId },
        dedupeKey: `forum.advance:${topicId}:seat:${message.id}`,
      });
      return announcePost(deps, topicId, orgId, message);
    }
    // The turn moved on meanwhile (deadline, "Concluir"): it stays a free post below.
    return freePost(deps, await loadTopic(db, orgId, topicId), userId, message, request);
  }
  if (request && topic.round >= topic.maxRounds && topic.maxRounds >= FORUM_LIMITS.maxRounds)
    throw new ValidationError("At most 10 rounds", "forum.max_rounds", { max: FORUM_LIMITS.maxRounds });
  const message = await postMessage(deps, topic, userId, text, {
    topicId,
    round: Math.max(1, topic.round),
    replyTo,
    ...(request ? { requestRound: request } : {}),
  });
  return freePost(deps, topic, userId, message, request);
}

/** `requestRound` on an open topic: one more round at the last one; the chosen agents speak in the next. */
function roundRequestPatch(topic: TopicRow, request: { agentIds: string[] | null } | null) {
  if (!request) return {};
  const next = topic.round === 0 ? 1 : topic.round + 1;
  return {
    maxRounds: Math.min(FORUM_LIMITS.maxRounds, Math.max(topic.maxRounds, next)),
    ...(request.agentIds ? { roundSpeakers: { round: next, agentIds: request.agentIds } } : {}),
  };
}

/** A person's post outside a seated turn: it leads the next round (after the current turn). */
async function freePost(
  deps: ForumDeps,
  topic: TopicRow,
  userId: string,
  message: Message,
  request: { agentIds: string[] | null } | null,
) {
  const { db } = deps;
  const leads = topic.round === 0 ? 1 : topic.round + 1;
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(forumTopics).where(eq(forumTopics.id, topic.id)).for("update");
    if (!locked) return;
    await tx.insert(forumTurns).values({
      orgId: topic.orgId,
      topicId: topic.id,
      round: leads,
      seatType: "person",
      seatId: userId,
      kind: "person_post",
      messageId: message.id,
      length: message.body.length,
    });
    await tx
      .update(forumTopics)
      .set({
        pendingPerson: true,
        ...roundRequestPatch(locked, request),
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(forumTopics.id, topic.id));
  });
  await enqueue(db, {
    orgId: topic.orgId,
    kind: "forum.advance",
    payload: { topicId: topic.id },
    dedupeKey: `forum.advance:${topic.id}:person:${message.id}`,
  });
  return announcePost(deps, topic.id, topic.orgId, message);
}

/** A new round asked from a comment on a concluded topic: it reopens in that person's name. */
async function reopenFromPost(
  deps: ForumDeps,
  topic: TopicRow,
  userId: string,
  text: string,
  request: { agentIds: string[] | null },
  replyTo: string | null,
) {
  const { db } = deps;
  const next = Math.max(1, topic.round) + 1;
  if (next > FORUM_LIMITS.maxRounds)
    throw new ValidationError("At most 10 rounds", "forum.max_rounds", { max: FORUM_LIMITS.maxRounds });
  const message = await postMessage(deps, topic, userId, text, {
    topicId: topic.id,
    round: next,
    replyTo,
    requestRound: request,
  });
  const reopened = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(forumTopics).where(eq(forumTopics.id, topic.id)).for("update");
    if (locked?.status !== "done") return false;
    await tx.insert(forumTurns).values({
      orgId: topic.orgId,
      topicId: topic.id,
      round: next,
      seatType: "person",
      seatId: userId,
      kind: "person_post",
      messageId: message.id,
      length: text.length,
    });
    await tx
      .update(forumTopics)
      .set({
        status: "open",
        phase: "discussing",
        round: locked.round,
        turn: 0,
        maxRounds: Math.max(locked.maxRounds, next),
        pendingPerson: true,
        stopRequested: false,
        currentRunId: null,
        waitingUserId: null,
        stall: null,
        // A passed deadline would end it at once: the new round has none.
        deadline: null,
        roundSpeakers: { round: next, agentIds: request.agentIds ?? [] },
        reopenedByUserId: userId,
        reopenedAt: new Date(),
        concludedAt: null,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(forumTopics.id, topic.id));
    await recordAudit(tx, {
      orgId: topic.orgId,
      actor: { type: "person", id: userId },
      action: "forum.topic_reopened",
      target: { type: "forum_topic", id: topic.id },
      details: { round: next, agentIds: request.agentIds },
    });
    return true;
  });
  if (!reopened) throw new ConflictError("This topic changed. Reload and try again.", "forum.state_changed");
  // "Only the chosen agents": an empty list means all of them.
  if (!request.agentIds) {
    const parts = await participantsOf(db, [topic.id]);
    await db
      .update(forumTopics)
      .set({ roundSpeakers: { round: next, agentIds: parts.flatMap((p) => (p.agentId ? [p.agentId] : [])) } })
      .where(eq(forumTopics.id, topic.id));
  }
  await enqueue(db, {
    orgId: topic.orgId,
    kind: "forum.advance",
    payload: { topicId: topic.id },
    dedupeKey: `forum.advance:${topic.id}:reopen:${message.id}`,
  });
  await topicEvent(deps, topic.orgId, { type: "forum.topic.updated", topicId: topic.id, status: "open", round: next });
  return announcePost(deps, topic.id, topic.orgId, message);
}

/** A seated person passes their turn ("Passar a vez"). */
export async function passForumTurn(deps: ForumDeps, userId: string, orgId: string, topicId: string) {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "post");
  await loadTopic(db, orgId, topicId);
  const passed = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(forumTopics).where(eq(forumTopics.id, topicId)).for("update");
    if (locked?.status !== "open" || locked.phase !== "waiting_person" || locked.waitingUserId !== userId) return false;
    await tx.insert(forumTurns).values({
      orgId,
      topicId,
      round: locked.round,
      seatType: "person",
      seatId: userId,
      kind: "passed",
    });
    await tx
      .update(forumTopics)
      .set({
        phase: "discussing",
        waitingUserId: null,
        turn: locked.turn + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(forumTopics.id, topicId));
    return true;
  });
  if (!passed) throw new ValidationError("It isn't your turn", "forum.not_your_turn");
  await resolveForumTurns(deps, orgId, topicId, [userId]).catch(() => {});
  await enqueue(db, {
    orgId,
    kind: "forum.advance",
    payload: { topicId },
    dedupeKey: `forum.advance:${topicId}:pass:${userId}:${Date.now()}`,
  });
  return getForumTopic(db, userId, orgId, topicId);
}

/** "Retomar": a stalled topic (its turn was stopped or failed) restarts that turn. */
export async function resumeForumTopic(deps: ForumDeps, userId: string, orgId: string, topicId: string) {
  const topic = await loadTopic(deps.db, orgId, topicId);
  await requireTopicManager(deps.db, userId, orgId, topic);
  if (topic.status !== "stalled") throw new ValidationError("This topic isn't stopped", "forum.not_stalled");
  await deps.db
    .update(forumTopics)
    .set({ status: "open", stall: null, updatedAt: new Date(), lastActivityAt: new Date() })
    .where(and(eq(forumTopics.id, topicId), eq(forumTopics.status, "stalled")));
  await enqueue(deps.db, {
    orgId,
    kind: "forum.advance",
    payload: { topicId },
    dedupeKey: `forum.advance:${topicId}:resume:${Date.now()}`,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.topic_resumed",
    target: { type: "forum_topic", id: topicId },
  });
  await topicEvent(deps, orgId, { type: "forum.topic.updated", topicId, status: "open", round: topic.round });
  return getForumTopic(deps.db, userId, orgId, topicId);
}

/** "Concluir": no new turns; the synthesis comes after the current one (also from a stalled topic). */
export async function concludeForumTopic(deps: ForumDeps, userId: string, orgId: string, topicId: string) {
  const topic = await loadTopic(deps.db, orgId, topicId);
  await requireTopicManager(deps.db, userId, orgId, topic);
  if (topic.status !== "open" && topic.status !== "stalled")
    throw new ValidationError("This topic has ended", "forum.topic_ended");
  await deps.db
    .update(forumTopics)
    .set({ status: "open", stall: null, stopRequested: true, updatedAt: new Date() })
    .where(eq(forumTopics.id, topicId));
  await enqueue(deps.db, {
    orgId,
    kind: "forum.advance",
    payload: { topicId },
    dedupeKey: `forum.advance:${topicId}:conclude:${Date.now()}`,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.topic_concluded",
    target: { type: "forum_topic", id: topicId },
  });
  return getForumTopic(deps.db, userId, orgId, topicId);
}

/** Ends the discussion with no synthesis. */
export async function cancelForumTopic(deps: ForumDeps, userId: string, orgId: string, topicId: string) {
  const topic = await loadTopic(deps.db, orgId, topicId);
  await requireTopicManager(deps.db, userId, orgId, topic);
  if (topic.status !== "open" && topic.status !== "stalled")
    throw new ValidationError("This topic has ended", "forum.topic_ended");
  await deps.db
    .update(forumTopics)
    .set({
      status: "canceled",
      phase: "finished",
      waitingUserId: null,
      stall: null,
      concludedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(forumTopics.id, topicId));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.topic_canceled",
    target: { type: "forum_topic", id: topicId },
  });
  await resolveForumTurns(deps, orgId, topicId).catch(() => {});
  await topicEvent(deps, orgId, { type: "forum.topic.updated", topicId, status: "canceled", round: topic.round });
  return getForumTopic(deps.db, userId, orgId, topicId);
}

/**
 * Adds or removes participants (manager of the topic). Agents must answer
 * the topic's person. `seatUserIds` sit people at the table (at the
 * end of the order); `unseatUserIds` take them out of the order.
 */
export async function setForumParticipants(
  deps: ForumDeps,
  userId: string,
  orgId: string,
  topicId: string,
  input: {
    addAgentIds?: string[];
    removeAgentIds?: string[];
    addUserIds?: string[];
    removeUserIds?: string[];
    seatUserIds?: string[];
    unseatUserIds?: string[];
  },
) {
  const { db } = deps;
  const topic = await loadTopic(db, orgId, topicId);
  await requireTopicManager(db, userId, orgId, topic);
  const requester = topic.requesterUserId ?? userId;
  const nextSeat = async () => {
    const parts = await participantsOf(db, [topicId]);
    return parts.reduce((n, p) => Math.max(n, (p.seat ?? (p.agentId ? p.position : -1)) + 1), 0);
  };
  const add = [...new Set(input.addAgentIds ?? [])];
  if (add.length > 0) {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, add), isNull(agents.archivedAt)));
    if (rows.length !== add.length)
      throw new ValidationError("An agent isn't in this organization", "forum.unknown_agent");
    const talks = await talksToAgents(db, orgId, requester);
    for (const a of rows) if (!canTalkTo(a, requester, talks)) throw await audienceError(db, a);
    const current = (await participantsOf(db, [topicId])).filter((p) => p.agentId);
    if (current.length + add.length > FORUM_LIMITS.maxAgents)
      throw new ValidationError("At most 8 agents", "forum.too_many_agents", { max: 8 });
    for (const [i, agentId] of add.entries()) {
      await db
        .insert(forumParticipants)
        .values({ orgId, topicId, agentId, position: current.length + i, seat: await nextSeat() })
        .onConflictDoNothing();
      await db.insert(channelMembers).values({ orgId, channelId: topic.channelId, agentId }).onConflictDoNothing();
    }
  }
  for (const agentId of input.removeAgentIds ?? []) {
    await db
      .delete(forumParticipants)
      .where(and(eq(forumParticipants.topicId, topicId), eq(forumParticipants.agentId, agentId)));
  }
  const addUsers = [...new Set([...(input.addUserIds ?? []), ...(input.seatUserIds ?? [])])];
  if (addUsers.length > 0) {
    const members = await db
      .select({ userId: schema.organizationMembers.userId })
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, orgId), inArray(schema.organizationMembers.userId, addUsers)));
    if (members.length !== addUsers.length)
      throw new ValidationError("Everyone must be in the organization", "forum.unknown_person");
    for (const u of addUsers) {
      await db.insert(forumParticipants).values({ orgId, topicId, userId: u }).onConflictDoNothing();
      await db.insert(channelMembers).values({ orgId, channelId: topic.channelId, userId: u }).onConflictDoNothing();
    }
  }
  for (const u of input.seatUserIds ?? []) {
    await db
      .update(forumParticipants)
      .set({ seat: await nextSeat() })
      .where(
        and(eq(forumParticipants.topicId, topicId), eq(forumParticipants.userId, u), isNull(forumParticipants.seat)),
      );
  }
  for (const u of input.unseatUserIds ?? []) {
    await db
      .update(forumParticipants)
      .set({ seat: null })
      .where(and(eq(forumParticipants.topicId, topicId), eq(forumParticipants.userId, u)));
  }
  for (const u of input.removeUserIds ?? []) {
    await db
      .delete(forumParticipants)
      .where(and(eq(forumParticipants.topicId, topicId), eq(forumParticipants.userId, u)));
  }
  caches.channelMembers.delete(`${orgId}:${topic.channelId}`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.participants_changed",
    target: { type: "forum_topic", id: topicId },
    details: input,
  });
  await topicEvent(deps, orgId, { type: "forum.topic.updated", topicId, status: topic.status, round: topic.round });
  return getForumTopic(db, userId, orgId, topicId);
}

// ── The worker: turns, rounds, synthesis ─────────────────────────────────────

const FINISHED = new Set(["done", "failed", "canceled"]);

/**
 * Job `forum.advance`: moves a topic on when nobody is working.
 * - A turn that ended is logged: spoke, skipped (the agent's budget ran
 *   out), or, when a person stopped it (or it failed), the topic stalls
 *   until someone resumes it.
 * - An agent's question to people (`waiting_input`) doesn't hold the topic.
 * - Next seat in the round: an agent whose own budget is out skips its turn;
 *   a seated person's turn waits for them ("Sua vez"), and the deadline
 *   or "Concluir" goes on without them.
 * - A new round (early when a person posted); after the last round, the
 *   deadline or "Concluir", the synthesis by the owner agent.
 * Strictly one turn at a time, in order; the router is never involved.
 */
export async function advanceForumTopic(deps: ForumDeps, topicId: string, now = new Date()) {
  const { db } = deps;
  const [pre] = await db
    .select({ orgId: forumTopics.orgId, status: forumTopics.status })
    .from(forumTopics)
    .where(eq(forumTopics.id, topicId));
  if (pre?.status !== "open") return "none";
  // Checked before the lock (the same counter the gateway reserves against).
  const preParts = await participantsOf(db, [topicId]);
  const broke = await agentsOutOfBudget(
    db,
    pre.orgId,
    preParts.flatMap((p) => (p.agentId ? [p.agentId] : [])),
    now,
  );
  type Outcome =
    | { kind: "none" }
    | { kind: "stalled"; topic: TopicRow }
    | { kind: "done"; topic: TopicRow }
    | { kind: "waiting"; topic: TopicRow; userId: string; round: number }
    | { kind: "turn" | "synthesis"; topic: TopicRow; agentId: string; round: number }
    | { kind: "finalize"; topic: TopicRow; runId: string };
  // Decide AND start the turn under the topic's row lock, in one transaction: two advances at
  // once (a run that ended and a person's post) must never start two turns.
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const [topic] = await tx.select().from(forumTopics).where(eq(forumTopics.id, topicId)).for("update");
    if (topic?.status !== "open") return { kind: "none" };
    const parts = await participantsOf(tx, [topicId]);
    const seats = seatsOf(parts);
    const agentIds = seats.flatMap((s) => (s.type === "agent" ? [s.id] : []));
    let round = topic.round;
    let turn = topic.turn;
    const log: (typeof forumTurns.$inferInsert)[] = [];
    const stallTopic = async (stall: Record<string, unknown>, patch: Partial<typeof forumTopics.$inferInsert> = {}) => {
      if (log.length) await tx.insert(forumTurns).values(log);
      await tx
        .update(forumTopics)
        .set({ status: "stalled", stall, currentRunId: null, updatedAt: new Date(), ...patch })
        .where(eq(forumTopics.id, topic.id));
      return { kind: "stalled" as const, topic };
    };

    if (topic.currentRunId) {
      const [run] = await tx
        .select({ id: agentRuns.id, status: agentRuns.status, error: agentRuns.error, agentId: agentRuns.agentId })
        .from(agentRuns)
        .where(eq(agentRuns.id, topic.currentRunId));
      // Someone is working (a question to people doesn't hold a discussion turn; the synthesis waits).
      const asking = run?.status === "waiting_input" && topic.phase !== "synthesizing";
      if (run && !FINISHED.has(run.status) && !asking) return { kind: "none" };
      const stoppedBy = run?.status === "canceled" ? canceledByUser(run.error) : null;
      const failed = run?.status === "failed" && run.error !== "budget_exceeded";
      if (topic.phase === "synthesizing") {
        if (run && (stoppedBy || failed)) {
          return stallTopic(
            {
              reason: stoppedBy ? "stopped" : "failed",
              byUserId: stoppedBy,
              agentId: run.agentId,
              round: topic.round,
              synthesis: true,
              at: now.toISOString(),
            },
            // "Retomar" writes the synthesis again.
            { phase: "discussing", stopRequested: true },
          );
        }
        // Claim the finalization so it happens once.
        await tx
          .update(forumTopics)
          .set({ phase: "finished", currentRunId: null, updatedAt: new Date() })
          .where(eq(forumTopics.id, topic.id));
        return { kind: "finalize", topic, runId: topic.currentRunId };
      }
      if (run) {
        const posted = await tx
          .select({ id: messages.id, body: messages.body })
          .from(messages)
          .where(and(eq(messages.orgId, topic.orgId), eq(messages.agentRunId, run.id)))
          .orderBy(asc(messages.createdAt));
        const entry = {
          orgId: topic.orgId,
          topicId: topic.id,
          round: Math.max(1, topic.round),
          seatType: "agent",
          seatId: run.agentId,
          runId: run.id,
          messageId: posted[0]?.id ?? null,
          length: posted.reduce((n, m) => n + m.body.length, 0),
        };
        if (stoppedBy || failed) {
          log.push({ ...entry, kind: stoppedBy ? "stopped" : "failed" });
          // The turn stays where it is: "Retomar" restarts it.
          return stallTopic({
            reason: stoppedBy ? "stopped" : "failed",
            byUserId: stoppedBy,
            agentId: run.agentId,
            round: topic.round,
            synthesis: false,
            at: now.toISOString(),
          });
        }
        const kind =
          run.status === "failed"
            ? "skipped_budget"
            : run.status === "canceled" && posted.length === 0
              ? "skipped"
              : "spoke";
        log.push({ ...entry, kind });
      }
      turn += 1;
    } else if (topic.phase === "waiting_person") {
      // A seated person's turn: only the deadline or "Concluir" goes on without them.
      const late = topic.deadline !== null && topic.deadline.getTime() <= now.getTime();
      if (!topic.stopRequested && !late) return { kind: "none" };
      if (topic.waitingUserId) {
        log.push({
          orgId: topic.orgId,
          topicId: topic.id,
          round: Math.max(1, topic.round),
          seatType: "person",
          seatId: topic.waitingUserId,
          kind: "skipped",
        });
      }
      turn += 1;
    } else if (topic.phase !== "discussing") {
      return { kind: "none" };
    }

    const requester = topic.requesterUserId;
    const finish = async () => {
      if (log.length) await tx.insert(forumTurns).values(log);
      await tx
        .update(forumTopics)
        .set({
          status: "done",
          phase: "finished",
          currentRunId: null,
          waitingUserId: null,
          concludedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(forumTopics.id, topic.id));
      return { kind: "done" as const, topic };
    };
    if (!requester) {
      await tx
        .update(forumTopics)
        .set({ status: "canceled", phase: "finished", currentRunId: null })
        .where(eq(forumTopics.id, topic.id));
      return { kind: "none" };
    }

    type Next =
      | { kind: "turn"; agentId: string; round: number; turn: number }
      | { kind: "person"; userId: string; round: number; turn: number };
    let next: Next | null = null;
    const late = topic.deadline !== null && topic.deadline.getTime() <= now.getTime();
    const anyoneCanSpeak = agentIds.some((a) => !broke.has(a));
    if (agentIds.length > 0 && anyoneCanSpeak && !topic.stopRequested && !late) {
      if (round === 0) {
        round = 1;
        turn = 0;
      } else if (topic.pendingPerson) {
        // A person spoke: their post leads the next round.
        round += 1;
        turn = 0;
      }
      for (let guard = 0; guard < 1000; guard++) {
        if (turn >= seats.length) {
          round += 1;
          turn = 0;
        }
        if (round > topic.maxRounds) break;
        const seat = seats[turn] as ForumSeat;
        const only = topic.roundSpeakers?.round === round ? topic.roundSpeakers.agentIds : null;
        if (only && (seat.type === "person" || !only.includes(seat.id))) {
          turn += 1;
          continue;
        }
        if (seat.type === "agent" && broke.has(seat.id)) {
          // Its own budget is out: it skips the turn and the discussion goes on.
          log.push({
            orgId: topic.orgId,
            topicId: topic.id,
            round,
            seatType: "agent",
            seatId: seat.id,
            kind: "skipped_budget",
          });
          turn += 1;
          continue;
        }
        next =
          seat.type === "agent"
            ? { kind: "turn", agentId: seat.id, round, turn }
            : { kind: "person", userId: seat.id, round, turn };
        break;
      }
    }
    if (log.length) await tx.insert(forumTurns).values(log);
    log.length = 0;

    if (next?.kind === "person") {
      await tx
        .update(forumTopics)
        .set({
          round: next.round,
          turn: next.turn,
          phase: "waiting_person",
          waitingUserId: next.userId,
          pendingPerson: false,
          currentRunId: null,
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(forumTopics.id, topic.id));
      return { kind: "waiting", topic, userId: next.userId, round: next.round };
    }

    // The synthesis: the owner (or the first agent that still has budget).
    let speaker: string | null = null;
    if (next?.kind === "turn") speaker = next.agentId;
    else {
      const owner = topic.ownerAgentId && agentIds.includes(topic.ownerAgentId) ? topic.ownerAgentId : agentIds[0];
      speaker = owner && !broke.has(owner) ? owner : (agentIds.find((a) => !broke.has(a)) ?? null);
      if (!speaker) return finish();
    }
    const [agent] = await tx
      .select({ handle: agents.handle })
      .from(agents)
      .where(and(eq(agents.id, speaker), eq(agents.orgId, topic.orgId)));
    const handle = agent?.handle ?? "agent";
    const isSynthesis = next === null;
    const revision = (topic.syntheses as unknown[]).length + 1;
    const lastRound = Math.max(1, Math.min(round, topic.maxRounds));
    const body = isSynthesis
      ? synthesisPrompt({ handle, title: topic.title, format: asFormat(topic.format), revision })
      : turnPrompt({
          handle,
          round: next?.round ?? round,
          rounds: topic.maxRounds,
          title: topic.title,
          goal: topic.goal,
        });
    const kickoffRound = isSynthesis ? lastRound : (next?.round ?? round);
    // A turn message the worker writes on the person's behalf (hidden from posts), then the run.
    const { message } = await insertMessageWithRuns(
      tx,
      {
        orgId: topic.orgId,
        channelId: topic.channelId,
        author: { type: "person", userId: requester },
        body,
        meta: {
          forum: { topicId: topic.id, round: kickoffRound, kickoff: true, ...(isSynthesis ? { synthesis: true } : {}) },
        },
      },
      { startRuns: false },
    );
    const created = await createAgentRuns(tx, { ...message, hop: 0 }, [speaker], "forum");
    await tx
      .update(forumTopics)
      .set({
        round: kickoffRound,
        turn: isSynthesis ? turn : (next?.turn ?? turn),
        phase: isSynthesis ? "synthesizing" : "discussing",
        pendingPerson: false,
        waitingUserId: null,
        currentRunId: created[0]?.id ?? null,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(forumTopics.id, topic.id));
    return { kind: isSynthesis ? "synthesis" : "turn", topic, agentId: speaker, round: kickoffRound };
  });

  if (outcome.kind === "none") return outcome.kind;
  if (outcome.kind === "finalize") {
    await resolveForumTurns(deps, outcome.topic.orgId, outcome.topic.id).catch(() => {});
    await finalizeSynthesis(deps, outcome.topic, outcome.runId);
    return outcome.kind;
  }
  const { topic } = outcome;
  // The inbox: a seated person's turn is over once the table moves on.
  await resolveForumTurns(deps, topic.orgId, topic.id).catch(() => {});
  if (outcome.kind === "stalled" || outcome.kind === "done") {
    await topicEvent(deps, topic.orgId, {
      type: "forum.topic.updated",
      topicId: topic.id,
      status: outcome.kind === "stalled" ? "stalled" : "done",
      round: topic.round,
    });
    return outcome.kind;
  }
  if (outcome.kind === "waiting") {
    await notifyForumTurn(deps, topic, outcome.userId, outcome.round).catch(() => {});
    await publishUserEvent(deps.pubsub, topic.orgId, outcome.userId, {
      type: "forum.your_turn",
      topicId: topic.id,
      title: topic.title,
      round: outcome.round,
      deadline: topic.deadline?.toISOString() ?? null,
    });
    await topicEvent(deps, topic.orgId, {
      type: "forum.topic.updated",
      topicId: topic.id,
      status: "open",
      round: outcome.round,
      phase: "waiting_person",
      waitingUserId: outcome.userId,
    });
    return outcome.kind;
  }
  await topicEvent(deps, topic.orgId, {
    type: "forum.topic.updated",
    topicId: topic.id,
    status: "open",
    round: outcome.round,
    phase: outcome.kind === "synthesis" ? "synthesizing" : "discussing",
    activeAgentIds: [outcome.agentId],
  });
  return outcome.kind;
}

/** Owners as the synthesis writes them ("@ada", "Marina") → agents or people of the org. */
async function ownerResolver(db: Database, orgId: string): Promise<OwnerResolver> {
  const [agentRows, people] = await Promise.all([
    db
      .select({ id: agents.id, handle: agents.handle, name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt))),
    db
      .select({ id: schema.users.id, name: schema.users.name, handle: schema.organizationMembers.handle })
      .from(schema.organizationMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.organizationMembers.userId))
      .where(eq(schema.organizationMembers.orgId, orgId)),
  ]);
  return (label) => {
    const l = label.trim().toLowerCase();
    const handle = l.replace(/^@/, "").split(/\s+/)[0] ?? "";
    const agent =
      agentRows.find((a) => a.handle === handle) ??
      (l.startsWith("@") ? undefined : agentRows.find((a) => a.name.toLowerCase() === l));
    if (agent) return { type: "agent", id: agent.id };
    const person =
      people.find((p) => p.handle?.toLowerCase() === handle) ??
      people.find((p) => p.name.toLowerCase() === l.replace(/^@/, "")) ??
      people.find((p) => p.name.toLowerCase().split(/\s+/)[0] === handle);
    return person ? { type: "person", id: person.id } : null;
  };
}

/**
 * The synthesis run finished: its text becomes the Drive document (a new
 * version of the same one when the topic was reopened), parsed into cards,
 * the topic is done, and the result goes back to where it came from (the
 * conversation, the issue).
 */
async function finalizeSynthesis(deps: ForumDeps, topic: TopicRow, runId: string) {
  const { db } = deps;
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  const posted = (await channelMessages(db, topic.orgId, topic.channelId)).filter((m) => m.agentRunId === runId);
  const markdown = posted
    .map((m) => m.body)
    .join("\n\n")
    .trim();
  const format = asFormat(topic.format);
  const history = topic.syntheses as unknown as ForumSynthesisVersion[];
  const revision = history.length + 1;
  const structured = parseSynthesis(format, markdown, await ownerResolver(db, topic.orgId));
  let artifact: { id: string; version: number } | null = null;
  if (markdown && run && deps.artifacts) {
    const actor = { type: "agent" as const, agentId: run.agentId, channelId: topic.channelId, runId };
    const content = { kind: "document" as const, markdown };
    const title = `${format === "plan" ? "Plan" : "Synthesis"}: ${topic.title}`.slice(0, 200);
    if (topic.synthesisArtifactId && revision > 1) {
      // Reopened: version 2… of the same document (older versions stay in the Drive).
      const updated = await updateArtifact(deps.artifacts, actor, topic.orgId, topic.synthesisArtifactId, {
        content,
        note: `Rewritten after round ${topic.round}`,
      }).catch(() => null);
      if (updated) artifact = { id: updated.id, version: updated.shownVersion };
    }
    if (!artifact) {
      const a = await createArtifact(deps.artifacts, actor, topic.orgId, { title, content });
      artifact = { id: a.id, version: a.version };
    }
  }
  const entry: ForumSynthesisVersion = {
    revision,
    artifactId: artifact?.id ?? null,
    artifactVersion: artifact?.version ?? null,
    agentId: run?.agentId ?? "",
    format,
    afterRound: Math.max(1, topic.round),
    createdAt: new Date().toISOString(),
    structured,
    markdown: cutText(markdown, 100_000),
  };
  const suggested = structured.suggestedIssues;
  await db.transaction(async (tx) => {
    await tx
      .update(forumTopics)
      .set({
        status: "done",
        phase: "finished",
        currentRunId: null,
        waitingUserId: null,
        synthesisArtifactId: artifact?.id ?? topic.synthesisArtifactId ?? null,
        synthesisVersion: artifact?.version ?? topic.synthesisVersion ?? null,
        suggestedIssues: suggested as unknown as Record<string, unknown>[],
        syntheses: [...history, entry] as unknown as Record<string, unknown>[],
        reopenedByUserId: null,
        reopenedAt: null,
        roundSpeakers: null,
        stopRequested: false,
        concludedAt: new Date(),
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(forumTopics.id, topic.id));
    if (run) {
      await tx.insert(forumTurns).values({
        orgId: topic.orgId,
        topicId: topic.id,
        round: Math.max(1, topic.round),
        seatType: "agent",
        seatId: run.agentId,
        kind: "synthesis",
        runId,
        messageId: posted[0]?.id ?? null,
        length: markdown.length,
      });
    }
  });
  const link = `/org/${topic.orgId}/forum/${topic.id}`;
  if (topic.originChannelId && run && artifact) {
    // Back where it was asked: the agent's message with the synthesis card, in the message's thread
    // when it has one, else in the channel (asked there).
    const [inThread] = topic.originMessageId
      ? await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.orgId, topic.orgId), eq(messages.threadId, topic.originMessageId)))
          .limit(1)
      : [];
    const { message } = await insertMessageWithRuns(
      db,
      {
        orgId: topic.orgId,
        channelId: topic.originChannelId,
        threadId: inThread ? topic.originMessageId : null,
        author: { type: "agent", agentId: run.agentId, runId: null, hop: 0, stretchId: null },
        body: `The forum "${topic.title}" is over. The ${format === "plan" ? "plan" : "synthesis"}${revision > 1 ? ` (version ${revision})` : ""} is in the file below${suggested.length ? `, with ${suggested.length} suggested issue(s) to approve` : ""}.`,
        meta: {
          artifacts: [artifact],
          forumTopicId: topic.id,
          // For the app to say it in the person's language.
          forumConcluded: {
            topicId: topic.id,
            title: topic.title,
            suggestedIssues: suggested.length,
            format,
            revision,
            summary: cutText(synthesisSummary(structured), 500),
          },
          bodyCode: suggested.length ? "forum_concluded_issues" : "forum_concluded",
          bodyParams: { title: topic.title, count: String(suggested.length) },
        },
      },
      { startRuns: false },
    ).catch(() => ({ message: null }));
    if (message && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  }
  if (topic.originIssueId && run) {
    // Back to the issue: a comment with the summary and the link, and "evaluated" in its activity.
    const summary = synthesisSummary(structured);
    await recordIssueForumEvent(
      { db, pubsub: deps.pubsub },
      topic.orgId,
      topic.originIssueId,
      { type: "agent", id: run.agentId },
      "forum_evaluated",
      { topicId: topic.id, title: topic.title, artifactId: artifact?.id ?? null, version: artifact?.version ?? null },
      {
        comment: [
          `The forum evaluated this issue: "${topic.title}"${revision > 1 ? ` (version ${revision})` : ""}.`,
          summary,
          suggested.length
            ? `${suggested.length} suggested ${suggested.length === 1 ? "issue" : "issues"} to approve.`
            : "",
          `[Open the ${format === "plan" ? "plan" : "synthesis"}](${link})`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ).catch(() => null);
  }
  await notifyForumSynthesis(deps, topic, {
    agentId: run?.agentId ?? null,
    revision,
    summary: synthesisSummary(structured),
  }).catch(() => {});
  const requestedBy = topic.requestedByUserId;
  for (const userId of new Set([topic.requesterUserId, requestedBy].filter((u): u is string => !!u))) {
    await publishUserEvent(deps.pubsub, topic.orgId, userId, {
      type: "forum.concluded",
      topicId: topic.id,
      title: topic.title,
      revision,
    });
  }
  await topicEvent(deps, topic.orgId, {
    type: "forum.topic.updated",
    topicId: topic.id,
    status: "done",
    round: topic.round,
  });
}

/**
 * The turn's post: the stance header ("Stance: agrees @ada", "Replying to",
 * "Position") is taken out of the body into `meta.forum`, with handles
 * resolved to ids and "Replying to: @x" to x's latest post.
 */
async function applyStance(db: Database, topic: TopicRow, runId: string) {
  const all = await channelMessages(db, topic.orgId, topic.channelId);
  const first = all.find((m) => m.agentRunId === runId);
  if (!first || forumMeta(first)?.stance !== undefined) return;
  const header = splitStance(first.body);
  let stance: ForumStance | null = null;
  const resolve =
    header.stance?.handle || header.replyTo?.startsWith("@") ? await ownerResolver(db, topic.orgId) : null;
  if (header.stance) {
    const who = header.stance.handle && resolve ? resolve(`@${header.stance.handle}`) : null;
    stance = {
      kind: header.stance.kind,
      ...(who
        ? { target: { type: who.type, id: who.id, handle: header.stance.handle } }
        : header.stance.handle
          ? { target: { type: "agent" as const, handle: header.stance.handle } }
          : header.stance.people
            ? { target: { type: "people" as const } }
            : {}),
    };
  }
  let replyTo: string | null = null;
  if (header.replyTo) {
    const before = all.filter((m) => m.createdAt.getTime() <= first.createdAt.getTime() && m.id !== first.id);
    if (header.replyTo.startsWith("@")) {
      const who = resolve?.(header.replyTo) ?? null;
      const target = who
        ? [...before]
            .reverse()
            .find(
              (m) =>
                !forumMeta(m)?.kickoff &&
                (who.type === "agent" ? m.authorAgentId === who.id : m.authorUserId === who.id),
            )
        : undefined;
      replyTo = target?.id ?? null;
    } else replyTo = before.some((m) => m.id === header.replyTo) ? header.replyTo : null;
  }
  const meta: ForumMeta = {
    topicId: topic.id,
    round: Math.max(1, topic.round),
    stance,
    replyTo,
    position: header.position,
  };
  await db
    .update(messages)
    .set({
      body: header.body,
      meta: sql`${messages.meta} || ${JSON.stringify({ forum: meta })}::jsonb`,
    })
    .where(and(eq(messages.id, first.id), eq(messages.orgId, topic.orgId)));
}

/**
 * Called when a run in a forum channel ends (or waits for a person's
 * answer): its stance is read, its post announced, and the topic moves on
 * (through the outbox, so it survives restarts).
 */
export async function onForumRunFinished(deps: ForumDeps, orgId: string, channelId: string, runId: string) {
  const [topic] = await deps.db
    .select()
    .from(forumTopics)
    .where(and(eq(forumTopics.orgId, orgId), eq(forumTopics.channelId, channelId)));
  if (!topic) return;
  const isSynthesis = topic.phase === "synthesizing" && topic.currentRunId === runId;
  if (!isSynthesis) await applyStance(deps.db, topic, runId).catch(() => {});
  const all = await channelMessages(deps.db, orgId, channelId);
  // The posts of this run, read in place (the kickoff before it says the round).
  const firstIdx = all.findIndex((m) => m.agentRunId === runId);
  const kickoff = firstIdx > 0 ? [...all.slice(0, firstIdx)].reverse().find((m) => forumMeta(m)?.kickoff) : undefined;
  const [post] = postsOf(topic.id, [...(kickoff ? [kickoff] : []), ...all.filter((m) => m.agentRunId === runId)]);
  if (post) await topicEvent(deps, orgId, { type: "forum.post.created", topicId: topic.id, post });
  await enqueue(deps.db, {
    orgId,
    kind: "forum.advance",
    payload: { topicId: topic.id },
    dedupeKey: `forum.advance:${topic.id}:run:${runId}`,
  });
}

/** An agent's own post outside its turn (`post_in_forum`): once per round, and only in an open topic. */
export async function postInForumAsAgent(
  deps: ForumDeps,
  agentId: string,
  orgId: string,
  topicId: string,
  body: string,
): Promise<ForumPostView> {
  const { db } = deps;
  const topic = await loadTopic(db, orgId, topicId);
  if (topic.status !== "open") throw new ValidationError("This topic has ended", "forum.topic_ended");
  const [participant] = await db
    .select({ id: forumParticipants.id })
    .from(forumParticipants)
    .where(and(eq(forumParticipants.topicId, topicId), eq(forumParticipants.agentId, agentId)));
  if (!participant) throw new ForbiddenError("You aren't in this topic", "forum.not_participant");
  const round = Math.max(1, topic.round);
  const already = postsOf(topicId, await channelMessages(db, orgId, topic.channelId)).some(
    (p) => p.author.type === "agent" && p.author.id === agentId && p.round === round,
  );
  if (already)
    throw new ValidationError("You already posted this round. Wait for the next one.", "forum.already_posted");
  const text = body.trim().slice(0, FORUM_LIMITS.postChars);
  if (!text) throw new ValidationError("Write something first", "forum.empty_post");
  const { message } = await insertMessageWithRuns(
    db,
    {
      orgId,
      channelId: topic.channelId,
      author: { type: "agent", agentId, runId: null, hop: 0, stretchId: null },
      body: text,
      meta: { forum: { topicId, round } satisfies ForumMeta },
    },
    { startRuns: false },
  );
  await db.update(forumTopics).set({ lastActivityAt: new Date() }).where(eq(forumTopics.id, topicId));
  return announcePost(deps, topicId, orgId, message);
}

/**
 * The synthesis' suggested issues, created by a person who approves them.
 * With an origin issue, they become its sub-issues; an owner the synthesis
 * named becomes the assignee.
 */
export async function createForumIssues(
  deps: ForumDeps,
  userId: string,
  orgId: string,
  topicId: string,
  items: ForumSuggestedIssue[],
) {
  const topic = await loadTopic(deps.db, orgId, topicId);
  await requirePermission(deps.db, userId, orgId, "post");
  if (items.length === 0 || items.length > 10)
    throw new ValidationError("Pick 1 to 10 issues", "forum.issue_count", { min: 1, max: 10 });
  const created: { id: string; number: number; title: string }[] = [];
  for (const item of items) {
    const assignee = item.owner ? { type: item.owner.type, id: item.owner.id } : null;
    const input = {
      title: item.title,
      description: item.description,
      source: { type: "forum" as const, threadId: topic.id },
      parentIssueId: topic.originIssueId,
    };
    // An owner that is no longer in the org: the issue is created without an assignee.
    const issue = await createIssue({ db: deps.db, pubsub: deps.pubsub }, { type: "person", userId }, orgId, {
      ...input,
      assignee,
    }).catch((error) =>
      assignee
        ? createIssue({ db: deps.db, pubsub: deps.pubsub }, { type: "person", userId }, orgId, input)
        : Promise.reject(error),
    );
    created.push({ id: issue.id, number: issue.number, title: issue.title });
  }
  await deps.db
    .update(forumTopics)
    .set({
      createdIssues: sql`${forumTopics.createdIssues} || ${JSON.stringify(created)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(forumTopics.id, topicId));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.issues_created",
    target: { type: "forum_topic", id: topicId },
    details: { numbers: created.map((c) => c.number), parentIssueId: topic.originIssueId },
  });
  return { numbers: created.map((c) => c.number), issues: created };
}

/** The topic of a forum channel (for the run context), or null. */
export async function forumTopicOfChannel(db: Database, orgId: string, channelId: string) {
  const [row] = await db
    .select()
    .from(forumTopics)
    .where(and(eq(forumTopics.orgId, orgId), eq(forumTopics.channelId, channelId)));
  return row ?? null;
}

// ── Suggestions: an agent suggests, a person opens ───────────────────────────

export interface ForumSuggestion {
  title: string;
  goal: string;
  agentIds: string[];
  rounds: number;
  format: ForumFormat;
  suggestedByAgentId: string;
  state: "pending" | "accepted" | "dismissed";
  topicId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
}

/**
 * The suggestion card (`suggest_forum_topic`): the agent's message in the
 * conversation with `meta.forumSuggestion`. It never opens a topic.
 */
export async function suggestForumTopic(
  deps: ForumDeps,
  ctx: { orgId: string; agentId: string; runId: string; channelId: string; threadId: string | null; hop: number },
  input: { title: string; goal: string; agentIds: string[]; rounds?: number; format?: ForumFormat },
) {
  const title = input.title.trim().slice(0, 200);
  const goal = input.goal.trim().slice(0, 5000);
  if (!title || !goal) throw new ValidationError("Give the topic a title and a question", "forum.title_required");
  const agentIds = [...new Set(input.agentIds)].slice(0, FORUM_LIMITS.maxAgents);
  const suggestion: ForumSuggestion = {
    title,
    goal,
    agentIds,
    rounds: Math.min(FORUM_LIMITS.maxRounds, Math.max(1, Math.round(input.rounds ?? FORUM_LIMITS.defaultRounds))),
    format: input.format === "plan" ? "plan" : "decision",
    suggestedByAgentId: ctx.agentId,
    state: "pending",
    topicId: null,
    decidedByUserId: null,
    decidedAt: null,
  };
  const { message } = await insertMessageWithRuns(
    deps.db,
    {
      orgId: ctx.orgId,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: ctx.hop },
      body: `Worth a forum? "${title}": ${goal}`,
      meta: {
        forumSuggestion: suggestion,
        bodyCode: "forum_suggestion",
        bodyParams: { title },
      },
    },
    { startRuns: false },
  );
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return { message, suggestion };
}

async function suggestionMessage(db: Database, userId: string, orgId: string, messageId: string) {
  const message = await getMessage(db, orgId, messageId);
  const suggestion = message?.meta.forumSuggestion as ForumSuggestion | undefined;
  if (!message || message.deletedAt || !suggestion) throw new NotFoundError("Suggestion not found");
  await requireChannelAccess(db, userId, orgId, message.channelId);
  return { message, suggestion };
}

async function setSuggestion(
  deps: ForumDeps,
  message: Message,
  suggestion: ForumSuggestion,
  from: ForumSuggestion["state"] | "accepting",
) {
  const [row] = await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{forumSuggestion}', ${JSON.stringify(suggestion)}::jsonb)` })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.orgId, message.orgId),
        sql`${messages.meta}->'forumSuggestion'->>'state' = ${from}`,
      ),
    )
    .returning({ id: messages.id });
  return row !== undefined;
}

async function announceSuggestion(deps: ForumDeps, message: Message, suggestion: ForumSuggestion) {
  await publishChannelEvent(deps.pubsub, {
    type: "forum.suggestion.updated",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    suggestion: suggestion as unknown as Record<string, unknown>,
  });
}

/**
 * A person opens the suggested topic ("Abrir no fórum"): it is theirs (the
 * responsible person), the suggestion card points to it, and the synthesis
 * comes back to that conversation. The card's fields can be adjusted.
 */
export async function acceptForumSuggestion(
  deps: ForumDeps,
  userId: string,
  orgId: string,
  messageId: string,
  overrides: Partial<Omit<ForumTopicInput, "origin">> = {},
) {
  const { message, suggestion } = await suggestionMessage(deps.db, userId, orgId, messageId);
  if (suggestion.state !== "pending")
    throw new ConflictError("This suggestion was already handled", "forum.suggestion_decided");
  const claiming = { ...suggestion, state: "accepting" as unknown as ForumSuggestion["state"] };
  if (!(await setSuggestion(deps, message, claiming, "pending")))
    throw new ConflictError("This suggestion was already handled", "forum.suggestion_decided");
  let topic: ForumTopicDetail;
  try {
    topic = await createForumTopic(deps, { type: "person", userId }, orgId, {
      title: overrides.title ?? suggestion.title,
      goal: overrides.goal ?? suggestion.goal,
      agentIds: overrides.agentIds ?? suggestion.agentIds,
      rounds: overrides.rounds ?? suggestion.rounds,
      format: overrides.format ?? suggestion.format,
      ...(overrides.seats ? { seats: overrides.seats } : {}),
      ...(overrides.userIds ? { userIds: overrides.userIds } : {}),
      ...(overrides.deadline ? { deadline: overrides.deadline } : {}),
      ...(overrides.ownerAgentId ? { ownerAgentId: overrides.ownerAgentId } : {}),
      origin: {
        kind: "suggestion",
        agentId: suggestion.suggestedByAgentId,
        channelId: message.channelId,
        messageId: message.threadId ?? message.id,
      },
    });
  } catch (error) {
    await setSuggestion(deps, message, suggestion, "accepting" as ForumSuggestion["state"]);
    throw error;
  }
  const accepted: ForumSuggestion = {
    ...suggestion,
    state: "accepted",
    topicId: topic.id,
    decidedByUserId: userId,
    decidedAt: new Date().toISOString(),
  };
  await setSuggestion(deps, message, accepted, "accepting" as ForumSuggestion["state"]);
  await announceSuggestion(deps, message, accepted);
  return { topic, suggestion: accepted };
}

/** "Agora não": the card stays, marked dismissed. */
export async function dismissForumSuggestion(deps: ForumDeps, userId: string, orgId: string, messageId: string) {
  const { message, suggestion } = await suggestionMessage(deps.db, userId, orgId, messageId);
  if (suggestion.state !== "pending")
    throw new ConflictError("This suggestion was already handled", "forum.suggestion_decided");
  const dismissed: ForumSuggestion = {
    ...suggestion,
    state: "dismissed",
    decidedByUserId: userId,
    decidedAt: new Date().toISOString(),
  };
  if (!(await setSuggestion(deps, message, dismissed, "pending")))
    throw new ConflictError("This suggestion was already handled", "forum.suggestion_decided");
  await announceSuggestion(deps, message, dismissed);
  return { suggestion: dismissed };
}
