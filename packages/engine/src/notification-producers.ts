import { and, asc, eq, inArray, isNotNull, schema } from "@agenteschat/db";
import {
  type NotificationActor,
  type NotificationDeps,
  type NotificationSource,
  notificationSnippet,
  notify,
  resolveNotifications,
} from "./notifications";

/**
 * Where notifications come from (D46): each flow calls one of these after
 * its change committed. They read what they need themselves (no imports of
 * the flows' modules, so no import cycles) and never throw into the flow:
 * callers add `.catch(() => {})`.
 */

const {
  messages,
  channels,
  channelMembers,
  threads,
  agentRuns,
  agents,
  organizationMembers,
  issues,
  issueActivity,
  missions,
  missionParticipants,
  routines,
  messageReactions,
} = schema;

type ApprovalRow = typeof schema.approvals.$inferSelect;
type QuestionRow = typeof schema.agentQuestions.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type TopicRow = typeof schema.forumTopics.$inferSelect;
type MissionRow = typeof missions.$inferSelect;

const person = (id: string | null | undefined): NotificationActor | null => (id ? { type: "user", id } : null);
const agent = (id: string | null | undefined): NotificationActor | null => (id ? { type: "agent", id } : null);

/** `@handle` tokens (same rule as chat mentions), lower-cased. */
function handlesIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/g)) {
    if (m[2]) found.add(m[2].toLowerCase());
  }
  return [...found];
}

/** The people among `userIds` who are members of the channel (private channels and DMs stay private). */
async function inChannel(deps: NotificationDeps, channelId: string, userIds: string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await deps.db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), inArray(channelMembers.userId, ids)));
  return rows.flatMap((r) => (r.userId ? [r.userId] : []));
}

/** The person behind a run: the author of its trigger, following agent hand-offs (at most 6 hops). */
async function requesterOfRun(deps: NotificationDeps, orgId: string, runId: string | null): Promise<string | null> {
  let current = runId;
  for (let hop = 0; current && hop < 6; hop++) {
    const [run] = await deps.db
      .select({ trigger: agentRuns.triggerMessageId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, current), eq(agentRuns.orgId, orgId)));
    if (!run) return null;
    const [m] = await deps.db
      .select({ userId: messages.authorUserId, runId: messages.agentRunId })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, run.trigger)));
    if (!m) return null;
    if (m.userId) return m.userId;
    current = m.runId;
  }
  return null;
}

async function agentOwner(deps: NotificationDeps, agentId: string) {
  const [a] = await deps.db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, agentId));
  return a?.owner ?? null;
}

// ── Chat: mentions, thread replies, DMs ───────────────────────────────────────

/**
 * Job `notifications.message` (enqueued in the message's own statement):
 * people mentioned (`mention`), the other person of a DM (`dm`), and the
 * people in a thread (`thread_reply`, merged per thread). Cards of the
 * agent's own flows (questions, approvals, secret requests) notify through
 * those flows instead; the forum notifies through its turns.
 */
export async function notifyMessage(deps: NotificationDeps, orgId: string, messageId: string) {
  const { db } = deps;
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  if (!message || message.deletedAt) return;
  const meta = message.meta;
  if (meta.questionId || meta.approvalId || meta.secretRequestId || meta.forum) return;
  const [channel] = await db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(and(eq(channels.id, message.channelId), eq(channels.orgId, orgId)));
  if (!channel || channel.kind === "forum") return;
  const actor = message.authorType === "person" ? person(message.authorUserId) : agent(message.authorAgentId);
  const authorUser = message.authorUserId;
  const text = notificationSnippet(message.body);
  const label = channel.kind === "channel" ? channel.name : undefined;
  const where: NotificationSource = {
    channelId: message.channelId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    messageId: message.id,
    ...(channel.kind === "dm" ? { dmId: message.channelId } : {}),
  };
  const done = new Set<string>(authorUser ? [authorUser] : []);

  // A DM from a person: the other person hears it (an agent's replies in a DM are the conversation itself).
  if (channel.kind === "dm") {
    if (message.authorType !== "person") return;
    const others = await db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, message.channelId), isNotNull(channelMembers.userId)));
    const to = others.flatMap((o) => (o.userId && o.userId !== authorUser ? [o.userId] : []));
    await notify(deps, {
      orgId,
      userIds: to,
      kind: "dm",
      groupKey: `dm:${message.id}`,
      actor,
      source: where,
      latest: { text },
    });
    return;
  }

  const mentioned = await inChannel(
    deps,
    message.channelId,
    message.mentionedUserIds.filter((u) => !done.has(u)),
  );
  let threadLabel: string | undefined;
  if (message.threadId) threadLabel = await threadTitle(deps, orgId, message.threadId);
  if (mentioned.length > 0) {
    await notify(deps, {
      orgId,
      userIds: mentioned,
      kind: "mention",
      groupKey: `mention:${message.id}`,
      actor,
      source: { ...where, label: threadLabel ?? label },
      latest: { text },
    });
    for (const u of mentioned) done.add(u);
  }

  // A reply in a thread: the people in it (who started it or wrote in it).
  // A routine's answer reaches its creator as `routine_finished` instead.
  if (!message.threadId || meta.viaRoutine) return;
  const [root] = await db
    .select({ authorUserId: messages.authorUserId, meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, message.threadId)));
  const people = await db
    .selectDistinct({ userId: messages.authorUserId })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.threadId, message.threadId),
        eq(messages.authorType, "person"),
        isNotNull(messages.authorUserId),
      ),
    );
  const starter = root && !root.meta.routine && !root.meta.forum ? root.authorUserId : null;
  const inThread = [starter, ...people.map((p) => p.userId)].filter((u): u is string => !!u && !done.has(u));
  const to = await inChannel(deps, message.channelId, inThread);
  if (to.length === 0) return;
  await notify(deps, {
    orgId,
    userIds: to,
    kind: "thread_reply",
    groupKey: `thread:${message.threadId}`,
    actor,
    source: { ...where, label: threadLabel ?? label },
    latest: { text },
  });
}

async function threadTitle(deps: NotificationDeps, orgId: string, rootId: string) {
  const [t] = await deps.db
    .select({ title: threads.title })
    .from(threads)
    .where(and(eq(threads.orgId, orgId), eq(threads.rootMessageId, rootId)));
  if (t?.title) return t.title;
  const [root] = await deps.db
    .select({ body: messages.body })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, rootId)));
  return root ? notificationSnippet(root.body, 80) || undefined : undefined;
}

const REACTION_EMOJI: Record<string, string> = { "+1": "👍", "-1": "👎" };

/**
 * Someone (a person or an agent) reacted to a person's message: its author
 * hears it (merged per message, also for 30 min after reading).
 */
export async function notifyReaction(
  deps: NotificationDeps,
  input: { orgId: string; messageId: string; userId?: string | null; agentId?: string | null },
) {
  const { db } = deps;
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, input.orgId), eq(messages.id, input.messageId)));
  if (message?.authorType !== "person" || !message.authorUserId) return;
  if (input.userId && message.authorUserId === input.userId) return;
  const actor = input.userId ? person(input.userId) : agent(input.agentId);
  if (!actor) return;
  const [channel] = await db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, message.channelId));
  const given = await db
    .select({ reaction: messageReactions.reaction, userId: messageReactions.userId })
    .from(messageReactions)
    .where(and(eq(messageReactions.orgId, input.orgId), eq(messageReactions.messageId, message.id)))
    .orderBy(asc(messageReactions.createdAt));
  const emojis = [
    ...new Set(
      given.filter((g) => g.userId !== message.authorUserId).map((g) => REACTION_EMOJI[g.reaction] ?? g.reaction),
    ),
  ].slice(-5);
  await notify(deps, {
    orgId: input.orgId,
    userIds: [message.authorUserId],
    kind: "reaction",
    groupKey: `reaction:${message.id}`,
    actor,
    source: {
      channelId: message.channelId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      messageId: message.id,
      ...(channel?.kind === "dm" ? { dmId: message.channelId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
    },
    latest: { emojis, quote: notificationSnippet(message.body, 140) },
  });
}

// ── Agent questions ───────────────────────────────────────────────────────────

/** An agent asked (`ask_user`) and waits: the person behind the run (else the agent's owner). */
export async function notifyQuestion(deps: NotificationDeps, q: QuestionRow) {
  const to = (await requesterOfRun(deps, q.orgId, q.runId)) ?? (await agentOwner(deps, q.agentId));
  if (!to) return;
  const [channel] = await deps.db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, q.channelId));
  await notify(deps, {
    orgId: q.orgId,
    userIds: [to],
    kind: "agent_question",
    groupKey: `agent_question:${q.id}`,
    waiting: true,
    actor: agent(q.agentId),
    source: {
      channelId: q.channelId,
      ...(q.threadId ? { threadId: q.threadId } : {}),
      ...(q.messageId ? { messageId: q.messageId } : {}),
      ...(channel?.kind === "dm" ? { dmId: q.channelId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
      questionId: q.id,
    },
    latest: { text: notificationSnippet(q.text), suggestions: q.choices ?? undefined },
  });
}

/** Answered (by anyone) or expired: out of everyone's inbox. */
export async function resolveQuestionNotifications(deps: NotificationDeps, orgId: string, questionId: string) {
  await resolveNotifications(deps, orgId, { groupKey: `agent_question:${questionId}` });
}

// ── Approvals ─────────────────────────────────────────────────────────────────

/** A sensitive action waits: everyone who may decide it. */
export async function notifyApproval(deps: NotificationDeps, approval: ApprovalRow, deciders: string[]) {
  const [channel] = await deps.db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, approval.channelId));
  await notify(deps, {
    orgId: approval.orgId,
    userIds: deciders,
    kind: "approval",
    groupKey: `approval:${approval.id}`,
    waiting: true,
    actor: agent(approval.agentId),
    source: {
      approvalId: approval.id,
      channelId: approval.channelId,
      threadId: approval.threadRootId,
      ...(approval.messageId ? { messageId: approval.messageId } : {}),
      ...(approval.missionId ? { missionId: approval.missionId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
    },
    latest: {
      title: notificationSnippet(approval.title, 200),
      text: notificationSnippet(approval.detail),
      expiresAt: approval.expiresAt.toISOString(),
    },
  });
}

export async function resolveApprovalNotifications(deps: NotificationDeps, orgId: string, approvalId: string) {
  await resolveNotifications(deps, orgId, { groupKey: `approval:${approvalId}` });
}

// ── Issues ────────────────────────────────────────────────────────────────────

/** Who follows an issue: its author, its assignee, and the people who commented or acted on it. */
async function issueFollowers(deps: NotificationDeps, issue: IssueRow) {
  const acted = await deps.db
    .selectDistinct({ userId: issueActivity.authorId })
    .from(issueActivity)
    .where(and(eq(issueActivity.issueId, issue.id), eq(issueActivity.authorType, "person")));
  const ids = new Set<string>(acted.map((a) => a.userId));
  if (issue.createdByType === "person") ids.add(issue.createdById);
  if (issue.assigneeType === "person" && issue.assigneeId) ids.add(issue.assigneeId);
  return visibleOnIssue(deps, issue, [...ids]);
}

/** An issue of a channel is seen by its members only; an org-wide one by everyone in the org. */
async function visibleOnIssue(deps: NotificationDeps, issue: IssueRow, userIds: string[]) {
  return issue.channelId ? inChannel(deps, issue.channelId, userIds) : userIds;
}

const issueSource = (issue: IssueRow): NotificationSource => ({
  issueId: issue.id,
  issueNumber: issue.number,
  ...(issue.channelId ? { channelId: issue.channelId } : {}),
  label: issue.title,
});

export type IssueNotifyActor = { type: "person"; id: string } | { type: "agent"; id: string };
const issueActor = (a: IssueNotifyActor): NotificationActor =>
  (a.type === "person" ? person(a.id) : agent(a.id)) as NotificationActor;

/**
 * After an issue changed: a new person assignee hears it (and the previous
 * one's "assigned to you" resolves); a status change reaches the followers.
 */
export async function notifyIssueChanged(
  deps: NotificationDeps,
  actor: IssueNotifyActor,
  before: Pick<IssueRow, "status" | "assigneeType" | "assigneeId"> | null,
  issue: IssueRow,
) {
  const at = issue.updatedAt.getTime();
  const prevPerson = before?.assigneeType === "person" ? before.assigneeId : null;
  const nowPerson = issue.assigneeType === "person" ? issue.assigneeId : null;
  if (prevPerson && prevPerson !== nowPerson) {
    await resolveNotifications(deps, issue.orgId, {
      groupKeyPrefix: `issue_assigned:${issue.id}:`,
      userIds: [prevPerson],
    });
  }
  if (nowPerson && nowPerson !== prevPerson) {
    await notify(deps, {
      orgId: issue.orgId,
      userIds: await visibleOnIssue(deps, issue, [nowPerson]),
      kind: "issue_assigned",
      groupKey: `issue_assigned:${issue.id}:${at}`,
      actor: issueActor(actor),
      source: issueSource(issue),
      latest: { title: issue.title, text: notificationSnippet(issue.description) },
    });
  }
  if (before && before.status !== issue.status) {
    await notify(deps, {
      orgId: issue.orgId,
      userIds: await issueFollowers(deps, issue),
      kind: "issue_status",
      groupKey: `issue_status:${issue.id}:${at}`,
      actor: issueActor(actor),
      source: issueSource(issue),
      latest: { title: issue.title, statusFrom: before.status, statusTo: issue.status },
    });
  }
}

/**
 * A comment: people it @mentions get a `mention` (source: the issue); the
 * other followers an `issue_comment`, merged per issue.
 */
export async function notifyIssueComment(
  deps: NotificationDeps,
  actor: IssueNotifyActor,
  issueId: string,
  activityId: string,
  text: string,
) {
  const [issue] = await deps.db.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) return;
  const snippet = notificationSnippet(text);
  const handles = handlesIn(text);
  const named = handles.length
    ? await deps.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, issue.orgId), inArray(organizationMembers.handle, handles)))
    : [];
  const mentioned = await visibleOnIssue(
    deps,
    issue,
    named.map((n) => n.userId),
  );
  const self = actor.type === "person" ? actor.id : null;
  const told = new Set<string>(self ? [self] : []);
  if (mentioned.length) {
    await notify(deps, {
      orgId: issue.orgId,
      userIds: mentioned,
      kind: "mention",
      groupKey: `mention:issue-comment:${activityId}`,
      actor: issueActor(actor),
      source: issueSource(issue),
      latest: { text: snippet, title: issue.title },
    });
    for (const u of mentioned) told.add(u);
  }
  const followers = (await issueFollowers(deps, issue)).filter((u) => !told.has(u));
  await notify(deps, {
    orgId: issue.orgId,
    userIds: followers,
    kind: "issue_comment",
    groupKey: `issue-comments:${issue.id}`,
    actor: issueActor(actor),
    source: issueSource(issue),
    latest: { text: snippet, title: issue.title },
  });
}

// ── Forum ─────────────────────────────────────────────────────────────────────

/** A seated person's turn at the table (waits for them). */
export async function notifyForumTurn(deps: NotificationDeps, topic: TopicRow, userId: string, round: number) {
  await notify(deps, {
    orgId: topic.orgId,
    userIds: [userId],
    kind: "forum_turn",
    groupKey: `forum_turn:${topic.id}:${round}`,
    waiting: true,
    actor: agent(topic.ownerAgentId),
    source: { topicId: topic.id, channelId: topic.channelId, label: topic.title },
    latest: {
      title: topic.title,
      text: notificationSnippet(topic.goal),
      round,
      rounds: topic.maxRounds,
      ...(topic.deadline ? { expiresAt: topic.deadline.toISOString() } : {}),
    },
  });
}

/** The turn was taken, passed, skipped, or the topic moved on or ended. */
export async function resolveForumTurns(deps: NotificationDeps, orgId: string, topicId: string, userIds?: string[]) {
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `forum_turn:${topicId}:`, userIds });
}

/** The synthesis (or plan) is out: whoever opened or asked for the topic. */
export async function notifyForumSynthesis(
  deps: NotificationDeps,
  topic: TopicRow,
  input: { agentId: string | null; revision: number; summary: string },
) {
  await notify(deps, {
    orgId: topic.orgId,
    userIds: [topic.requesterUserId, topic.requestedByUserId],
    kind: "forum_synthesis",
    groupKey: `forum_synthesis:${topic.id}:${input.revision}`,
    actor: agent(input.agentId),
    source: { topicId: topic.id, channelId: topic.channelId, label: topic.title },
    latest: { title: topic.title, text: notificationSnippet(input.summary) },
  });
}

// ── Missions ──────────────────────────────────────────────────────────────────

/** A mission finished (closed as done) or stopped: its owner and participants. */
export async function notifyMissionEnded(
  deps: NotificationDeps,
  mission: MissionRow,
  kind: "mission_finished" | "mission_stopped",
  actor: NotificationActor | null,
  text?: string | null,
) {
  const parts = await deps.db
    .select({ userId: missionParticipants.userId })
    .from(missionParticipants)
    .where(eq(missionParticipants.missionId, mission.id));
  await notify(deps, {
    orgId: mission.orgId,
    userIds: [mission.ownerId, ...parts.map((p) => p.userId)],
    kind,
    groupKey: `${kind}:${mission.id}:${mission.updatedAt.getTime()}`,
    actor,
    source: {
      missionId: mission.id,
      channelId: mission.channelId,
      threadId: mission.threadRootId,
      label: mission.title,
    },
    latest: {
      title: mission.title,
      ...(text ? { text: notificationSnippet(text) } : {}),
      ...(mission.planTotal > 0 ? { steps: { done: mission.planDone, total: mission.planTotal } } : {}),
    },
  });
}

// ── Routines ──────────────────────────────────────────────────────────────────

/** A routine's run ended (its agent's answer, or a failure): the routine's creator. */
export async function notifyRoutineRun(
  deps: NotificationDeps,
  input: {
    orgId: string;
    routineId: string;
    agentId: string;
    ok: boolean;
    /** Agent run or routine run id: one notification per run. */
    runKey: string;
    text?: string | null;
  },
) {
  const [routine] = await deps.db
    .select({ name: routines.name, creator: routines.createdByUserId })
    .from(routines)
    .where(and(eq(routines.id, input.routineId), eq(routines.orgId, input.orgId)));
  if (!routine?.creator) return;
  const kind = input.ok ? "routine_finished" : "routine_failed";
  await notify(deps, {
    orgId: input.orgId,
    userIds: [routine.creator],
    kind,
    groupKey: `${kind}:${input.runKey}`,
    actor: agent(input.agentId),
    source: { routineId: input.routineId, label: routine.name },
    latest: { title: routine.name, ...(input.text ? { text: notificationSnippet(input.text) } : {}) },
  });
}

/** The routine's answer: the reply message of an agent run, for the card. */
export async function routineReplyText(deps: NotificationDeps, orgId: string, runId: string) {
  const [run] = await deps.db
    .select({ reply: agentRuns.replyMessageId, error: agentRuns.error })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!run?.reply) return run?.error ?? null;
  const [m] = await deps.db
    .select({ body: messages.body })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, run.reply)));
  return m?.body ?? null;
}
