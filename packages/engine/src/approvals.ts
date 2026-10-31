import { MAIL_PRESETS, type PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, lt, ne, or, schema, sql } from "@agenteschat/db";
import { addApprovalRules, type RememberedKind, rememberedKindOf } from "./approval-rules";
import { recordAudit } from "./audit";
import { learnFromRefusal } from "./context/feedback";
import type { MemoryJudging } from "./context/items";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent, publishUserEvent } from "./events";
import { type MailPreview, parseMailDetail, withoutReplyPrefix } from "./mail/preview";
import { notifyApproval, resolveApprovalNotifications } from "./notification-producers";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { maySql } from "./permissions";
import type { Approval } from "./tools/gateway";
import { REQUEST_PERMISSION_TOOL } from "./tools/permission";
import type { ApprovalOrigin } from "./tools/run-policy";

const {
  approvals,
  organizationMembers,
  channelMembers,
  agents,
  agentRuns,
  agentRunSteps,
  connectorConnections,
  issues,
  mailAccounts,
  messages,
} = schema;

/** The email a mail approval would write (a draft, a send, a reply or a forward), as its card shows it. */
export interface ApprovalEmail extends MailPreview {
  verb: "draft" | "send" | "reply" | "forward";
  /** The mailbox it goes through, and its provider's name ("iCloud", "Gmail"; null: unknown). */
  mailbox: string;
  provider: string | null;
}

export interface ApprovalView {
  id: string;
  /** Null for an approval a mission's executor asked (`missionId`). */
  runId: string | null;
  missionId: string | null;
  agentId: string;
  channelId: string;
  /** Where its card is: the thread, or null for the main timeline (asked there). */
  threadId: string | null;
  messageId: string | null;
  tool: string;
  scope: string;
  title: string;
  detail: string;
  params: Record<string, unknown>;
  /** Stable key for the card's title (the tool), and the values it shows: the app words it in the person's language. */
  kind: string;
  titleParams: Record<string, string | number | boolean>;
  status: Approval["status"];
  expiresAt: string;
  createdAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  reason: string | null;
  /** Whether the person asking may approve or refuse it. */
  canDecide: boolean;
  /** The agent's owner at request time (they and admins may decide). */
  ownerUserId: string | null;
  /** When the approved action ran (null: not yet, or never). */
  executedAt: string | null;
  /** What the action returned once it ran (raw tool output, short). */
  result: { ok: boolean; text: string } | null;
  /** The connector the action goes through (`github`), and its account (`acme`); null for built-in tools. */
  connector: string | null;
  connectorAccount: string | null;
  /** The email itself (From, To, Subject, text), for mail drafts and sends; null for every other action. */
  email: ApprovalEmail | null;
  /** The agent's required reason (ADR 0053): what it found and why this action, shown on the card. */
  why: string | null;
  /** Asked while nobody watched: by a routine (its name) or an unattended run; null when a person was behind it. */
  origin: ApprovalOrigin | null;
  /** The issue the run works on, when there is one. */
  issue: { id: string; number: number; title: string } | null;
  /** How the run got here: what the agent said at each turn before asking (one approval only). */
  trail?: { text: string; at: string }[];
  /** "Aprovar sempre" is offered: the server's tool and the actions approving for good covers; null: not offered. */
  approveAlways: RememberedKind | null;
}

/** What the approval row alone doesn't say: the connector, the issue (and, for one, the trail). */
interface ApprovalContext {
  connector: string | null;
  connectorAccount: string | null;
  email: ApprovalEmail | null;
  issue: { id: string; number: number; title: string } | null;
  trail: { text: string; at: string }[];
}

/** The stored origin (`approvals.origin`), read safely: its card and its notification say it. */
export function approvalOriginOf(value: Approval["origin"]): ApprovalOrigin | null {
  if (value?.kind === "unattended") return { kind: "unattended" };
  if (value?.kind === "routine" && typeof value.routineId === "string") {
    return {
      kind: "routine",
      routineId: value.routineId,
      routineName: typeof value.routineName === "string" ? value.routineName : "",
    };
  }
  return null;
}

const resultOf = (a: Approval): ApprovalView["result"] => {
  const r = a.result as { content?: unknown; isError?: unknown } | null;
  if (!r) return null;
  return { ok: r.isError !== true, text: typeof r.content === "string" ? r.content.slice(0, 600) : "" };
};

/** Batched: connections, the runs' narration up to each approval step, the runs' issues. */
async function approvalContexts(db: Database, rows: Approval[]): Promise<Map<string, ApprovalContext>> {
  const out = new Map<string, ApprovalContext>();
  if (rows.length === 0) return out;
  // Mission approvals (ADR 0029) have no run.
  const runIds = [...new Set(rows.map((r) => r.runId).filter((id): id is string => !!id))];
  const connectionIds = [...new Set(rows.map((r) => r.connectionId).filter((id): id is string => !!id))];
  const [connections, mailboxes, steps, runs] = await Promise.all([
    connectionIds.length
      ? db
          .select({
            id: connectorConnections.id,
            connector: connectorConnections.connector,
            account: connectorConnections.accountLabel,
          })
          .from(connectorConnections)
          .where(inArray(connectorConnections.id, connectionIds))
      : Promise.resolve([]),
    // A mail tool's connection is the mailbox (ADR 0038).
    connectionIds.length
      ? db
          .select({
            id: mailAccounts.id,
            address: mailAccounts.address,
            provider: mailAccounts.provider,
            preset: mailAccounts.preset,
          })
          .from(mailAccounts)
          .where(inArray(mailAccounts.id, connectionIds))
      : Promise.resolve([]),
    runIds.length
      ? db
          .select({
            runId: agentRunSteps.runId,
            kind: agentRunSteps.kind,
            narration: sql<string | null>`${agentRunSteps.data}->>'narration'`,
            approvalId: sql<string | null>`${agentRunSteps.data}->>'approvalId'`,
            createdAt: agentRunSteps.createdAt,
          })
          .from(agentRunSteps)
          .where(and(inArray(agentRunSteps.runId, runIds), inArray(agentRunSteps.kind, ["model_call", "approval"])))
          .orderBy(agentRunSteps.runId, agentRunSteps.seq)
      : Promise.resolve([]),
    runIds.length
      ? db.select({ id: agentRuns.id, issueId: agentRuns.issueId }).from(agentRuns).where(inArray(agentRuns.id, runIds))
      : Promise.resolve([]),
  ]);
  const issueIds = [...new Set(runs.map((r) => r.issueId).filter((id): id is string => !!id))];
  const issueRows = issueIds.length
    ? await db
        .select({ id: issues.id, number: issues.number, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIds))
    : [];
  const connectionOf = new Map(connections.map((c) => [c.id, c]));
  const mailboxOf = new Map(mailboxes.map((m) => [m.id, m]));
  const issueOfRun = new Map(runs.map((r) => [r.id, issueRows.find((i) => i.id === r.issueId) ?? null]));
  for (const row of rows) {
    // The narration of every turn before this approval's step.
    const trail: ApprovalContext["trail"] = [];
    for (const s of steps) {
      if (s.runId !== row.runId) continue;
      if (s.kind === "approval" && s.approvalId === row.id) break;
      if (s.kind === "model_call" && s.narration) trail.push({ text: s.narration, at: s.createdAt.toISOString() });
    }
    const connection = row.connectionId ? connectionOf.get(row.connectionId) : undefined;
    const mailbox = row.connectionId ? mailboxOf.get(row.connectionId) : undefined;
    out.set(row.id, {
      connector: connection?.connector ?? (mailbox ? "email" : null),
      connectorAccount: connection?.account ?? mailbox?.address ?? null,
      email: mailbox ? approvalEmail(row, mailbox) : null,
      issue: row.runId ? (issueOfRun.get(row.runId) ?? null) : null,
      trail: trail.slice(-12),
    });
  }
  return out;
}

const MAIL_VERBS = ["draft", "send", "reply", "forward"] as const;

/** The provider's name for people: "Gmail", "Outlook", the IMAP preset's ("iCloud"); null for a custom server. */
function mailProviderName(m: { provider: string; preset: string | null }) {
  if (m.provider === "gmail") return "Gmail";
  if (m.provider === "outlook") return "Outlook";
  const preset = m.preset && m.preset !== "custom" ? MAIL_PRESETS.find((p) => p.id === m.preset) : undefined;
  return preset ? preset.label.replace(/\s*\(.*\)$/, "") : null;
}

/**
 * The email a mail approval writes: from its detail (`mailDetail`), else from the call's own values (a draft
 * or a send carry them all). Null for the other mail actions (organizing, deleting).
 */
export function approvalEmail(
  row: Pick<Approval, "tool" | "detail" | "params">,
  mailbox: { address: string; provider: string; preset: string | null },
): ApprovalEmail | null {
  const verb = MAIL_VERBS.find((v) => row.tool.startsWith("mail_") && row.tool.endsWith(`_${v}`));
  if (!verb) return null;
  const preview = parseMailDetail(row.detail) ?? previewFromParams(row.params, mailbox.address, verb);
  return preview ? { ...preview, verb, mailbox: mailbox.address, provider: mailProviderName(mailbox) } : null;
}

function previewFromParams(params: Record<string, unknown>, address: string, verb: ApprovalEmail["verb"]) {
  if (verb !== "draft" && verb !== "send") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const subject = text(params.subject);
  return {
    from: text(params.from) || address,
    to: list(params.to),
    cc: list(params.cc),
    bcc: list(params.bcc),
    subject,
    body: text(params.body),
    original: text(params.in_reply_to) ? { subject: withoutReplyPrefix(subject), from: null } : null,
  } satisfies MailPreview;
}

/**
 * Where each approval's card is: its message's thread (null: the main timeline).
 * `thread_root_id` is the run's conversation, which for a run asked in the main
 * timeline is its trigger, not a thread. No card yet: that conversation.
 */
export async function approvalCardThreads(db: Executor, rows: Pick<Approval, "id" | "messageId" | "threadRootId">[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.messageId ? [r.messageId] : [])))];
  const cards = ids.length
    ? await db.select({ id: messages.id, threadId: messages.threadId }).from(messages).where(inArray(messages.id, ids))
    : [];
  const threadOf = new Map(cards.map((m) => [m.id, m.threadId]));
  return new Map(
    rows.map((r) => {
      const card = r.messageId && threadOf.has(r.messageId) ? r.messageId : null;
      return [r.id, card ? (threadOf.get(card) ?? null) : r.threadRootId] as const;
    }),
  );
}

/** Views with their context (connector, issue); `trail` only when asked (one approval's details). */
async function viewsOf(db: Database, rows: Approval[], canDecide: (row: Approval) => boolean, trail = false) {
  const [contexts, cardThreads] = await Promise.all([
    approvalContexts(db, rows).catch(() => new Map<string, ApprovalContext>()),
    approvalCardThreads(db, rows).catch(() => new Map<string, string | null>()),
  ]);
  return rows.map((r) => {
    const { trail: steps, ...context } = contexts.get(r.id) ?? {
      connector: null,
      connectorAccount: null,
      email: null,
      issue: null,
      trail: [],
    };
    const view = approvalView(r, canDecide(r));
    const threadId = cardThreads.has(r.id) ? (cardThreads.get(r.id) ?? null) : view.threadId;
    return { ...view, threadId, ...context, ...(trail ? { trail: steps } : {}) };
  });
}

/** Top-level scalar inputs of an approved action ("pullNumber", "owner", "repo", "environment"…), short. */
export function scalarParams(params: Record<string, unknown>) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params ?? {}).slice(0, 20)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
  }
  return out;
}

export const approvalView = (a: Approval, canDecide = false): ApprovalView => ({
  id: a.id,
  runId: a.runId,
  missionId: a.missionId ?? null,
  agentId: a.agentId,
  channelId: a.channelId,
  threadId: a.threadRootId,
  messageId: a.messageId,
  tool: a.tool,
  scope: a.scope,
  title: a.title,
  detail: a.detail,
  params: a.params,
  kind: a.tool,
  titleParams: scalarParams(a.params),
  status: a.status,
  expiresAt: a.expiresAt.toISOString(),
  createdAt: a.createdAt.toISOString(),
  decidedByUserId: a.decidedByUserId,
  decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
  reason: a.reason,
  canDecide: canDecide && a.status === "pending",
  ownerUserId: a.ownerUserId,
  executedAt: a.executedAt ? a.executedAt.toISOString() : null,
  result: resultOf(a),
  connector: null,
  connectorAccount: null,
  email: null,
  why: a.why.trim() || null,
  origin: approvalOriginOf(a.origin),
  issue: null,
  approveAlways: a.connectionId ? rememberedKindOf(a.approveAlways) : null,
});

/**
 * Whether only admins decide it: `request_permission` turns a connector or a built-in on for good, which
 * is an admin's call like the agent's scopes (`setAgentScopes`); the agent's owner decides the others.
 */
export const adminsDecide = (approval: Pick<Approval, "tool">) => approval.tool === REQUEST_PERMISSION_TOOL;

/** People who may decide: whoever may approve actions (ADR 0085), and the agent's owner (`adminsDecide` aside). */
export async function approverIds(
  db: Database,
  approval: Pick<Approval, "orgId" | "ownerUserId"> & Partial<Pick<Approval, "tool">>,
) {
  const admins = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, approval.orgId),
        maySql(approval.orgId, organizationMembers.userId, "approve_actions"),
      ),
    );
  const ids = new Set(admins.map((a) => a.userId));
  if (approval.ownerUserId && !adminsDecide({ tool: approval.tool ?? "" })) {
    const [owner] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, approval.orgId), eq(organizationMembers.userId, approval.ownerUserId)));
    if (owner) ids.add(owner.userId);
  }
  return [...ids];
}

/** Tells the channel and every approver about an approval (card in the chat, badge on the Approvals screen). */
export async function publishApproval(
  deps: { db: Database; pubsub: PubSub },
  approval: Approval,
  type: "approval.created" | "approval.decided",
) {
  const [view = approvalView(approval)] = await viewsOf(deps.db, [approval], () => false);
  await publishChannelEvent(deps.pubsub, { type, channelId: approval.channelId, approval: view });
  const deciders = await approverIds(deps.db, approval);
  for (const userId of deciders) {
    await publishUserEvent(deps.pubsub, approval.orgId, userId, { type, approval: { ...view, canDecide: true } });
  }
  // The inbox: waiting for whoever may decide; out of it once decided or expired.
  if (type === "approval.created" && approval.status === "pending") {
    await notifyApproval(deps, approval, deciders).catch(() => {});
  } else if (type === "approval.decided") {
    await resolveApprovalNotifications(deps, approval.orgId, approval.id).catch(() => {});
  }
}

/** What a decision wakes: the run that asked. */
async function enqueueResume(tx: Executor, row: Pick<Approval, "id" | "orgId" | "runId">) {
  if (row.runId) {
    await enqueue(tx, {
      orgId: row.orgId,
      kind: "agent_run.execute",
      payload: { runId: row.runId },
      dedupeKey: `agent_run.execute:${row.runId}:approval:${row.id}`,
      maxAttempts: 4,
    });
  }
}

async function mayDecide(db: Database, actorId: string, approval: Approval) {
  const membership = await requirePermission(db, actorId, approval.orgId, "read");
  return can(membership, "approve_actions") || (approval.ownerUserId === actorId && !adminsDecide(approval));
}

/**
 * Approves or refuses a pending approval. Only the agent's owner and org
 * admins may (a `request_permission` one: admins only, `adminsDecide`). The decision and the job that resumes the run commit together;
 * the run then executes exactly the hashed action, or tells the model it was
 * refused (with the reason). `always` ("Aprovar sempre", only where the
 * approval offers it) also keeps its kind for good in the same transaction:
 * the agent's next calls of that kind run without asking.
 */
export async function decideApproval(
  /** `memory`: how the lesson from a refusal is judged (context/items.ts `MemoryJudging`). */
  deps: { db: Database; pubsub: PubSub; now?: () => Date; memory?: MemoryJudging },
  actorId: string,
  orgId: string,
  approvalId: string,
  input: { decision: "approve" | "refuse"; reason?: string; always?: boolean },
): Promise<ApprovalView> {
  const { db } = deps;
  const at = deps.now?.() ?? new Date();
  const [current] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, orgId)));
  if (!current) throw new NotFoundError("Approval not found");
  if (!(await mayDecide(db, actorId, current))) {
    throw new ForbiddenError(
      adminsDecide(current)
        ? "Only an admin can give an agent new access"
        : "Only the agent's owner or an admin can decide this",
    );
  }
  const kind = input.always ? rememberedKindOf(current.approveAlways) : null;
  if (input.always && (input.decision !== "approve" || !kind || !current.connectionId)) {
    throw new ConflictError("This request can't be approved for good", "approval.always_unavailable");
  }

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
    if (row?.status !== "pending") return { error: "This request was already decided" as const };
    const expired = row.expiresAt <= at;
    const [updated] = await tx
      .update(approvals)
      .set(
        expired
          ? { status: "expired" }
          : {
              status: input.decision === "approve" ? "approved" : "refused",
              decidedByUserId: actorId,
              decidedAt: at,
              reason: input.reason?.trim().slice(0, 1000) || null,
            },
      )
      .where(eq(approvals.id, approvalId))
      .returning();
    await enqueueResume(tx, row);
    const always = !expired && kind && row.connectionId ? { connectionId: row.connectionId, ...kind } : null;
    if (always) {
      await addApprovalRules(tx, { orgId, agentId: row.agentId, connectionId: always.connectionId }, always, actorId);
    }
    if (updated) await auditDecision(tx, updated, expired ? null : actorId, always);
    return expired ? { error: "This request has expired" as const, row: updated } : { row: updated };
  });
  if (outcome.row) await publishApproval(deps, outcome.row, "approval.decided");
  if (outcome.error || !outcome.row) throw new ConflictError(outcome.error ?? "approval vanished");
  // A refusal (with its reason) becomes an outcome and a lesson for the agent.
  if (outcome.row.status === "refused") await learnFromRefusal(deps, outcome.row).catch(() => null);
  const [view = approvalView(outcome.row)] = await viewsOf(db, [outcome.row], () => false);
  return view;
}

/**
 * An approval's ending in the audit log: the person who approved or refused it, or the system when it
 * expired unanswered. The action it then ran is the agent's own row (`tool.call`, agent-audit.ts).
 */
function auditDecision(
  tx: Executor,
  row: Approval,
  personId: string | null,
  always: (RememberedKind & { connectionId: string }) | null = null,
) {
  return recordAudit(tx, {
    orgId: row.orgId,
    actor: personId ? { type: "person", id: personId } : { type: "system", id: null },
    action: `approval.${row.status}`,
    target: { type: "approval", id: row.id },
    details: {
      tool: row.tool,
      agentId: row.agentId,
      title: row.title,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(always ? { always } : {}),
    },
    runId: row.runId,
    channelId: row.channelId,
  });
}

/** Marks pending approvals past their deadline as expired and resumes their runs (worker, every minute). */
export async function expireApprovals(deps: { db: Database; pubsub: PubSub }, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
      .returning();
    for (const row of rows) {
      await enqueueResume(tx, row);
      await auditDecision(tx, row, null);
    }
    return rows;
  });
  for (const row of expired) await publishApproval(deps, row, "approval.decided");
  return expired.length;
}

/**
 * Approvals a person can see: admins see all; others see those of agents they
 * own and those in channels they belong to. Each carries `canDecide`.
 */
export async function listApprovals(
  db: Database,
  actorId: string,
  orgId: string,
  options: { status?: "pending" | "decided"; agentId?: string; limit?: number } = {},
): Promise<ApprovalView[]> {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const admin = can(membership, "approve_actions");
  const myChannels = db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, actorId)));
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, orgId),
        options.status === "pending"
          ? eq(approvals.status, "pending")
          : options.status === "decided"
            ? ne(approvals.status, "pending")
            : undefined,
        options.agentId ? eq(approvals.agentId, options.agentId) : undefined,
        admin ? undefined : or(eq(approvals.ownerUserId, actorId), inArray(approvals.channelId, myChannels)),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
  return viewsOf(db, rows, (r) => admin || (r.ownerUserId === actorId && !adminsDecide(r)));
}

export async function getApproval(db: Database, actorId: string, orgId: string, approvalId: string) {
  const list = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, orgId)));
  const row = list[0];
  if (!row) throw new NotFoundError("Approval not found");
  const visible = (await listApprovals(db, actorId, orgId, { agentId: row.agentId, limit: 500 })).find(
    (a) => a.id === row.id,
  );
  if (!visible) throw new NotFoundError("Approval not found");
  const [detailed] = await viewsOf(db, [row], () => visible.canDecide, true);
  return { ...visible, trail: detailed?.trail ?? [] };
}

/** Pending approvals per agent, for badges. */
export async function pendingApprovalCounts(db: Database, orgId: string) {
  return db
    .select({ agentId: approvals.agentId, handle: agents.handle, pending: sql<number>`count(*)::int` })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .groupBy(approvals.agentId, agents.handle);
}
