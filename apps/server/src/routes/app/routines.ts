import {
  cancelReminder,
  createReminderFromApp,
  createRoutine,
  deleteRoutine,
  describeRule,
  describeWhen,
  duplicateRoutine,
  getRoutineView,
  HOOK_OUTCOMES,
  listMyReminders,
  listRoutineRuns,
  listRoutines,
  localDateTimeOf,
  managedWebhookRoutine,
  newRoutineHookAddress,
  newRoutineHookSecret,
  normalizeRule,
  parseScheduleForOrg,
  ROUTINE_ACCESS,
  ROUTINE_EVENTS,
  ROUTINE_REPORT,
  type RoutineDeps,
  readSchedule,
  removeRoutineHookSecret,
  requirePermission,
  routineHookView,
  routineTimezone,
  ruleOccurrences,
  ruleToCron,
  runRoutineNow,
  type ScheduleRule,
  schedulesOf,
  sendRoutineHookTest,
  stopRoutineRun,
  takeOverRoutine,
  updateRoutine,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  hookConfig,
  json,
  noContent,
  OrgParams,
  requireSession,
  routineHookDeps,
  security,
} from "./context";

const tags = ["Routines"];
const Event = z.enum(ROUTINE_EVENTS);
/** New mail in a mailbox folder (ADR 0038): `from` takes addresses or `@domains`. */
const MailFilterSchema = z
  .object({
    from: z.array(z.string().max(320)).max(50).optional(),
    subject: z.string().max(200).optional(),
    text: z.string().max(200).optional(),
  })
  .openapi("MailFilter");
const Reminder = z
  .object({
    id: z.uuid().openapi({ description: "A one-off routine: also listed in Routines." }),
    message: z.string(),
    at: z.string().nullable().openapi({ description: "When it fires; null once done." }),
    timezone: z.string(),
    description: z.string().openapi({ description: 'When, in English ("tomorrow, Oct 16, at 09:00 (…)").' }),
    forUserId: z.string(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    done: z.boolean(),
  })
  .openapi("Reminder");
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

const Access = z.enum(ROUTINE_ACCESS).openapi({
  description: "What it may do while nobody watches: `read` (look and report) or `act` (also change things).",
});
const Report = z.enum(ROUTINE_REPORT).openapi({
  description: "When it speaks: `when_new` (only when there is something new) or `always` (a report every run).",
});

const RoutineRun = z
  .object({
    id: z.uuid(),
    at: z.string(),
    status: z
      .enum([
        "queued",
        "running",
        "waiting",
        "reported",
        "silent",
        "failed",
        "canceled",
        "superseded",
        "missed",
        "skipped",
      ])
      .openapi({
        description:
          "`reported`: it handed off a report; `silent`: nothing new, nothing posted; `canceled`: a person stopped it; `superseded`: the next slot replaced it while it waited; `missed`: it couldn't run in time; `skipped`: the slot never started.",
      }),
    code: z.string().nullable().openapi({
      description:
        "Why it was skipped, missed, failed or stopped (`previous_running`, `waiting_computer`, `stopped`, `budget_exceeded`…): the app translates it.",
    }),
    codeParams: z.record(z.string(), z.string()).optional().openapi({ description: "`stopped`: `by` (a name)." }),
    summary: z.string().openapi({ description: "Its record or report, cut; empty when you may not read it." }),
    weight: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .openapi({ description: "Recent runs only: cost (tokens on a plan) as a share of the priciest recent run." }),
    brain: z.string().nullable().openapi({ description: "The brain that ran it: `model`, `claude_code` or `codex`." }),
    link: z
      .object({ channelId: z.uuid(), threadId: z.uuid().nullable(), messageId: z.uuid() })
      .nullable()
      .openapi({ description: "The agent's message people saw (its report)." }),
    approvalId: z
      .uuid()
      .nullable()
      .optional()
      .openapi({ description: "While `waiting`: the approval it waits on, if any." }),
    finishedAt: z.string().nullable(),
  })
  .openapi("RoutineRun");
const Routine = z
  .object({
    id: z.uuid(),
    name: z.string(),
    agentId: z.uuid(),
    prompt: z.string().nullable().openapi({
      description: "Null when you may not see it (a DM, Drive or private-channel routine you don't read).",
    }),
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
        description: z.string().openapi({ description: '"tomorrow, Oct 16, at 09:00 (Brasília time)".' }),
      }),
      z.object({
        type: z.literal("email"),
        accountId: z.uuid(),
        folder: z.string(),
        filter: MailFilterSchema,
        status: z
          .enum(["active", "needs_reconnect", "error"])
          .optional()
          .openapi({ description: "`needs_reconnect`: the mailbox must be reconnected before it wakes the routine." }),
      }),
      z.object({
        type: z.literal("webhook"),
        url: z.string().nullable().openapi({
          description: "Its address (`POST` to start it); null unless you may manage the routine.",
        }),
        signed: z.boolean().openapi({ description: "Calls must carry an HMAC-SHA256 signature of the body." }),
      }),
    ]),
    active: z.boolean().openapi({ description: "One-off routines are inactive once they fired." }),
    nextRunAt: z.string().nullable(),
    createdAt: z.string(),
    access: Access,
    report: Report,
    pausedReason: z.string().nullable().openapi({
      description:
        "Why it paused itself (`creator_left`, `creator_no_access`, `agent_archived`, `agent_not_in_channel`, `audience`, `failing`); null when a person paused it.",
    }),
    failuresInRow: z.number().int(),
    state: z
      .enum(["active", "paused", "running", "waiting_computer", "waiting_person", "failing", "needs_webhook"])
      .openapi({ description: "`needs_webhook`: its event comes through a webhook this workspace doesn't have yet." }),
    waitingFor: z
      .object({ machineId: z.uuid(), machineName: z.string(), since: z.string() })
      .nullable()
      .openapi({ description: "Its run waits for the agent's computer since then." }),
    brain: z.object({
      kind: z.enum(["model", "claude_code", "codex"]),
      machineName: z.string().nullable().openapi({ description: "The computer a computer brain runs on." }),
    }),
    health: z
      .object({
        ok: z.number().int(),
        silent: z.number().int(),
        failed: z.number().int(),
        skipped: z.number().int(),
        missed: z.number().int(),
        total: z.number().int(),
      })
      .openapi({
        description:
          "The last 7 days by outcome (`ok`: reported; `skipped`: slots that didn't run, replaced ones too; `total`: their sum, without runs a person stopped).",
      }),
    canSeeDetails: z.boolean().openapi({ description: "You read its prompt, records and reports." }),
    canManage: z.boolean().openapi({ description: "You may change, pause, stop or delete it." }),
    createdByUserId: z
      .string()
      .nullable()
      .openapi({ description: "Its creator, whose reach it has (kept on edit); null once they left." }),
    lastRun: RoutineRun.nullable(),
    recentRuns: z.array(RoutineRun).openapi({ description: "The last runs, newest first (at most 14)." }),
    usage: z
      .object({
        runs: z.number().int(),
        tokens: z.number(),
        costNanoUsd: z.number(),
        billedTo: z.enum(["api", "plan", "mixed"]),
      })
      .openapi({ description: "The last 7 days: runs that started the agent, tokens and cost (zero on a plan)." }),
    ahead: z
      .array(
        z.object({
          id: z.uuid().openapi({ description: "The approval." }),
          tool: z.string(),
          scope: z.string(),
          title: z.string(),
          params: z.record(z.string(), z.unknown()).openapi({ description: "Exactly what will run." }),
          status: z.enum(["pending", "approved"]),
          runAt: z.string().openapi({ description: "When its run does it by itself." }),
          canCancel: z.boolean().openapi({ description: "You may withdraw it (`POST …/approvals/{id}/cancel`)." }),
        }),
      )
      .openapi({
        description:
          "Actions prepared for its runs (`schedule_action`) that may still run: waiting for a person, or approved ahead. Only those you see on the approvals list, none when you don't read it.",
      }),
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
    .openapi({ description: "A phrase (`weekdays at 9am`, or pt `dias úteis às 9h`) or a `rule` from the picker." }),
  z.object({ type: z.literal("event"), event: Event }),
  z.object({
    type: z.literal("once"),
    at: z.iso.datetime({ offset: true }),
    timezone: z.string().max(64).optional(),
  }),
  z
    .object({
      type: z.literal("email"),
      accountId: z.uuid(),
      folder: z.string().min(1).max(300).optional(),
      filter: MailFilterSchema.optional(),
    })
    .openapi({ description: "New mail in a mailbox the agent can read; `folder` default the inbox." }),
  z
    .object({ type: z.literal("webhook") })
    .openapi({ description: "A call to an address of its own (`GET …/hook` gives it to who manages the routine)." }),
]);

const HookCall = z
  .object({
    id: z.uuid(),
    at: z.string(),
    outcome: z.enum(HOOK_OUTCOMES).openapi({
      description:
        "`duplicate`: the same `Idempotency-Key` (or `X-GitHub-Delivery`) within 24 hours, nothing new ran; `rate_limited`: one line a minute while calls are refused.",
    }),
    status: z.number().int().openapi({ description: "The HTTP status it got." }),
    bytes: z.number().int(),
    runId: z.uuid().nullable().openapi({ description: "The routine run it went into." }),
    test: z.boolean().openapi({ description: "Sent with Testar." }),
  })
  .openapi("RoutineHookCall");
const Hook = z
  .object({
    url: z.string(),
    signed: z.boolean(),
    calls: z.array(HookCall).openapi({ description: "The latest calls, newest first (at most 20)." }),
  })
  .openapi("RoutineHook");

const RoutineParams = OrgParams.extend({ routineId: z.uuid() });

/** Routines: an agent does something on a schedule (in the workspace time zone) or when an event happens. */
export function routineRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const hooks = hookConfig(deps.config);
  const routines: RoutineDeps = {
    db,
    pubsub: adapters.pubsub,
    context: deps.extras?.context,
    artifacts: deps.extras?.artifacts,
    mail: adapters.mail,
    hooks,
  };
  const hookDeps = routineHookDeps(deps);

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/routines",
      tags,
      security,
      summary: "Routines with their next run and last runs",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ routines: z.array(Routine) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      return c.json({ routines: await listRoutines(db, actor, orgId, hooks) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/parse-schedule",
      tags,
      security,
      summary: "A schedule phrase (any language) → cron and rule, in the person's time zone (or the one given)",
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
            locale: z.string().max(10).optional().openapi({
              description: "Ignored (kept for older clients): descriptions are English; the app words the rule itself.",
            }),
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
            z.object({
              ok: z.literal(false),
              error: z.string(),
              code: z.string(),
              params: z.record(z.string(), z.unknown()).optional(),
            }),
          ]),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { phrase, timezone } = c.req.valid("json");
      // Membership is the gate for this org's schedule reader (a model call): a
      // supplied timezone otherwise skips the only path that checked it.
      await requirePermission(db, c.get("user").id, orgId, "read");
      return c.json(await parseScheduleForOrg(routines, c.get("user").id, orgId, phrase, timezone), 200);
    },
  );

  const RuleAnswer = z.union([
    z.object({
      ok: z.literal(true),
      rule: ScheduleRuleSchema,
      description: z.string().openapi({ description: '"Every 2 weeks, Mon and Wed, at 09:00 (Brasília time)".' }),
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
  const answer = (rule: ScheduleRule) => {
    const normal = normalizeRule(rule);
    return {
      ok: true as const,
      rule: normal,
      description: describeRule(normal),
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
            locale: z.string().max(10).optional().openapi({
              description: "Ignored (kept for older clients): descriptions are English; the app words the rule itself.",
            }),
          }),
        ),
      },
      responses: { 200: json(RuleAnswer), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { phrase, timezone } = c.req.valid("json");
      // Membership is the gate for this org's schedule reader (a model call): a
      // supplied timezone otherwise skips the only path that checked it.
      await requirePermission(db, c.get("user").id, orgId, "read");
      const zone = await routineTimezone(db, c.get("user").id, orgId, timezone);
      const reader = routines.context ? schedulesOf(routines.context) : null;
      const reading = await readSchedule(reader, { orgId, phrase, timezone: zone });
      if (!reading.ok) {
        const { ok: _ok, ...rest } = reading;
        return c.json({ ok: false as const, ...rest }, 200);
      }
      if (reading.type === "once") {
        // The picker's "once": that day and time in the zone.
        const local = localDateTimeOf(reading.at, zone);
        return c.json(
          {
            ok: true as const,
            rule: { freq: "once" as const, start: local.slice(0, 10), times: [local.slice(11)], timezone: zone },
            description: describeWhen(reading.at, zone),
            cron: null,
            nextRuns: [reading.at.toISOString()],
          },
          200,
        );
      }
      if (reading.type === "cron") {
        return c.json(
          {
            ok: false as const,
            error: 'Couldn\'t read the period. Try "every 2 weeks on Monday at 9am".',
            code: "schedule.unreadable",
          },
          200,
        );
      }
      return c.json(answer(reading.rule), 200);
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
            locale: z
              .string()
              .max(10)
              .optional()
              .openapi({ description: "Ignored (kept for older clients): descriptions are English." }),
          }),
        ),
      },
      responses: { 200: json(RuleAnswer), ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "read");
      try {
        const input = c.req.valid("json");
        return c.json(answer(input.rule as ScheduleRule), 200);
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
      description:
        "Refused: `routine.too_frequent` (a routine that starts the agent runs at most every 15 minutes), `routine.too_many` (20 active routines per agent), `routine.creator_cannot_post` (you must be able to post where it reports).",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            name: z.string().max(120).optional(),
            agentId: z.uuid(),
            prompt: z.string().min(1).max(10_000),
            target: Target,
            trigger: TriggerInput,
            access: Access.optional().openapi({ description: "Default `read`." }),
            report: Report.optional().openapi({ description: "Default `when_new`." }),
          }),
        ),
      },
      responses: { 201: json(Routine, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      const created = await createRoutine(routines, actor, orgId, c.req.valid("json"));
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
        "Edit a routine (its creator, admins or the agent's owner): what, when, where, access, report, pause/resume",
      request: {
        params: RoutineParams,
        body: body(
          z.object({
            name: z.string().min(1).max(120).optional(),
            prompt: z.string().min(1).max(10_000).optional(),
            agentId: z.uuid().optional(),
            trigger: TriggerInput.optional().openapi({
              description:
                "A schedule phrase is parsed again (in `timezone`, else the routine's own zone); `nextRunAt` is recomputed.",
            }),
            target: TargetView.optional(),
            active: z.boolean().optional().openapi({
              description: "`true` resumes it and clears `pausedReason` and `failuresInRow`.",
            }),
            access: Access.optional(),
            report: Report.optional(),
          }),
        ),
      },
      responses: { 200: json(Routine), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      const actor = c.get("user").id;
      const routine = await updateRoutine(routines, actor, orgId, routineId, c.req.valid("json"));
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
      request: {
        params: RoutineParams,
        body: body(
          z.object({
            name: z
              .string()
              .max(120)
              .optional()
              .openapi({ description: "The copy's name, in the person's language (default \"{name} (copy)\")." }),
          }),
        ),
      },
      responses: { 201: json(Routine, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      const actor = c.get("user").id;
      const { name } = c.req.valid("json");
      const copy = await duplicateRoutine(routines, actor, orgId, routineId, { name });
      return c.json(copy, 201);
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
      const actor = c.get("user").id;
      const routine = await runRoutineNow(routines, actor, orgId, routineId);
      deps.wakeWorkers?.();
      return c.json(routine, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/{routineId}/stop",
      tags,
      security,
      summary: "Stop the routine's run in progress (its creator, admins or the agent's owner)",
      description:
        "The background run is canceled quietly (nothing is posted) and the run ends `canceled` with code `stopped` and who stopped it. The routine keeps its schedule.",
      request: { params: RoutineParams },
      responses: { 200: json(Routine), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      const actor = c.get("user").id;
      await stopRoutineRun(routines, actor, orgId, routineId);
      return c.json(await getRoutineView(db, actor, orgId, routineId, hooks), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/{routineId}/take-over",
      tags,
      security,
      summary: "Take a routine over (admins or the agent's owner): you become its creator",
      description:
        "For a routine whose creator left or can no longer post where it reports: you become accountable for it (its approvals and notifications come to you).",
      request: { params: RoutineParams },
      responses: { 200: json(Routine), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      const actor = c.get("user").id;
      await takeOverRoutine(routines, actor, orgId, routineId);
      return c.json(await getRoutineView(db, actor, orgId, routineId, hooks), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/routines/{routineId}/runs",
      tags,
      security,
      summary: "Run history",
      request: { params: RoutineParams },
      responses: { 200: json(z.object({ runs: z.array(RoutineRun) })), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      return c.json({ runs: await listRoutineRuns(db, c.get("user").id, orgId, routineId) }, 200);
    },
  );

  // A webhook routine's address (ADR 0106): its creator, admins and the agent's owner.
  const managed = (actor: string, param: { orgId: string; routineId: string }) =>
    managedWebhookRoutine(db, actor, param.orgId, param.routineId);

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/routines/{routineId}/hook",
      tags,
      security,
      summary: "A webhook routine's address, whether calls must be signed, and its latest calls",
      request: { params: RoutineParams },
      responses: { 200: json(Hook), ...errors },
    }),
    async (c) => c.json(await routineHookView(hookDeps, await managed(c.get("user").id, c.req.valid("param"))), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/{routineId}/hook/address",
      tags,
      security,
      summary: "A new address: the old one stops working at once",
      request: { params: RoutineParams },
      responses: { 200: json(Hook), ...errors },
    }),
    async (c) => {
      const actor = c.get("user").id;
      return c.json(await newRoutineHookAddress(hookDeps, actor, await managed(actor, c.req.valid("param"))), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/{routineId}/hook/secret",
      tags,
      security,
      summary: "A new signing secret (shown this once): from now on calls must be signed with it",
      description:
        "A call carries the HMAC-SHA256 of its raw body as `X-Agentes-Signature: sha256=<hex>` (GitHub's `X-Hub-Signature-256` works too).",
      request: { params: RoutineParams },
      responses: { 200: json(z.object({ secret: z.string(), hook: Hook })), ...errors },
    }),
    async (c) => {
      const actor = c.get("user").id;
      return c.json(await newRoutineHookSecret(hookDeps, actor, await managed(actor, c.req.valid("param"))), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/routines/{routineId}/hook/secret",
      tags,
      security,
      summary: "Calls no longer need a signature",
      request: { params: RoutineParams },
      responses: { 200: json(Hook), ...errors },
    }),
    async (c) => {
      const actor = c.get("user").id;
      return c.json(await removeRoutineHookSecret(hookDeps, actor, await managed(actor, c.req.valid("param"))), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/routines/{routineId}/hook/test",
      tags,
      security,
      summary: "Testar: a sample call, as a real one would come (the agent knows it is a test, and its run only reads)",
      description:
        "Refused: `routine.webhook_paused` (409) while the routine is turned off, `routine.webhook_rate_limited` (429) past the routine's calls per minute.",
      request: { params: RoutineParams },
      responses: {
        200: json(z.object({ runId: z.uuid().nullable(), hook: Hook })),
        429: errorResponse("Too many calls to this routine"),
        ...errors,
      },
    }),
    async (c) => {
      const result = await sendRoutineHookTest(hookDeps, await managed(c.get("user").id, c.req.valid("param")));
      deps.wakeWorkers?.();
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/reminders",
      tags,
      security,
      summary: '"Remind me": a one-off reminder about a message or a conversation',
      description:
        "Like an agent's reminder: at `at` an agent of the conversation posts \"@you Reminder: …\" where the message is (its thread; in a DM, the DM), which notifies you. The agent: `agentId`, else the message's author when it is an agent, else the first agent there you can talk to (`reminder.no_agent` when none). Text: `text`, else the message's first line. Refused: `when.past`, `when.too_far` (over a year).",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            channelId: z.uuid(),
            threadId: z.uuid().nullable().optional().openapi({ description: "Post in this thread (its root id)." }),
            messageId: z.uuid().nullable().optional().openapi({ description: "The message to be reminded of." }),
            agentId: z.uuid().nullable().optional(),
            at: z.iso.datetime({ offset: true }),
            text: z.string().max(2000).nullable().optional(),
            timezone: z.string().max(64).nullable().optional().openapi({
              description: "How the time is described; default: yours, else the workspace's.",
            }),
          }),
        ),
      },
      responses: { 201: json(Reminder, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const reminder = await createReminderFromApp(routines, c.get("user").id, orgId, {
        ...input,
        at: new Date(input.at),
      });
      return c.json(reminder, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/reminders",
      tags,
      security,
      summary: "Your pending reminders in conversations, soonest first",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ reminders: z.array(Reminder) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ reminders: await listMyReminders(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/reminders/{reminderId}",
      tags,
      security,
      summary: "Cancel one of your reminders (someone else's is not found)",
      request: { params: OrgParams.extend({ reminderId: z.uuid() }) },
      responses: { 200: json(Reminder), ...errors },
    }),
    async (c) => {
      const { orgId, reminderId } = c.req.valid("param");
      return c.json(await cancelReminder(routines, c.get("user").id, orgId, reminderId), 200);
    },
  );

  return app;
}
