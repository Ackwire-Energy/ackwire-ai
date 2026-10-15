import {
  createRoutine,
  listRoutineRuns,
  listRoutines,
  parseScheduleForOrg,
  ROUTINE_EVENTS,
  type RoutineDeps,
  runRoutineNow,
  setRoutineActive,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Routines"];
const Event = z.enum(ROUTINE_EVENTS);
const Target = z.union([
  z.object({ type: z.literal("channel"), channelId: z.uuid() }),
  z.object({ type: z.literal("dm") }),
  z.object({ type: z.literal("artifact") }),
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
    target: Target,
    trigger: z.union([
      z.object({
        type: z.literal("schedule"),
        phrase: z.string(),
        cron: z.string(),
        timezone: z.string(),
        description: z.string(),
      }),
      z.object({ type: z.literal("event"), event: Event }),
    ]),
    active: z.boolean(),
    nextRunAt: z.string().nullable(),
    running: z.boolean(),
    lastRun: RoutineRun.nullable(),
    monthCostUsd: z.number(),
    createdAt: z.string(),
  })
  .openapi("Routine");

const RoutineParams = OrgParams.extend({ routineId: z.uuid() });

/** Routines: an agent does something on a schedule (in the workspace time zone) or when an event happens. */
export function routineRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const routines: RoutineDeps = { db, pubsub: adapters.pubsub, context: deps.extras?.context };

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
            trigger: z.union([
              z.object({
                type: z.literal("schedule"),
                phrase: z.string().min(1).max(300),
                timezone: z.string().max(64).optional(),
              }),
              z.object({ type: z.literal("event"), event: Event }),
            ]),
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
      summary: "Pause or resume",
      request: { params: RoutineParams, body: body(z.object({ active: z.boolean() })) },
      responses: { 200: json(Routine), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      const routine = await setRoutineActive(routines, c.get("user").id, orgId, routineId, c.req.valid("json").active);
      return c.json(routine, 200);
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
