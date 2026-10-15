import {
  createRoutine,
  deleteRoutine,
  duplicateRoutine,
  listRoutineRuns,
  listRoutines,
  parseScheduleForOrg,
  ROUTINE_EVENTS,
  type RoutineDeps,
  runRoutineNow,
  updateRoutine,
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

const tags = ["Routines"];
const Event = z.enum(ROUTINE_EVENTS);
const Target = z.union([
  z.object({ type: z.literal("channel"), channelId: z.uuid() }),
  z.object({ type: z.literal("dm") }),
  z.object({ type: z.literal("artifact") }),
  z
    .object({
      type: z.literal("forum"),
      agentIds: z.array(z.uuid()).min(1).max(8),
      rounds: z.number().int().min(1).max(10).optional(),
    })
    .openapi({
      description: "Opens a forum topic each time: the prompt is its goal; the routine's agent writes the synthesis.",
    }),
]);
/** What routines show: also `conversation` (a thread or DM, from an agent's `schedule_reminder` or `create_routine`). */
const TargetView = z.union([
  ...Target.options,
  z.object({
    type: z.literal("conversation"),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    reminder: z.boolean().optional().openapi({ description: "A plain reminder (the agent's message, no run)." }),
    forUserId: z.string().optional(),
  }),
]);
const RoutineRun = z
  .object({
    id: z.uuid(),
    at: z.string(),
    status: z.enum(["ok", "failed", "skipped"]),
    summary: z.string(),
    costUsd: z.number(),
  })
  .openapi("RoutineRun");
const Routine = z
  .object({
    id: z.uuid(),
    name: z.string(),
    agentId: z.uuid(),
    prompt: z.string(),
    target: TargetView,
    trigger: z.union([
      z.object({
        type: z.literal("schedule"),
        phrase: z.string(),
        cron: z.string(),
        timezone: z.string(),
        description: z.string(),
      }),
      z.object({ type: z.literal("event"), event: Event }),
      z.object({
        type: z.literal("once"),
        at: z.string(),
        timezone: z.string(),
        description: z.string().openapi({ description: '"amanhã, 16/10, às 09:00 (horário de Brasília)".' }),
      }),
    ]),
    active: z.boolean().openapi({ description: "One-off routines are inactive once they fired." }),
    nextRunAt: z.string().nullable(),
    running: z.boolean(),
    lastRun: RoutineRun.nullable(),
    monthCostUsd: z.number(),
    budgetUsd: z.number().nullable().openapi({ description: "Monthly spend cap of this routine (null = none)." }),
    createdAt: z.string(),
  })
  .openapi("Routine");

const TriggerInput = z.union([
  z.object({
    type: z.literal("schedule"),
    phrase: z.string().min(1).max(300),
    timezone: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal("event"), event: Event }),
  z.object({
    type: z.literal("once"),
    at: z.iso.datetime({ offset: true }),
    timezone: z.string().max(64).optional(),
  }),
]);
const Budget = z.number().min(0).max(100_000).nullable().optional();

const RoutineParams = OrgParams.extend({ routineId: z.uuid() });

/** Routines: an agent does something on a schedule (in the workspace time zone) or when an event happens. */
export function routineRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const routines: RoutineDeps = {
    db,
    pubsub: adapters.pubsub,
    context: deps.extras?.context,
    artifacts: deps.extras?.artifacts,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/routines",
      tags,
      security,
      summary: "Routines with their next run, last run and this month's cost",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ routines: z.array(Routine) })), ...errors },
    }),
    async (c) => c.json({ routines: await listRoutines(db, c.get("user").id, c.req.valid("param").orgId) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/parse-schedule",
      tags,
      security,
      summary: "Natural language → cron, in the person's time zone (or the one given)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            phrase: z.string().max(300),
            timezone: z
              .string()
              .max(64)
              .optional()
              .openapi({ description: "IANA zone; default: the person's own, then the organization's, then UTC." }),
          }),
        ),
      },
      responses: {
        200: json(
          z.union([
            z.object({ ok: z.literal(true), cron: z.string(), description: z.string(), timezone: z.string() }),
            z.object({ ok: z.literal(false), error: z.string() }),
          ]),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { phrase, timezone } = c.req.valid("json");
      return c.json(await parseScheduleForOrg(routines, c.get("user").id, orgId, phrase, timezone), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines",
      tags,
      security,
      summary: "Create a routine (admins or the agent's owner)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            name: z.string().max(120).optional(),
            agentId: z.uuid(),
            prompt: z.string().min(1).max(10_000),
            target: Target,
            trigger: TriggerInput,
            budgetUsd: Budget,
          }),
        ),
      },
      responses: { 201: json(Routine, "Created"), ...errors },
    }),
    async (c) => {
      const created = await createRoutine(routines, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/routines/{routineId}",
      tags,
      security,
      summary:
        "Edit a routine (its creator, admins or the agent's owner): name, prompt, agent, trigger, target, budget, pause/resume",
      request: {
        params: RoutineParams,
        body: body(
          z.object({
            name: z.string().min(1).max(120).optional(),
            prompt: z.string().min(1).max(10_000).optional(),
            agentId: z.uuid().optional(),
            trigger: TriggerInput.optional().openapi({
              description:
                "A schedule phrase is parsed again (in `timezone`, else the person's); `nextRunAt` is recomputed.",
            }),
            target: TargetView.optional(),
            budgetUsd: Budget,
            active: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(Routine), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      const routine = await updateRoutine(routines, c.get("user").id, orgId, routineId, c.req.valid("json"));
      return c.json(routine, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/routines/{routineId}",
      tags,
      security,
      summary: "Delete a routine (it stops firing; its run history stays)",
      request: { params: RoutineParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      await deleteRoutine(routines, c.get("user").id, orgId, routineId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/{routineId}/duplicate",
      tags,
      security,
      summary: "A paused copy of a routine",
      request: { params: RoutineParams },
      responses: { 201: json(Routine, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      return c.json(await duplicateRoutine(routines, c.get("user").id, orgId, routineId), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/{routineId}/run",
      tags,
      security,
      summary: "Run now",
      request: { params: RoutineParams },
      responses: { 200: json(Routine), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      const routine = await runRoutineNow(routines, c.get("user").id, orgId, routineId);
      deps.wakeWorkers?.();
      return c.json(routine, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/routines/{routineId}/runs",
      tags,
      security,
      summary: "Run history with cost",
      request: { params: RoutineParams },
      responses: { 200: json(z.object({ runs: z.array(RoutineRun) })), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      return c.json({ runs: await listRoutineRuns(db, c.get("user").id, orgId, routineId) }, 200);
    },
  );

  return app;
}
