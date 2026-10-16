import { MISSION_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { getChannelCached } from "./context";
import { taskRequester } from "./machine-tasks";
import { getMessage } from "./messages";
import {
  homeThreadForDm,
  MISSION_LIMITS,
  type MissionDeps,
  missionOfThread,
  missionRole,
  proposeMission,
  sendToMainSession,
} from "./missions";
import { SANDBOX_SCOPE } from "./sandbox";
import { grantedScopeKeys, grantKey, toolAllowScope } from "./tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
  ...((error as { code?: unknown }).code ? { data: { code: (error as { code: string }).code } } : {}),
});

/**
 * The agent's side of missions (ADR 0029), scope `sandbox:run`, only for an
 * agent whose connected computer can run them (commands on, runner protocol
 * 5): `propose_mission` (the executor plans it; the person confirms with
 * Start) and `send_to_mission` (passes what the owner or a decider asks to
 * the mission's main session).
 */
export function createMissionToolSource(deps: Omit<MissionDeps, "db">): ToolSource {
  const missionDeps = (ctx: ToolContext): MissionDeps => ({ ...deps, db: ctx.db });

  const tools = (computer: string): ToolDefinition[] => [
    {
      name: "propose_mission",
      description: `Propose a mission when a request is long work on the computer "${computer}" (several deliverables, days, product decisions): Claude Code there explores the repository and plans it, and the people get a plan card with Start. Nothing changes until the person who asked presses Start. For one task, use start_task instead.`,
      scope: SANDBOX_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: MISSION_LIMITS.title, description: "A few words" },
          goal: {
            type: "string",
            minLength: 1,
            maxLength: MISSION_LIMITS.goal,
            description: "What the mission must achieve",
          },
          folder: {
            type: "string",
            maxLength: MISSION_LIMITS.repoDir,
            description: "The repository's folder inside your folder on the computer (default: your folder)",
          },
        },
        required: ["title", "goal"],
        additionalProperties: false,
      },
      describe: (input) => ({
        title: `Propose the mission ${str(input.title)}`,
        detail: str(input.goal).slice(0, 500),
      }),
      async execute(input, ctx) {
        try {
          const owner = await taskRequester(ctx);
          if (!owner) return { content: "Only a person's request can become a mission.", isError: true };
          const channel = await getChannelCached(ctx.db, ctx.orgId, ctx.channelId);
          if (!channel || channel.kind === "forum")
            return { content: "Missions live in a channel or a DM.", isError: true };
          const flat = channel.kind === "dm" && ctx.threadRootId === ctx.triggerMessageId;
          const trigger = flat ? await getMessage(ctx.db, ctx.orgId, ctx.triggerMessageId) : null;
          // A flat DM: the mission gets a thread of its own, started from the message that asked.
          const home = flat
            ? await homeThreadForDm(missionDeps(ctx), trigger?.authorUserId ?? owner, {
                orgId: ctx.orgId,
                channelId: ctx.channelId,
                messageId: ctx.triggerMessageId,
                title: str(input.title),
              })
            : ctx.threadRootId;
          const mission = await proposeMission(missionDeps(ctx), {
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            ownerId: owner,
            channelId: ctx.channelId,
            threadRootId: home,
            title: str(input.title),
            goal: str(input.goal),
            repoDir: str(input.folder) || null,
            runId: ctx.runId,
          });
          return {
            content: `Mission ${mission.id} proposed: Claude Code on ${computer} is planning it now (read only). The people see a plan card with Start; nothing changes until the person who asked presses it. Tell them in one or two lines, and end your turn.`,
            data: { missionId: mission.id, threadId: home },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "send_to_mission",
      description:
        "Pass a request, a change or an answer to the mission of this thread: its executor's main session gets it (now, or as soon as it can). Use it when the mission's owner or someone who can decide asks for work; don't start tasks yourself in a mission thread.",
      scope: SANDBOX_SCOPE,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, maxLength: MISSION_LIMITS.sendText } },
        required: ["text"],
        additionalProperties: false,
      },
      describe: (input) => ({ title: "Send to the mission", detail: str(input.text).slice(0, 500) }),
      async execute(input, ctx) {
        try {
          const mission = await missionOfThread(ctx.db, ctx.orgId, ctx.threadRootId);
          if (!mission || mission.agentId !== ctx.agentId) {
            return { content: "This thread has no mission of yours.", isError: true };
          }
          const person = await taskRequester(ctx);
          const role = person ? await missionRole(ctx.db, mission, person) : "none";
          if (role !== "owner" && role !== "decide") {
            return {
              content: "Only the mission's owner or someone who can decide can ask for work on the computer.",
              isError: true,
              data: { code: "mission.not_allowed" },
            };
          }
          const [who] = person
            ? await ctx.db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, person))
            : [];
          const out = await sendToMainSession(missionDeps(ctx), mission, str(input.text), {
            name: who?.name ?? "someone",
            userId: person,
          });
          return {
            content: out.delivered
              ? "Sent: the executor's main session is working on it now. Tell the people you passed it on."
              : "Queued: the main session gets it as soon as it can (its current turn ends, the mission resumes or the computer is back). Tell the people.",
            data: { delivered: out.delivered },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];

  return {
    name: "missions",
    async tools(ctx) {
      const keys = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
      const granted =
        keys.has(grantKey(null, SANDBOX_SCOPE)) ||
        ["propose_mission", "send_to_mission"].some((n) => keys.has(grantKey(null, toolAllowScope(n))));
      if (!granted || !deps.hub) return [];
      const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
      if (!agent?.machineId) return [];
      const status = await deps.hub.status(agent.machineId);
      if (!status || status.orgId !== ctx.orgId || !status.execAllowed || status.protocol < MISSION_PROTOCOL) return [];
      return tools(status.name);
    },
  };
}
