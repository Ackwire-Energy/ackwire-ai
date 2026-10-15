import {
  createRoutine,
  cronToRule,
  deleteRoutine,
  describeRule,
  duplicateRoutine,
  listRoutineRuns,
  listRoutines,
  normalizeRule,
  parseScheduleForOrg,
  phraseToRule,
  ROUTINE_EVENTS,
  type RoutineDeps,
  requirePermission,
  routineTimezone,
  ruleOccurrences,
  ruleToCron,
  runRoutineNow,
  type ScheduleRule,
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
/** A structured schedule (the period picker): RRULE-like, in a time zone. */
const ScheduleRuleSchema = z
  .object({
    freq: z.enum(["once", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(1000).optional(),
    byWeekday: z
      .array(z.string().regex(/^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/))
      .max(14)
      .optional()
      .openapi({ description: '"MO"…"SU"; monthly/yearly may carry a position: "2TU", "-1FR".' }),
    byMonthDay: z.array(z.number().int().min(-31).max(31)).max(31).optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    bySetPos: z
      .union([z.number().int().min(-31).max(31), z.array(z.number().int().min(-31).max(31)).max(10)])
      .optional(),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    times: z
      .array(z.string().regex(/^\d{2}:\d{2}$/))
      .max(24)
      .optional(),
    timezone: z.string().max(64),
    start: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    count: z.number().int().min(1).max(10_000).nullable().optional(),
  })
  .openapi("ScheduleRule");

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
        rule: ScheduleRuleSchema.nullable(),
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
  z
    .object({
      type: z.literal("schedule"),
      phrase: z.string().min(1).max(300).optional(),
      rule: ScheduleRuleSchema.optional(),
      timezone: z.string().max(64).optional(),
    })
    .openapi({ description: "A phrase (`dias úteis às 9h`) or a `rule` from the picker." }),
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
            locale: z
              .string()
              .max(10)
              .optional()
              .openapi({ description: '"pt-BR" (default) or "en": the description\'s language.' }),
          }),
        ),
      },
      responses: {
        200: json(
          z.union([
            z.object({
              ok: z.literal(true),
              cron: z.string(),
              description: z.string(),
              timezone: z.string(),
              rule: ScheduleRuleSchema.nullable().openapi({
                description: "The same schedule as a rule (for the picker), when it maps.",
              }),
            }),
            z.object({ ok: z.literal(false), error: z.string(), code: z.string() }),
          ]),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { phrase, timezone, locale } = c.req.valid("json");
      const parsed = await parseScheduleForOrg(routines, c.get("user").id, orgId, phrase, timezone);
      if (!parsed.ok) return c.json(parsed, 200);
      const asRule = cronToRule(parsed.cron, parsed.timezone);
      const rule = asRule ? normalizeRule(asRule) : null;
      const description =
        rule && locale && !locale.toLowerCase().startsWith("pt") ? describeRule(rule, locale) : parsed.description;
      return c.json({ ...parsed, description, rule }, 200);
    },
  );

  const RuleAnswer = z.union([
    z.object({
      ok: z.literal(true),
      rule: ScheduleRuleSchema,
      description: z
        .string()
        .openapi({ description: '"A cada 2 semanas, seg e qua, às 09:00 (horário de Brasília)".' }),
      cron: z.string().nullable().openapi({ description: "When cron can say it." }),
      nextRuns: z.array(z.string()).openapi({ description: "The next 5 times." }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
      code: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  ]);
  const answer = (rule: ScheduleRule, locale?: string) => {
    const normal = normalizeRule(rule);
    return {
      ok: true as const,
      rule: normal,
      description: describeRule(normal, locale),
      cron: ruleToCron(normal),
      nextRuns: ruleOccurrences(normal, new Date(), new Date(Date.now() + 5 * 366 * 86_400_000), 5).map((d) =>
        d.toISOString(),
      ),
    };
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/parse-rule",
      tags,
      security,
      summary: "A schedule phrase → a structured rule (to fill the period picker), with its description and next runs",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            phrase: z.string().min(1).max(300),
            timezone: z.string().max(64).optional(),
            locale: z
              .string()
              .max(10)
              .optional()
              .openapi({ description: '"pt-BR" (default) or "en": the description\'s language.' }),
          }),
        ),
      },
      responses: { 200: json(RuleAnswer), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { phrase, timezone, locale } = c.req.valid("json");
      const zone = await routineTimezone(db, c.get("user").id, orgId, timezone);
      const rule = phraseToRule(phrase, zone);
      if (!rule) {
        return c.json(
          {
            ok: false as const,
            error: 'Couldn\'t read the period. Try "every 2 weeks on Monday at 9am".',
            code: "schedule.unreadable",
          },
          200,
        );
      }
      try {
        return c.json(answer(rule, locale), 200);
      } catch (error) {
        return c.json(
          {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string }).code ?? "schedule.invalid",
            ...((error as { params?: Record<string, unknown> }).params
              ? { params: (error as { params?: Record<string, unknown> }).params }
              : {}),
          },
          200,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/describe-rule",
      tags,
      security,
      summary: "A rule from the picker → its description in pt-BR, cron (when possible) and next runs",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            rule: ScheduleRuleSchema,
            locale: z.string().max(10).optional().openapi({ description: '"pt-BR" (default) or "en".' }),
          }),
        ),
      },
      responses: { 200: json(RuleAnswer), ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "read");
      try {
        const input = c.req.valid("json");
        return c.json(answer(input.rule as ScheduleRule, input.locale), 200);
      } catch (error) {
        return c.json(
          {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string }).code ?? "schedule.invalid",
            ...((error as { params?: Record<string, unknown> }).params
              ? { params: (error as { params?: Record<string, unknown> }).params }
              : {}),
          },
          200,
        );
      }
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
