import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../errors";
import { publishChannelEvent, publishMessageCreated } from "../events";
import type { MachineCaller } from "../machine-hub";
import { insertMessage, messageView } from "../messages";
import { missionOfRun } from "../mission-context";
import {
  browserHandoffRecipient,
  humanBehindRun,
  notifyBrowserHandoff,
  resolveBrowserHandoffNotifications,
} from "../notification-producers";
import { can, getMembership } from "../organizations";
import { resumeRunWithResult } from "../run-resume";
import { bodyCode, runWhere } from "../run-tools";
import { grantedScopeKeys, isAllowed, toolAccess } from "../tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { agentBrowserStatus, browserUnavailableText } from "./status";
import { BROWSER_SCOPE, BROWSER_TOOL_INFO, type BrowserHandoffResult } from "./types";

const { browserHandoffs, agentRuns, agents, messages } = schema;

export type BrowserHandoffRow = typeof browserHandoffs.$inferSelect;
export type BrowserHandoffStatus = BrowserHandoffRow["status"];

/** How long an agent waits by default for a person to open its request. */
export const HANDOFF_TIMEOUT_DEFAULT_MINUTES = 10;
/** The longest an agent may ask to wait. */
export const HANDOFF_TIMEOUT_MAX_MINUTES = 30;
/**
 * Once a person has control there is no deadline; only their live view going
 * away for this long ends it (expired): time to reconnect and carry on.
 */
export const CONTROL_GRACE_MS = 2 * 60_000;
/** While the person in control watches, their grace is pushed at most this often (one write, not one per frame). */
const CONTROL_TOUCH_EVERY_MS = 30_000;
export const ASK_PERSON_TOOL = "browser_ask_person";
/**
 * Server-side topic of handoff changes (never sent to clients): every
 * replica's live view hears them, so the one holding the computer's socket
 * switches the stream and keeps control even when the change came from
 * another replica.
 */
export const BROWSER_HANDOFF_TOPIC = "browser-handoffs";

const OPEN: BrowserHandoffStatus[] = ["pending", "active"];

/**
 * A person's turn in an agent's browser (ADR 0040 §6), as the app shows it:
 * the chat card (`meta.browserHandoff`), the live view's header and the
 * routes. An `ask`'s id is its card message's id.
 */
export interface BrowserHandoffView {
  id: string;
  agentId: string;
  runId: string | null;
  machineId: string;
  kind: "ask" | "takeover";
  instructions: string;
  status: BrowserHandoffStatus;
  requestedForUserId: string | null;
  controllerUserId: string | null;
  note: string | null;
  /** Pending: the agent's deadline. Null once a person has control (no deadline then). */
  expiresAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function handoffView(h: BrowserHandoffRow): BrowserHandoffView {
  return {
    id: h.id,
    agentId: h.agentId,
    runId: h.runId,
    machineId: h.machineId,
    kind: h.kind,
    instructions: h.instructions,
    status: h.status,
    requestedForUserId: h.requestedForUserId,
    controllerUserId: h.controllerUserId,
    note: h.note,
    expiresAt: h.status === "pending" ? h.expiresAt.toISOString() : null,
    createdAt: h.createdAt.toISOString(),
    resolvedAt: h.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * The live view's side of a handoff (`live.ts`): told when control changes
 * hands, so the stream switches between watching and control. Optional: the
 * handoff works without anyone watching.
 */
export interface HandoffLiveHooks {
  changed(row: BrowserHandoffRow): void;
}

export interface HandoffDeps {
  db: Database;
  pubsub?: PubSub;
  live?: HandoffLiveHooks;
}

/** What the agent reads when its run resumes. */
export function handoffResultText(result: BrowserHandoffResult, kind: "ask" | "takeover" = "ask"): string {
  if (kind === "takeover") {
    return "A person used your browser and handed it back. The page may have changed: read it again (browser_read) before acting.";
  }
  if (result.result === "done") {
    return "The person says it's done. Read the page again (browser_read) and check it worked before going on; if it didn't, say so instead of carrying on.";
  }
  if (result.result === "failed") {
    return `The person couldn't do it${result.note ? `: ${result.note}` : "."} Read the page again and decide what to do; if you are stuck, say what you need in your reply.`;
  }
  return "No one did it in time. Read the page again; if it still needs a person, say so in your reply instead of asking again right away.";
}

// ── Access ────────────────────────────────────────────────────────────────────

/**
 * Who may watch an agent's browser, and take part in its handoffs: org admins,
 * the agent's responsible person, the person a handoff was asked of, and the
 * person behind the work (who asked for the run waiting on it, or for one of
 * the agent's runs going on now). Not everyone who can read a channel: the
 * browser shows all of the agent's work, DMs included.
 */
export async function requireBrowserAccess(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  handoff?: BrowserHandoffRow | null,
) {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  const [agent] = await db
    .select({ owner: agents.ownerUserId, machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  const admin = can(membership.role, "manage_agents");
  const access = { ...agent, admin };
  if (admin || agent.owner === userId) return access;
  const open = handoff === undefined ? await openHandoffOf(db, orgId, agentId) : handoff;
  if (open?.requestedForUserId === userId) return access;
  const runs = open?.runId
    ? [open.runId]
    : (
        await db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.orgId, orgId),
              eq(agentRuns.agentId, agentId),
              inArray(agentRuns.status, ["queued", "running", "waiting_input", "waiting_approval"]),
            ),
          )
          .orderBy(desc(agentRuns.createdAt))
          .limit(5)
      ).map((r) => r.id);
  for (const runId of runs) {
    if ((await humanBehindRun({ db }, orgId, runId)) === userId) return access;
  }
  throw new ForbiddenError("You can't use this agent's browser");
}

/**
 * The computer an agent's browser runs on now: an open handoff's, else the
 * one its browser tools last used (`agents.browser_machine_id`: a mission's
 * or its own, whichever run used it), else the agent's own computer.
 */
export async function browserMachineOf(db: Database, orgId: string, agentId: string): Promise<string | null> {
  const open = await openHandoffOf(db, orgId, agentId);
  if (open) return open.machineId;
  const [agent] = await db
    .select({ machineId: agents.machineId, browserMachineId: agents.browserMachineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  return agent?.browserMachineId ?? agent?.machineId ?? null;
}

async function loadHandoff(db: Executor, orgId: string, handoffId: string) {
  const [row] = await db
    .select()
    .from(browserHandoffs)
    .where(and(eq(browserHandoffs.id, handoffId), eq(browserHandoffs.orgId, orgId)));
  if (!row) throw new NotFoundError("Not found");
  return row;
}

/** The handoff open on an agent's browser (a person in control, or asked to be), if any. */
export async function openHandoffOf(db: Executor, orgId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(browserHandoffs)
    .where(
      and(
        eq(browserHandoffs.orgId, orgId),
        eq(browserHandoffs.agentId, agentId),
        inArray(browserHandoffs.status, OPEN),
      ),
    )
    .orderBy(desc(browserHandoffs.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getHandoff(db: Database, userId: string, orgId: string, handoffId: string) {
  const row = await loadHandoff(db, orgId, handoffId);
  await requireBrowserAccess(db, userId, orgId, row.agentId, row);
  return handoffView(row);
}

// ── Card, events, notifications ───────────────────────────────────────────────

/** Writes the handoff's state into its chat card (`meta.browserHandoff`); takeovers have no card. */
async function syncCard(db: Executor, row: BrowserHandoffRow) {
  if (row.kind !== "ask") return;
  await db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{browserHandoff}', ${JSON.stringify(handoffView(row))}::jsonb)` })
    .where(and(eq(messages.id, row.id), eq(messages.orgId, row.orgId)));
}

async function cardWhere(db: Executor, row: BrowserHandoffRow) {
  if (row.kind !== "ask") return null;
  const [m] = await db
    .select({ channelId: messages.channelId, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.id, row.id), eq(messages.orgId, row.orgId)));
  return m ?? null;
}

/** Tells the conversation (card state) and the live view (who is in control) after a change committed. */
async function afterChange(deps: HandoffDeps, row: BrowserHandoffRow) {
  deps.live?.changed(row);
  // The replica holding the computer's socket may be another one: it hears it here.
  await deps.pubsub
    ?.publish(BROWSER_HANDOFF_TOPIC, {
      type: "browser.handoff.changed",
      orgId: row.orgId,
      agentId: row.agentId,
      handoffId: row.id,
    })
    .catch(() => {});
  const where = await cardWhere(deps.db, row);
  if (where) {
    await publishChannelEvent(deps.pubsub, {
      type: "browser.handoff.updated",
      channelId: where.channelId,
      threadId: where.threadId,
      handoff: handoffView(row),
    });
  }
  if (!OPEN.includes(row.status)) {
    await resolveBrowserHandoffNotifications(deps, row.orgId, row.id).catch(() => {});
  }
}

// ── The tool ──────────────────────────────────────────────────────────────────

/**
 * `browser_ask_person` (scope `browser:use`): the agent asks a person to do
 * something in its browser (sign in, a code, a captcha). A card goes to the
 * conversation, the person who asked for the work (else the agent's owner)
 * hears it in "Waiting for you" and on the phone, and the run waits
 * (`data.pause`) until they press Done or Couldn't, or it expires. The
 * agent then reads the page again and checks.
 */
export function createBrowserHandoffToolSource(
  deps: { pubsub?: PubSub; machines?: { hub: MachineCaller } } = {},
): ToolSource {
  const hub = deps.machines?.hub;
  /** The same computer and checks as the other browser tools: the mission's in a mission thread, else the agent's. */
  const statusOf = async (ctx: ToolContext) =>
    agentBrowserStatus(ctx.db, hub, ctx.orgId, ctx.agentId, (await missionOfRun(ctx))?.machineId ?? null);
  const tool: ToolDefinition = {
    name: ASK_PERSON_TOOL,
    description:
      "Ask a person to do something in your browser that you can't (sign in, type a code sent to their phone, solve a captcha) and wait until they're done. Write what to do in one short sentence in the language the people use. Before asking, try what you can yourself (a password you were given through request_secret goes in with browser_type_secret). End your turn after calling it: you are woken with the result, then read the page again and check.",
    scope: BROWSER_SCOPE,
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", minLength: 1, maxLength: 500 },
        timeout_minutes: {
          type: "integer",
          minimum: 1,
          maximum: HANDOFF_TIMEOUT_MAX_MINUTES,
          description: `How long to wait for someone to open it (default ${HANDOFF_TIMEOUT_DEFAULT_MINUTES}).`,
        },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: BROWSER_TOOL_INFO.browser_ask_person.label,
      detail: typeof input.instructions === "string" ? input.instructions : undefined,
    }),
    async execute(input, ctx): Promise<ToolOutput> {
      const instructions = String(input.instructions ?? "").trim();
      if (!instructions) return { content: "Say what the person should do.", isError: true };
      const minutes =
        typeof input.timeout_minutes === "number"
          ? Math.min(HANDOFF_TIMEOUT_MAX_MINUTES, Math.max(1, Math.floor(input.timeout_minutes)))
          : HANDOFF_TIMEOUT_DEFAULT_MINUTES;
      const status = await statusOf(ctx);
      if (!status.available) return { content: browserUnavailableText(status), isError: true };
      if (!status.online) {
        return {
          content: `Your computer ${status.machineName} is offline, so no one can use your browser now. Say so in your reply.`,
          isError: true,
        };
      }
      const machineId = status.machineId;
      const [run] = await ctx.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)));
      if (!run) return { content: "This call can't wait for a person here.", isError: true };
      const open = await openHandoffOf(ctx.db, ctx.orgId, ctx.agentId);
      if (open) {
        return {
          content:
            open.kind === "takeover"
              ? "A person is using your browser right now. Wait for them to hand it back before asking."
              : "You already asked a person for help in your browser; wait for that answer.",
          isError: true,
        };
      }
      const where = await runWhere(ctx.db, run);
      const recipient = await browserHandoffRecipient({ db: ctx.db }, ctx.orgId, ctx.runId, ctx.agentId);
      const busy = {
        content: "A person is using your browser, or was just asked to; wait for that before asking.",
        isError: true,
      };
      let created: { card: Awaited<ReturnType<typeof insertMessage>>; row: BrowserHandoffRow };
      try {
        created = await ctx.db.transaction(async (tx) => {
          const card = await insertMessage(tx, {
            orgId: run.orgId,
            channelId: where.channelId,
            threadId: where.threadId,
            author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
            body: `Help needed in the browser: ${instructions}`,
            meta: bodyCode("browser_handoff", { instructions }),
          });
          // The card's id is the handoff's: the card is found and kept in sync by it.
          const [row] = await tx
            .insert(browserHandoffs)
            .values({
              id: card.id,
              orgId: run.orgId,
              agentId: run.agentId,
              runId: run.id,
              machineId,
              kind: "ask",
              instructions,
              requestedForUserId: recipient,
              expiresAt: new Date(Date.now() + minutes * 60_000),
            })
            .returning();
          if (!row) throw new Error("handoff not created");
          await syncCard(tx, row);
          card.meta = { ...card.meta, browserHandoff: handoffView(row) };
          return { card, row };
        });
      } catch (error) {
        // Someone took over (or another run asked) between the check and the insert: one open handoff per browser.
        if (isUniqueViolation(error)) return busy;
        throw error;
      }
      if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(created.card));
      await notifyBrowserHandoff({ db: ctx.db, pubsub: deps.pubsub }, created.row, {
        channelId: where.channelId,
        threadId: where.threadId,
      }).catch(() => {});
      return {
        content: `Asked for help (if nobody opens it within ${minutes} min you'll be told). End your turn now; you'll be woken with the result.`,
        // The run waits on this handoff and resumes with the result (`resumeRunWithResult`).
        data: { pause: { kind: "input", id: created.row.id }, handoffId: created.row.id },
      };
    },
  };
  return {
    name: "browser-handoff",
    // Offered with the other browser tools: only when the agent's computer serves its browser.
    async tools(ctx) {
      if (!hub) return [];
      const granted = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
      if (!isAllowed(toolAccess(granted, tool))) return [];
      return (await statusOf(ctx)).available ? [tool] : [];
    },
  };
}

// ── A person's side ───────────────────────────────────────────────────────────

/** Resumes the run waiting on a handoff (if any) with what the agent should read. Idempotent. */
async function resumeWaitingRun(db: Database, row: BrowserHandoffRow, result: BrowserHandoffResult) {
  if (!row.runId) return;
  await resumeRunWithResult(db, {
    runId: row.runId,
    waitId: row.id,
    result: { content: handoffResultText(result, row.kind) },
  });
}

/** What an ended handoff tells the agent. */
function endedResult(row: BrowserHandoffRow): BrowserHandoffResult {
  if (row.status === "done") return { result: "done" };
  if (row.status === "cancelled") return { result: "failed", note: "a person canceled the request" };
  if (row.status === "failed") return { result: "failed", ...(row.note ? { note: row.note } : {}) };
  return { result: "expired" };
}

/**
 * After a handoff ended (committed): the run goes on and everyone hears.
 * Failures don't undo the end: the sweep (`expireBrowserHandoffs`) resumes
 * runs still waiting on ended handoffs.
 */
async function settle(deps: HandoffDeps, row: BrowserHandoffRow) {
  await resumeWaitingRun(deps.db, row, endedResult(row)).catch(() => {});
  await afterChange(deps, row).catch(() => {});
}

/**
 * A person takes control of an asked handoff (opens the live view and starts
 * driving). Idempotent for the person already in control; another person in
 * control → `ConflictError`.
 */
export async function claimHandoff(deps: HandoffDeps, actorId: string, orgId: string, handoffId: string) {
  const current = await loadHandoff(deps.db, orgId, handoffId);
  await requireBrowserAccess(deps.db, actorId, orgId, current.agentId, current);
  if (!OPEN.includes(current.status)) throw new ConflictError("This is already over");
  if (current.status === "active" && current.controllerUserId === actorId) return handoffView(current);
  const now = Date.now();
  const [row] = await deps.db
    .update(browserHandoffs)
    .set({
      status: "active",
      controllerUserId: actorId,
      // No deadline while in control: only their live view going away for the grace ends it.
      expiresAt: new Date(now + CONTROL_GRACE_MS),
    })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        sql`(${browserHandoffs.status} = 'pending' or (${browserHandoffs.status} = 'active' and ${browserHandoffs.controllerUserId} is null))`,
        sql`${browserHandoffs.expiresAt} > now()`,
      ),
    )
    .returning();
  if (!row) throw new ConflictError("Someone else is in control");
  await syncCard(deps.db, row);
  await afterChange(deps, row);
  return handoffView(row);
}

/**
 * Done or Couldn't (with a note) on an asked handoff, or the hand back of a
 * take over: it ends, and the run waiting on it resumes. Only the person in
 * control, or anyone allowed while nobody took control.
 */
export async function finishHandoff(
  deps: HandoffDeps,
  actorId: string,
  orgId: string,
  handoffId: string,
  input: { result: "done" | "failed"; note?: string },
) {
  const current = await loadHandoff(deps.db, orgId, handoffId);
  await requireBrowserAccess(deps.db, actorId, orgId, current.agentId, current);
  if (current.controllerUserId && current.controllerUserId !== actorId && current.status === "active") {
    throw new ConflictError("Someone else is in control");
  }
  const note = input.result === "failed" ? input.note?.trim().slice(0, 1000) || null : null;
  const ended = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(browserHandoffs)
      .set({
        status: input.result,
        note,
        controllerUserId: current.controllerUserId ?? actorId,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(browserHandoffs.id, handoffId),
          inArray(browserHandoffs.status, OPEN),
          // Someone else took control since it was read: not theirs to finish.
          sql`(${browserHandoffs.status} <> 'active' or ${browserHandoffs.controllerUserId} is null or ${browserHandoffs.controllerUserId} = ${actorId})`,
        ),
      )
      .returning();
    if (!row) return null;
    await syncCard(tx, row);
    return row;
  });
  if (!ended) {
    const now = await loadHandoff(deps.db, orgId, handoffId);
    throw new ConflictError(OPEN.includes(now.status) ? "Someone else is in control" : "This is already over");
  }
  await settle(deps, ended);
  return handoffView(ended);
}

/** A person cancels a handoff (the agent no longer needs it, or they won't do it): the run resumes as failed. */
export async function cancelHandoff(deps: HandoffDeps, actorId: string, orgId: string, handoffId: string) {
  const current = await loadHandoff(deps.db, orgId, handoffId);
  const access = await requireBrowserAccess(deps.db, actorId, orgId, current.agentId, current);
  // Only the person in control, the one it was asked of, the agent's owner or an admin.
  const mayCancel =
    access.admin ||
    access.owner === actorId ||
    current.requestedForUserId === actorId ||
    (current.status === "active" && current.controllerUserId === actorId);
  if (!mayCancel) throw new ForbiddenError("Only the person in control or the agent's owner can cancel this");
  const [row] = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(browserHandoffs)
      .set({ status: "cancelled", resolvedAt: new Date() })
      .where(and(eq(browserHandoffs.id, handoffId), inArray(browserHandoffs.status, OPEN)))
      .returning();
    if (rows[0]) await syncCard(tx, rows[0]);
    return rows;
  });
  if (!row) throw new ConflictError("This is already over");
  await settle(deps, row);
  return handoffView(row);
}

/**
 * A person watching takes over the agent's browser. An open handoff of that
 * agent is claimed instead (one person in control at a time); otherwise a
 * `takeover` starts, and the agent's browser tools wait until it is handed
 * back (`waitIfPersonInControl`).
 */
export async function startTakeover(deps: HandoffDeps, actorId: string, orgId: string, agentId: string) {
  await requireBrowserAccess(deps.db, actorId, orgId, agentId);
  const open = await openHandoffOf(deps.db, orgId, agentId);
  if (open) return claimHandoff(deps, actorId, orgId, open.id);
  const machineId = await browserMachineOf(deps.db, orgId, agentId);
  if (!machineId) throw new ValidationError("This agent has no computer");
  const now = Date.now();
  let row: BrowserHandoffRow | undefined;
  try {
    [row] = await deps.db
      .insert(browserHandoffs)
      .values({
        orgId,
        agentId,
        machineId,
        kind: "takeover",
        status: "active",
        controllerUserId: actorId,
        expiresAt: new Date(now + CONTROL_GRACE_MS),
      })
      .returning();
  } catch (error) {
    // Opened meanwhile (another person, or the agent asked): that one is claimed instead, or it says who has it.
    if (!isUniqueViolation(error)) throw error;
    const raced = await openHandoffOf(deps.db, orgId, agentId);
    if (!raced) throw new ConflictError("Someone else just took control");
    return claimHandoff(deps, actorId, orgId, raced.id);
  }
  if (!row) throw new Error("takeover not created");
  await afterChange(deps, row);
  return handoffView(row);
}

/**
 * Before an agent acts in its browser: a person in control, or asked to take
 * it, makes the call wait (the run pauses on that handoff and resumes when
 * it ends); another run of the agent is refused. Null: go on. For the
 * browser tools (`tools.ts`).
 */
export async function waitIfPersonInControl(
  db: Database,
  ctx: { orgId: string; agentId: string; runId: string },
): Promise<ToolOutput | null> {
  const open = await openHandoffOf(db, ctx.orgId, ctx.agentId);
  if (!open) return null;
  const busy = "A person has control of your browser, or has been asked to take it.";
  if (open.runId && open.runId !== ctx.runId) {
    return { content: `${busy} Try again later, or say so in your reply.`, isError: true };
  }
  if (!open.runId) {
    const [bound] = await db
      .update(browserHandoffs)
      .set({ runId: ctx.runId })
      .where(and(eq(browserHandoffs.id, open.id), isNull(browserHandoffs.runId)))
      .returning({ id: browserHandoffs.id });
    if (!bound) return { content: `${busy} Try again later.`, isError: true };
  }
  return {
    content: `${busy} End your turn; you'll be woken when it's over.`,
    data: { pause: { kind: "input", id: open.id }, handoffId: open.id },
  };
}

/**
 * After a person had control of the agent's browser, the page changed under
 * it: its browser tools other than `browser_read` refuse until it reads the
 * page again (`markPageRead`). Null: go on.
 */
export async function requirePageRead(
  db: Database,
  ctx: { orgId: string; agentId: string },
): Promise<ToolOutput | null> {
  const [changed] = await db
    .select({ id: browserHandoffs.id })
    .from(browserHandoffs)
    .where(
      and(
        eq(browserHandoffs.orgId, ctx.orgId),
        eq(browserHandoffs.agentId, ctx.agentId),
        isNotNull(browserHandoffs.resolvedAt),
        isNotNull(browserHandoffs.controllerUserId),
        isNull(browserHandoffs.pageReadAt),
      ),
    )
    .limit(1);
  if (!changed) return null;
  return {
    content: "Read the page again first (a person changed it): call browser_read, then act on what it shows.",
    isError: true,
  };
}

/** The agent read its page: whatever a person changed before is now seen. */
export async function markPageRead(db: Database, ctx: { orgId: string; agentId: string }) {
  await db
    .update(browserHandoffs)
    .set({ pageReadAt: new Date() })
    .where(
      and(
        eq(browserHandoffs.orgId, ctx.orgId),
        eq(browserHandoffs.agentId, ctx.agentId),
        isNotNull(browserHandoffs.resolvedAt),
        isNull(browserHandoffs.pageReadAt),
      ),
    );
}

/**
 * The person in control left (their live view dropped and didn't come back
 * within `CONTROL_GRACE_MS`): the handoff ends as expired, and the waiting
 * run resumes. Nothing when someone else took over meanwhile or it ended.
 */
export async function expireControl(deps: HandoffDeps, handoffId: string, userId: string, now = new Date()) {
  const [row] = await deps.db
    .update(browserHandoffs)
    .set({ status: "expired", resolvedAt: now })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        eq(browserHandoffs.status, "active"),
        eq(browserHandoffs.controllerUserId, userId),
        // Their presence is kept in the database: back on another server (or still typing there)
        // pushed the deadline, and only a deadline that passed ends it.
        lte(browserHandoffs.expiresAt, now),
      ),
    )
    .returning();
  if (!row) return null;
  await syncCard(deps.db, row).catch(() => {});
  await settle(deps, row);
  return handoffView(row);
}

/**
 * The person in control is still there (watching or typing): their grace
 * moves to `CONTROL_GRACE_MS` from now. Kept in the database so control ends
 * even when the server that saw them go restarts. Written at most every
 * `CONTROL_TOUCH_EVERY_MS`, unless `force` (they just came back: at once, so
 * a server that saw them leave doesn't end it).
 */
export async function touchControl(db: Executor, handoffId: string, userId: string, now = new Date(), force = false) {
  const until = new Date(now.getTime() + CONTROL_GRACE_MS);
  await db
    .update(browserHandoffs)
    .set({ expiresAt: until })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        eq(browserHandoffs.status, "active"),
        eq(browserHandoffs.controllerUserId, userId),
        force ? sql`true` : lt(browserHandoffs.expiresAt, new Date(until.getTime() - CONTROL_TOUCH_EVERY_MS)),
      ),
    );
}

/**
 * The person in control left this server: their control ends at `until`
 * unless they come back here or elsewhere (`touchControl` pushes it again).
 */
export async function setControlDeadline(db: Executor, handoffId: string, userId: string, until: Date) {
  await db
    .update(browserHandoffs)
    .set({ expiresAt: until })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        eq(browserHandoffs.status, "active"),
        eq(browserHandoffs.controllerUserId, userId),
      ),
    );
}

/**
 * Ends handoffs past their deadline (the agent's wait while pending, the
 * person's inactivity while active) and resumes their runs (worker, every
 * minute). Then resumes runs still waiting on a handoff that ended (a resume
 * that failed earlier): resuming is idempotent, so nothing is lost.
 */
export async function expireBrowserHandoffs(deps: HandoffDeps, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(browserHandoffs)
      .set({ status: "expired", resolvedAt: now })
      .where(and(inArray(browserHandoffs.status, OPEN), lt(browserHandoffs.expiresAt, now)))
      .returning();
    for (const row of rows) await syncCard(tx, row);
    return rows;
  });
  for (const row of expired) await settle(deps, row);
  const stranded = await deps.db
    .select({ handoff: browserHandoffs })
    .from(browserHandoffs)
    .innerJoin(agentRuns, eq(agentRuns.id, browserHandoffs.runId))
    .where(
      and(
        isNotNull(browserHandoffs.resolvedAt),
        gt(browserHandoffs.resolvedAt, new Date(now.getTime() - 24 * 60 * 60_000)),
        inArray(agentRuns.status, ["waiting_input", "waiting_approval"]),
      ),
    )
    .limit(50);
  for (const { handoff } of stranded) {
    if (OPEN.includes(handoff.status)) continue;
    await resumeWaitingRun(deps.db, handoff, endedResult(handoff)).catch(() => {});
  }
  return expired.length;
}

/**
 * "Parar" on the live view or the computer page: closes the agent's browser
 * now (its logins stay in its profile). Whoever may watch it may stop it; the
 * agent's next browser call opens a fresh one.
 */
export async function stopAgentBrowser(
  db: Database,
  hub: MachineCaller | undefined,
  actorId: string,
  orgId: string,
  agentId: string,
) {
  await requireBrowserAccess(db, actorId, orgId, agentId);
  if (!hub) throw new ValidationError("Connected computers are not available on this server");
  const machineId = await browserMachineOf(db, orgId, agentId);
  if (!machineId) throw new ValidationError("This agent has no computer");
  const agent = await getAgentCached(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  await hub.call<"browser.stop">(
    machineId,
    { op: "browser.stop", agent: { id: agentId, handle: agent.handle, ...(agent.name ? { name: agent.name } : {}) } },
    { timeoutMs: 30_000 },
  );
}
