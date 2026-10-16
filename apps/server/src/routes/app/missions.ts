import {
  approveProvisionalDecisions,
  chooseDecision,
  closeMission,
  createMission,
  decideReview,
  decideSuggestion,
  getMission,
  getMissionByThread,
  getMissionFiles,
  getMissionPlan,
  listDecisions,
  listMissions,
  listParticipants,
  listReviews,
  listThreadMachineTasks,
  type MissionDeps,
  machineTaskView,
  missionSummary,
  opineDecision,
  pauseMission,
  removeParticipant,
  resumeMission,
  sendMissionMessage,
  setMissionMachine,
  setParticipant,
  startMission,
  stopMission,
  transferMission,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Missions"];
const Status = z.enum(["proposed", "active", "paused", "done", "canceled"]);
const Role = z.enum(["owner", "decide", "comment", "none"]);
const PlanItem = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["todo", "doing", "waiting_you", "done", "dropped"]),
  note: z.string().optional(),
});

const Mission = z
  .object({
    id: z.uuid(),
    threadId: z.uuid().openapi({ description: "The home thread (root message id)." }),
    channelId: z.uuid(),
    agentId: z.uuid(),
    ownerId: z.string().nullable(),
    executor: z.string(),
    title: z.string(),
    goal: z.string(),
    status: Status,
    repoDir: z.string(),
    resumeTasks: z.boolean(),
    plan: z.object({ version: z.number(), done: z.number(), total: z.number(), waiting: z.number() }),
    pending: z.object({
      decisions: z.number(),
      provisional: z.number(),
      reviews: z.number(),
      suggestions: z.number(),
    }),
    runningTasks: z.number(),
    machine: z
      .object({ id: z.uuid(), name: z.string(), online: z.boolean(), lentBy: z.string().nullable() })
      .nullable(),
    needsComputer: z.boolean().openapi({ description: "Handed over without a computer: the owner sets one." }),
    role: Role.openapi({ description: "Your role in it." }),
    canAct: z.boolean().openapi({ description: "You may start work, decide, review, pause and stop." }),
    canManage: z.boolean().openapi({ description: "You may close it and change who takes part." }),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    pausedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    closeReason: z.string().nullable(),
    wikiPageId: z.string().nullable(),
  })
  .openapi("Mission");

const Decision = z
  .object({
    id: z.uuid(),
    missionId: z.uuid(),
    taskId: z.string().nullable(),
    messageId: z.string().nullable(),
    question: z.string(),
    options: z.array(z.string()),
    recommendation: z.string().nullable(),
    why: z.string().nullable(),
    impact: z.string().nullable(),
    blocking: z.boolean(),
    status: z.enum(["pending", "provisional", "taken"]),
    chosen: z.string().nullable(),
    chosenBy: z.string().nullable(),
    chosenAt: z.string().nullable(),
    opinions: z.array(z.object({ userId: z.string(), option: z.string(), at: z.string() })),
    createdAt: z.string(),
  })
  .openapi("MissionDecision");

const Review = z
  .object({
    id: z.uuid(),
    missionId: z.uuid(),
    taskId: z.string().nullable(),
    messageId: z.string().nullable(),
    title: z.string(),
    summary: z.string(),
    prUrl: z.string().nullable(),
    artifactIds: z.array(z.string()),
    status: z.enum(["pending", "approved", "changes_requested"]),
    note: z.string().nullable(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("MissionReview");

const Participants = z.object({
  owner: z.object({ userId: z.string(), name: z.string() }).nullable(),
  participants: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      role: z.enum(["decide", "comment"]),
      addedBy: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

const Task = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    machineId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.string().nullable(),
    missionId: z.string().nullable(),
    title: z.string(),
    executor: z.string(),
    status: z.enum(["queued", "running", "interrupted", "done", "failed", "canceled"]),
    exitCode: z.number().nullable(),
    seconds: z.number().nullable(),
    lastLine: z.string().nullable(),
    files: z.array(z.string()),
    branch: z.string().nullable(),
    cwd: z.string().nullable(),
    resumedFromId: z.string().nullable(),
    resumedTaskId: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    lastEventAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("MachineTask");

const MissionParams = OrgParams.extend({ missionId: z.uuid() });
const ThreadParams = OrgParams.extend({ threadId: z.uuid() });
const Empty = body(z.object({}).openapi({ description: "Send `{}`." }));

/**
 * Missions (ADR 0029): long work driven by the executor on a connected
 * computer, in one thread. Everyone who reads the home conversation sees a
 * mission; its owner and those who can decide act (start, pause, stop,
 * decide, review, accept suggestions); its owner and admins close it and
 * change who takes part. The web composer's commands call these: `/mission`
 * (create), `/stop`, `/pause` (and resume), `/summary`, `/plan`.
 */
export function missionRoutes(deps: AppDeps) {
  const { db, adapters, config } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const missions = (): MissionDeps => ({
    db,
    pubsub: adapters.pubsub,
    hub: deps.extras?.sandbox?.machines?.hub ?? null,
    artifacts: deps.extras?.artifacts,
    search: deps.extras?.context,
    publicUrl: config.PUBLIC_URL,
  });
  const after = <T>(value: T) => {
    deps.wakeWorkers?.();
    return value;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions",
      tags,
      security,
      summary: "Missions you can see (the Threads page's Missions tab), most recently changed first",
      request: {
        params: OrgParams,
        query: z.object({
          status: z.enum(["open", "closed", "proposed", "active", "paused", "done", "canceled"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: { 200: json(z.object({ missions: z.array(Mission) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const list = await listMissions(missions(), c.get("user").id, orgId, c.req.valid("query"));
      return c.json({ missions: list }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions",
      tags,
      security,
      summary: "`/mission <goal>`: the agent's executor plans it on its computer; a plan card with Start follows",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            agentId: z.uuid(),
            goal: z.string().min(1).max(2000),
            title: z.string().max(120).optional(),
            channelId: z.uuid().optional().openapi({ description: "Where it starts (a new thread there)." }),
            threadId: z.uuid().optional().openapi({ description: "Or the thread that becomes its home." }),
            folder: z.string().max(300).optional().openapi({
              description: "The repository on the computer, relative to the agent's folder.",
            }),
          }),
        ),
      },
      responses: { 201: json(Mission, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { folder, ...input } = c.req.valid("json");
      const mission = await createMission(missions(), c.get("user").id, orgId, { ...input, repoDir: folder });
      return c.json(after(mission), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}",
      tags,
      security,
      summary: "One mission",
      request: { params: MissionParams },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await getMission(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/threads/{threadId}/mission",
      tags,
      security,
      summary: "The mission of a thread (404 `mission.not_found` when it has none)",
      request: { params: ThreadParams },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, threadId } = c.req.valid("param");
      return c.json(await getMissionByThread(missions(), c.get("user").id, orgId, threadId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/threads/{threadId}/tasks",
      tags,
      security,
      summary: "The background tasks of a thread (newest first); live changes come as `machine.task` events",
      request: { params: ThreadParams },
      responses: { 200: json(z.object({ tasks: z.array(Task) })), ...errors },
    }),
    async (c) => {
      const { orgId, threadId } = c.req.valid("param");
      const rows = await listThreadMachineTasks(missions(), c.get("user").id, orgId, threadId);
      return c.json({ tasks: rows.map(machineTaskView) }, 200);
    },
  );

  const controls = [
    ["start", startMission, "Start (only its owner): the plan is approved and the work begins"],
    ["pause", pauseMission, "`/pause`: no new work starts for it"],
    ["resume", resumeMission, "Resume a paused mission (queued messages go out)"],
  ] as const;
  for (const [action, run, summary] of controls) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/missions/{missionId}/${action}`,
        tags,
        security,
        summary,
        request: { params: MissionParams, body: Empty },
        responses: { 200: json(Mission), ...errors },
      }),
      async (c) => {
        const { orgId, missionId } = c.req.valid("param");
        return c.json(after(await run(missions(), c.get("user").id, orgId, missionId)), 200);
      },
    );
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/stop",
      tags,
      security,
      summary: "`/stop`: its running tasks are canceled and it pauses",
      request: { params: MissionParams, body: Empty },
      responses: { 200: json(Mission.extend({ canceledTasks: z.number() })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(after(await stopMission(missions(), c.get("user").id, orgId, missionId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/close",
      tags,
      security,
      summary: "Close as done or canceled (its owner or an admin); optionally save decisions and lessons to the wiki",
      request: {
        params: MissionParams,
        body: body(
          z.object({
            outcome: z.enum(["done", "canceled"]),
            saveToWiki: z.boolean().optional(),
            note: z.string().max(500).optional(),
          }),
        ),
      },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(
        after(await closeMission(missions(), c.get("user").id, orgId, missionId, c.req.valid("json"))),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/messages",
      tags,
      security,
      summary: "Send something to the executor's main session (\"Mudar algo\"); queued when it can't hear now",
      request: { params: MissionParams, body: body(z.object({ text: z.string().min(1).max(8000) })) },
      responses: { 200: json(z.object({ delivered: z.boolean(), taskId: z.string().optional() })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      const out = await sendMissionMessage(missions(), c.get("user").id, orgId, missionId, c.req.valid("json").text);
      return c.json(after(out), 200);
    },
  );

  // ── Participants and ownership ─────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/participants",
      tags,
      security,
      summary: "Its owner and who can decide or comment",
      request: { params: MissionParams },
      responses: { 200: json(Participants), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await listParticipants(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/participants",
      tags,
      security,
      summary: '"Compartilhar missão": add someone who reads its conversation, with a role',
      request: {
        params: MissionParams,
        body: body(z.object({ userId: z.string().min(1).max(200), role: z.enum(["decide", "comment"]) })),
      },
      responses: { 200: json(Participants), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await setParticipant(missions(), c.get("user").id, orgId, missionId, c.req.valid("json")), 200);
    },
  );

  const ParticipantParams = MissionParams.extend({ userId: z.string().min(1).max(200) });
  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/missions/{missionId}/participants/{userId}",
      tags,
      security,
      summary: "Change someone's role",
      request: { params: ParticipantParams, body: body(z.object({ role: z.enum(["decide", "comment"]) })) },
      responses: { 200: json(Participants), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, userId } = c.req.valid("param");
      const out = await setParticipant(missions(), c.get("user").id, orgId, missionId, {
        userId,
        role: c.req.valid("json").role,
      });
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/missions/{missionId}/participants/{userId}",
      tags,
      security,
      summary: "Remove someone (or leave it yourself)",
      request: { params: ParticipantParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, missionId, userId } = c.req.valid("param");
      await removeParticipant(missions(), c.get("user").id, orgId, missionId, userId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/transfer",
      tags,
      security,
      summary:
        "Hand it over. The computer doesn't move: the new owner's own machine, the previous owner lending theirs (`lendMachine`), or it pauses with `code: mission.needs_computer`",
      request: {
        params: MissionParams,
        body: body(z.object({ userId: z.string().min(1).max(200), lendMachine: z.boolean().optional() })),
      },
      responses: { 200: json(Mission.extend({ code: z.string().optional() })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await transferMission(missions(), c.get("user").id, orgId, missionId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/missions/{missionId}/machine",
      tags,
      security,
      summary: "Its owner points it at a computer they paired (new sessions start from the mission files)",
      request: {
        params: MissionParams,
        body: body(z.object({ machineId: z.uuid(), repoDir: z.string().max(300).optional() })),
      },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await setMissionMachine(missions(), c.get("user").id, orgId, missionId, c.req.valid("json")), 200);
    },
  );

  // ── Decisions, reviews, suggestions ─────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/decisions",
      tags,
      security,
      summary: "Its decisions, newest first",
      request: { params: MissionParams },
      responses: { 200: json(z.object({ decisions: z.array(Decision) })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json({ decisions: await listDecisions(missions(), c.get("user").id, orgId, missionId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/decisions/approve-provisional",
      tags,
      security,
      summary: "Take every provisional decision as the executor went with it",
      request: { params: MissionParams, body: Empty },
      responses: { 200: json(z.object({ decisions: z.array(Decision) })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      const decisions = await approveProvisionalDecisions(missions(), c.get("user").id, orgId, missionId);
      return c.json({ decisions }, 200);
    },
  );

  const DecisionParams = MissionParams.extend({ decisionId: z.uuid() });
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/decisions/{decisionId}/choose",
      tags,
      security,
      summary: "Choose (owner or deciders): the session that asked is resumed with it",
      request: { params: DecisionParams, body: body(z.object({ option: z.string().min(1).max(200) })) },
      responses: { 200: json(Decision), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, decisionId } = c.req.valid("param");
      const out = await chooseDecision(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        decisionId,
        c.req.valid("json").option,
      );
      return c.json(after(out), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/decisions/{decisionId}/opinion",
      tags,
      security,
      summary: 'Give an opinion ("Ana prefere tabs"): anyone taking part, comment included; never decides',
      request: { params: DecisionParams, body: body(z.object({ option: z.string().min(1).max(200) })) },
      responses: { 200: json(Decision), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, decisionId } = c.req.valid("param");
      const out = await opineDecision(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        decisionId,
        c.req.valid("json").option,
      );
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/reviews",
      tags,
      security,
      summary: "Its reviews, newest first",
      request: { params: MissionParams },
      responses: { 200: json(z.object({ reviews: z.array(Review) })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json({ reviews: await listReviews(missions(), c.get("user").id, orgId, missionId) }, 200);
    },
  );

  const ReviewParams = MissionParams.extend({ reviewId: z.uuid() });
  const reviewActions = [
    ["approve", "approved", z.object({ note: z.string().max(4000).optional() }), "Approve: the session goes on"],
    [
      "changes",
      "changes_requested",
      z.object({ note: z.string().min(1).max(4000) }),
      "Ask for changes (with a note): the session is resumed with it",
    ],
  ] as const;
  for (const [action, outcome, schema, summary] of reviewActions) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/missions/{missionId}/reviews/{reviewId}/${action}`,
        tags,
        security,
        summary,
        request: { params: ReviewParams, body: body(schema) },
        responses: { 200: json(Review), ...errors },
      }),
      async (c) => {
        const { orgId, missionId, reviewId } = c.req.valid("param");
        const { note } = c.req.valid("json") as { note?: string };
        const out = await decideReview(missions(), c.get("user").id, orgId, missionId, reviewId, { outcome, note });
        return c.json(after(out), 200);
      },
    );
  }

  const SuggestionParams = MissionParams.extend({ messageId: z.uuid() });
  for (const [action, outcome] of [
    ["accept", "accepted"],
    ["decline", "declined"],
  ] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/missions/{missionId}/suggestions/{messageId}/${action}`,
        tags,
        security,
        summary:
          action === "accept"
            ? "Accept a suggestion (owner or deciders): forwarded to the main session"
            : "Decline a suggestion",
        request: { params: SuggestionParams, body: Empty },
        responses: {
          200: json(z.object({ messageId: z.uuid(), status: z.enum(["accepted", "declined"]) })),
          ...errors,
        },
      }),
      async (c) => {
        const { orgId, missionId, messageId } = c.req.valid("param");
        const out = await decideSuggestion(missions(), c.get("user").id, orgId, missionId, messageId, outcome);
        return c.json(after(out), 200);
      },
    );
  }

  // ── Reading: files, summary, plan ───────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/files",
      tags,
      security,
      summary: "The `.agentes/` files (latest content) and the edits found on the machine",
      request: { params: MissionParams },
      responses: {
        200: json(
          z.object({
            files: z.array(
              z.object({
                name: z.string(),
                content: z.string().nullable(),
                source: z.string().nullable(),
                writtenAt: z.string().nullable(),
                updatedAt: z.string().nullable(),
              }),
            ),
            editedOnMachine: z.array(z.record(z.string(), z.unknown())),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await getMissionFiles(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/summary",
      tags,
      security,
      summary: "`/summary`: where it stands, from the database (no model)",
      request: { params: MissionParams },
      responses: {
        200: json(
          z.object({
            missionId: z.uuid(),
            text: z.string(),
            plan: z.object({ done: z.number(), total: z.number(), doing: z.number(), waiting: z.number() }),
            running: z.number(),
            pendingDecisions: z.number(),
            provisionalDecisions: z.number(),
            pendingReviews: z.number(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await missionSummary(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  const PlanVersion = z.object({
    version: z.number(),
    items: z.array(PlanItem),
    source: z.string(),
    taskId: z.string().nullable(),
    createdAt: z.string(),
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/plan",
      tags,
      security,
      summary: "`/plan`: the latest version and the history",
      request: { params: MissionParams },
      responses: {
        200: json(z.object({ missionId: z.uuid(), current: PlanVersion.nullable(), history: z.array(PlanVersion) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await getMissionPlan(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  return app;
}
