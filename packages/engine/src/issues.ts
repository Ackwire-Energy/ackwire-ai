import { PERMISSION_TOOL, type PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgent } from "./agents";
import { audienceError, canTalkTo, speakerFor } from "./audience";
import { recordAudit } from "./audit";
import { runAuthorityById } from "./authority";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated, publishOrgEvent } from "./events";
import { cutText } from "./format";
import { boardColumns, columnForMove, columnOf, topRank } from "./issue-columns";
import type { IssueWorkMeta } from "./issue-work";
import { getMessage, insertMessage, type MessageView, messageView, postPersonMessage } from "./messages";
import { enqueueRunJob } from "./mission-runs";
import { notifyIssueChanged } from "./notification-producers";
import { can, getMembership, requireActiveMembership } from "./organizations";
import { fireRoutineEvent } from "./routines";
import { agentSearchChannels, enqueueIndex, registerDocumentBuilder } from "./search";
import { admitTaskAgents } from "./task-access";
import {
  ensureTaskConversation,
  type TaskConversationRef,
  type TaskConversationSummary,
  taskConversationSummaries,
} from "./task-conversation";
import { promptAnswer, promptPoll, toolDetail } from "./tool-detail";
import { syncWikiLinks, withWikiLinks } from "./wiki-links";
import { type WorkRow, type WorkView, workViews } from "./works";

const { issues, issueActivity, issueCounters, channels, channelMembers, artifacts, agentRuns, agentRunSteps } = schema;

export type IssueStatus = "todo" | "in_progress" | "in_review" | "done" | "canceled";
export type IssuePriority = "low" | "normal" | "high";
export interface WorkActor {
  type: "person" | "agent";
  id: string;
}
export type IssueSource =
  | { type: "manual" }
  | { type: "message"; channelId: string; messageId: string }
  | { type: "agent"; agentId: string; workId?: string; channelId?: string; messageId?: string }
  | { type: "webhook"; provider: string };

/** An issue as the app shows it. */
export interface IssueView {
  id: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  /** Its board column: always one of its stage. */
  columnId: string | null;
  /** Order inside the column, lowest first. */
  boardRank: number;
  priority: IssuePriority;
  assignee: WorkActor | null;
  labels: string[];
  dueDate: string | null;
  /** `doneBy`: who checked it (an agent shows its face next to it). */
  criteria: { id: string; text: string; done: boolean; doneBy?: WorkActor | null }[];
  createdBy: WorkActor;
  source: IssueSource;
  channelId: string | null;
  /** The issue this one is a sub-issue of. */
  parentIssueId: string | null;
  pullRequests: { number: number; url: string; openedBy: WorkActor | null }[];
  artifacts: { id: string; title: string; createdBy: WorkActor }[];
  /** The assigned agent's work on it, from its runs (null: a person has it, nobody, or it is closed). */
  work: IssueWork | null;
  /** Long work stopped on something (ADR 0121 §4): a badge, the card stays in its stage. */
  blocked: { reason: string; since: string; text?: string } | null;
  /** The agent's background work this card tracks (its plan, last update and line), newest. */
  backgroundWork: WorkView | null;
  /** Its conversation (ADR 0145), once someone wrote or opened it: replies, who took part, an agent at work. */
  conversation: TaskConversationSummary | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the assigned agent is doing on an issue, derived from its runs (never
 * a status the agent sets): `running` / `waiting_approval` / `waiting_input`
 * while a linked run is alive; `stalled` when the issue is in progress with
 * the agent and no run is alive (it ended, failed or was stopped).
 */
export interface IssueWork {
  agentId: string;
  runId: string | null;
  state: "running" | "waiting_approval" | "waiting_input" | "stalled";
  /** When the live run started, or when the work stopped (stalled). */
  since: string;
  /**
   * The run's last tool calls, oldest first (safe labels only: built-in details, no connector inputs). A permission
   * check also says when its command was refused or still waits on a person (`outcome`).
   */
  steps: { tool: string; detail?: string; at: string; outcome?: "refused" | "waiting" }[];
  /** Stalled: how the last run ended, when it did not finish on its own. */
  reason?: "failed" | "canceled" | "budget";
}

/** One issue with its sub-issues. */
export interface IssueDetailView extends IssueView {
  subIssues: { id: string; number: number; title: string; status: IssueStatus; assignee: WorkActor | null }[];
}

export interface IssueActivityView {
  id: string;
  kind: "comment" | "event";
  author: WorkActor;
  text: string;
  event?: string;
  /** An event in the app's words (`issues.event.{textCode}`), with its params; `text` is the English fallback. */
  textCode?: string;
  textParams?: Record<string, string>;
  /** The system moved it on its own (status follows the agent's runs and PRs). */
  auto?: boolean;
  /** Files attached to a comment (Drive files; they are linked to the issue too). */
  attachments?: { id: string; title: string }[];
  createdAt: string;
}

export interface IssueInput {
  title: string;
  description?: string;
  criteria?: string[];
  assignee?: WorkActor | null;
  priority?: IssuePriority;
  dueDate?: string | null;
  labels?: string[];
}

export type IssuePatch = Partial<{
  title: string;
  description: string;
  status: IssueStatus;
  /** A board column: the issue takes that column's stage. */
  columnId: string;
  boardRank: number;
  priority: IssuePriority;
  assignee: WorkActor | null;
  dueDate: string | null;
  labels: string[];
  /**
   * The whole list of acceptance criteria, in order: an `id` keeps that criterion (and whether it is checked), one
   * without is new, and a criterion left out is removed.
   */
  criteria: { id?: string; text: string }[];
}>;

/** Who acts: a person, or an agent during a run (it sees what its channel lets it see). */
export type IssueActor =
  | { type: "person"; userId: string }
  /** `runId`: the run acting (links the run to the issue it touches). */
  | { type: "agent"; agentId: string; channelId: string; runId?: string };

type IssueRow = typeof issues.$inferSelect;

const STATUSES: readonly IssueStatus[] = ["todo", "in_progress", "in_review", "done", "canceled"];
const PRIORITIES: readonly IssuePriority[] = ["low", "normal", "high"];
const STATUS_WORDS: Record<IssueStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};

const actorOf = (a: IssueActor): WorkActor =>
  a.type === "person" ? { type: "person", id: a.userId } : { type: "agent", id: a.agentId };

function checkDate(d: string | null | undefined) {
  if (d === undefined || d === null) return d;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new ValidationError("dueDate must be YYYY-MM-DD");
  }
  return d;
}

function cleanLabels(labels: string[] | undefined) {
  if (!labels) return undefined;
  return [...new Set(labels.map((l) => l.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

/** `channelId`: the conversation the task is tied to, which a person assigned to it must be able to read. */
async function checkAssignee(
  db: Database,
  orgId: string,
  a: WorkActor | null | undefined,
  channelId: string | null = null,
) {
  if (!a) return;
  if (a.type === "agent") {
    const agent = await getAgent(db, orgId, a.id);
    if (!agent || agent.archivedAt) throw new ValidationError("That agent does not exist in this organization");
  } else if (!(await getMembership(db, a.id, orgId))) {
    throw new ValidationError("That person is not a member of this organization");
  } else if (!(await canSee(db, { type: "person", userId: a.id }, orgId, channelId))) {
    throw new ValidationError(
      "That person isn't in this task's conversation, so they can't see it",
      "issue.assignee_outside",
    );
  }
}

/**
 * The conversation a task made from `channelId` stays tied to: a DM or a private channel; from a task's own
 * conversation (`task`), whatever that task is tied to. Null where the whole workspace may see it: a public channel,
 * and a room no person reads (a routine's), whose task would otherwise be nobody's.
 */
async function conversationOf(db: Database, orgId: string, channelId: string) {
  const [row] = await db
    .select({
      kind: channels.kind,
      visibility: channels.visibility,
      taskChannelId: issues.channelId,
      people: sql<boolean>`exists (select 1 from ${channelMembers} cm
        where cm.channel_id = ${channels.id} and cm.user_id is not null)`,
    })
    .from(channels)
    .leftJoin(issues, eq(issues.conversationChannelId, channels.id))
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (row?.kind === "task") return { task: true, tiedTo: row.taskChannelId };
  const open = !row?.people || (row.kind === "channel" && row.visibility === "public");
  return { task: false, tiedTo: open ? null : channelId };
}

/**
 * Asked to implement an issue, an agent works on it in the requester's DM (`dmId`): from there it sees the
 * issue when that person can see its channel (`channelId`, an SQL expression).
 */
const seenFromDmSql = (orgId: string, dmId: string, channelId: SQL) => sql`exists (select 1
    from ${channelMembers} dm_m join ${channels} dm on dm.id = dm_m.channel_id and dm.kind = 'dm'
    where dm_m.channel_id = ${dmId}::uuid and dm_m.org_id = ${orgId}::uuid and dm_m.user_id is not null
      and exists (select 1 from ${channelMembers} cm2 where cm2.channel_id = ${channelId} and cm2.user_id = dm_m.user_id))`;

async function canSee(
  db: Database,
  actor: IssueActor,
  orgId: string,
  channelId: string | null,
  /** The issue's assignee: an agent working on it from a DM sees what the person there sees. */
  assignee?: { type: string | null; id: string | null },
  /** The issue's own conversation (ADR 0145): an agent there sees it (it joined only seeing it, or assigned). */
  conversationChannelId?: string | null,
) {
  if (!channelId) return true;
  if (actor.type === "agent") {
    if (conversationChannelId && actor.channelId === conversationChannelId) return true;
    if ((await agentSearchChannels(db, orgId, actor.agentId, actor.channelId)).includes(channelId)) return true;
    // In a task's conversation, an agent of the place it's tied to reads what's tied there (a step made here). One
    // assigned from outside reaches its own task only.
    const [sibling] = await db
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(
        channelMembers,
        and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, actor.agentId)),
      )
      .where(and(eq(issues.conversationChannelId, actor.channelId), eq(issues.channelId, channelId)));
    if (sibling) return true;
    if (assignee?.type !== "agent" || assignee.id !== actor.agentId) return false;
    const [row] = rowsOf<{ yes: boolean | string }>(
      await db.execute(sql`select ${seenFromDmSql(orgId, actor.channelId, sql`${channelId}::uuid`)} as yes`),
    );
    return row?.yes === true || row?.yes === "t";
  }
  const [row] = await db
    .select({ visibility: channels.visibility, kind: channels.kind, memberId: channelMembers.id })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, actor.userId)))
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  return !!row && (row.memberId !== null || (row.visibility === "public" && row.kind === "channel"));
}

async function requireOrgMember(db: Database, actor: IssueActor, orgId: string) {
  if (actor.type !== "person") return null;
  const membership = await requireActiveMembership(db, actor.userId, orgId);
  return membership;
}

const LIVE_RUN = new Set(["queued", "running", "waiting_approval", "waiting_input"]);
const OPEN_FOR_WORK = new Set<IssueStatus>(["todo", "in_progress", "in_review"]);
const STEPS_SHOWN = 8;

/** The assigned agents' work on these issues: their latest linked run and its last tool calls. */
async function workOf(db: Database, rows: IssueRow[]): Promise<Map<string, IssueWork>> {
  const out = new Map<string, IssueWork>();
  const withAgent = rows.filter((r) => r.assigneeType === "agent" && r.assigneeId && OPEN_FOR_WORK.has(r.status));
  if (withAgent.length === 0) return out;
  const latest = await db
    .selectDistinctOn([agentRuns.issueId], {
      id: agentRuns.id,
      issueId: agentRuns.issueId,
      agentId: agentRuns.agentId,
      status: agentRuns.status,
      error: agentRuns.error,
      createdAt: agentRuns.createdAt,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      updatedAt: agentRuns.updatedAt,
    })
    .from(agentRuns)
    .where(
      inArray(
        agentRuns.issueId,
        withAgent.map((r) => r.id),
      ),
    )
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt));
  const runOf = new Map(latest.map((r) => [r.issueId ?? "", r]));
  const runIds = latest.map((r) => r.id);
  const steps = runIds.length
    ? await db
        .select({
          runId: agentRunSteps.runId,
          kind: agentRunSteps.kind,
          data: agentRunSteps.data,
          createdAt: agentRunSteps.createdAt,
        })
        .from(agentRunSteps)
        .where(
          and(
            inArray(agentRunSteps.runId, runIds),
            or(
              eq(agentRunSteps.kind, "tool_call"),
              and(eq(agentRunSteps.kind, "tool_result"), sql`${agentRunSteps.data}->>'name' = ${PERMISSION_TOOL}`),
            ),
          ),
        )
        .orderBy(asc(agentRunSteps.seq))
    : [];
  // A permission check's answer, by its call: refused, or waiting on a person until the runner's asking again brings
  // the person's answer (by its request: Claude Code may ask twice while the card is open).
  const answers = new Map(
    steps.flatMap((st) =>
      st.kind === "tool_result" ? [[st.data.toolUseId, promptAnswer(String(st.data.content ?? ""))] as const] : [],
    ),
  );
  const waiting = new Map<string, IssueWork["steps"]>();
  const stepsOf = new Map<string, IssueWork["steps"]>();
  for (const st of steps) {
    const name = st.kind === "tool_call" && typeof st.data.name === "string" ? st.data.name : "";
    const input = st.data.input as Record<string, unknown> | undefined;
    if (!name) continue;
    const answer = name === PERMISSION_TOOL ? answers.get(st.data.toolUseId) : undefined;
    if (promptPoll(name, input)) {
      for (const asked of answer?.behavior ? (waiting.get(String(input?.request_id)) ?? []) : []) {
        if (answer?.behavior === "deny") asked.outcome = "refused";
        else delete asked.outcome;
      }
      continue;
    }
    const detail = toolDetail(name, input);
    const outcome = answer?.behavior === "deny" ? "refused" : answer?.status === "pending" ? "waiting" : null;
    const step: IssueWork["steps"][number] = {
      tool: name,
      ...(detail ? { detail } : {}),
      at: st.createdAt.toISOString(),
      ...(outcome ? { outcome } : {}),
    };
    if (outcome === "waiting" && answer?.request_id)
      waiting.set(answer.request_id, [...(waiting.get(answer.request_id) ?? []), step]);
    const list = stepsOf.get(st.runId) ?? [];
    list.push(step);
    stepsOf.set(st.runId, list);
  }
  for (const r of withAgent) {
    const run = runOf.get(r.id);
    // A run of another agent (the issue changed hands) is not this agent's work.
    const mine = run && run.agentId === r.assigneeId ? run : undefined;
    const runSteps = mine ? (stepsOf.get(mine.id) ?? []).slice(-STEPS_SHOWN) : [];
    if (mine && LIVE_RUN.has(mine.status)) {
      out.set(r.id, {
        agentId: r.assigneeId as string,
        runId: mine.id,
        state: mine.status === "waiting_approval" || mine.status === "waiting_input" ? mine.status : "running",
        since: (mine.startedAt ?? mine.createdAt).toISOString(),
        steps: runSteps,
      });
      continue;
    }
    // Committed but not running: in progress with the agent, nothing alive.
    if (r.status !== "in_progress") continue;
    const reason =
      mine?.status === "canceled"
        ? ("canceled" as const)
        : mine?.status === "failed"
          ? mine.error === "budget_exceeded"
            ? ("budget" as const)
            : ("failed" as const)
          : undefined;
    out.set(r.id, {
      agentId: r.assigneeId as string,
      runId: mine?.id ?? null,
      state: "stalled",
      since: (mine ? (mine.finishedAt ?? mine.updatedAt) : r.updatedAt).toISOString(),
      steps: runSteps,
      ...(reason ? { reason } : {}),
    });
  }
  return out;
}

async function views(db: Database, rows: IssueRow[]): Promise<IssueView[]> {
  const [work, works, conversations] = await Promise.all([
    workOf(db, rows),
    backgroundWorksOf(db, rows),
    taskConversationSummaries(db, rows),
  ]);
  const ids = [...new Set(rows.flatMap((r) => r.artifactIds))];
  const files = ids.length
    ? await db
        .select({ id: artifacts.id, title: artifacts.title, type: artifacts.createdByType, by: artifacts.createdById })
        .from(artifacts)
        .where(and(inArray(artifacts.id, ids), isNull(artifacts.deletedAt)))
    : [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const orgId = rows[0]?.orgId;
  const columns = orgId ? await boardColumns(db, orgId) : [];
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    description: r.description,
    status: r.status,
    columnId: columnOf(columns, r)?.id ?? null,
    boardRank: r.boardRank,
    priority: r.priority,
    assignee: r.assigneeType && r.assigneeId ? { type: r.assigneeType as WorkActor["type"], id: r.assigneeId } : null,
    labels: r.labels,
    dueDate: r.dueDate,
    criteria: r.criteria,
    createdBy: { type: r.createdByType as WorkActor["type"], id: r.createdById },
    source: r.source as unknown as IssueSource,
    channelId: r.channelId,
    parentIssueId: r.parentIssueId,
    pullRequests: r.pullRequests as unknown as IssueView["pullRequests"],
    artifacts: r.artifactIds.flatMap((id) => {
      const f = byId.get(id);
      return f ? [{ id: f.id, title: f.title, createdBy: { type: f.type as WorkActor["type"], id: f.by } }] : [];
    }),
    work: work.get(r.id) ?? null,
    blocked: r.blocked ?? null,
    backgroundWork: works.get(r.id) ?? null,
    conversation: conversations.get(r.id) ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** The newest background work each card tracks (ADR 0121 §4). */
async function backgroundWorksOf(db: Database, rows: IssueRow[]): Promise<Map<string, WorkView>> {
  const ids = rows.map((r) => r.id);
  const out = new Map<string, WorkView>();
  if (ids.length === 0) return out;
  const w = schema.agentWorks;
  const latest = await db
    .selectDistinctOn([w.issueId], { id: w.id, issueId: w.issueId, orgId: w.orgId })
    .from(w)
    .where(inArray(w.issueId, ids))
    .orderBy(w.issueId, desc(w.createdAt));
  const orgId = rows[0]?.orgId;
  if (!orgId || latest.length === 0) return out;
  const views = await workViews(
    db,
    orgId,
    latest.map((l) => l.id),
  );
  for (const l of latest) {
    const v = views.get(l.id);
    if (v && l.issueId) out.set(l.issueId, v);
  }
  return out;
}

async function one(db: Database, row: IssueRow) {
  const [v] = await views(db, [row]);
  if (!v) throw new Error("issue view missing");
  return v;
}

async function addActivity(
  tx: Executor,
  issue: Pick<IssueRow, "id" | "orgId">,
  entry: { kind: "comment" | "event"; author: WorkActor; text: string; event?: string; data?: Record<string, unknown> },
) {
  const [row] = await tx
    .insert(issueActivity)
    .values({
      orgId: issue.orgId,
      issueId: issue.id,
      kind: entry.kind,
      authorType: entry.author.type,
      authorId: entry.author.id,
      text: entry.text,
      event: entry.event ?? null,
      data: entry.data ?? {},
    })
    .returning();
  if (!row) throw new Error("activity insert returned nothing");
  return row;
}

const activityView = (a: typeof issueActivity.$inferSelect): IssueActivityView => ({
  id: a.id,
  kind: a.kind as IssueActivityView["kind"],
  author: { type: a.authorType as WorkActor["type"], id: a.authorId },
  text: a.text,
  ...(a.event ? { event: a.event } : {}),
  ...(a.kind === "event" ? eventDetail(a.event, a.data as Record<string, unknown>) : {}),
  ...((a.data as Record<string, unknown>).auto === true ? { auto: true } : {}),
  ...(Array.isArray((a.data as Record<string, unknown>).attachments)
    ? { attachments: (a.data as { attachments: { id: string; title: string }[] }).attachments }
    : {}),
  createdAt: a.createdAt.toISOString(),
});

/** The code and params of an activity event, from its `event` and `data` (older rows lacking a param keep `text`). */
function eventDetail(event: string | null, data: Record<string, unknown>) {
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  const out = (textCode: string, textParams: Record<string, string> = {}) => ({ textCode, textParams });
  switch (event) {
    case "created":
    case "renamed":
    case "description_changed":
    case "criteria_changed":
    case "artifact_linked":
      return out(event);
    case "status_changed":
      return s(data.to) ? out(event, { status: s(data.to) as string }) : {};
    case "priority_changed":
      return s(data.to) ? out(event, { priority: s(data.to) as string }) : {};
    case "assigned":
      return "assignee" in data ? out(data.assignee ? "assigned" : "unassigned") : {};
    case "due_date":
      if (!("dueDate" in data)) return {};
      return s(data.dueDate) ? out("due_date_set", { date: s(data.dueDate) as string }) : out("due_date_removed");
    case "pr_linked":
      return s(data.number) ? out(event, { number: s(data.number) as string }) : {};
    case "criterion_checked":
      return s(data.text)
        ? out(data.done ? "criterion_checked" : "criterion_unchecked", { text: s(data.text) as string })
        : {};
    case "agent_asked":
      // `threadId`: the requester's DM thread where the work lives (only they can open it).
      return s(data.agentName)
        ? out(event, {
            name: s(data.agentName) as string,
            ...(s(data.threadId) ? { threadId: s(data.threadId) as string } : {}),
          })
        : {};
    case "work_update":
      return s(data.text) ? out(event, { text: s(data.text) as string }) : {};
    case "work_stopped":
      return out(event, s(data.byUserId) ? { byUserId: s(data.byUserId) as string } : {});
    case "shared_everyone":
      return out(event, {});
    default:
      return {};
  }
}

/** Tells whoever can see the issue: its channel, or the whole org. */
async function announce(
  pubsub: PubSub | undefined,
  orgId: string,
  issue: IssueView,
  type: "issue.created" | "issue.updated",
) {
  if (issue.channelId) await publishChannelEvent(pubsub, { type, channelId: issue.channelId, issue });
  else await publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type, issue } });
}

export interface IssueDeps {
  db: Database;
  pubsub?: PubSub;
}

/** Creates an issue with the next number of the org. */
export async function createIssue(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  input: IssueInput & {
    source?: IssueSource;
    channelId?: string | null;
    parentIssueId?: string | null;
    /** Drive files uploaded from the new-issue box: linked to the issue and kept on its "created" event. */
    attachmentIds?: string[];
  },
): Promise<IssueView> {
  const { db } = deps;
  const membership = await requireOrgMember(db, actor, orgId);
  if (membership && !can(membership, "post")) throw new ForbiddenError();
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new ValidationError("title is required");
  const files = await ownFiles(db, actor, orgId, input.attachmentIds);
  if (input.priority && !PRIORITIES.includes(input.priority)) throw new ValidationError("invalid priority");
  const criteria = (input.criteria ?? [])
    .map((text) => text.trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 50)
    .map((text) => ({ id: Bun.randomUUIDv7(), text, done: false }));
  const [parent] = input.parentIssueId
    ? await db
        .select({ channelId: issues.channelId })
        .from(issues)
        .where(and(eq(issues.id, input.parentIssueId), eq(issues.orgId, orgId)))
    : [];
  if (input.parentIssueId && (!parent || !(await canSee(db, actor, orgId, parent.channelId)))) {
    throw new ValidationError("The parent issue does not exist");
  }
  // A task never reaches further than where it was made: an agent's, its run's conversation. A step, its parent's.
  const madeIn = input.channelId ?? (actor.type === "agent" ? actor.channelId : null);
  const made = madeIn ? await conversationOf(db, orgId, madeIn) : null;
  const channelId = parent?.channelId ?? made?.tiedTo ?? (made?.task ? null : (input.channelId ?? null));
  await checkAssignee(db, orgId, input.assignee, channelId);
  const author = actorOf(actor);
  const source: IssueSource =
    input.source ?? (actor.type === "agent" ? { type: "agent", agentId: actor.agentId } : { type: "manual" });
  const row = await db.transaction(async (tx) => {
    const [counter] = await tx
      .insert(issueCounters)
      .values({ orgId, last: 1 })
      .onConflictDoUpdate({ target: issueCounters.orgId, set: { last: sql`${issueCounters.last} + 1` } })
      .returning();
    const [issue] = await tx
      .insert(issues)
      .values({
        orgId,
        number: counter?.last ?? 1,
        title,
        description: (input.description ?? "").slice(0, 50_000),
        priority: input.priority ?? "normal",
        boardRank: topRank(),
        assigneeType: input.assignee?.type ?? null,
        assigneeId: input.assignee?.id ?? null,
        labels: cleanLabels(input.labels) ?? [],
        dueDate: checkDate(input.dueDate) ?? null,
        criteria,
        source: source as unknown as Record<string, unknown>,
        channelId,
        parentIssueId: input.parentIssueId ?? null,
        ...(files.length ? { artifactIds: files.map((f) => f.id) } : {}),
        createdByType: author.type,
        createdById: author.id,
      })
      .returning();
    if (!issue) throw new Error("issue insert returned nothing");
    await addActivity(tx, issue, {
      kind: "event",
      author,
      text: "created the issue",
      event: "created",
      ...(files.length ? { data: { attachments: files } } : {}),
    });
    await enqueueIndex(tx, { orgId, kind: "issue", sourceId: issue.id });
    if (issue.description.includes("[[")) {
      await syncWikiLinks(tx, orgId, { type: "issue", id: issue.id, channelId: issue.channelId }, issue.description);
    }
    return issue;
  });
  const view = await one(db, row);
  await announce(deps.pubsub, orgId, view, "issue.created");
  if (row.assigneeType === "person") await notifyIssueChanged(deps, author, null, row).catch(() => {});
  // Routines on `issue.created` (ADR 0053 §6.5): never for an issue a routine or an unattended run created
  // (a routine would trigger itself), only for routines whose creator can see the issue, and with its id,
  // not its title (the run reads it with its own tools).
  const origin =
    actor.type === "person"
      ? "person"
      : actor.runId
        ? (await runAuthorityById(db, orgId, actor.runId).catch(() => null))?.kind
        : "unattended";
  if (origin === "person") {
    await fireRoutineEvent(
      deps,
      orgId,
      "issue.created",
      { summary: `New issue #${view.number} (id ${view.id})`, issueId: view.id, number: view.number, origin },
      {
        dedupeKey: `issue:${view.id}`,
        visibleTo: (userId) => canSee(db, { type: "person", userId }, orgId, row.channelId),
      },
    ).catch(() => 0);
  }
  return view;
}

async function findVisible(db: Database, actor: IssueActor, orgId: string, where: { id?: string; number?: number }) {
  await requireOrgMember(db, actor, orgId);
  const [row] = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        where.id ? eq(issues.id, where.id) : undefined,
        where.number !== undefined ? eq(issues.number, where.number) : undefined,
      ),
    );
  if (
    !row ||
    !(await canSee(
      db,
      actor,
      orgId,
      row.channelId,
      { type: row.assigneeType, id: row.assigneeId },
      row.conversationChannelId,
    ))
  )
    throw new NotFoundError("Issue not found");
  return row;
}

export async function getIssue(db: Database, actor: IssueActor, orgId: string, ref: { id?: string; number?: number }) {
  return one(db, await findVisible(db, actor, orgId, ref));
}

/** An issue with its sub-issues (the ones the actor can see). */
export async function getIssueDetail(
  db: Database,
  actor: IssueActor,
  orgId: string,
  ref: { id?: string; number?: number },
): Promise<IssueDetailView> {
  const row = await findVisible(db, actor, orgId, ref);
  const [view, children] = await Promise.all([
    one(db, row),
    db
      .select()
      .from(issues)
      .where(and(eq(issues.orgId, orgId), eq(issues.parentIssueId, row.id)))
      .orderBy(asc(issues.number)),
  ]);
  const subIssues: IssueDetailView["subIssues"] = [];
  for (const c of children) {
    if (!(await canSee(db, actor, orgId, c.channelId))) continue;
    subIssues.push({
      id: c.id,
      number: c.number,
      title: c.title,
      status: c.status,
      assignee: c.assigneeType && c.assigneeId ? { type: c.assigneeType as WorkActor["type"], id: c.assigneeId } : null,
    });
  }
  return { ...view, subIssues };
}

/** Issues the actor can see, open first then by most recent update. */
export async function listIssues(
  db: Database,
  actor: IssueActor,
  orgId: string,
  filters: { q?: string; status?: IssueStatus; assignee?: WorkActor; parentIssueId?: string; limit?: number } = {},
): Promise<IssueView[]> {
  await requireOrgMember(db, actor, orgId);
  const q = filters.q?.trim();
  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        filters.status ? eq(issues.status, filters.status) : undefined,
        filters.parentIssueId ? eq(issues.parentIssueId, filters.parentIssueId) : undefined,
        filters.assignee
          ? and(eq(issues.assigneeType, filters.assignee.type), eq(issues.assigneeId, filters.assignee.id))
          : undefined,
        q
          ? or(
              sql`${issues.title} ilike ${`%${q}%`}`,
              sql`${issues.description} ilike ${`%${q}%`}`,
              /^#?\d+$/.test(q) ? eq(issues.number, Number(q.replace("#", ""))) : undefined,
            )
          : undefined,
      ),
    )
    .orderBy(sql`${issues.status} in ('done', 'canceled')`, desc(issues.updatedAt))
    .limit(Math.min(500, filters.limit ?? 200));
  const visible: IssueRow[] = [];
  for (const r of rows) {
    const assignee = { type: r.assigneeType, id: r.assigneeId };
    if (await canSee(db, actor, orgId, r.channelId, assignee, r.conversationChannelId)) visible.push(r);
  }
  return views(db, visible);
}

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** Changes fields; each change is an event in the activity ("changed the status to In review"). */
export async function updateIssue(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  patch: IssuePatch & { addPullRequest?: { number: number; url: string }; addArtifactId?: string },
): Promise<IssueView> {
  const { db } = deps;
  const current = await findVisible(db, actor, orgId, { id: issueId });
  if (patch.status && !STATUSES.includes(patch.status)) throw new ValidationError("invalid status");
  if (patch.priority && !PRIORITIES.includes(patch.priority)) throw new ValidationError("invalid priority");
  if (patch.assignee !== undefined) await checkAssignee(db, orgId, patch.assignee, current.channelId);
  const author = actorOf(actor);
  const set: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() };
  const events: { text: string; event: string; data?: Record<string, unknown> }[] = [];
  if (patch.title?.trim() && patch.title.trim() !== current.title) {
    set.title = patch.title.trim().slice(0, 300);
    events.push({ text: "renamed the issue", event: "renamed" });
  }
  if (patch.description !== undefined && patch.description !== current.description) {
    set.description = patch.description.slice(0, 50_000);
    events.push({ text: "edited the description", event: "description_changed" });
  }
  // A board column carries its stage; a bare status lands on top of the stage's first column.
  const column = patch.columnId ? await columnForMove(db, orgId, patch.columnId) : null;
  const status = column?.stage ?? patch.status;
  if (column) set.columnId = column.id;
  if (status && status !== current.status) {
    set.status = status;
    if (!column) set.columnId = null;
    events.push({
      text: `changed the status to ${STATUS_WORDS[status]}`,
      event: "status_changed",
      data: { from: current.status, to: status },
    });
  }
  if (patch.boardRank !== undefined && Number.isFinite(patch.boardRank)) set.boardRank = patch.boardRank;
  else if (set.columnId !== undefined) set.boardRank = topRank();
  if (patch.priority && patch.priority !== current.priority) {
    set.priority = patch.priority;
    events.push({ text: "changed the priority", event: "priority_changed", data: { to: patch.priority } });
  }
  if (patch.assignee !== undefined) {
    set.assigneeType = patch.assignee?.type ?? null;
    set.assigneeId = patch.assignee?.id ?? null;
    events.push({
      text: patch.assignee ? "assigned the issue" : "removed the assignee",
      event: "assigned",
      data: { assignee: patch.assignee },
    });
  }
  if (patch.dueDate !== undefined) {
    set.dueDate = checkDate(patch.dueDate) ?? null;
    events.push({
      text: patch.dueDate ? `set the due date to ${patch.dueDate}` : "removed the due date",
      event: "due_date",
      data: { dueDate: patch.dueDate || null },
    });
  }
  if (patch.labels !== undefined) set.labels = cleanLabels(patch.labels) ?? [];
  if (patch.criteria !== undefined) {
    const criteria = editedCriteria(current.criteria, patch.criteria);
    const same =
      criteria.length === current.criteria.length &&
      criteria.every((c, k) => c.id === current.criteria[k]?.id && c.text === current.criteria[k]?.text);
    if (!same) {
      set.criteria = criteria;
      events.push({ text: "edited the acceptance criteria", event: "criteria_changed" });
    }
  }
  if (patch.addPullRequest) {
    // People open this link from the issue page: only an https address, never javascript:, data: or the like.
    if (!isHttpsUrl(patch.addPullRequest.url))
      throw new ValidationError("The pull request URL must be an https:// address");
    const prs = (current.pullRequests as unknown as IssueView["pullRequests"]).filter(
      (p) => p.url !== patch.addPullRequest?.url,
    );
    const pr = { number: patch.addPullRequest.number, url: patch.addPullRequest.url, openedBy: author };
    set.pullRequests = [...prs, pr] as unknown as Record<string, unknown>[];
    events.push({ text: `linked PR #${pr.number}`, event: "pr_linked", data: { url: pr.url, number: pr.number } });
  }
  // A linked PR moves open work to review on its own (unless the status is being set now).
  if (
    patch.addPullRequest &&
    !patch.status &&
    !patch.columnId &&
    (current.status === "todo" || current.status === "in_progress")
  ) {
    set.status = "in_review";
    set.columnId = null;
    set.boardRank = topRank();
    events.push({
      text: `changed the status to ${STATUS_WORDS.in_review} (automatic: a PR was linked)`,
      event: "status_changed",
      data: { from: current.status, to: "in_review", auto: true },
    });
  }
  if (patch.addArtifactId && !current.artifactIds.includes(patch.addArtifactId)) {
    set.artifactIds = [...current.artifactIds, patch.addArtifactId];
    events.push({ text: "attached a file", event: "artifact_linked", data: { artifactId: patch.addArtifactId } });
  }
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(issues).set(set).where(eq(issues.id, current.id)).returning();
    if (!updated) throw new NotFoundError("Issue not found");
    for (const e of events) await addActivity(tx, updated, { kind: "event", author, ...e });
    await enqueueIndex(tx, { orgId, kind: "issue", sourceId: updated.id });
    if (set.description !== undefined && (set.description.includes("[[") || current.description.includes("[["))) {
      await syncWikiLinks(tx, orgId, { type: "issue", id: updated.id, channelId: updated.channelId }, set.description);
    }
    return updated;
  });
  await linkRun(deps, actor, row);
  // A new agent assignee joins the task's conversation (ADR 0145): a mention there reaches it.
  if (patch.assignee?.type === "agent" && row.conversationChannelId) {
    await admitTaskAgents(db, orgId, row.conversationChannelId, { ids: [patch.assignee.id] });
  }
  const view = await one(db, (await reload(db, row)) ?? row);
  await announce(deps.pubsub, orgId, view, "issue.updated");
  // The inbox: a new assignee, a status change for whoever follows it.
  if (patch.assignee !== undefined || row.status !== current.status) {
    await notifyIssueChanged(deps, author, current, row).catch(() => {});
  }
  return view;
}

const reload = async (db: Database, row: IssueRow) => (await db.select().from(issues).where(eq(issues.id, row.id)))[0];

/**
 * The criteria a person edited in place: a kept one keeps its id and its check (and who checked it), a new one
 * starts unchecked; the same limits as at creation (500 characters each, 50 in all, empty lines dropped).
 */
function editedCriteria(current: IssueRow["criteria"], next: { id?: string; text: string }[]): IssueRow["criteria"] {
  const byId = new Map(current.map((c) => [c.id, c]));
  const seen = new Set<string>();
  return next
    .map((c) => ({ id: c.id, text: c.text.trim().slice(0, 500) }))
    .filter((c) => c.text)
    .slice(0, 50)
    .map((c) => {
      const kept = c.id && !seen.has(c.id) ? byId.get(c.id) : undefined;
      if (kept) {
        seen.add(kept.id);
        return { ...kept, text: c.text };
      }
      return { id: Bun.randomUUIDv7(), text: c.text, done: false };
    });
}

/**
 * An agent's run touched this issue (an issue tool, or "implement" asked):
 * the run is linked to it, and an issue the agent has that is still "to do"
 * moves to "in progress" on its own.
 */
async function linkRun(deps: IssueDeps, actor: IssueActor, issue: IssueRow) {
  if (actor.type !== "agent" || !actor.runId) return;
  await startedWork(deps, issue, actor.agentId, [actor.runId]);
}

async function startedWork(deps: IssueDeps, issue: IssueRow, agentId: string, runIds: string[]) {
  if (runIds.length === 0) return;
  await deps.db
    .update(agentRuns)
    .set({ issueId: issue.id })
    .where(and(inArray(agentRuns.id, runIds), isNull(agentRuns.issueId), eq(agentRuns.orgId, issue.orgId)));
  const [current] = await deps.db.select().from(issues).where(eq(issues.id, issue.id));
  const isMineToStart =
    current?.status === "todo" && current.assigneeType === "agent" && current.assigneeId === agentId;
  if (!current || !isMineToStart) return;
  await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(issues)
      .set({ status: "in_progress", columnId: null, boardRank: topRank(), updatedAt: new Date() })
      .where(and(eq(issues.id, current.id), eq(issues.status, "todo")))
      .returning();
    if (!updated) return;
    await addActivity(tx, updated, {
      kind: "event",
      author: { type: "agent", id: agentId },
      text: `changed the status to ${STATUS_WORDS.in_progress} (automatic: the agent started)`,
      event: "status_changed",
      data: { from: "todo", to: "in_progress", auto: true },
    });
  });
}

/** Checks or unchecks one acceptance criterion. */
export async function setCriterion(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  criterionId: string,
  done: boolean,
): Promise<IssueView> {
  const current = await findVisible(deps.db, actor, orgId, { id: issueId });
  const criterion = current.criteria.find((c) => c.id === criterionId);
  if (!criterion) throw new NotFoundError("Criterion not found");
  const criteria = current.criteria.map((c) =>
    c.id === criterionId ? { ...c, done, doneBy: done ? actorOf(actor) : null } : c,
  );
  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(issues)
      .set({ criteria, updatedAt: new Date() })
      .where(eq(issues.id, current.id))
      .returning();
    if (!updated) throw new NotFoundError("Issue not found");
    await addActivity(tx, updated, {
      kind: "event",
      author: actorOf(actor),
      text: `${done ? "checked" : "unchecked"} the criterion "${cutText(criterion.text, 80)}"`,
      event: "criterion_checked",
      data: { criterionId, done, text: cutText(criterion.text, 80) },
    });
    return updated;
  });
  await linkRun(deps, actor, row);
  const view = await one(deps.db, (await reload(deps.db, row)) ?? row);
  await announce(deps.pubsub, orgId, view, "issue.updated");
  return view;
}

export async function listIssueActivity(db: Database, actor: IssueActor, orgId: string, issueId: string) {
  const issue = await findVisible(db, actor, orgId, { id: issueId });
  const rows = await db
    .select()
    .from(issueActivity)
    .where(eq(issueActivity.issueId, issue.id))
    .orderBy(issueActivity.createdAt, issueActivity.id);
  return rows.map(activityView);
}

/**
 * Files attached from a box (new issue, comment): at most 10, in the org, not in the trash and uploaded by
 * this author, so an id alone can't pull someone else's file into an issue.
 */
async function ownFiles(db: Database, actor: IssueActor, orgId: string, attachmentIds: string[] | undefined) {
  const ids = [...new Set(attachmentIds ?? [])].slice(0, 10);
  if (ids.length === 0) return [];
  const files = await db
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, orgId),
        inArray(artifacts.id, ids),
        isNull(artifacts.deletedAt),
        eq(artifacts.createdByType, actorOf(actor).type),
        eq(artifacts.createdById, actorOf(actor).id),
      ),
    );
  if (files.length !== ids.length) throw new ValidationError("An attached file does not exist");
  // In the order they were attached.
  return ids.flatMap((id) => files.filter((f) => f.id === id));
}
/**
 * A comment: a reply in the task's conversation (ADR 0145), on the chat's own path. A person's goes like any
 * message there (a mention wakes the agent, receipts, the working line); an agent's (`comment_issue`, a reply
 * mirrored from elsewhere) is its own message there. Drive files uploaded for it show on it and are linked to
 * the issue. Notifications come from the message (`notifications.message`).
 */
export async function commentIssue(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  text: string,
  options: { attachmentIds?: string[] } = {},
): Promise<IssueActivityView> {
  const body = text.trim().slice(0, 20_000);
  if (!body && (options.attachmentIds ?? []).length === 0) throw new ValidationError("Comment is empty");
  const issue = await findVisible(deps.db, actor, orgId, { id: issueId });
  const files = await ownFiles(deps.db, actor, orgId, options.attachmentIds);
  const conversation = await ensureTaskConversation(deps.db, issue.id);
  const message = await postInConversation(
    deps,
    actor,
    orgId,
    conversation,
    body,
    files.map((f) => f.id),
  );
  const linked = [...issue.artifactIds, ...files.map((f) => f.id).filter((id) => !issue.artifactIds.includes(id))];
  await deps.db
    .update(issues)
    .set({ updatedAt: new Date(), ...(files.length ? { artifactIds: linked } : {}) })
    .where(eq(issues.id, issue.id));
  await linkRun(deps, actor, issue);
  return {
    id: message.id,
    kind: "comment",
    author: actorOf(actor),
    text: message.body,
    ...(files.length ? { attachments: files } : {}),
    createdAt: message.createdAt,
  };
}

/** A reply in the task's conversation by a person (the chat's send) or an agent (its own message). */
async function postInConversation(
  deps: IssueDeps,
  actor: IssueActor | { type: "agent"; agentId: string; runId?: string },
  orgId: string,
  at: TaskConversationRef,
  body: string,
  fileIds: string[] = [],
): Promise<MessageView> {
  if (!deps.pubsub) throw new Error("posting in a task's conversation needs pub/sub");
  if (actor.type === "person") {
    return postPersonMessage({ db: deps.db, pubsub: deps.pubsub }, actor.userId, orgId, at.channelId, {
      body,
      threadId: at.rootId,
      ...(fileIds.length ? { attachments: fileIds } : {}),
    });
  }
  const refs = fileIds.length
    ? await deps.db
        .select({ id: artifacts.id, version: artifacts.currentVersion, title: artifacts.title })
        .from(artifacts)
        .where(and(eq(artifacts.orgId, orgId), inArray(artifacts.id, fileIds)))
    : [];
  // It saw the task (the caller's check): later mentions of it there reach it.
  await admitTaskAgents(deps.db, orgId, at.channelId, { ids: [actor.agentId] });
  const message = await insertMessage(deps.db, {
    orgId,
    channelId: at.channelId,
    threadId: at.rootId,
    author: actor.runId
      ? { type: "agent", agentId: actor.agentId, runId: actor.runId, hop: 1 }
      : { type: "agent", agentId: actor.agentId, runId: null, hop: 1, stretchId: null },
    body,
    ...(refs.length ? { meta: { artifacts: fileIds.flatMap((id) => refs.filter((r) => r.id === id)) } } : {}),
  });
  const [view] = (await withWikiLinks(deps.db, orgId, [messageView(message)])) as [MessageView];
  await publishMessageCreated(deps.pubsub, view);
  return view;
}

/**
 * After a reply in a task's conversation (ADR 0145): its files are linked to the task (its Anexos), and whoever sees
 * the task gets its card with the new count.
 */
export async function announceTaskConversation(deps: IssueDeps, orgId: string, messageId: string) {
  const message = await getMessage(deps.db, orgId, messageId);
  if (!message?.threadId) return;
  const [issue] = await deps.db
    .select()
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.conversationChannelId, message.channelId)));
  if (!issue) return;
  const attached = Array.isArray(message.meta.artifacts) ? (message.meta.artifacts as { id?: unknown }[]) : [];
  const files = attached.flatMap((f) => (typeof f.id === "string" && !issue.artifactIds.includes(f.id) ? [f.id] : []));
  const row = files.length
    ? ((
        await deps.db
          .update(issues)
          // Appended in SQL: another write to the list meanwhile keeps its own.
          .set({
            artifactIds: sql`${issues.artifactIds} || array(select x from unnest(${`{${files.join(",")}}`}::uuid[]) x
              where not x = any(${issues.artifactIds}))`,
          })
          .where(eq(issues.id, issue.id))
          .returning()
      )[0] ?? issue)
    : issue;
  await announce(deps.pubsub, orgId, await one(deps.db, row), "issue.updated");
}

/** The task's conversation for whoever sees the task, made on first use (opening it, ADR 0145). */
export async function openTaskConversation(
  db: Database,
  actor: IssueActor,
  orgId: string,
  issueId: string,
): Promise<TaskConversationRef> {
  const issue = await findVisible(db, actor, orgId, { id: issueId });
  return ensureTaskConversation(db, issue.id);
}

/** "Turn into issue": a message becomes an issue that keeps its channel's visibility. */
export async function issueFromMessage(
  deps: IssueDeps,
  userId: string,
  orgId: string,
  messageId: string,
  input: { title?: string } = {},
) {
  const message = await getMessage(deps.db, orgId, messageId);
  if (!message) throw new NotFoundError("Message not found");
  const actor: IssueActor = { type: "person", userId };
  const made = await conversationOf(deps.db, orgId, message.channelId);
  // People are never members of a task's conversation: they read it as they read its task.
  if (!(await canSee(deps.db, actor, orgId, made.task ? made.tiedTo : message.channelId)))
    throw new NotFoundError("Message not found");
  const firstLine = message.body.split("\n")[0]?.trim() ?? "";
  return createIssue(deps, actor, orgId, {
    title: input.title?.trim() || firstLine.slice(0, 120) || "New issue",
    description: message.body,
    source: { type: "message", channelId: message.channelId, messageId: message.id },
    channelId: made.tiedTo,
  });
}

/**
 * "Ask Ada to implement": assigns the agent and starts its work in the task's own conversation (ADR 0145), where
 * everyone who sees the task follows it and talks to it, on a short line from the person ("Please implement issue
 * #N", `meta.issueWorkStart`). The instructions never show in the chat: the run's context builds them from the
 * issue (`issueWorkBrief`). Criteria, PR and status stay on the issue. An issue made from a channel message gets one
 * discreet line there (`meta.issueTaken`); nothing else is posted in channels.
 */
export async function askAgentToImplement(
  deps: IssueDeps,
  userId: string,
  orgId: string,
  issueId: string,
  agentId: string,
): Promise<IssueView> {
  const { db } = deps;
  if (!deps.pubsub) throw new Error("askAgentToImplement needs pub/sub");
  const pubsub = deps.pubsub;
  const actor: IssueActor = { type: "person", userId };
  const issue = await findVisible(db, actor, orgId, { id: issueId });
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!canTalkTo(agent, userId, await speakerFor(db, orgId, userId))) throw await audienceError(db, agent);
  const updated = await updateIssue(deps, actor, orgId, issue.id, { assignee: { type: "agent", id: agentId } });
  const conversation = await ensureTaskConversation(db, issue.id);
  await admitTaskAgents(db, orgId, conversation.channelId, { ids: [agentId] });
  const card: IssueWorkMeta = { issueId: issue.id, number: issue.number, title: issue.title, agentId };
  const { start, runId } = await db.transaction(async (tx) => {
    // What starts the run, in the conversation: short and human (shown in the person's language).
    const start = await insertMessage(tx, {
      orgId,
      channelId: conversation.channelId,
      threadId: conversation.rootId,
      author: { type: "person", userId },
      body: `Please implement issue #${issue.number}.`,
      meta: {
        issueId: issue.id,
        issueWorkStart: true,
        bodyCode: "issue_work_start",
        bodyParams: { number: issue.number },
      },
    });
    const { run } = await enqueueRunJob(tx, start, agentId);
    return { start, runId: run?.id ?? null };
  });
  await publishMessageCreated(pubsub, messageView(start));
  if (runId) {
    await publishChannelEvent(pubsub, {
      type: "agent.thinking",
      channelId: conversation.channelId,
      threadId: conversation.rootId,
      agentId,
      runId,
    });
  }
  await db.transaction(async (tx) => {
    await addActivity(tx, issue, {
      kind: "event",
      author: { type: "person", id: userId },
      text: `asked ${agent.name} to implement`,
      event: "agent_asked",
      data: {
        agentId,
        agentName: agent.name,
        channelId: conversation.channelId,
        messageId: start.id,
        threadId: conversation.rootId,
        inConversation: true,
      },
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "issue.agent_asked",
      target: { type: "issue", id: issue.id },
      details: { agentId },
    });
  });
  await announceTaken(deps, issue, card);
  await startedWork(deps, issue, agentId, runId ? [runId] : []);
  const fresh = await reload(db, issue);
  if (!fresh) return updated;
  const view = await one(db, fresh);
  await announce(pubsub, orgId, view, "issue.updated");
  return view;
}

/** An issue made from a channel message: one discreet line there ("Ada took issue #24"), never a thread. */
async function announceTaken(deps: IssueDeps, issue: IssueRow, card: IssueWorkMeta) {
  const source = issue.source as IssueSource;
  if (source.type !== "message" || !deps.pubsub) return;
  const origin = await getMessage(deps.db, issue.orgId, source.messageId);
  if (!origin || origin.channelId !== source.channelId) return;
  const [channel] = await deps.db
    .select({ kind: channels.kind, archivedAt: channels.archivedAt })
    .from(channels)
    .where(eq(channels.id, origin.channelId));
  if (!channel || channel.archivedAt) return;
  const line = await insertMessage(deps.db, {
    orgId: issue.orgId,
    channelId: origin.channelId,
    threadId: origin.threadId,
    author: { type: "agent", agentId: card.agentId, runId: null, hop: 0, stretchId: null },
    body: `Took issue #${card.number}: ${card.title}`.slice(0, 2_000),
    meta: { issueTaken: card, bodyCode: "issue_taken", bodyParams: { number: card.number } },
  });
  await publishMessageCreated(deps.pubsub, messageView(line));
}

/**
 * An agent's reply to a task it was asked to implement (trigger `meta.issueId`) goes to the task's conversation,
 * unless it was written there already (ADR 0145: where "Pedir ao" works now; older work threads lived in a DM).
 */
export async function mirrorReplyToIssue(
  deps: IssueDeps,
  run: { orgId: string; agentId: string; channelId: string },
  issueId: string,
  text: string,
) {
  const [issue] = await deps.db
    .select({ conversationChannelId: issues.conversationChannelId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orgId, run.orgId)));
  if (!issue || issue.conversationChannelId === run.channelId) return;
  await commentIssue(deps, { type: "agent", agentId: run.agentId, channelId: run.channelId }, run.orgId, issueId, text);
}

/**
 * A run started in an issue's work thread (or on its start message) works on that issue, as if it had
 * touched it with a tool: the issue shows it working instead of stalled. Only while the issue is open and
 * still this agent's.
 */
export async function linkRunToIssue(
  deps: IssueDeps,
  run: { id: string; orgId: string; agentId: string },
  issueId: string,
) {
  const [issue] = await deps.db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orgId, run.orgId)));
  // The issue's work is its latest linked run: a run in the thread of an agent it was taken from would hide
  // the assignee's.
  if (issue?.assigneeType !== "agent" || issue.assigneeId !== run.agentId || !OPEN_FOR_WORK.has(issue.status)) return;
  await startedWork(deps, issue, run.agentId, [run.id]);
}

const OPEN_TASKS_SHOWN = 5;

/**
 * A run's reminder of the agent's open tasks: issues assigned to it, not done or canceled, that it can see
 * from the run's channel, newest activity first. `updates`: it has the tools to keep them updated. Null when
 * there are none.
 */
export async function openTasksBrief(
  db: Database,
  orgId: string,
  agentId: string,
  channelId: string,
  updates: boolean,
) {
  const visible = await agentSearchChannels(db, orgId, agentId, channelId);
  const rows = await db
    .select({ number: issues.number, title: issues.title, status: issues.status, criteria: issues.criteria })
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        eq(issues.assigneeType, "agent"),
        eq(issues.assigneeId, agentId),
        inArray(issues.status, [...OPEN_FOR_WORK]),
        // What `canSee` lets it read from here: an issue of a private channel or DM would leak its title.
        or(
          isNull(issues.channelId),
          inArray(issues.channelId, visible),
          seenFromDmSql(orgId, channelId, sql`${issues.channelId}`),
          // From a task's own conversation: that task (ADR 0145), and what's tied to the same place.
          eq(issues.conversationChannelId, channelId),
          sql`${issues.channelId} = (select t.channel_id from ${issues} t where t.conversation_channel_id = ${channelId}::uuid)`,
        ),
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(OPEN_TASKS_SHOWN);
  if (rows.length === 0) return null;
  return [
    "# Your open tasks",
    "Issues assigned to you, latest activity first:",
    ...rows.map((r) => {
      const done = r.criteria.filter((c) => c.done).length;
      return `- #${r.number} ${r.title} (${r.status}${r.criteria.length ? `, criteria ${done}/${r.criteria.length}` : ""})`;
    }),
    ...(updates
      ? [
          "When what you're doing belongs to one of them, keep that task updated as you go: a short progress comment (`comment_issue`) and each criterion as you meet it (`update_issue`); its status moves on its own. That also ties your run to it, so the team sees you working on it.",
        ]
      : []),
  ].join("\n");
}

registerDocumentBuilder("issue", async (db, orgId, id) => {
  const [i] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, id), eq(issues.orgId, orgId)));
  if (!i) return null;
  return {
    orgId,
    kind: "issue",
    sourceId: i.id,
    channelIds: i.channelId ? [i.channelId] : [],
    title: `#${i.number} ${i.title}`,
    body: [i.description, ...i.criteria.map((c) => c.text)].join("\n").slice(0, 20_000),
    createdAt: i.createdAt,
  };
});

/**
 * Links a background work to its card (ADR 0121 §4): issue `number` when the agent named one it can see, else the issue
 * the run already works on, else a new card assigned to the agent in the conversation's channel (who reads the
 * conversation sees it). An existing card's criteria are never touched. Returns the issue's id.
 */
export async function linkIssueToWork(
  deps: IssueDeps,
  work: WorkRow,
  run: { id: string; orgId: string; agentId: string; channelId: string; issueId: string | null },
  input: { number?: number; description: string },
): Promise<string | null> {
  const actor: IssueActor = { type: "agent", agentId: run.agentId, channelId: run.channelId, runId: run.id };
  let issueId: string | null = null;
  if (input.number !== undefined) {
    // Only a card the person behind the work can read, in this conversation or workspace-wide: its updates must not
    // carry the conversation to readers it doesn't have.
    const found = work.requestedByUserId
      ? await findVisible(deps.db, { type: "person", userId: work.requestedByUserId }, run.orgId, {
          number: input.number,
        }).catch(() => null)
      : null;
    issueId = found && (found.channelId === null || found.channelId === work.channelId) ? found.id : null;
  }
  issueId ??= run.issueId;
  if (!issueId) {
    const created = await createIssue(deps, actor, run.orgId, {
      title: work.title,
      description: input.description,
      assignee: { type: "agent", id: run.agentId },
      source: {
        type: "agent",
        agentId: run.agentId,
        workId: work.id,
        channelId: work.channelId,
        messageId: work.anchorMessageId,
      },
      channelId: work.channelId,
    });
    issueId = created.id;
  }
  await deps.db.update(schema.agentWorks).set({ issueId }).where(eq(schema.agentWorks.id, work.id));
  await deps.db
    .update(agentRuns)
    .set({ issueId })
    .where(and(eq(agentRuns.workId, work.id), isNull(agentRuns.issueId)));
  await setWorkIssueState(deps, { ...work, issueId }, {});
  return issueId;
}

/**
 * A card follows its work (ADR 0121 §4): queued → A fazer, working → Em andamento, waiting on a person, paused or
 * failed → the blocked badge in its stage, done → Feito (left in review when the agent moved it there), stopped →
 * back to A fazer. An update is an activity event on it.
 */
export async function setWorkIssueState(
  deps: IssueDeps,
  work: Pick<WorkRow, "id" | "orgId" | "agentId" | "issueId">,
  input: { update?: string; plan?: boolean; ended?: "done" | "failed" | "canceled" },
) {
  if (!work.issueId) return;
  const view = (await workViews(deps.db, work.orgId, [work.id])).get(work.id);
  const [current] = await deps.db.select().from(issues).where(eq(issues.id, work.issueId));
  if (!view || !current || current.status === "canceled") return;
  const now = new Date();
  let status: IssueStatus = current.status;
  let blocked: IssueRow["blocked"] = null;
  const ended = input.ended ?? (view.status === "live" || view.status === "queued" ? null : view.status);
  if (ended === "done") status = current.status === "in_review" ? "in_review" : "done";
  else if (ended === "canceled") status = "todo";
  else if (ended === "failed") blocked = { reason: "failed", since: now.toISOString(), text: view.errorCode ?? "" };
  else if (view.state === "queued") status = current.status === "done" ? current.status : "todo";
  else {
    if (current.status === "todo" || current.status === "done") status = "in_progress";
    if (view.state && view.state !== "working")
      blocked = { reason: view.state, since: current.blocked?.since ?? now.toISOString() };
  }
  const author: WorkActor = { type: "agent", id: work.agentId };
  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(issues)
      .set({
        blocked,
        updatedAt: now,
        ...(status !== current.status ? { status, columnId: null, boardRank: topRank() } : {}),
      })
      .where(eq(issues.id, current.id))
      .returning();
    if (!updated) return null;
    if (status !== current.status) {
      await addActivity(tx, updated, {
        kind: "event",
        author,
        text: `changed the status to ${STATUS_WORDS[status]} (automatic: background work)`,
        event: "status_changed",
        data: { from: current.status, to: status, auto: true },
      });
    }
    if (input.update) {
      await addActivity(tx, updated, {
        kind: "event",
        author,
        text: input.update,
        event: "work_update",
        data: { text: input.update, workId: work.id, auto: true },
      });
    }
    if (ended === "canceled" && view.canceledByUserId) {
      await addActivity(tx, updated, {
        kind: "event",
        author,
        text: "stopped",
        event: "work_stopped",
        data: { byUserId: view.canceledByUserId, workId: work.id, auto: true },
      });
    }
    return updated;
  });
  if (!row) return;
  await announce(deps.pubsub, work.orgId, await one(deps.db, row), "issue.updated");
}

/**
 * "Mostrar para todos" (ADR 0121 §4): the one way a task tied to a conversation reaches the whole workspace, and only
 * someone who reads that conversation gets this far. A background work's card: who asked for that work, who created
 * the card or an admin. A task an agent made in the conversation has no other owner: anyone there. Any other issue
 * keeps its channel.
 */
export async function shareIssueWithEveryone(deps: IssueDeps, actor: IssueActor, orgId: string, issueId: string) {
  const current = await findVisible(deps.db, actor, orgId, { id: issueId });
  if (!current.channelId) return one(deps.db, current);
  if (actor.type !== "person") throw new ForbiddenError();
  const [work] = await deps.db
    .select({ requestedByUserId: schema.agentWorks.requestedByUserId })
    .from(schema.agentWorks)
    .where(and(eq(schema.agentWorks.orgId, orgId), eq(schema.agentWorks.issueId, current.id)))
    .orderBy(desc(schema.agentWorks.createdAt))
    .limit(1);
  const source = current.source as { type?: string; workId?: string };
  const ofWork = !!work || (source.type === "agent" && !!source.workId);
  if (!ofWork && current.createdByType !== "agent") throw new ForbiddenError();
  const membership = await requireActiveMembership(deps.db, actor.userId, orgId);
  const creator = current.createdByType === "person" && current.createdById === actor.userId;
  if (ofWork && work?.requestedByUserId !== actor.userId && !creator && !can(membership, "manage_agents"))
    throw new ForbiddenError();
  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(issues)
      .set({ channelId: null, updatedAt: new Date() })
      .where(eq(issues.id, current.id))
      .returning();
    if (updated)
      await addActivity(tx, updated, {
        kind: "event",
        author: actorOf(actor),
        text: "showed the card to everyone in the workspace",
        event: "shared_everyone",
        data: { channelId: current.channelId },
      });
    await enqueueIndex(tx, { orgId, kind: "issue", sourceId: current.id });
    return updated;
  });
  const view = await one(deps.db, row ?? current);
  await announce(deps.pubsub, orgId, view, "issue.updated");
  return view;
}
