import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { audienceError, canTalkTo } from "./audience";
import { recordAudit } from "./audit";
import { openDm } from "./dms";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated, publishOrgEvent } from "./events";
import type { IssueWorkMeta } from "./issue-work";
import { getMessage, insertMessage, messageView } from "./messages";
import { enqueueRunJob } from "./mission-runs";
import { notifyIssueChanged, notifyIssueComment } from "./notification-producers";
import { can, getMembership } from "./organizations";
import { fireRoutineEvent } from "./routines";
import { agentSearchChannels, enqueueIndex, registerDocumentBuilder } from "./search";
import { toolDetail } from "./tool-detail";
import { syncWikiLinks } from "./wiki-links";

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
  | { type: "forum"; threadId: string }
  | { type: "agent"; agentId: string }
  | { type: "webhook"; provider: string };

/** An issue as the app shows it. */
export interface IssueView {
  id: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee: WorkActor | null;
  labels: string[];
  dueDate: string | null;
  /** `doneBy`: who checked it (an agent shows its face next to it). */
  criteria: { id: string; text: string; done: boolean; doneBy?: WorkActor | null }[];
  createdBy: WorkActor;
  source: IssueSource;
  channelId: string | null;
  /** The issue this one is a sub-issue of (e.g. a plan step from the forum, D45). */
  parentIssueId: string | null;
  pullRequests: { number: number; url: string; openedBy: WorkActor | null }[];
  artifacts: { id: string; title: string; createdBy: WorkActor }[];
  /** The assigned agent's work on it, from its runs (null: a person has it, nobody, or it is closed). */
  work: IssueWork | null;
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
  /** The run's last tool calls, oldest first (safe labels only: built-in details, no connector inputs). */
  steps: { tool: string; detail?: string; at: string }[];
  /** Stalled: how the last run ended, when it did not finish on its own. */
  reason?: "failed" | "canceled" | "budget";
}

/** One issue with what hangs from it: its sub-issues and the forum topics that evaluate it. */
export interface IssueDetailView extends IssueView {
  subIssues: { id: string; number: number; title: string; status: IssueStatus; assignee: WorkActor | null }[];
  forumTopics: { id: string; title: string; status: string; format: string }[];
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
  priority: IssuePriority;
  assignee: WorkActor | null;
  dueDate: string | null;
  labels: string[];
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

async function checkAssignee(db: Database, orgId: string, a: WorkActor | null | undefined) {
  if (!a) return;
  if (a.type === "agent") {
    const agent = await getAgent(db, orgId, a.id);
    if (!agent || agent.archivedAt) throw new ValidationError("That agent does not exist in this organization");
  } else if (!(await getMembership(db, a.id, orgId))) {
    throw new ValidationError("That person is not a member of this organization");
  }
}

async function canSee(
  db: Database,
  actor: IssueActor,
  orgId: string,
  channelId: string | null,
  /** The issue's assignee: an agent working on it from a DM sees what the person there sees. */
  assignee?: { type: string | null; id: string | null },
) {
  if (!channelId) return true;
  if (actor.type === "agent") {
    if ((await agentSearchChannels(db, orgId, actor.agentId, actor.channelId)).includes(channelId)) return true;
    if (assignee?.type !== "agent" || assignee.id !== actor.agentId) return false;
    // Asked to implement it (its work lives in the requester's DM): visible when that person can see its channel.
    const [row] = await db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .innerJoin(channels, and(eq(channels.id, channelMembers.channelId), eq(channels.kind, "dm")))
      .where(
        and(
          eq(channelMembers.channelId, actor.channelId),
          eq(channelMembers.orgId, orgId),
          sql`${channelMembers.userId} is not null`,
          sql`exists (select 1 from ${channelMembers} cm2 where cm2.channel_id = ${channelId}::uuid
            and cm2.user_id = ${channelMembers.userId})`,
        ),
      )
      .limit(1);
    return Boolean(row);
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
  const membership = await getMembership(db, actor.userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
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
        .select({ runId: agentRunSteps.runId, data: agentRunSteps.data, createdAt: agentRunSteps.createdAt })
        .from(agentRunSteps)
        .where(and(inArray(agentRunSteps.runId, runIds), eq(agentRunSteps.kind, "tool_call")))
        .orderBy(asc(agentRunSteps.seq))
    : [];
  const stepsOf = new Map<string, IssueWork["steps"]>();
  for (const st of steps) {
    const name = typeof st.data.name === "string" ? st.data.name : "";
    if (!name) continue;
    const detail = toolDetail(name, st.data.input as Record<string, unknown> | undefined);
    const list = stepsOf.get(st.runId) ?? [];
    list.push({ tool: name, ...(detail ? { detail } : {}), at: st.createdAt.toISOString() });
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
  const work = await workOf(db, rows);
  const ids = [...new Set(rows.flatMap((r) => r.artifactIds))];
  const files = ids.length
    ? await db
        .select({ id: artifacts.id, title: artifacts.title, type: artifacts.createdByType, by: artifacts.createdById })
        .from(artifacts)
        .where(and(inArray(artifacts.id, ids), isNull(artifacts.deletedAt)))
    : [];
  const byId = new Map(files.map((f) => [f.id, f]));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    description: r.description,
    status: r.status,
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
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
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
    case "forum_opened":
    case "forum_evaluated":
      return s(data.title) ? out(event, { title: s(data.title) as string, topicId: s(data.topicId) ?? "" }) : {};
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
  input: IssueInput & { source?: IssueSource; channelId?: string | null; parentIssueId?: string | null },
): Promise<IssueView> {
  const { db } = deps;
  const membership = await requireOrgMember(db, actor, orgId);
  if (membership && !can(membership.role, "post")) throw new ForbiddenError();
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new ValidationError("title is required");
  if (input.priority && !PRIORITIES.includes(input.priority)) throw new ValidationError("invalid priority");
  await checkAssignee(db, orgId, input.assignee);
  const criteria = (input.criteria ?? [])
    .map((text) => text.trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 50)
    .map((text) => ({ id: Bun.randomUUIDv7(), text, done: false }));
  if (input.parentIssueId) {
    const [parent] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, input.parentIssueId), eq(issues.orgId, orgId)));
    if (!parent) throw new ValidationError("The parent issue does not exist");
  }
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
        assigneeType: input.assignee?.type ?? null,
        assigneeId: input.assignee?.id ?? null,
        labels: cleanLabels(input.labels) ?? [],
        dueDate: checkDate(input.dueDate) ?? null,
        criteria,
        source: source as unknown as Record<string, unknown>,
        channelId: input.channelId ?? null,
        parentIssueId: input.parentIssueId ?? null,
        createdByType: author.type,
        createdById: author.id,
      })
      .returning();
    if (!issue) throw new Error("issue insert returned nothing");
    await addActivity(tx, issue, { kind: "event", author, text: "created the issue", event: "created" });
    await enqueueIndex(tx, { orgId, kind: "issue", sourceId: issue.id });
    if (issue.description.includes("[[")) {
      await syncWikiLinks(tx, orgId, { type: "issue", id: issue.id, channelId: issue.channelId }, issue.description);
    }
    return issue;
  });
  const view = await one(db, row);
  await announce(deps.pubsub, orgId, view, "issue.created");
  if (row.assigneeType === "person") await notifyIssueChanged(deps, author, null, row).catch(() => {});
  await fireRoutineEvent(deps, orgId, "issue.created", {
    summary: `New issue #${view.number}: ${view.title}`,
    issueId: view.id,
  }).catch(() => 0);
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
  if (!row || !(await canSee(db, actor, orgId, row.channelId, { type: row.assigneeType, id: row.assigneeId })))
    throw new NotFoundError("Issue not found");
  return row;
}

export async function getIssue(db: Database, actor: IssueActor, orgId: string, ref: { id?: string; number?: number }) {
  return one(db, await findVisible(db, actor, orgId, ref));
}

/** An issue with its sub-issues (the ones the actor can see) and the forum topics that evaluate it. */
export async function getIssueDetail(
  db: Database,
  actor: IssueActor,
  orgId: string,
  ref: { id?: string; number?: number },
): Promise<IssueDetailView> {
  const row = await findVisible(db, actor, orgId, ref);
  const [view, children, topics] = await Promise.all([
    one(db, row),
    db
      .select()
      .from(issues)
      .where(and(eq(issues.orgId, orgId), eq(issues.parentIssueId, row.id)))
      .orderBy(asc(issues.number)),
    db
      .select({
        id: schema.forumTopics.id,
        title: schema.forumTopics.title,
        status: schema.forumTopics.status,
        format: schema.forumTopics.format,
      })
      .from(schema.forumTopics)
      .where(and(eq(schema.forumTopics.orgId, orgId), eq(schema.forumTopics.originIssueId, row.id)))
      .orderBy(asc(schema.forumTopics.createdAt)),
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
  return { ...view, subIssues, forumTopics: topics };
}

/**
 * The forum's mark on an issue's activity (D45): `forum_opened` ("in
 * evaluation in the forum") when a topic opens from it, `forum_evaluated`
 * when its synthesis is written (with `comment`: the summary and the link,
 * and the synthesis file linked to the issue). No visibility check: the
 * forum calls it for the topic it opened from this issue.
 */
export async function recordIssueForumEvent(
  deps: IssueDeps,
  orgId: string,
  issueId: string,
  author: WorkActor,
  event: "forum_opened" | "forum_evaluated",
  data: { topicId: string; title: string; artifactId?: string | null; version?: number | null },
  options: { comment?: string } = {},
) {
  const [issue] = await deps.db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)));
  if (!issue) return null;
  const row = await deps.db.transaction(async (tx) => {
    const a = await addActivity(tx, issue, {
      kind: "event",
      author,
      text:
        event === "forum_opened" ? `took it to the forum: "${data.title}"` : `the forum evaluated it: "${data.title}"`,
      event,
      data,
    });
    const comment = options.comment?.trim()
      ? await addActivity(tx, issue, { kind: "comment", author, text: options.comment.trim().slice(0, 20_000) })
      : null;
    const file = data.artifactId && !issue.artifactIds.includes(data.artifactId) ? data.artifactId : null;
    await tx
      .update(issues)
      .set({ updatedAt: new Date(), ...(file ? { artifactIds: [...issue.artifactIds, file] } : {}) })
      .where(eq(issues.id, issue.id));
    return [a, ...(comment ? [comment] : [])];
  });
  const activities = row.map(activityView);
  for (const activity of activities) {
    const e = { type: "issue.comment" as const, issueId: issue.id, activity };
    if (issue.channelId) await publishChannelEvent(deps.pubsub, { ...e, channelId: issue.channelId });
    else await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: e });
  }
  return activities;
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
  for (const r of rows) if (await canSee(db, actor, orgId, r.channelId)) visible.push(r);
  return views(db, visible);
}

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
  if (patch.assignee !== undefined) await checkAssignee(db, orgId, patch.assignee);
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
  if (patch.status && patch.status !== current.status) {
    set.status = patch.status;
    events.push({
      text: `changed the status to ${STATUS_WORDS[patch.status]}`,
      event: "status_changed",
      data: { from: current.status, to: patch.status },
    });
  }
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
  if (patch.addPullRequest) {
    const prs = (current.pullRequests as unknown as IssueView["pullRequests"]).filter(
      (p) => p.url !== patch.addPullRequest?.url,
    );
    const pr = { number: patch.addPullRequest.number, url: patch.addPullRequest.url, openedBy: author };
    set.pullRequests = [...prs, pr] as unknown as Record<string, unknown>[];
    events.push({ text: `linked PR #${pr.number}`, event: "pr_linked", data: { url: pr.url, number: pr.number } });
  }
  // A linked PR moves open work to review on its own (unless the status is being set now).
  if (patch.addPullRequest && !patch.status && (current.status === "todo" || current.status === "in_progress")) {
    set.status = "in_review";
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
  const view = await one(db, (await reload(db, row)) ?? row);
  await announce(deps.pubsub, orgId, view, "issue.updated");
  // The inbox (D46): a new assignee, a status change for whoever follows it.
  if (patch.assignee !== undefined || row.status !== current.status) {
    await notifyIssueChanged(deps, author, current, row).catch(() => {});
  }
  return view;
}

const reload = async (db: Database, row: IssueRow) => (await db.select().from(issues).where(eq(issues.id, row.id)))[0];

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
      .set({ status: "in_progress", updatedAt: new Date() })
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
      text: `${done ? "checked" : "unchecked"} the criterion "${criterion.text.slice(0, 80)}"`,
      event: "criterion_checked",
      data: { criterionId, done, text: criterion.text.slice(0, 80) },
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
 * A comment by a person or an agent (agents report progress this way). It may
 * carry Drive files (uploaded from the comment box): they show on the comment
 * and are linked to the issue.
 */
export async function commentIssue(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  text: string,
  options: { attachmentIds?: string[] } = {},
) {
  const body = text.trim().slice(0, 20_000);
  const ids = [...new Set(options.attachmentIds ?? [])].slice(0, 10);
  if (!body && ids.length === 0) throw new ValidationError("Comment is empty");
  const issue = await findVisible(deps.db, actor, orgId, { id: issueId });
  const files = ids.length
    ? await deps.db
        .select({ id: artifacts.id, title: artifacts.title })
        .from(artifacts)
        // Only files this author uploaded (from the comment box): an id alone can't pull in someone else's file.
        .where(
          and(
            eq(artifacts.orgId, orgId),
            inArray(artifacts.id, ids),
            isNull(artifacts.deletedAt),
            eq(artifacts.createdByType, actorOf(actor).type),
            eq(artifacts.createdById, actorOf(actor).id),
          ),
        )
    : [];
  if (files.length !== ids.length) throw new ValidationError("An attached file does not exist");
  const row = await deps.db.transaction(async (tx) => {
    const a = await addActivity(tx, issue, {
      kind: "comment",
      author: actorOf(actor),
      text: body,
      ...(files.length ? { data: { attachments: files } } : {}),
    });
    const linked = [...issue.artifactIds, ...files.map((f) => f.id).filter((id) => !issue.artifactIds.includes(id))];
    await tx
      .update(issues)
      .set({ updatedAt: new Date(), ...(files.length ? { artifactIds: linked } : {}) })
      .where(eq(issues.id, issue.id));
    return a;
  });
  const view = activityView(row);
  await linkRun(deps, actor, issue);
  const event = { type: "issue.comment" as const, issueId: issue.id, activity: view };
  if (issue.channelId) await publishChannelEvent(deps.pubsub, { ...event, channelId: issue.channelId });
  else await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event });
  if (body) await notifyIssueComment(deps, actorOf(actor), issue.id, row.id, body).catch(() => {});
  return view;
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
  if (!(await canSee(deps.db, actor, orgId, message.channelId))) throw new NotFoundError("Message not found");
  const [channel] = await deps.db
    .select({ visibility: channels.visibility, kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, message.channelId));
  const open = channel?.visibility === "public" && channel.kind === "channel";
  const firstLine = message.body.split("\n")[0]?.trim() ?? "";
  return createIssue(deps, actor, orgId, {
    title: input.title?.trim() || firstLine.slice(0, 120) || "New issue",
    description: message.body,
    source: { type: "message", channelId: message.channelId, messageId: message.id },
    channelId: open ? null : message.channelId,
  });
}

/**
 * "Ask Ada to implement": assigns the agent and starts its work in the
 * requester's DM with it, as a thread whose root is a compact card
 * (`meta.issueWork`); the run starts on a short line in that thread. The
 * instructions never show in the chat: the run's context builds them from
 * the issue (`issueWorkBrief`). The issue stays the public record: progress
 * comments (`comment_issue`), the final reply mirrored as a comment, criteria,
 * PR, status. An issue made from a channel message gets one discreet line
 * there (`meta.issueTaken`); nothing else is posted in channels.
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
  // The person must be able to talk to the agent (D31); the DM needs nothing else.
  if (!canTalkTo(agent, userId)) throw await audienceError(db, agent);
  const dm = await openDm(db, userId, orgId, { agentId });
  const updated = await updateIssue(deps, actor, orgId, issue.id, { assignee: { type: "agent", id: agentId } });
  const card: IssueWorkMeta = { issueId: issue.id, number: issue.number, title: issue.title, agentId };
  const { root, start, runId } = await db.transaction(async (tx) => {
    // The thread's root: the card (written directly, it routes to no agent).
    const root = await insertMessage(tx, {
      orgId,
      channelId: dm.id,
      author: { type: "person", userId },
      body: `Issue #${issue.number}: ${issue.title}`.slice(0, 2_000),
      meta: { issueWork: card },
    });
    // What starts the run, inside the thread: short and human (shown in the person's language).
    const start = await insertMessage(tx, {
      orgId,
      channelId: dm.id,
      threadId: root.id,
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
    return { root, start, runId: run?.id ?? null };
  });
  await publishMessageCreated(pubsub, messageView(root));
  await publishMessageCreated(pubsub, messageView(start));
  await db.transaction(async (tx) => {
    await addActivity(tx, issue, {
      kind: "event",
      author: { type: "person", id: userId },
      text: `asked ${agent.name} to implement`,
      event: "agent_asked",
      data: { agentId, agentName: agent.name, channelId: dm.id, messageId: root.id, threadId: root.id },
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
  if (!channel || channel.archivedAt || channel.kind === "forum") return;
  const line = await insertMessage(deps.db, {
    orgId: issue.orgId,
    channelId: origin.channelId,
    threadId: origin.threadId,
    author: { type: "agent", agentId: card.agentId, runId: null, hop: 0 },
    body: `Took issue #${card.number}: ${card.title}`.slice(0, 2_000),
    meta: { issueTaken: card, bodyCode: "issue_taken", bodyParams: { number: card.number } },
  });
  await publishMessageCreated(deps.pubsub, messageView(line));
}

/** Mirrors an agent's final reply to the issue it was asked to implement (trigger `meta.issueId`). */
export async function mirrorReplyToIssue(
  deps: IssueDeps,
  run: { orgId: string; agentId: string; channelId: string },
  issueId: string,
  text: string,
) {
  await commentIssue(deps, { type: "agent", agentId: run.agentId, channelId: run.channelId }, run.orgId, issueId, text);
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
