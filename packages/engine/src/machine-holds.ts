import type { MachineReplies, MachineRequest, PubSub, RunnerFrame, RunnerHolds } from "@agenteschat/adapters";
import { and, type Database, desc, eq, gt, inArray, isNotNull, isNull, lte, type SQL, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { publishOrgEvent } from "./events";

const { machineHolds } = schema;

/**
 * `keep_running` (ADR 0176): what an agent keeps running on its computer. The runner holds the computer's standard
 * "don't go idle" lock for each hold, bound to the program, the browser or a time; the words people read live here.
 * People see each hold on the agent's computer and may stop it; the computer says when one ends by itself, and its
 * `hello` which live: a time's hold is taken again after a restart or a move for the time left, a program's or the
 * browser's ends with them.
 */

/** Live holds an agent may have at once. */
export const MAX_HOLDS_PER_AGENT = 10;
/** How far ahead a hold may end at most: a time's hold must end, and a week covers a weekend or a campaign. */
export const HOLD_MAX_MS = 7 * 24 * 3600_000;
/** How long an ended hold is still told to its agent, in its tool's description. */
const ENDED_TOLD_MS = 7 * 24 * 3600_000;

export type HoldRow = typeof machineHolds.$inferSelect;
export type HoldEndReason = NonNullable<HoldRow["endReason"]>;

/** A hold as people and the apps see it. */
export interface HoldView {
  id: string;
  agentId: string;
  machineId: string;
  what: string;
  why: string;
  /** What it is bound to: one of the agent's programs, its browser, or a time alone. */
  kind: "program" | "browser" | "time";
  since: string;
  until: string | null;
}

export const holdView = (row: HoldRow): HoldView => ({
  id: row.id,
  agentId: row.agentId,
  machineId: row.machineId,
  what: row.what,
  why: row.why,
  kind: row.pid !== null ? "program" : row.browser ? "browser" : "time",
  since: row.createdAt.toISOString(),
  until: row.until?.toISOString() ?? null,
});

interface Deps {
  db: Database;
  pubsub?: PubSub;
}

/** Calls the computer the hold is on (`hub.call`, or a socket's own on its hello). */
type Call = <Op extends "keep.start" | "keep.end">(
  machineId: string,
  request: Extract<MachineRequest, { op: Op }>,
) => Promise<MachineReplies[Op]>;

/** The hold's agent as requests name it: the computer finds its user by the id, and names a new one after it. */
async function agentOf(db: Database, row: Pick<HoldRow, "orgId" | "agentId">) {
  const agent = await getAgentCached(db, row.orgId, row.agentId).catch(() => null);
  return { id: row.agentId, handle: agent?.handle ?? "agent", ...(agent?.name ? { name: agent.name } : {}) };
}

/** The apps that show the agent's computer read its holds again (only ids go out). */
const holdsChanged = (pubsub: PubSub | undefined, row: Pick<HoldRow, "orgId" | "machineId" | "agentId">) =>
  publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId: row.orgId,
    event: { type: "machine.holds", machineId: row.machineId, agentId: row.agentId },
  });

/**
 * Holds whose time passed end as expired, here as on the computer (where only the runner's clock says so), at their
 * time: one that ran out while the computer was away ends with no word from it.
 */
async function expire(deps: Deps, where: SQL | undefined) {
  const rows = await deps.db
    .select()
    .from(machineHolds)
    .where(
      and(where, isNull(machineHolds.endedAt), isNotNull(machineHolds.until), lte(machineHolds.until, new Date())),
    );
  for (const row of rows) await endHold(deps, row, "expired", {}, row.until ?? undefined);
}

/** The agent's live holds, oldest first. */
export async function agentHolds(deps: Deps, orgId: string, agentId: string): Promise<HoldRow[]> {
  const { db } = deps;
  await expire(deps, and(eq(machineHolds.orgId, orgId), eq(machineHolds.agentId, agentId)));
  return db
    .select()
    .from(machineHolds)
    .where(and(eq(machineHolds.orgId, orgId), eq(machineHolds.agentId, agentId), isNull(machineHolds.endedAt)))
    .orderBy(machineHolds.createdAt);
}

/** Holds of the agent that ended lately, newest first: its next turns are told (a program gone with a restart). */
export async function endedHolds(db: Database, orgId: string, agentId: string, limit = 5): Promise<HoldRow[]> {
  return db
    .select()
    .from(machineHolds)
    .where(
      and(
        eq(machineHolds.orgId, orgId),
        eq(machineHolds.agentId, agentId),
        gt(machineHolds.endedAt, new Date(Date.now() - ENDED_TOLD_MS)),
      ),
    )
    .orderBy(desc(machineHolds.endedAt))
    .limit(limit);
}

/** Ends a live hold here (the computer is told by the caller, or knows already); false when it had ended. */
export async function endHold(
  deps: Deps,
  row: HoldRow,
  reason: HoldEndReason,
  by: { userId?: string; runId?: string } = {},
  at = new Date(),
): Promise<boolean> {
  const [ended] = await deps.db
    .update(machineHolds)
    .set({ endedAt: at, endReason: reason, endedByUserId: by.userId ?? null, updatedAt: new Date() })
    .where(and(eq(machineHolds.id, row.id), isNull(machineHolds.endedAt)))
    .returning();
  if (!ended) return false;
  await recordAudit(deps.db, {
    orgId: row.orgId,
    actor: by.userId
      ? { type: "person", id: by.userId }
      : by.runId
        ? { type: "agent", id: row.agentId }
        : { type: "system", id: null },
    action: "machine.hold_ended",
    target: { type: "machine", id: row.machineId },
    details: { holdId: row.id, agentId: row.agentId, what: row.what, reason },
    runId: by.runId ?? null,
  }).catch(() => undefined);
  await holdsChanged(deps.pubsub, row);
  return true;
}

export interface HoldAsk {
  orgId: string;
  agent: { id: string; handle: string };
  machineId: string;
  /** The agent's live hold to change, by its id (a time's hold has no program to find it by). */
  holdId?: string;
  runId?: string | null;
  what: string;
  why: string;
  pid?: number;
  browser?: boolean;
  until?: Date;
}

/**
 * Takes a hold on the agent's computer, or changes the agent's live one of that id, or on the same program (or its
 * browser): the computer first, then the row, so a hold people see is one the computer holds. Throws the computer's
 * refusal.
 */
export async function takeHold(
  deps: Deps & { call: Call },
  ask: HoldAsk,
): Promise<{ row: HoldRow; updated: boolean } | { full: true }> {
  const live = await agentHolds(deps, ask.orgId, ask.agent.id);
  const same = live.find(
    (h) =>
      h.machineId === ask.machineId &&
      (h.id === ask.holdId ||
        (ask.pid !== undefined && h.pid === ask.pid) ||
        (ask.browser === true && h.browser && h.pid === null)),
  );
  if (!same && live.length >= MAX_HOLDS_PER_AGENT) return { full: true };
  const id = same?.id ?? Bun.randomUUIDv7();
  await deps.call(ask.machineId, {
    op: "keep.start",
    agent: ask.agent,
    holdId: id,
    ...(ask.pid !== undefined ? { pid: ask.pid } : {}),
    ...(ask.browser ? { browser: true } : {}),
    ...(ask.until ? { until: ask.until.toISOString() } : {}),
  });
  const now = new Date();
  const fields = { what: ask.what, why: ask.why, until: ask.until ?? null, runId: ask.runId ?? null, updatedAt: now };
  const [row] = same
    ? await deps.db
        .update(machineHolds)
        // The computer holds it now: an end it heard meanwhile (its old lock's, a time run out) is undone.
        .set({ ...fields, endedAt: null, endReason: null, endedByUserId: null })
        .where(eq(machineHolds.id, same.id))
        .returning()
    : await deps.db
        .insert(machineHolds)
        .values({
          ...fields,
          id,
          orgId: ask.orgId,
          agentId: ask.agent.id,
          machineId: ask.machineId,
          pid: ask.pid ?? null,
          browser: ask.browser === true,
        })
        .returning();
  if (!row) throw new Error("machine_holds write returned nothing");
  await recordAudit(deps.db, {
    orgId: ask.orgId,
    actor: { type: "agent", id: ask.agent.id },
    action: same ? "machine.hold_changed" : "machine.hold_started",
    target: { type: "machine", id: ask.machineId },
    details: { holdId: id, what: ask.what, kind: holdView(row).kind, until: row.until?.toISOString() ?? null },
    runId: ask.runId ?? null,
  }).catch(() => undefined);
  await holdsChanged(deps.pubsub, row);
  return { row, updated: Boolean(same) };
}

/**
 * Ends a hold for the agent (`keep_running` `end`) or for a person (Stop, `stop`: its program or browser too). The
 * computer hears it now when it is there; one that isn't learns it at its next `hello`.
 */
export async function releaseHold(
  deps: Deps & { call: Call },
  row: HoldRow,
  how: { reason: "ended_by_agent"; runId?: string } | { reason: "stopped_by_person"; userId: string },
): Promise<void> {
  try {
    await deps.call(row.machineId, {
      op: "keep.end",
      agent: await agentOf(deps.db, row),
      holdId: row.id,
      ...(how.reason === "stopped_by_person" ? { stop: true } : {}),
    });
  } catch {
    // Offline or too old: its next hello says the hold lives, and hears it ended, a Stop with what it held
    // (`reconcileHolds`).
  }
  await endHold(
    deps,
    row,
    how.reason,
    how.reason === "stopped_by_person" ? { userId: how.userId } : { runId: how.runId },
  );
}

/**
 * The computer said hello: each live hold here it doesn't hold any more ended there (the reason it gives), or with a
 * restart; a time's hold is taken again for its time left; one it holds that ended here ends there too, and a person's
 * Stop while it was away stops its program or browser then. A runner before `KEEP_RUNNING_PROTOCOL` (no `call`) holds
 * none.
 */
export async function reconcileHolds(
  deps: Deps & { call: Call | null },
  machineId: string,
  reported: RunnerHolds | undefined,
): Promise<void> {
  const { call } = deps;
  await expire(deps, eq(machineHolds.machineId, machineId));
  const live = await deps.db
    .select()
    .from(machineHolds)
    .where(and(eq(machineHolds.machineId, machineId), isNull(machineHolds.endedAt)));
  const held = new Set(reported?.live ?? []);
  const ended = new Map((reported?.ended ?? []).map((e) => [e.id, e.reason]));
  for (const row of live) {
    if (held.has(row.id)) continue;
    const reason = ended.get(row.id);
    if (reason) {
      await endHold(deps, row, reason);
      continue;
    }
    if (call && row.pid === null && !row.browser && row.until) {
      try {
        await call(machineId, {
          op: "keep.start",
          agent: await agentOf(deps.db, row),
          holdId: row.id,
          until: row.until.toISOString(),
        });
        continue;
      } catch {
        // It couldn't take it again: ended, like a program's.
      }
    }
    await endHold(deps, row, "restarted");
  }
  const known = new Set(live.map((r) => r.id));
  const stale = [...held].filter((id) => !known.has(id));
  if (!call || stale.length === 0) return;
  // Ended here meanwhile, or never recorded (the server failed between the computer's answer and its write). A
  // person's Stop while it was away stops what it held now.
  const stopped = await deps.db
    .select({ id: machineHolds.id })
    .from(machineHolds)
    .where(
      and(
        eq(machineHolds.machineId, machineId),
        inArray(machineHolds.id, stale),
        eq(machineHolds.endReason, "stopped_by_person"),
      ),
    );
  const stop = new Set(stopped.map((r) => r.id));
  for (const holdId of stale) {
    await call(machineId, { op: "keep.end", holdId, ...(stop.has(holdId) ? { stop: true } : {}) }).catch(
      () => undefined,
    );
  }
}

/** `keep.ended`: a hold ended on the computer by itself (its program or browser went away, or its time ran out). */
export async function holdEndedOnComputer(
  deps: Deps,
  machineId: string,
  frame: Extract<RunnerFrame, { type: "keep.ended" }>,
): Promise<void> {
  const [row] = await deps.db
    .select()
    .from(machineHolds)
    .where(and(eq(machineHolds.id, frame.holdId), eq(machineHolds.machineId, machineId), isNull(machineHolds.endedAt)));
  if (row) await endHold(deps, row, frame.reason);
}

/** The agent's live holds and those that ended lately, for its tool's description. */
export async function holdsText(deps: Deps, orgId: string, agentId: string): Promise<string> {
  const [live, ended] = await Promise.all([agentHolds(deps, orgId, agentId), endedHolds(deps.db, orgId, agentId)]);
  const bound = (r: HoldRow) =>
    r.pid !== null ? `program ${r.pid}` : r.browser ? "your browser" : `until ${r.until?.toISOString()}`;
  const why: Record<HoldEndReason, string> = {
    exited: "it stopped",
    expired: "its time ran out",
    stopped_by_person: "a person stopped it",
    ended_by_agent: "you ended it",
    restarted: "the computer restarted",
  };
  const lines = [
    ...(live.length > 0
      ? [
          "Your holds now:",
          ...live.map(
            (r) =>
              `- ${r.id} "${r.what}": ${bound(r)}${r.until && (r.pid !== null || r.browser) ? `, until ${r.until.toISOString()}` : ""}`,
          ),
        ]
      : []),
    ...(ended.length > 0
      ? [
          "Ended lately:",
          ...ended.map(
            (r) => `- "${r.what}" (${bound(r)}): ${why[r.endReason ?? "exited"]}, ${r.endedAt?.toISOString() ?? ""}`,
          ),
        ]
      : []),
  ];
  return lines.join("\n");
}

/** The agent's live hold of this id (one the agent or a person named), or null. */
export async function liveHold(deps: Deps, orgId: string, agentId: string, holdId: string) {
  const live = await agentHolds(deps, orgId, agentId);
  return live.find((h) => h.id === holdId) ?? null;
}
