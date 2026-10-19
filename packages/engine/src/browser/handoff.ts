import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, isNull, lt, schema, sql } from "@agenteschat/db";
import { requireChannelAccess } from "../channels";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { publishChannelEvent, publishMessageCreated } from "../events";
import { getMachineById, machineOnline } from "../machines";
import { insertMessage, messageView } from "../messages";
import {
  browserHandoffRecipient,
  notifyBrowserHandoff,
  resolveBrowserHandoffNotifications,
} from "../notification-producers";
import { can, getMembership } from "../organizations";
import { resumeRunWithResult } from "../run-resume";
import { bodyCode, runWhere } from "../run-tools";
import type { ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { BROWSER_SCOPE, BROWSER_TOOL_INFO, type BrowserHandoffResult } from "./types";

const { browserHandoffs, agentRuns, agents, messages } = schema;

export type BrowserHandoffRow = typeof browserHandoffs.$inferSelect;
export type BrowserHandoffStatus = BrowserHandoffRow["status"];

/** The longest an agent may wait for a person in its browser (and the default). */
export const HANDOFF_TIMEOUT_MAX_MINUTES = 30;
/** A person in control whose live view dropped keeps control this long, to reconnect and carry on. */
export const CONTROL_GRACE_MS = 60_000;
export const ASK_PERSON_TOOL = "browser_ask_person";

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
  expiresAt: string;
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
    expiresAt: h.expiresAt.toISOString(),
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
 * the agent's responsible person, the person a handoff was asked of, and
 * whoever can read the conversation the waiting run belongs to.
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
  if (can(membership.role, "manage_agents") || agent.owner === userId) return agent;
  if (handoff?.requestedForUserId === userId) return agent;
  // The conversation of the run waiting on it (or of the agent's latest active run).
  const runId =
    handoff?.runId ??
    (
      await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, orgId),
            eq(agentRuns.agentId, agentId),
            inArray(agentRuns.status, ["running", "waiting_input", "waiting_approval"]),
          ),
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1)
    )[0]?.id;
  if (runId) {
    const [run] = await db
      .select({ channelId: agentRuns.channelId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
    if (run) {
      await requireChannelAccess(db, userId, orgId, run.channelId);
      return agent;
    }
  }
  throw new ForbiddenError("You can't use this agent's browser");
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
export function createBrowserHandoffToolSource(deps: { pubsub?: PubSub } = {}): ToolSource {
  const tool: ToolDefinition = {
    name: ASK_PERSON_TOOL,
    description:
      "Ask a person to do something in your browser that you can't (sign in, type a code sent to their phone, solve a captcha) and wait until they're done. Write what to do in one short sentence in the language the people use. Use test accounts or your own; never ask for someone's personal account. Before asking, try what you can yourself (a password you were given goes through browser_type_secret). End your turn after calling it: you are woken with the result, then read the page again and check.",
    scope: BROWSER_SCOPE,
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", minLength: 1, maxLength: 500 },
        timeout_minutes: { type: "integer", minimum: 1, maximum: HANDOFF_TIMEOUT_MAX_MINUTES },
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
          : HANDOFF_TIMEOUT_MAX_MINUTES;
      const [agent] = await ctx.db
        .select({ machineId: agents.machineId })
        .from(agents)
        .where(and(eq(agents.id, ctx.agentId), eq(agents.orgId, ctx.orgId)));
      if (!agent?.machineId) {
        return { content: "Your browser runs on a connected computer, and you have none.", isError: true };
      }
      const machine = await getMachineById(ctx.db, agent.machineId);
      if (!machine || machine.deletedAt || !machineOnline(machine)) {
        return {
          content: `Your computer${machine ? ` ${machine.name}` : ""} is offline, so no one can use your browser now. Say so in your reply.`,
          isError: true,
        };
      }
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
      const created = await ctx.db.transaction(async (tx) => {
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
            machineId: agent.machineId as string,
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
      if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(created.card));
      await notifyBrowserHandoff({ db: ctx.db, pubsub: deps.pubsub }, created.row, {
        channelId: where.channelId,
        threadId: where.threadId,
      }).catch(() => {});
      return {
        content: `Asked ${recipient ? "the person" : "the people"} for help (up to ${minutes} min). End your turn now; you'll be woken with the result.`,
        // The run waits on this handoff and resumes with the result (`resumeRunWithResult`).
        data: { pause: { kind: "input", id: created.row.id }, handoffId: created.row.id },
      };
    },
  };
  return { name: "browser-handoff", tools: async () => [tool] };
}

// ── A person's side ───────────────────────────────────────────────────────────

/** Resumes the run waiting on a handoff (if any) with what the agent should read. */
async function resumeWaitingRun(db: Database, row: BrowserHandoffRow, result: BrowserHandoffResult) {
  if (!row.runId) return;
  await resumeRunWithResult(db, {
    runId: row.runId,
    waitId: row.id,
    result: { content: handoffResultText(result, row.kind) },
  });
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
  const [row] = await deps.db
    .update(browserHandoffs)
    .set({ status: "active", controllerUserId: actorId })
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
      .where(and(eq(browserHandoffs.id, handoffId), inArray(browserHandoffs.status, OPEN)))
      .returning();
    if (!row) return null;
    await syncCard(tx, row);
    return row;
  });
  if (!ended) throw new ConflictError("This is already over");
  await resumeWaitingRun(deps.db, ended, { result: input.result, ...(note ? { note } : {}) });
  await afterChange(deps, ended);
  return handoffView(ended);
}

/** A person cancels a handoff (the agent no longer needs it, or they won't do it): the run resumes as failed. */
export async function cancelHandoff(deps: HandoffDeps, actorId: string, orgId: string, handoffId: string) {
  const current = await loadHandoff(deps.db, orgId, handoffId);
  await requireBrowserAccess(deps.db, actorId, orgId, current.agentId, current);
  const [row] = await deps.db
    .update(browserHandoffs)
    .set({ status: "cancelled", resolvedAt: new Date() })
    .where(and(eq(browserHandoffs.id, handoffId), inArray(browserHandoffs.status, OPEN)))
    .returning();
  if (!row) throw new ConflictError("This is already over");
  await syncCard(deps.db, row);
  await resumeWaitingRun(deps.db, row, { result: "failed", note: "a person canceled the request" });
  await afterChange(deps, row);
  return handoffView(row);
}

/**
 * A person watching takes over the agent's browser. An open handoff of that
 * agent is claimed instead (one person in control at a time); otherwise a
 * `takeover` starts, and the agent's browser tools wait until it is handed
 * back (`waitIfPersonInControl`).
 */
export async function startTakeover(deps: HandoffDeps, actorId: string, orgId: string, agentId: string) {
  const agent = await requireBrowserAccess(deps.db, actorId, orgId, agentId);
  if (!agent.machineId) throw new ValidationError("This agent has no computer");
  const open = await openHandoffOf(deps.db, orgId, agentId);
  if (open) return claimHandoff(deps, actorId, orgId, open.id);
  const [row] = await deps.db
    .insert(browserHandoffs)
    .values({
      orgId,
      agentId,
      machineId: agent.machineId,
      kind: "takeover",
      status: "active",
      controllerUserId: actorId,
      expiresAt: new Date(Date.now() + HANDOFF_TIMEOUT_MAX_MINUTES * 60_000),
    })
    .returning();
  if (!row) throw new Error("takeover not created");
  await afterChange(deps, row);
  return handoffView(row);
}

/**
 * Before an agent acts in its browser: a person in control makes the call
 * wait (the run pauses on that handoff and resumes when it is handed back).
 * Null: nobody is in control, go on. For the browser tools (`tools.ts`).
 */
export async function waitIfPersonInControl(
  db: Database,
  ctx: { orgId: string; agentId: string; runId: string },
): Promise<ToolOutput | null> {
  const open = await openHandoffOf(db, ctx.orgId, ctx.agentId);
  if (open?.status !== "active") return null;
  if (open.runId && open.runId !== ctx.runId) {
    return {
      content: "A person is using your browser right now. Try again later, or say so in your reply.",
      isError: true,
    };
  }
  if (!open.runId) {
    const [bound] = await db
      .update(browserHandoffs)
      .set({ runId: ctx.runId })
      .where(and(eq(browserHandoffs.id, open.id), isNull(browserHandoffs.runId)))
      .returning({ id: browserHandoffs.id });
    if (!bound) {
      return { content: "A person is using your browser right now. Try again later.", isError: true };
    }
  }
  return {
    content: "A person is using your browser right now. End your turn; you'll be woken when they hand it back.",
    data: { pause: { kind: "input", id: open.id }, handoffId: open.id },
  };
}

/**
 * The person in control left (their live view dropped and didn't come back
 * within `CONTROL_GRACE_MS`): the handoff ends as expired, and the waiting
 * run resumes. Nothing when someone else took over meanwhile or it ended.
 */
export async function expireControl(deps: HandoffDeps, handoffId: string, userId: string) {
  const [row] = await deps.db
    .update(browserHandoffs)
    .set({ status: "expired", resolvedAt: new Date() })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        eq(browserHandoffs.status, "active"),
        eq(browserHandoffs.controllerUserId, userId),
      ),
    )
    .returning();
  if (!row) return null;
  await syncCard(deps.db, row);
  await resumeWaitingRun(deps.db, row, { result: "expired" });
  await afterChange(deps, row);
  return handoffView(row);
}

/** Ends handoffs past their deadline and resumes their runs (worker, every minute). */
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
  for (const row of expired) {
    await resumeWaitingRun(deps.db, row, { result: "expired" });
    await afterChange(deps, row).catch(() => {});
  }
  return expired.length;
}
