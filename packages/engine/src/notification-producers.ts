import { and, asc, eq, inArray, isNotNull, isNull, schema } from "@agenteschat/db";
import { approvalCardThreads, approvalOriginOf, approverIds } from "./approvals";
import { accountablePerson, runAuthorityById } from "./authority";
import { threadFollowChoices } from "./follows";
import { type TaskEnd, taskEndText } from "./machine-task-text";
import { isMediaAfterReply } from "./media";
import { previewMediaKind } from "./message-preview";
import { isAgentOnlyNotice } from "./notices";
import {
  type NotificationActor,
  type NotificationDeps,
  type NotificationSource,
  notificationSnippet,
  notify,
  remindNotifications,
  resolveNotifications,
  retargetNotifications,
} from "./notifications";
import { maySql, type RolePermission } from "./permissions";
import { stretchCardOf } from "./stretch";

/**
 * Where notifications come from: each flow calls one of these after
 * its change committed. They read what they need themselves (no imports of
 * the flows' modules, so no import cycles) and never throw into the flow:
 * callers add `.catch(() => {})`.
 */

const {
  messages,
  channels,
  channelMembers,
  threads,
  agents,
  organizationMembers,
  issues,
  issueActivity,
  missions,
  missionParticipants,
  routines,
  messageReactions,
  machines,
  approvals,
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

/**
 * Who hears about a run's requests (questions, browser handoffs): the person accountable for it
 * (`accountablePerson`: the person behind it, else the routine's creator), or null (the caller falls
 * back to the agent's owner).
 */
async function requesterOfRun(
  deps: Pick<NotificationDeps, "db">,
  orgId: string,
  runId: string | null,
): Promise<string | null> {
  return runId ? accountablePerson(await runAuthorityById(deps.db, orgId, runId)) : null;
}

/** The person behind a run (who asked for the work, through agents that asked each other), or null. */
export async function humanBehindRun(
  deps: Pick<NotificationDeps, "db">,
  orgId: string,
  runId: string | null,
): Promise<string | null> {
  return runId ? (await runAuthorityById(deps.db, orgId, runId)).personId : null;
}

async function isOrgMember(deps: Pick<NotificationDeps, "db">, orgId: string, userId: string) {
  const [row] = await deps.db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return Boolean(row);
}

async function agentOwner(deps: Pick<NotificationDeps, "db">, agentId: string) {
  const [a] = await deps.db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, agentId));
  return a?.owner ?? null;
}

// ── Chat: mentions, thread replies, DMs ───────────────────────────────────────

/**
 * One open `agent_reply` per conversation (a channel's top level, a thread, a DM): an agent's later answers there
 * merge into it until it's read. Reading the conversation resolves it (`markChannelRead`).
 */
export const agentReplyGroup = (channelId: string, threadId: string | null) =>
  `agent_reply:${channelId}:${threadId ?? "top"}`;

/**
 * Job `notifications.message` (enqueued in the message's own statement):
 * people mentioned (`mention`), the other person of a DM (`dm`), the person
 * an agent answers (`agent_reply`, merged per conversation, ADR 0071), and
 * the people in a thread (`thread_reply`, merged per thread). Cards of the
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
  // An agent's sticker or GIF after its own reply (ADR 0091) is silent: the reply already told whoever it was for.
  if (isMediaAfterReply(meta)) return;
  // An agent's follow-up line, and the notice that wakes it: the reply it brings notifies instead.
  if ((meta.notice as { kind?: unknown } | undefined)?.kind === "follow_up") return;
  // Only for its agent: people never see it.
  if (isAgentOnlyNotice(meta)) return;
  // A long work's progress line (ADR 0121) never pushes: it counts as unread only for who follows its thread.
  if (meta.workUpdate) return;
  const [channel] = await db
    .select({ kind: channels.kind, name: channels.name, visibility: channels.visibility })
    .from(channels)
    .where(and(eq(channels.id, message.channelId), eq(channels.orgId, orgId)));
  if (!channel || channel.kind === "forum") return;
  const actor = message.authorType === "person" ? person(message.authorUserId) : agent(message.authorAgentId);
  const authorUser = message.authorUserId;
  const text = notificationSnippet(await quotedBody(deps, orgId, message));
  // Only a GIF or a sticker (ADR 0091): the apps and the push say which, in the person's language.
  const media = previewMediaKind(message.body, meta);
  const latest = media ? { text, media } : { text };
  const label = channel.kind === "channel" ? channel.name : undefined;
  const where: NotificationSource = {
    channelId: message.channelId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    messageId: message.id,
    ...(channel.kind === "dm" ? { dmId: message.channelId } : {}),
  };
  const done = new Set<string>(authorUser ? [authorUser] : []);

  // An agent's answer: the person behind its run hears it (ADR 0071), once per conversation until read, so they
  // can close the tab while it works. Not a routine's (its creator hears `routine_finished`), not a run that
  // person stopped, not when they're mentioned in it (the mention says it).
  const behind =
    message.authorType === "agent" && message.agentRunId && !meta.viaRoutine && !meta.canceled && !meta.agentDm
      ? await humanBehindRun(deps, orgId, message.agentRunId)
      : null;
  // A stretch's pause card (ADR 0089) also tells the routine's creator when nobody asked for the work, and when
  // nobody is behind it at all, the owner of the agent it last stopped at (ADR 0053, addendum of 2026-10-31): they
  // hear it in any public channel of the workspace, joined or not, since they answer for their agent's work there.
  const card = message.authorType === "agent" ? stretchCardOf(meta) : null;
  const stoppedAt = card?.agentIds.at(-1);
  const owner = !behind && !card?.forUserId && stoppedAt ? await agentOwner(deps, stoppedAt) : null;
  const asker = behind ?? card?.forUserId ?? owner;
  const ownerSees =
    asker !== null &&
    asker === owner &&
    channel.kind === "channel" &&
    channel.visibility === "public" &&
    (await isOrgMember(deps, orgId, asker));
  if (
    asker &&
    !message.mentionedUserIds.includes(asker) &&
    // A work the person stopped themselves tells them nothing new.
    (meta.workEnd as { byUserId?: unknown } | undefined)?.byUserId !== asker &&
    (ownerSees || (await inChannel(deps, message.channelId, [asker])).length > 0)
  ) {
    // A long work's report (ADR 0121) is news of its own, never merged into the conversation's open reply.
    const workEnd = (meta.workEnd as { id?: unknown } | undefined)?.id;
    await notify(deps, {
      orgId,
      userIds: [asker],
      kind: "agent_reply",
      groupKey:
        typeof workEnd === "string" ? `work_end:${workEnd}` : agentReplyGroup(message.channelId, message.threadId),
      actor,
      source: { ...where, ...(label ? { label } : {}) },
      latest,
    });
    done.add(asker);
  }

  // A DM from a person: the other person hears it (an agent's replies in a DM are the conversation itself,
  // answered above for the person behind them, except a message the agent started there on someone's behalf,
  // `send_dm`).
  if (channel.kind === "dm") {
    if (message.authorType !== "person" && !meta.agentDm) return;
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
      latest,
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
      latest,
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
  // Explicit choices win: following adds someone, muting drops them even where they wrote.
  const choices = await threadFollowChoices(db, orgId, message.threadId);
  const inThread = [starter, ...people.map((p) => p.userId), ...choices.followers].filter(
    (u): u is string => !!u && !done.has(u) && !choices.muted.has(u),
  );
  const to = await inChannel(deps, message.channelId, inThread);
  if (to.length === 0) return;
  await notify(deps, {
    orgId,
    userIds: to,
    kind: "thread_reply",
    groupKey: `thread:${message.threadId}`,
    actor,
    source: { ...where, label: threadLabel ?? label },
    latest,
  });
}

/**
 * What a notification quotes of a message: its body, but a task's end (`meta.machineTask`) names its computer only
 * where the workspace has more than one, the apps' rule (`namesComputers`). The agent still reads where it ran.
 */
async function quotedBody(deps: NotificationDeps, orgId: string, message: typeof messages.$inferSelect) {
  const task = message.meta.machineTask as (TaskEnd & { computer?: string }) | undefined;
  if (typeof task?.title !== "string") return message.body;
  const computers = await deps.db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
    .limit(2);
  return taskEndText(task, computers.length > 1 ? (task.computer ?? null) : null);
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

// ── Secret requests (ADR 0027) ────────────────────────────────────────────────

/**
 * An agent waits for a secret (`request_secret`): the one person who can answer it, in their "Waiting for you" and
 * with a push, as a browser handoff asks. Only its name and what it is for travel, never a field: it is typed in
 * the card, where it is sealed for the computer.
 */
export async function notifySecretRequest(deps: NotificationDeps, r: typeof schema.secretRequests.$inferSelect) {
  const [channel] = await deps.db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, r.channelId));
  await notify(deps, {
    orgId: r.orgId,
    userIds: [r.requestedForUserId],
    kind: "secret_request",
    groupKey: `secret_request:${r.id}`,
    waiting: true,
    actor: agent(r.agentId),
    source: {
      channelId: r.channelId,
      ...(r.threadId ? { threadId: r.threadId } : {}),
      ...(r.messageId ? { messageId: r.messageId } : {}),
      ...(channel?.kind === "dm" ? { dmId: r.channelId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
    },
    latest: { title: r.name, text: notificationSnippet(r.purpose), expiresAt: r.expiresAt.toISOString() },
  });
}

/** Delivered, declined, expired or its run stopped: out of the inbox. */
export async function resolveSecretRequestNotifications(deps: NotificationDeps, orgId: string, requestId: string) {
  await resolveNotifications(deps, orgId, { groupKey: `secret_request:${requestId}` });
}

// ── Approvals ─────────────────────────────────────────────────────────────────

/**
 * A sensitive action waits: everyone who may decide it, with the agent's why (short, in `text`) and,
 * asked while nobody watched, where it came from (`origin`: a routine, or no one): ADR 0053 §8.
 */
/**
 * One notification per approval card (`openApprovalCard`): a request joining a card that already waits
 * updates that card's notification (its count, the newest title) instead of adding one.
 */
const approvalGroupKey = (approval: Pick<ApprovalRow, "id" | "messageId">) =>
  approval.messageId ? `approval-card:${approval.messageId}` : `approval:${approval.id}`;

export async function notifyApproval(deps: NotificationDeps, approval: ApprovalRow, deciders: string[]) {
  const [[channel], cardThreads, [first]] = await Promise.all([
    deps.db
      .select({ kind: channels.kind, name: channels.name })
      .from(channels)
      .where(eq(channels.id, approval.channelId)),
    approvalCardThreads(deps.db, [approval]),
    approval.messageId
      ? deps.db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.orgId, approval.orgId),
              eq(approvals.messageId, approval.messageId),
              eq(approvals.status, "pending"),
            ),
          )
          .orderBy(asc(approvals.createdAt))
          .limit(1)
      : Promise.resolve([]),
  ]);
  // Where its card is (the main timeline has no thread).
  const threadId = cardThreads.get(approval.id) ?? null;
  await notify(deps, {
    orgId: approval.orgId,
    userIds: deciders,
    kind: "approval",
    groupKey: approvalGroupKey(approval),
    waiting: true,
    actor: agent(approval.agentId),
    source: {
      // The card's oldest waiting request: the notification opens the card, which lists the rest.
      approvalId: first?.id ?? approval.id,
      channelId: approval.channelId,
      ...(threadId ? { threadId } : {}),
      ...(approval.messageId ? { messageId: approval.messageId } : {}),
      ...(approval.missionId ? { missionId: approval.missionId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
    },
    latest: approvalLatest(approval),
  });
}

const approvalLatest = (approval: ApprovalRow) => ({
  title: notificationSnippet(approval.title, 200),
  text: notificationSnippet(approval.why, 200),
  origin: approvalOriginOf(approval.origin) ?? undefined,
  expiresAt: approval.expiresAt.toISOString(),
});

/**
 * Out of the inbox once nothing on its card waits any more. Until then each person's entry describes the
 * card's oldest request still waiting that they may decide, and leaves the inbox of whoever has none left.
 */
export async function resolveApprovalNotifications(
  deps: NotificationDeps,
  approval: Pick<ApprovalRow, "id" | "orgId" | "messageId">,
) {
  const groupKey = approvalGroupKey(approval);
  const waiting = approval.messageId
    ? await deps.db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.orgId, approval.orgId),
            eq(approvals.messageId, approval.messageId),
            eq(approvals.status, "pending"),
          ),
        )
        .orderBy(asc(approvals.createdAt))
    : [];
  if (waiting.length === 0) return resolveNotifications(deps, approval.orgId, { groupKey });
  const deciders = await Promise.all(waiting.map(async (a) => new Set(await approverIds(deps.db, a))));
  await retargetNotifications(deps, approval.orgId, groupKey, (userId) => {
    const next = waiting.find((_, i) => deciders[i]?.has(userId));
    return next ? { source: { approvalId: next.id }, latest: approvalLatest(next) } : null;
  });
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

// ── Routines (ADR 0053) ─────────────────────────────────────────────────────────

/** A routine's name, creator and agent, and the agent's owner: who hears about it. */
async function routineAudience(deps: Pick<NotificationDeps, "db">, orgId: string, routineId: string) {
  const [r] = await deps.db
    .select({ name: routines.name, creator: routines.createdByUserId, agentId: routines.agentId })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)));
  if (!r) return null;
  return { ...r, owner: await agentOwner(deps, r.agentId) };
}

/**
 * A routine's run failed after a good one (§6.6): its creator (else the agent's owner) hears it
 * once per failure streak (`streakKey`: the streak's first failed run), with the run's coded reason
 * (`latest.reason`: the app says it in the person's language). Resolved by the next good run.
 */
export async function notifyRoutineFailed(
  deps: NotificationDeps,
  input: { orgId: string; routineId: string; streakKey: string; reason?: string | null },
) {
  const r = await routineAudience(deps, input.orgId, input.routineId);
  if (!r) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [r.creator ?? r.owner],
    kind: "routine_failed",
    groupKey: `routine_failed:${input.routineId}:${input.streakKey}`,
    actor: agent(r.agentId),
    source: { routineId: input.routineId, label: r.name },
    latest: { title: r.name, reason: input.reason ?? undefined },
  });
}

/**
 * A routine couldn't call an agent its creator can't talk to (`reach.ts`, and its own tell_agent or
 * ask_agent, `consultations.ts`): the agent's owner hears it once per routine and agent, or who manages agents when
 * it has none. It opens the agent's page (who talks to it), the place they may not otherwise reach being private;
 * `source.userId` is the routine's creator, whom its one-click action lets talk to the agent.
 */
export async function notifyAgentUnreached(
  deps: NotificationDeps,
  input: {
    orgId: string;
    agentId: string;
    routineId: string;
    routineName: string;
    creatorUserId: string;
    channelId: string;
    threadId?: string | null;
    messageId?: string;
  },
) {
  const owner = await agentOwner(deps, input.agentId);
  await notify(deps, {
    orgId: input.orgId,
    userIds: owner ? [owner] : await adminsOf(deps, input.orgId, "manage_agents"),
    kind: "agent_unreached",
    groupKey: `agent_unreached:${input.routineId}:${input.agentId}`,
    actor: agent(input.agentId),
    source: {
      routineId: input.routineId,
      agentId: input.agentId,
      userId: input.creatorUserId,
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      label: input.routineName,
    },
    latest: { title: input.routineName, reason: "routine_creator_reach" },
  });
}

/**
 * A routine paused itself (§6.2, §6.6): its creator and the agent's owner hear it once per pause
 * (`key`), with the coded reason (`latest.reason`, the app translates it) and its English fallback.
 */
export async function notifyRoutinePaused(
  deps: NotificationDeps,
  input: {
    orgId: string;
    routineId: string;
    name: string;
    agentId: string;
    creatorUserId: string | null;
    reason: string;
    text: string;
    key: string;
  },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.creatorUserId, await agentOwner(deps, input.agentId)],
    kind: "routine_paused",
    groupKey: `routine_paused:${input.routineId}:${input.key}`,
    actor: agent(input.agentId),
    source: { routineId: input.routineId, label: input.name },
    latest: { title: input.name, reason: input.reason, text: input.text },
  });
}

/**
 * A routine's run waits for the agent's computer (§6.4): its creator and the agent's owner hear it
 * once per outage (`outageKey`: the routine's last run that really ran; the next one that does starts a
 * new outage). Resolved by the next good run.
 */
export async function notifyRoutineStalled(
  deps: NotificationDeps,
  input: { orgId: string; routineId: string; machineId: string; machineName: string; outageKey: string },
) {
  const r = await routineAudience(deps, input.orgId, input.routineId);
  if (!r) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [r.creator, r.owner],
    kind: "routine_stalled",
    groupKey: `routine_stalled:${input.routineId}:${input.machineId}:${input.outageKey}`,
    actor: agent(r.agentId),
    source: { routineId: input.routineId, machineId: input.machineId, label: r.name },
    latest: { title: r.name, ...(input.machineName ? { text: notificationSnippet(input.machineName) } : {}) },
  });
}

/**
 * A routine's run waits for its agent's plan to reset: its creator and the agent's owner hear it once per
 * outage (`outageKey`, as `notifyRoutineStalled`). Resolved by the next good run.
 */
export async function notifyRoutineWaitingPlan(
  deps: NotificationDeps,
  input: { orgId: string; routineId: string; outageKey: string },
) {
  const r = await routineAudience(deps, input.orgId, input.routineId);
  if (!r) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [r.creator, r.owner],
    kind: "routine_waiting_plan",
    groupKey: `routine_waiting_plan:${input.routineId}:${input.outageKey}`,
    actor: agent(r.agentId),
    source: { routineId: input.routineId, label: r.name },
    latest: { title: r.name },
  });
}

/**
 * An agent's work has waited `UNKNOWN_RESET_NOTICE_MS` on its plan's limit and the plan never said when it resets:
 * the agent's owner hears it once per wait, opening the conversation the work waits in.
 */
export async function notifyPlanResetUnknown(
  deps: NotificationDeps,
  input: {
    orgId: string;
    agentId: string;
    agentName: string;
    plan: string;
    runId: string;
    channelId: string;
    threadId: string | null;
  },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [await agentOwner(deps, input.agentId)],
    kind: "plan_reset_unknown",
    groupKey: `plan_reset_unknown:${input.runId}`,
    actor: agent(input.agentId),
    source: {
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      label: input.agentName,
    },
    latest: { title: input.plan },
  });
}

/**
 * The agent told people what a routine found (the message its report woke, §7): its creator hears
 * it, opening that message, unless they are a member of that conversation (they see it there).
 */
export async function notifyRoutineFinished(
  deps: NotificationDeps,
  input: {
    orgId: string;
    routineId: string;
    routineRunId: string;
    messageId: string;
    channelId: string;
    threadId: string | null;
    text?: string | null;
  },
) {
  const r = await routineAudience(deps, input.orgId, input.routineId);
  if (!r?.creator) return;
  if ((await inChannel(deps, input.channelId, [r.creator])).length > 0) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [r.creator],
    kind: "routine_finished",
    groupKey: `routine_finished:${input.routineRunId}`,
    actor: agent(r.agentId),
    source: {
      routineId: input.routineId,
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      messageId: input.messageId,
      label: r.name,
    },
    latest: { title: r.name, ...(input.text ? { text: notificationSnippet(input.text) } : {}) },
  });
}

// ── Runs (ADR 0097) ─────────────────────────────────────────────────────────────

const runFailedGroup = (run: { agentId: string; channelId: string; threadRootId: string }) =>
  `run_failed:${run.agentId}:${run.channelId}:${run.threadRootId}`;

/**
 * A conversation run failed for good (`reportRunFailure`): `userId` (else the agent's owner) hears it once per agent
 * and conversation, with the run's coded reason (`latest.reason`). Resolved by the agent's next good run there.
 */
export async function notifyRunFailed(
  deps: NotificationDeps,
  run: { orgId: string; agentId: string; channelId: string; threadRootId: string; triggerMessageId: string },
  userId: string | null,
  reason: string,
) {
  const to = userId ?? (await agentOwner(deps, run.agentId));
  if (!to) return;
  const [channel] = await deps.db.select({ name: channels.name }).from(channels).where(eq(channels.id, run.channelId));
  await notify(deps, {
    orgId: run.orgId,
    userIds: [to],
    kind: "run_failed",
    groupKey: runFailedGroup(run),
    actor: agent(run.agentId),
    source: {
      channelId: run.channelId,
      ...(run.threadRootId !== run.triggerMessageId ? { threadId: run.threadRootId } : {}),
      messageId: run.triggerMessageId,
      agentId: run.agentId,
      ...(channel?.name ? { label: channel.name } : {}),
    },
    latest: { reason: reason.split(":")[0] ?? reason },
  });
}

/** The agent's run in that conversation ended well: its failure there is done. */
export async function resolveRunFailed(
  deps: NotificationDeps,
  run: { orgId: string; agentId: string; channelId: string; threadRootId: string },
) {
  await resolveNotifications(deps, run.orgId, { groupKey: runFailedGroup(run) });
}

/** A routine ran well again: its failure streak and computer outage notifications are done. */
export async function resolveRoutineTrouble(deps: NotificationDeps, orgId: string, routineId: string) {
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `routine_failed:${routineId}:` });
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `routine_stalled:${routineId}:` });
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `routine_waiting_plan:${routineId}:` });
}

/** A person resumed or took over a routine: its pause notifications are done. */
export async function resolveRoutinePaused(deps: NotificationDeps, orgId: string, routineId: string) {
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `routine_paused:${routineId}:` });
}

/** Who in the organization may `permission` (ADR 0085), or only its owners. */
const adminsOf = async (deps: NotificationDeps, orgId: string, permission: RolePermission | "owners") =>
  (
    await deps.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          permission === "owners"
            ? eq(organizationMembers.role, "owner")
            : maySql(orgId, organizationMembers.userId, permission),
        ),
      )
  ).map((a) => a.userId);

// ── Connected computers ───────────────────────────────────────────────────────

/**
 * A computer was connected to the organization (ADR 0036 §5): every admin
 * hears, except who connected it, so a computer nobody expected (a phished
 * code) is seen and can be removed at once.
 */
export async function notifyMachineConnected(
  deps: NotificationDeps,
  machine: { id: string; orgId: string; name: string; hostname: string },
  actorId: string,
) {
  await notify(deps, {
    orgId: machine.orgId,
    userIds: await adminsOf(deps, machine.orgId, "configure"),
    kind: "machine_connected",
    groupKey: `machine_connected:${machine.id}`,
    actor: person(actorId),
    source: { machineId: machine.id, label: machine.name },
    latest: { title: machine.name, ...(machine.hostname ? { text: notificationSnippet(machine.hostname) } : {}) },
  });
}

/** The share of a computer's workspace disk in use past which its admins hear it (ADR 0115). */
export const DISK_WARN_USE = 0.85;
/** Under this share the warning is armed again, so a disk hovering at the line doesn't notify on every report. */
export const DISK_REARM_USE = 0.8;

/**
 * A computer's disk passed `DISK_WARN_USE` (ADR 0115): who configures the workspace hears it, once each time it
 * crosses (the caller compares with the last report), since agents filling the shared folder fail together.
 */
export async function notifyComputerDiskFull(
  deps: NotificationDeps,
  machine: { id: string; orgId: string; name: string },
  disk: { diskUse: number; diskFreeGb?: number },
  at: Date,
) {
  await notify(deps, {
    orgId: machine.orgId,
    userIds: await adminsOf(deps, machine.orgId, "configure"),
    kind: "computer_disk_full",
    groupKey: `computer_disk_full:${machine.id}:${at.getTime()}`,
    source: { machineId: machine.id, label: machine.name },
    latest: {
      title: machine.name,
      diskUse: disk.diskUse,
      ...(disk.diskFreeGb === undefined ? {} : { diskFreeGb: disk.diskFreeGb }),
    },
  });
}

/**
 * The workspace's own computer is ready (ADR 0056 §10): its owners hear it, since preparing it may take
 * from seconds to an approval hours later. One row each time it gets ready.
 */
export async function notifyComputerReady(
  deps: NotificationDeps,
  machine: { id: string; orgId: string; name: string },
  readyAt: Date,
) {
  await notify(deps, {
    orgId: machine.orgId,
    userIds: await adminsOf(deps, machine.orgId, "owners"),
    kind: "computer_ready",
    groupKey: `computer_ready:${machine.id}:${readyAt.getTime()}`,
    source: { machineId: machine.id, label: machine.name },
    latest: { title: machine.name },
  });
}

/**
 * The workspace used its Composio calls for the month (ADR 0107 §7): who manages its connectors hears it once that
 * month (the caller marks the month capped first).
 */
export async function notifyComposioLimit(deps: NotificationDeps, orgId: string, month: string, calls: number) {
  await notify(deps, {
    orgId,
    userIds: await adminsOf(deps, orgId, "manage_connectors"),
    kind: "composio_limit",
    groupKey: `composio_limit:${month}`,
    source: {},
    latest: { title: month, calls },
  });
}

const toolChangedGroup = (connectionId: string) => `connector_tool_changed:${connectionId}:`;

/**
 * A connected MCP server changed tools an admin approved (ADR 0117): who manages connectors hears it once per change,
 * `source.label` the connection's name and `latest.title` the tools. Resolved when nothing of it waits any more.
 */
export async function notifyToolChanged(
  deps: NotificationDeps,
  connection: { id: string; orgId: string; label: string },
  tools: { name: string; fingerprint: string }[],
) {
  await notify(deps, {
    orgId: connection.orgId,
    userIds: await adminsOf(deps, connection.orgId, "manage_connectors"),
    kind: "connector_tool_changed",
    groupKey: `${toolChangedGroup(connection.id)}${tools[0]?.fingerprint ?? ""}`,
    waiting: true,
    source: { label: connection.label },
    latest: { title: tools.map((t) => t.name).join(", ") },
  });
}

export const resolveToolChanged = (deps: NotificationDeps, orgId: string, connectionId: string) =>
  resolveNotifications(deps, orgId, { groupKeyPrefix: toolChangedGroup(connectionId) });

// ── Workspace standing (ADR 0056 §8) ──────────────────────────────────────────

/**
 * The people who run this server held, suspended or restored the workspace, with the notice shown: its
 * owners and admins hear it, with the reason (`latest.text`), or a billing hold's code (`latest.billingHold`,
 * ADR 0079), which the apps say in the person's words, and on agentes.chat Cloud `latest.cloud`, so the apps
 * read a restriction as the restriction itself reads. One row per change.
 */
export async function notifyOrgStanding(
  deps: NotificationDeps,
  orgId: string,
  standing: { state: string; reason: string | null; changedAt: Date | null; billing?: boolean; cloud?: boolean },
) {
  const why = standing.billing
    ? { billingHold: standing.reason ?? "" }
    : standing.reason
      ? { text: notificationSnippet(standing.reason) }
      : {};
  await notify(deps, {
    orgId,
    userIds: await adminsOf(deps, orgId, "configure"),
    kind: "org_standing",
    groupKey: `org_standing:${orgId}:${standing.changedAt?.getTime() ?? 0}`,
    source: {},
    latest: { statusTo: standing.state, ...why, ...(standing.cloud ? { cloud: true } : {}) },
  });
}

const agentHoldGroup = (agentId: string) => `org_standing:agent:${agentId}:`;

/**
 * An agent was held on agentes.chat Cloud (ADR 0056 §9): its responsible person and the workspace's owners and admins
 * hear it, with the hold's kind (`latest.holdKind`), never its reason. One row each time they are told (`at`): when
 * it is held, and when it is held again for another kind.
 */
export async function notifyAgentHold(
  deps: NotificationDeps,
  hold: { orgId: string; agentId: string; name: string; kind: string; at: Date },
) {
  await notify(deps, {
    orgId: hold.orgId,
    userIds: [await agentOwner(deps, hold.agentId), ...(await adminsOf(deps, hold.orgId, "manage_agents"))],
    kind: "org_standing",
    groupKey: `${agentHoldGroup(hold.agentId)}${hold.at.getTime()}:${hold.kind}`,
    source: { agentId: hold.agentId, label: hold.name },
    latest: { statusTo: "agent_hold", holdKind: hold.kind },
  });
}

/** The agent was let go: what its people were told of the hold is done. */
export const resolveAgentHold = (deps: NotificationDeps, orgId: string, agentId: string) =>
  resolveNotifications(deps, orgId, { groupKeyPrefix: agentHoldGroup(agentId), kind: "org_standing" });

// ── Agent browser (ADR 0040) ──────────────────────────────────────────────────

/** Who an agent's browser handoff is asked of: the person behind the run, else the agent's owner. */
export async function browserHandoffRecipient(
  deps: Pick<NotificationDeps, "db">,
  orgId: string,
  runId: string | null,
  agentId: string,
) {
  return (await requesterOfRun(deps, orgId, runId)) ?? (await agentOwner(deps, agentId));
}

/**
 * An agent needs a person in its browser (`browser_ask_person`): in the
 * "Waiting for you" of whoever asked for the work and of the agent's
 * responsible person, with a push. Either may open it; the first in control
 * does it, the other sees who is helping. `to`: exactly who instead (a
 * desktop's request goes only to who may drive its computer).
 */
export async function notifyBrowserHandoff(
  deps: NotificationDeps,
  h: typeof schema.browserHandoffs.$inferSelect,
  where: { channelId: string; threadId: string | null },
  to?: string[],
) {
  // Who asked for the work and the agent's responsible person (once when it's the same person).
  const userIds = [...new Set(to ?? [h.requestedForUserId, await agentOwner(deps, h.agentId)])].filter(
    (id): id is string => !!id,
  );
  if (userIds.length === 0) return;
  const [channel] = await deps.db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, where.channelId));
  const handoff = { handoffId: h.id, agentId: h.agentId, ...(h.screen !== "browser" ? { screen: h.screen } : {}) };
  const base = {
    orgId: h.orgId,
    kind: "browser_handoff",
    groupKey: `browser_handoff:${h.id}`,
    waiting: true,
    actor: agent(h.agentId),
    latest: { text: notificationSnippet(h.instructions), expiresAt: h.expiresAt.toISOString() },
  } as const;
  const members = await inChannel(deps, where.channelId, userIds);
  await notify(deps, {
    ...base,
    userIds: members,
    source: {
      channelId: where.channelId,
      ...(where.threadId ? { threadId: where.threadId } : {}),
      messageId: h.id,
      ...(channel?.kind === "dm" ? { dmId: where.channelId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
      ...handoff,
    },
  });
  // Who can't open the card's conversation gets no link to it: the request opens on the agent's computer.
  const others = userIds.filter((id) => !members.includes(id));
  if (others.length > 0) await notify(deps, { ...base, userIds: others, source: handoff });
}

/** Still unanswered an hour later: back on top, unread, and pushed once more saying the agent still needs them. */
export const remindBrowserHandoffNotifications = (deps: NotificationDeps, orgId: string, handoffId: string) =>
  remindNotifications(deps, orgId, `browser_handoff:${handoffId}`, { reminder: true }, "reminder");

/** Done, couldn't, canceled or expired: out of everyone's inbox. */
export async function resolveBrowserHandoffNotifications(deps: NotificationDeps, orgId: string, handoffId: string) {
  await resolveNotifications(deps, orgId, { groupKey: `browser_handoff:${handoffId}` });
}

/**
 * Something an AI app created as the person (ADR 0119): it tells them in their own inbox, one row per connection that
 * sums what it made while unread ("Claude criou 3 agentes e 2 rotinas pelo app"), opening the newest agent or routine.
 */
export async function notifyAppCreated(
  deps: NotificationDeps,
  input: { orgId: string; userId: string; grantId: string; app: string; kind: string; id: string },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.userId],
    kind: "app_created",
    groupKey: `app_created:${input.grantId}`,
    source: input.kind === "agent" ? { agentId: input.id } : input.kind === "routine" ? { routineId: input.id } : {},
    latest: { title: input.app, created: { [input.kind]: 1 } },
  });
}
