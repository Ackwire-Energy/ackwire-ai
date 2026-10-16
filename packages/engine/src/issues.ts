import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishOrgEvent } from "./events";
import { getMessage, postPersonMessage } from "./messages";
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

async function canSee(db: Database, actor: IssueActor, orgId: string, channelId: string | null) {
  if (!channelId) return true;
  if (actor.type === "agent")
    return (await agentSearchChannels(db, orgId, actor.agentId, actor.channelId)).includes(channelId);
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
      return s(data.agentName) ? out(event, { name: s(data.agentName) as string }) : {};
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
  input: IssueInput & { source?: IssueSource; channelId?: string | null },
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
  if (!row || !(await canSee(db, actor, orgId, row.channelId))) throw new NotFoundError("Issue not found");
  return row;
}

export async function getIssue(db: Database, actor: IssueActor, orgId: string, ref: { id?: string; number?: number }) {
  return one(db, await findVisible(db, actor, orgId, ref));
}

/** Issues the actor can see, open first then by most recent update. */
export async function listIssues(
  db: Database,
  actor: IssueActor,
  orgId: string,
  filters: { q?: string; status?: IssueStatus; assignee?: WorkActor; limit?: number } = {},
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

/** A comment by a person or an agent (agents report progress this way). */
export async function commentIssue(deps: IssueDeps, actor: IssueActor, orgId: string, issueId: string, text: string) {
  const body = text.trim().slice(0, 20_000);
  if (!body) throw new ValidationError("Comment is empty");
  const issue = await findVisible(deps.db, actor, orgId, { id: issueId });
  const row = await deps.db.transaction(async (tx) => {
    const a = await addActivity(tx, issue, { kind: "comment", author: actorOf(actor), text: body });
    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    return a;
  });
  const view = activityView(row);
  await linkRun(deps, actor, issue);
  const event = { type: "issue.comment" as const, issueId: issue.id, activity: view };
  if (issue.channelId) await publishChannelEvent(deps.pubsub, { ...event, channelId: issue.channelId });
  else await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event });
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
 * "Ask Ada to implement": assigns the agent and asks it in a channel
 * it works in (the issue's channel, else #general, else its first channel).
 * The run reports progress as issue comments (`comment_issue`); its final
 * reply is mirrored as a comment. Sensitive actions still need approval.
 */
export async function askAgentToImplement(
  deps: IssueDeps,
  userId: string,
  orgId: string,
  issueId: string,
  agentId: string,
): Promise<IssueView> {
  const { db } = deps;
  const actor: IssueActor = { type: "person", userId };
  const issue = await findVisible(db, actor, orgId, { id: issueId });
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  const memberships = await db
    .select({ channelId: channelMembers.channelId, name: channels.name })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.agentId, agentId), eq(channels.kind, "channel"), isNull(channels.archivedAt)));
  const candidates = [
    ...memberships.filter((m) => m.channelId === issue.channelId),
    ...memberships.filter((m) => m.name === "general"),
    ...memberships,
  ];
  let channelId: string | null = null;
  for (const c of candidates) {
    const [mine] = await db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, c.channelId), eq(channelMembers.userId, userId)));
    if (mine) {
      channelId = c.channelId;
      break;
    }
  }
  if (!channelId) throw new ValidationError("Add the agent to a channel you are in first");
  const updated = await updateIssue(deps, actor, orgId, issue.id, { assignee: { type: "agent", id: agentId } });
  const criteria = issue.criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n");
  const body = [
    `@${agent.handle} implement issue #${issue.number}: ${issue.title}`,
    issue.description.trim(),
    criteria ? `Acceptance criteria:\n${criteria}` : "",
    `Report progress on the issue with comment_issue (issue_id ${issue.id}), check the criteria you meet with update_issue (done_criteria), and link the PR with update_issue. The issue's status follows your work on its own.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!deps.pubsub) throw new Error("askAgentToImplement needs pub/sub");
  const message = await postPersonMessage({ db, pubsub: deps.pubsub }, userId, orgId, channelId, {
    body,
    meta: { issueId: issue.id },
  });
  // The message started the agent's run: it works on this issue from now on.
  const runs = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.triggerMessageId, message.id), eq(agentRuns.agentId, agentId)));
  await db.transaction(async (tx) => {
    await addActivity(tx, issue, {
      kind: "event",
      author: { type: "person", id: userId },
      text: `asked ${agent.name} to implement`,
      event: "agent_asked",
      data: { agentId, agentName: agent.name, channelId, messageId: message.id },
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "issue.agent_asked",
      target: { type: "issue", id: issue.id },
      details: { agentId },
    });
  });
  await startedWork(
    deps,
    issue,
    agentId,
    runs.map((r) => r.id),
  );
  const fresh = await reload(db, issue);
  if (!fresh) return updated;
  const view = await one(db, fresh);
  await announce(deps.pubsub, orgId, view, "issue.updated");
  return view;
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
