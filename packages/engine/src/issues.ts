import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishOrgEvent } from "./events";
import { getMessage, postPersonMessage } from "./messages";
import { can, getMembership } from "./organizations";
import { fireRoutineEvent } from "./routines";
import { agentSearchChannels, enqueueIndex, registerDocumentBuilder } from "./search";
import { syncWikiLinks } from "./wiki-links";

const { issues, issueActivity, issueCounters, channels, channelMembers, artifacts } = schema;

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
  criteria: { id: string; text: string; done: boolean }[];
  createdBy: WorkActor;
  source: IssueSource;
  channelId: string | null;
  pullRequests: { number: number; url: string; openedBy: WorkActor | null }[];
  artifacts: { id: string; title: string; createdBy: WorkActor }[];
  createdAt: string;
  updatedAt: string;
}

export interface IssueActivityView {
  id: string;
  kind: "comment" | "event";
  author: WorkActor;
  text: string;
  event?: string;
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
export type IssueActor = { type: "person"; userId: string } | { type: "agent"; agentId: string; channelId: string };

type IssueRow = typeof issues.$inferSelect;

const STATUSES: readonly IssueStatus[] = ["todo", "in_progress", "in_review", "done", "canceled"];
const PRIORITIES: readonly IssuePriority[] = ["low", "normal", "high"];
const STATUS_WORDS: Record<IssueStatus, string> = {
  todo: "A fazer",
  in_progress: "Em andamento",
  in_review: "Em revisão",
  done: "Concluída",
  canceled: "Cancelada",
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

async function views(db: Database, rows: IssueRow[]): Promise<IssueView[]> {
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
  createdAt: a.createdAt.toISOString(),
});

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
    await addActivity(tx, issue, { kind: "event", author, text: "criou a issue", event: "created" });
    await enqueueIndex(tx, { orgId, kind: "issue", sourceId: issue.id });
    if (issue.description.includes("[[")) {
      await syncWikiLinks(tx, orgId, { type: "issue", id: issue.id, channelId: issue.channelId }, issue.description);
    }
    return issue;
  });
  const view = await one(db, row);
  await announce(deps.pubsub, orgId, view, "issue.created");
  await fireRoutineEvent(deps, orgId, "issue.created", {
    summary: `Nova issue #${view.number}: ${view.title}`,
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

/** Changes fields; each change is an event in the activity ("mudou o status para Em revisão"). */
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
    events.push({ text: "renomeou a issue", event: "renamed" });
  }
  if (patch.description !== undefined && patch.description !== current.description) {
    set.description = patch.description.slice(0, 50_000);
    events.push({ text: "editou a descrição", event: "description_changed" });
  }
  if (patch.status && patch.status !== current.status) {
    set.status = patch.status;
    events.push({
      text: `mudou o status para ${STATUS_WORDS[patch.status]}`,
      event: "status_changed",
      data: { from: current.status, to: patch.status },
    });
  }
  if (patch.priority && patch.priority !== current.priority) {
    set.priority = patch.priority;
    events.push({ text: "mudou a prioridade", event: "priority_changed", data: { to: patch.priority } });
  }
  if (patch.assignee !== undefined) {
    set.assigneeType = patch.assignee?.type ?? null;
    set.assigneeId = patch.assignee?.id ?? null;
    events.push({
      text: patch.assignee ? "atribuiu a issue" : "removeu o responsável",
      event: "assigned",
      data: { assignee: patch.assignee },
    });
  }
  if (patch.dueDate !== undefined) {
    set.dueDate = checkDate(patch.dueDate) ?? null;
    events.push({
      text: patch.dueDate ? `definiu o prazo para ${patch.dueDate}` : "removeu o prazo",
      event: "due_date",
    });
  }
  if (patch.labels !== undefined) set.labels = cleanLabels(patch.labels) ?? [];
  if (patch.addPullRequest) {
    const prs = (current.pullRequests as unknown as IssueView["pullRequests"]).filter(
      (p) => p.url !== patch.addPullRequest?.url,
    );
    const pr = { number: patch.addPullRequest.number, url: patch.addPullRequest.url, openedBy: author };
    set.pullRequests = [...prs, pr] as unknown as Record<string, unknown>[];
    events.push({ text: `ligou o PR #${pr.number}`, event: "pr_linked", data: { url: pr.url } });
  }
  if (patch.addArtifactId && !current.artifactIds.includes(patch.addArtifactId)) {
    set.artifactIds = [...current.artifactIds, patch.addArtifactId];
    events.push({ text: "anexou um arquivo", event: "artifact_linked", data: { artifactId: patch.addArtifactId } });
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
  const view = await one(db, row);
  await announce(deps.pubsub, orgId, view, "issue.updated");
  return view;
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
  const criteria = current.criteria.map((c) => (c.id === criterionId ? { ...c, done } : c));
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
      text: `${done ? "marcou" : "desmarcou"} o critério "${criterion.text.slice(0, 80)}"`,
      event: "criterion_checked",
      data: { criterionId, done },
    });
    return updated;
  });
  const view = await one(deps.db, row);
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
  const event = { type: "issue.comment" as const, issueId: issue.id, activity: view };
  if (issue.channelId) await publishChannelEvent(deps.pubsub, { ...event, channelId: issue.channelId });
  else await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event });
  return view;
}

/** "Transformar em issue": a message becomes an issue that keeps its channel's visibility. */
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
    title: input.title?.trim() || firstLine.slice(0, 120) || "Nova issue",
    description: message.body,
    source: { type: "message", channelId: message.channelId, messageId: message.id },
    channelId: open ? null : message.channelId,
  });
}

/**
 * "Pedir à Ada para implementar": assigns the agent and asks it in a channel
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
    `@${agent.handle} implementa a issue #${issue.number}: ${issue.title}`,
    issue.description.trim(),
    criteria ? `Critérios de aceite:\n${criteria}` : "",
    `Conte o andamento na issue com comment_issue (issue_id ${issue.id}) e ligue o PR com update_issue.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!deps.pubsub) throw new Error("askAgentToImplement needs pub/sub");
  const message = await postPersonMessage({ db, pubsub: deps.pubsub }, userId, orgId, channelId, {
    body,
    meta: { issueId: issue.id },
  });
  await db.transaction(async (tx) => {
    await addActivity(tx, issue, {
      kind: "event",
      author: { type: "person", id: userId },
      text: `pediu a ${agent.name} para implementar`,
      event: "agent_asked",
      data: { agentId, channelId, messageId: message.id },
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "issue.agent_asked",
      target: { type: "issue", id: issue.id },
      details: { agentId },
    });
  });
  return updated;
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
