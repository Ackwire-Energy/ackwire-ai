import { MISSION_MCP_TOOLS } from "@agenteschat/adapters";
import { and, eq, inArray, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { getChannelCached } from "./context";
import { publishUserEvent } from "./events";
import { taskRequester } from "./machine-tasks";
import { getMessage } from "./messages";
import { missionOfRun, type RunMission, runActsForMission } from "./mission-context";
import { completeMission } from "./mission-delivery";
import {
  askDecision,
  checkMissionToolRate,
  getMissionRow,
  homeThreadForDm,
  MISSION_LIMITS,
  type MissionDeps,
  type MissionExecutor,
  type MissionRow,
  machineExecutors,
  missionOfThread,
  missionRole,
  noMentions,
  postMissionMessage,
  proposeMission,
  recordMissionEvent,
  requestReview,
  sendToMainSession,
  updatePlan,
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
const EXECUTOR_NAMES: Record<MissionExecutor, string> = { claude: "Claude Code", codex: "Codex", agent: "you" };

/** The same JSON Schemas the executor's MCP tools have (one contract for both). */
const mcpSchema = (name: string) =>
  (MISSION_MCP_TOOLS.find((t) => t.name === name)?.inputSchema ?? { type: "object" }) as ToolDefinition["inputSchema"];

/**
 * The agent's side of missions (ADR 0029), scope `sandbox:run`:
 * `propose_mission` (the work is planned before the person presses Start) and
 * `send_to_mission` (passes what the owner or a decider asks to the
 * executor's main session). In agent mode the agent IS the executor: in its
 * mission's thread it gets the mission tools the executor would have
 * (`update_plan`, `report`, `ask_decision`, `request_review`,
 * `request_approval`; files go to the Drive with `upload_file`), bound to
 * that mission. Each call needs the person behind the run to be the owner or
 * a decider, or the mission itself to have woken the run.
 */
export function createMissionToolSource(deps: Omit<MissionDeps, "db">): ToolSource {
  const missionDeps = (ctx: ToolContext): MissionDeps => ({ ...deps, db: ctx.db });

  const proposeTool = (computer: string, executors: MissionExecutor[]): ToolDefinition => ({
    name: "propose_mission",
    description: `Propose a mission when a request is long work on the computer "${computer}" (several deliverables, days, product decisions). ${
      executors.includes("claude")
        ? "By default Claude Code there explores the repository and plans it;"
        : "You explore the repository there and plan it yourself;"
    } the people get a plan card to start it. Nothing changes until the person who asked starts it. For one task, use start_task instead.`,
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
        executor: {
          enum: [...executors],
          description: `Who programs: ${executors
            .map((e) => (e === "agent" ? "agent (you, with your own tools)" : e))
            .join(", ")}. Only when the person asked for one.`,
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
          executor: (str(input.executor) || null) as MissionExecutor | null,
          runId: ctx.runId,
        });
        const who = EXECUTOR_NAMES[mission.executor as MissionExecutor] ?? "Claude Code";
        // Its home is a new thread (a flat DM): the reply here gets a link card to it.
        const elsewhere = home !== ctx.threadRootId;
        const shown = elsewhere
          ? "The app shows a link card to the mission's thread under your reply, and the plan card there has the button to start."
          : "The app shows the plan card in this thread, with the button to start.";
        const reply =
          "Reply briefly (one or two lines) in the person's language; don't name buttons or other parts of the app.";
        return {
          content:
            mission.executor === "agent"
              ? `Mission ${mission.id} proposed: you program it yourself on ${computer}. Plan it now in its thread (read only: read_file, list_files, read-only commands), then update_plan with the first items and report the goal, in the person's language; the person who asked starts it when the plan looks right. ${shown}`
              : `Mission ${mission.id} proposed: ${who} on ${computer} is planning it now (read only); nothing changes until the person who asked starts it. ${shown} ${reply} Then end your turn.`,
          data: {
            missionId: mission.id,
            threadId: home,
            executor: mission.executor,
            ...(elsewhere ? { missionLink: { missionId: mission.id, threadId: home } } : {}),
          },
        };
      } catch (error) {
        return failed(error);
      }
    },
  });

  const sendTool: ToolDefinition = {
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
  };

  /**
   * One agent-mode mission tool: the mission is re-read (it may have paused
   * or closed), the run must act for it, and the hourly rate holds.
   */
  const bound = (
    run: RunMission,
    tool: Omit<ToolDefinition, "execute" | "scope"> & {
      run(input: Record<string, unknown>, ctx: ToolContext, mission: MissionRow): Promise<ToolOutput>;
      /** Also while proposed (the plan before Start). */
      whileProposed?: boolean;
    },
  ): ToolDefinition => {
    const { run: body, whileProposed, ...definition } = tool;
    return {
      ...definition,
      scope: SANDBOX_SCOPE,
      missionId: run.id,
      async execute(input, ctx) {
        try {
          const mission = await getMissionRow(ctx.db, run.id);
          if (!mission || !["proposed", "active", "paused", "awaiting_close"].includes(mission.status)) {
            return { content: "The mission is closed: stop here.", isError: true, data: { code: "mission.closed" } };
          }
          if (mission.status === "proposed" && !whileProposed) {
            return { content: "The plan isn't approved yet: wait for the people to press Start.", isError: true };
          }
          if (!(await runActsForMission(ctx, run))) {
            return {
              content:
                "Only the mission's owner or someone who can decide can make the mission act. Tell the person; the owner can accept their suggestion.",
              isError: true,
              data: { code: "mission.not_allowed" },
            };
          }
          await checkMissionToolRate(ctx.db, mission, tool.name, `agent:${ctx.agentId}`);
          const out = await body(input, ctx, mission);
          await recordAudit(ctx.db, {
            orgId: mission.orgId,
            actor: { type: "agent", id: mission.agentId },
            action: `mission.tool_${tool.name}`,
            target: { type: "mission", id: mission.id },
            details: { runId: ctx.runId },
          }).catch(() => undefined);
          return out;
        } catch (error) {
          return failed(error);
        }
      },
    };
  };

  const agentTools = (run: RunMission, computer: string): ToolDefinition[] => [
    bound(run, {
      name: "update_plan",
      description:
        "Replace this mission's plan: the whole checklist, every time (keep each item's id stable). Statuses: todo, doing, waiting_you (needs a person), done, dropped. Keep an item's title unless what it means changed. People see each change as one line in the thread. Write it in the language the people use in the thread.",
      inputSchema: mcpSchema("update_plan"),
      whileProposed: true,
      async run(input, ctx, mission) {
        const out = await updatePlan(missionDeps(ctx), mission, { items: input.items, source: "executor" });
        const c = out.change;
        return {
          content: `Plan saved (version ${out.version}: ${out.items.length} items; +${c.added.length} −${c.removed.length} ~${c.changed.length}).`,
        };
      },
    }),
    bound(run, {
      name: "report",
      description:
        "Tell the people in this mission's thread where things stand: a milestone, what you found, what is next, as a status card. One short paragraph; at milestones, not for every step. pr_url: a pull request you opened. Write it in the language the people use in the thread.",
      inputSchema: mcpSchema("report"),
      whileProposed: true,
      async run(input, ctx, mission) {
        const summary = str(input.summary).trim().slice(0, 4000);
        const status = str(input.status) || "working";
        await postMissionMessage(missionDeps(ctx), mission, summary, {
          missionReport: { missionId: mission.id, taskId: null, status, executor: "agent", computer, main: true },
        });
        await recordMissionEvent(ctx.db, mission, "report", { runId: ctx.runId, status });
        return { content: "Reported in the mission's thread (no need to repeat it in your answer)." };
      },
    }),
    bound(run, {
      name: "ask_decision",
      description:
        "Ask the people a product or technical decision as a card with 2 to 4 options. blocking: true when you can't go on without it (then end your turn; you are woken with the answer). blocking: false to go on with your recommendation as a provisional decision they review later. Write it in the language the people use in the thread.",
      inputSchema: mcpSchema("ask_decision"),
      async run(input, ctx, mission) {
        const blocking = input.blocking === true;
        await askDecision(missionDeps(ctx), mission, null, {
          question: input.question,
          options: input.options,
          recommendation: input.recommendation,
          why: input.why,
          impact: input.impact,
          blocking,
        });
        return {
          content: blocking
            ? "Recorded. End your turn now; you'll be woken here with the decision."
            : "Recorded as provisional: continue with your recommendation.",
        };
      },
    }),
    bound(run, {
      name: "request_review",
      description:
        "Ask the people to look at something you can show (screens, a prototype, a PR). Send files to the Drive first with upload_file and pass their artifact ids. Then end your turn: you are woken with their answer (approved, or the changes they want). Write it in the language the people use in the thread.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          summary: { type: "string", maxLength: 4000 },
          pr_url: { type: "string", maxLength: 500 },
          artifact_ids: { type: "array", maxItems: 10, items: { type: "string", minLength: 36, maxLength: 36 } },
        },
        required: ["title"],
        additionalProperties: false,
      },
      async run(input, ctx, mission) {
        const asked = (Array.isArray(input.artifact_ids) ? input.artifact_ids.map(String) : []).filter((id) =>
          /^[0-9a-f-]{36}$/i.test(id),
        );
        const found = asked.length
          ? await ctx.db
              .select({ id: schema.artifacts.id })
              .from(schema.artifacts)
              .where(and(eq(schema.artifacts.orgId, mission.orgId), inArray(schema.artifacts.id, asked)))
          : [];
        const review = await requestReview(missionDeps(ctx), mission, null, {
          title: input.title,
          summary: input.summary,
          prUrl: input.pr_url,
          artifactIds: found.map((a) => a.id),
        });
        return {
          content: `Review requested${found.length ? ` with ${found.length} file(s)` : ""}${
            found.length < asked.length ? `; ${asked.length - found.length} id(s) not found in the Drive` : ""
          } (${review.id}). End your turn; you'll be woken with the people's answer.`,
        };
      },
    }),
    bound(run, {
      name: "complete_mission",
      description:
        "When every plan item is done: hand the mission over to the people as a delivery card. summary: what you delivered. checklist: what the person should check (short items). Send files to the Drive first with upload_file and pass their artifact ids. Then end your turn: the person concludes the mission or asks for changes (you are woken with them). Don't keep working. Write it in the language the people use in the thread.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 4000 },
          checklist: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } },
          artifact_ids: { type: "array", maxItems: 10, items: { type: "string", minLength: 36, maxLength: 36 } },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      async run(input, ctx, mission) {
        const asked = (Array.isArray(input.artifact_ids) ? input.artifact_ids.map(String) : []).filter((id) =>
          /^[0-9a-f-]{36}$/i.test(id),
        );
        const found = asked.length
          ? await ctx.db
              .select({ id: schema.artifacts.id })
              .from(schema.artifacts)
              .where(and(eq(schema.artifacts.orgId, mission.orgId), inArray(schema.artifacts.id, asked)))
          : [];
        const delivery = await completeMission(missionDeps(ctx), mission, null, {
          summary: input.summary,
          checklist: input.checklist,
          artifactIds: found.map((a) => a.id),
        });
        return {
          content: `Delivered${found.length ? ` with ${found.length} file(s)` : ""}${
            found.length < asked.length ? `; ${asked.length - found.length} id(s) not found in the Drive` : ""
          } (${delivery.id}). Stop now and wait for the person to check it: end your turn.`,
        };
      },
    }),
    bound(run, {
      name: "request_approval",
      description:
        "Ask a person to approve a merge, a deploy or a rollback before you do it. Never merge, deploy or roll back without an approval. Your run waits for the decision; once approved, do it.",
      inputSchema: mcpSchema("request_approval"),
      sensitive: true,
      describe: (input) => ({
        title: `${({ merge: "Merge", deploy: "Deploy", rollback: "Roll back" } as Record<string, string>)[str(input.action)] ?? "Approve"} ${noMentions(str(input.target)).slice(0, 280)}`,
        detail: noMentions(str(input.detail)).slice(0, 1000),
      }),
      async run(input, ctx, mission) {
        // Runs only after a person approved it (ADR 0015): the run resumes here.
        await recordMissionEvent(ctx.db, mission, "approval_granted", {
          runId: ctx.runId,
          action: str(input.action),
          target: str(input.target).slice(0, 300),
        });
        return {
          content: `Approved: go ahead with the ${str(input.action)} of ${str(input.target)} now, then report it.`,
        };
      },
    }),
  ];

  return {
    name: "missions",
    async tools(ctx) {
      const keys = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
      const names = [
        "propose_mission",
        "send_to_mission",
        "update_plan",
        "report",
        "ask_decision",
        "request_review",
        "complete_mission",
      ];
      const granted =
        keys.has(grantKey(null, SANDBOX_SCOPE)) || names.some((n) => keys.has(grantKey(null, toolAllowScope(n))));
      if (!granted || !deps.hub) return [];
      const out: ToolDefinition[] = [];
      const [agent, mission] = await Promise.all([getAgentCached(ctx.db, ctx.orgId, ctx.agentId), missionOfRun(ctx)]);
      if (agent?.machineId && !mission) {
        const status = await deps.hub.status(agent.machineId);
        if (status && status.orgId === ctx.orgId) {
          const { available } = machineExecutors(status);
          if (available.length > 0) out.push(proposeTool(status.name, available));
        }
      }
      // On the engine (ADR 0032 §6) the run in the mission thread IS the main session, whatever its brain.
      const doesTheWork = Boolean(mission && (mission.executor === "agent" || deps.missionsOnEngine));
      if (mission && !doesTheWork) out.push(sendTool);
      if (mission && doesTheWork) {
        const status = mission.machineId ? await deps.hub.status(mission.machineId) : null;
        out.push(...agentTools(mission, status?.name ?? "the computer"));
      }
      return out;
    },
  };
}

/** Tells the mission's owner an approval waits (agent mode: the approval belongs to the run). */
export async function notifyMissionApproval(
  deps: Pick<MissionDeps, "db" | "pubsub">,
  approval: { id: string; orgId: string; missionId: string | null },
) {
  if (!approval.missionId) return;
  const [m] = await deps.db
    .select({ ownerId: schema.missions.ownerId })
    .from(schema.missions)
    .where(eq(schema.missions.id, approval.missionId));
  if (!m?.ownerId) return;
  await publishUserEvent(deps.pubsub, approval.orgId, m.ownerId, {
    type: "mission.approval_requested",
    missionId: approval.missionId,
    approvalId: approval.id,
  });
}
