import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, gt, inArray, isNull, schema, sql } from "@agenteschat/db";
import { publishOrgEvent } from "./events";
import { requirePermission } from "./organizations";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agents, agentRuns } = schema;

/**
 * An agent's presence, from its work (ADR 0081): nobody sets it by hand.
 * - `busy`: on heavy work (a routine, a task, or a run going for a while), or it said so (`set_status`).
 * - `online`: answering someone, waiting on an answer, or active recently.
 * - `away`: idle for a while.
 * - `offline`: held by the people who run the server. An agent with no AI is drawn offline by the apps,
 *   which already know it (`GET …/agents/ai-status`).
 */
export type AgentPresence = "online" | "busy" | "away" | "offline";

/** A run going this long is heavy work: the agent reads as busy. */
export const AGENT_HEAVY_AFTER_MS = 2 * 60_000;
/** No run for this long: away. */
export const AGENT_AWAY_AFTER_MS = 30 * 60_000;

export const AGENT_STATUS_TEXT_MAX = 100;
/** The longest an agent's status may outlive its run. */
export const AGENT_STATUS_MAX_MS = 24 * 3600_000;

export interface AgentStatusView {
  agentId: string;
  presence: AgentPresence;
  /** What it says it is doing; null = nothing. */
  status: { text: string; emoji: string | null; until: string | null } | null;
  /** Its last run's end (or now while one is going), ISO; null = it never worked. */
  activeAt: string | null;
}

const ACTIVE = ["queued", "running"] as const;
const WAITING = ["waiting_approval", "waiting_input"] as const;

/** How far back an agent's last run is looked for ("active 3 days ago"). */
const ACTIVITY_LOOKBACK_MS = 7 * 24 * 3600_000;

/** Every agent's presence and written status, for a member of the organization. */
export async function agentStatuses(db: Database, actorId: string, orgId: string, now = new Date()) {
  await requirePermission(db, actorId, orgId, "read");
  return loadAgentStatuses(db, orgId, now);
}

/** Every agent's presence and written status in an organization, at `now` (no permission check). */
export async function loadAgentStatuses(db: Database, orgId: string, now = new Date()): Promise<AgentStatusView[]> {
  const [list, open, last] = await Promise.all([
    db
      .select({
        id: agents.id,
        heldAt: agents.operatorHoldAt,
        statusText: agents.statusText,
        statusEmoji: agents.statusEmoji,
        statusBusy: agents.statusBusy,
        statusRunId: agents.statusRunId,
        statusUntil: agents.statusUntil,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt))),
    db
      .select({
        id: agentRuns.id,
        agentId: agentRuns.agentId,
        status: agentRuns.status,
        background: agentRuns.background,
        issueId: agentRuns.issueId,
        startedAt: agentRuns.startedAt,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.status, [...ACTIVE, ...WAITING]))),
    db
      .select({ agentId: agentRuns.agentId, at: sql<Date | string | null>`max(${agentRuns.finishedAt})` })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, orgId), gt(agentRuns.createdAt, new Date(now.getTime() - ACTIVITY_LOOKBACK_MS))),
      )
      .groupBy(agentRuns.agentId),
  ]);
  const lastAt = new Map(last.map((r) => [r.agentId, r.at ? new Date(r.at) : null]));
  const openIds = new Set(open.map((r) => r.id));
  return list.map((a) => {
    const runs = open.filter((r) => r.agentId === a.id);
    const status = liveStatus(a, openIds, now);
    const working = runs.filter((r) => (ACTIVE as readonly string[]).includes(r.status));
    const long = (r: (typeof runs)[number]) =>
      r.startedAt !== null && now.getTime() - r.startedAt.getTime() >= AGENT_HEAVY_AFTER_MS;
    const heavy = working.some((r) => r.background || r.issueId !== null || long(r));
    const activeAt = runs.length > 0 ? now : (lastAt.get(a.id) ?? null);
    const presence: AgentPresence = a.heldAt
      ? "offline"
      : heavy || (status?.busy && working.length > 0)
        ? "busy"
        : runs.length > 0 || (activeAt && now.getTime() - activeAt.getTime() < AGENT_AWAY_AFTER_MS)
          ? "online"
          : "away";
    return {
      agentId: a.id,
      presence,
      status: status && { text: status.text, emoji: status.emoji, until: status.until },
      activeAt: activeAt?.toISOString() ?? null,
    };
  });
}

/** The written status while it holds: its run is still going, or its end time hasn't come. */
function liveStatus(
  a: {
    statusText: string | null;
    statusEmoji: string | null;
    statusBusy: boolean;
    statusRunId: string | null;
    statusUntil: Date | null;
  },
  openRunIds: Set<string>,
  now: Date,
) {
  if (!a.statusText) return null;
  if (a.statusUntil ? a.statusUntil <= now : !a.statusRunId || !openRunIds.has(a.statusRunId)) return null;
  return {
    text: a.statusText,
    emoji: a.statusEmoji,
    busy: a.statusBusy,
    until: a.statusUntil?.toISOString() ?? null,
  };
}

export const SET_STATUS_TOOL = "set_status";

/**
 * The built-in `set_status`: the agent says what it is doing ("Revisando o PR #12"), shown next to its
 * name everywhere, and may ask not to be interrupted (`busy`). It clears when the run ends, or at
 * `minutes` from now. Every agent has it; it changes nothing but its own line.
 */
export function createSetStatusToolSource(deps: { pubsub?: PubSub } = {}): ToolSource {
  const tool: ToolDefinition = {
    name: SET_STATUS_TOOL,
    description:
      "Show the team what you are doing, next to your name: a short line in the language of the conversation (e.g. 'Revisando o PR #12'). Use it when starting work that takes more than a couple of minutes; set `busy` when it is heavy and you'd rather not be interrupted. It clears when you finish; `minutes` keeps it longer (up to a day). An empty `text` clears it now.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: AGENT_STATUS_TEXT_MAX },
        emoji: { type: "string", maxLength: 16, description: "One emoji, optional." },
        busy: { type: "boolean", description: "Heavy work: people see you as busy." },
        minutes: {
          type: "integer",
          minimum: 1,
          maximum: AGENT_STATUS_MAX_MS / 60_000,
          description: "Keep it this long after you finish; omit to clear it when you finish.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Set status", detail: String(input.text ?? "") }),
    async execute(input, ctx) {
      const text = String(input.text ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, AGENT_STATUS_TEXT_MAX);
      const emoji = typeof input.emoji === "string" && input.emoji.trim() ? input.emoji.trim().slice(0, 16) : null;
      const minutes = typeof input.minutes === "number" ? Math.min(input.minutes, AGENT_STATUS_MAX_MS / 60_000) : null;
      await ctx.db
        .update(agents)
        .set(
          text
            ? {
                statusText: text,
                statusEmoji: emoji,
                statusBusy: input.busy === true,
                statusRunId: ctx.runId || null,
                statusUntil: minutes ? new Date(Date.now() + minutes * 60_000) : null,
              }
            : { statusText: null, statusEmoji: null, statusBusy: false, statusRunId: null, statusUntil: null },
        )
        .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId)));
      await publishOrgEvent(deps.pubsub, {
        type: "org.broadcast",
        orgId: ctx.orgId,
        event: { type: "agent.status", orgId: ctx.orgId, agentId: ctx.agentId },
      });
      return { content: text ? "Status set." : "Status cleared." };
    },
  };
  return { name: "status", tools: async () => [tool] };
}
