import { and, asc, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { canTalkTo } from "./audience";
import { caches } from "./cache";
import { summarizeScopes } from "./capabilities";
import { requesterOf } from "./dispatch";
import { getMessage } from "./messages";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agentRuns, agentScopes, agents, users } = schema;

export const FIND_AGENT_TOOL = "find_agent";
/** Up to this many teammates are named in every prompt; above it, only a hint to use `find_agent`. */
export const TEAM_IN_PROMPT = 15;

type Teammate = Pick<
  typeof agents.$inferSelect,
  "id" | "name" | "handle" | "role" | "instructions" | "ownerUserId" | "audienceMode" | "audienceUserIds"
>;

/** The org's active agents, oldest first (per-process cache; agent writes drop it). */
export function loadTeam(db: Database, orgId: string): Promise<Teammate[]> {
  return caches.agents.getOrLoad(`${orgId}:team`, () =>
    db
      .select({
        id: agents.id,
        name: agents.name,
        handle: agents.handle,
        role: agents.role,
        instructions: agents.instructions,
        ownerUserId: agents.ownerUserId,
        audienceMode: agents.audienceMode,
        audienceUserIds: agents.audienceUserIds,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .orderBy(asc(agents.createdAt)),
  ) as Promise<Teammate[]>;
}

export const forgetTeam = (orgId: string) => caches.agents.delete(`${orgId}:team`);

/**
 * "# Your team" for the system prompt (D54): the other agents the person
 * behind the run can talk to, one short line each, so an agent knows who
 * exists even in a DM. Details stay behind `find_agent`. Agents already
 * described in "Where you are" (channel members) are left out.
 */
export function teamPrompt(team: Teammate[], selfId: string, requester: string | null, skip: Set<string>) {
  const others = team.filter((a) => a.id !== selfId && !skip.has(a.id) && canTalkTo(a, requester));
  if (others.length === 0) return "";
  const lines =
    others.length > TEAM_IN_PROMPT
      ? `${others.length} other agents work in this organization.`
      : `Other agents in this organization: ${others.map((a) => `@${a.handle}${a.role ? ` (${a.role})` : ""}`).join(", ")}.`;
  return `# Your team\n${lines} Use \`${FIND_AGENT_TOOL}\` to see who knows or can do something and what each one can do; ask one with \`ask_agent\` when you need its help for the task, instead of saying you can't or sending the person to it.`;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);

/**
 * The built-in `find_agent` tool (D54): who else works here, searchable by
 * name, role or what they do. Lists only agents the person behind the run can
 * talk to, with what they can do, who is responsible and whether they are
 * busy. Read-only; asking one is `ask_agent`.
 */
export function createFindAgentToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: FIND_AGENT_TOOL,
    description:
      "Find the organization's other agents: who knows or can do something (e.g. deploys, finance, design), what each one can do, who is responsible for it and whether it is busy now. Leave `query` empty to list them all. To ask one, use ask_agent.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "What you need, e.g. 'staging deploy' or 'invoices'." },
      },
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Find agents", detail: String(input.query ?? "") }),
    async execute(input, ctx) {
      const { db } = ctx;
      const trigger = await getMessage(db, ctx.orgId, ctx.triggerMessageId);
      const person = trigger ? await requesterOf(db, trigger) : null;
      const team = (await loadTeam(db, ctx.orgId)).filter((a) => a.id !== ctx.agentId && canTalkTo(a, person));
      const query = words(String(input.query ?? ""));
      const scored = team
        .map((a) => {
          const name = new Set(words(`${a.name} ${a.handle} ${a.role}`));
          const body = new Set(words(a.instructions));
          const score = query.reduce((s, w) => s + (name.has(w) ? 3 : 0) + (body.has(w) ? 1 : 0), 0);
          return { a, score };
        })
        .filter((x) => query.length === 0 || x.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 10);
      if (scored.length === 0) {
        return {
          content:
            team.length === 0
              ? "No other agent here works with this person."
              : `No agent matches that. The others: ${team.map((a) => `@${a.handle}${a.role ? ` (${a.role})` : ""}`).join(", ")}.`,
        };
      }
      const ids = scored.map((x) => x.a.id);
      const ownerIds = [...new Set(scored.map((x) => x.a.ownerUserId).filter((id): id is string => !!id))];
      const [scopes, owners, busy] = await Promise.all([
        db
          .select({ agentId: agentScopes.agentId, scope: agentScopes.scope })
          .from(agentScopes)
          .where(and(eq(agentScopes.orgId, ctx.orgId), inArray(agentScopes.agentId, ids))),
        ownerIds.length
          ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))
          : Promise.resolve([]),
        db
          .select({ agentId: agentRuns.agentId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.orgId, ctx.orgId),
              inArray(agentRuns.agentId, ids),
              inArray(agentRuns.status, ["running", "waiting_approval", "waiting_input"]),
            ),
          ),
      ]);
      const busyIds = new Set(busy.map((r) => r.agentId));
      const content = scored
        .map(({ a }) => {
          const about = a.instructions.trim().replace(/\s+/g, " ");
          const owner = owners.find((o) => o.id === a.ownerUserId)?.name;
          return [
            `@${a.handle}: ${a.name}${a.role ? `, ${a.role}` : ""}${busyIds.has(a.id) ? " (working now)" : ""}`,
            `  Can: ${summarizeScopes(scopes.filter((s) => s.agentId === a.id).map((s) => s.scope))}`,
            owner ? `  Responsible person: ${owner}` : "",
            about ? `  About: ${about.length > 240 ? `${about.slice(0, 237)}…` : about}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n");
      return { content };
    },
  };
  return { name: "team", tools: async () => [tool] };
}
