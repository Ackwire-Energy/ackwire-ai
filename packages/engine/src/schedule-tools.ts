import { and, eq, isNull, schema, sql } from "@agenteschat/db";
import { getChannelCached } from "./context";
import {
  cancelReminder,
  createReminder,
  createRoutine,
  listReminders,
  type RoutineDeps,
  routineTimezone,
} from "./routines";
import { describeWhen, parseWhen, timezoneName } from "./schedule";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

export const SCHEDULE_SCOPE = "schedule:write";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** The person whose message started this run (reminders are theirs). */
async function requesterOf(ctx: ToolContext): Promise<string | null> {
  const [m] = await ctx.db
    .select({ userId: schema.messages.authorUserId })
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, ctx.orgId), eq(schema.messages.id, ctx.triggerMessageId)));
  return m?.userId ?? null;
}

/** This conversation: the thread in a channel, or the DM itself (flat). */
async function conversationOf(ctx: ToolContext) {
  const channel = await getChannelCached(ctx.db, ctx.orgId, ctx.channelId);
  return { channelId: ctx.channelId, threadId: channel?.kind === "dm" ? null : ctx.threadRootId };
}

const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The agent's active routine in this conversation with the same instructions,
 * if any: asking twice (an interrupted run asked again, a repeated message)
 * must not schedule the same job twice.
 */
async function sameRoutine(ctx: ToolContext, conv: { channelId: string; threadId: string | null }, prompt: string) {
  const { routines } = schema;
  const rows = await ctx.db
    .select({
      id: routines.id,
      name: routines.name,
      prompt: routines.prompt,
      target: routines.target,
      nextRunAt: routines.nextRunAt,
      timezone: routines.timezone,
    })
    .from(routines)
    .where(
      and(
        eq(routines.orgId, ctx.orgId),
        eq(routines.agentId, ctx.agentId),
        eq(routines.active, true),
        isNull(routines.deletedAt),
        sql`${routines.target}->>'channelId' = ${conv.channelId}`,
      ),
    );
  return (
    rows.find(
      (r) =>
        ((r.target as { threadId?: string | null }).threadId ?? null) === conv.threadId && sameText(r.prompt, prompt),
    ) ?? null
  );
}

const noRequester: ToolOutput = {
  content: "Only a person's request can schedule something (this run wasn't started by a person).",
  isError: true,
};

/**
 * Scheduling from the chat (scope `schedule:write`, on by default):
 * `schedule_reminder`, `create_routine`, `list_reminders`, `cancel_reminder`.
 * Everything belongs to the person who asked, in their time zone, in this
 * conversation; reminders are one-off routines, so they show in Rotinas.
 */
export function createScheduleToolSource(deps: Omit<RoutineDeps, "db">): ToolSource {
  const routineDeps = (ctx: ToolContext): RoutineDeps => ({ ...deps, db: ctx.db });
  const tools: ToolDefinition[] = [
    {
      name: "schedule_reminder",
      description:
        'Schedule a one-off reminder in this conversation: at that time you post "Lembrete: …" mentioning the person. `when` is natural language in the person\'s time zone ("amanhã às 9h", "sexta às 15h", "em 2 horas") or ISO. Set ask_agent when, at that time, you should do something (not just remind). If the time is ambiguous, ask with ask_user first.',
      scope: SCHEDULE_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          when: { type: "string", minLength: 1, maxLength: 120 },
          message: { type: "string", minLength: 1, maxLength: 2000 },
          for: { type: "string", maxLength: 64, description: "@handle of someone else in this conversation" },
          ask_agent: { type: "boolean" },
        },
        required: ["when", "message"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const timezone = await routineTimezone(ctx.db, requester, ctx.orgId);
          const when = parseWhen(str(input.when), timezone);
          if (!when.ok) {
            return { content: `${when.error} Ask the person (ask_user) for a clear date and time.`, isError: true };
          }
          let forUserId: string | undefined;
          const handle = str(input.for).replace(/^@/, "").trim().toLowerCase();
          if (handle) {
            const [member] = await ctx.db
              .select({ userId: schema.organizationMembers.userId })
              .from(schema.organizationMembers)
              .where(
                and(eq(schema.organizationMembers.orgId, ctx.orgId), eq(schema.organizationMembers.handle, handle)),
              );
            if (!member) return { content: `No one is @${handle} here.`, isError: true };
            forUserId = member.userId;
          }
          const conv = await conversationOf(ctx);
          const r = await createReminder(routineDeps(ctx), requester, ctx.orgId, {
            agentId: ctx.agentId,
            ...conv,
            at: when.at,
            timezone: when.timezone,
            description: when.description,
            message: str(input.message),
            forUserId,
            askAgent: input.ask_agent === true,
          });
          return {
            content: `Scheduled reminder ${r.id} for ${when.description}. Confirm it to the person in those words ("Combinado: ${when.description}").`,
            data: { reminder: { id: r.id, at: r.at } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "create_routine",
      description:
        'Create a recurring routine in this conversation ("toda segunda às 9h", "dias úteis às 18h"): at each time you get `prompt` as a request from the person. Only admins or your owner can create routines.',
      scope: SCHEDULE_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          schedule: { type: "string", minLength: 1, maxLength: 300 },
          prompt: { type: "string", minLength: 1, maxLength: 10_000 },
          title: { type: "string", maxLength: 120 },
        },
        required: ["schedule", "prompt"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const conv = await conversationOf(ctx);
          const existing = await sameRoutine(ctx, conv, str(input.prompt));
          if (existing) {
            const next = existing.nextRunAt ? describeWhen(existing.nextRunAt, existing.timezone ?? "UTC") : "";
            return {
              content: `Routine ${existing.id} "${existing.name}" already exists in this conversation with these instructions (next: ${next}). Don't create another: tell the person it's already set up. To change when it runs, they edit it in Rotinas.`,
              data: { routine: { id: existing.id }, existing: true },
            };
          }
          const routine = await createRoutine(routineDeps(ctx), requester, ctx.orgId, {
            name: str(input.title) || undefined,
            agentId: ctx.agentId,
            prompt: str(input.prompt),
            target: { type: "conversation", ...conv, reminder: false },
            trigger: { type: "schedule", phrase: str(input.schedule) },
          });
          const t = routine.trigger;
          const zone = t.type === "schedule" ? t.timezone : "UTC";
          const next = routine.nextRunAt ? describeWhen(new Date(routine.nextRunAt), zone) : "";
          const when = t.type === "schedule" ? `${t.description} (${timezoneName(zone)})` : "";
          return {
            content: `Created routine ${routine.id} "${routine.name}": ${when}; next: ${next}. Confirm it to the person.`,
            data: { routine: { id: routine.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "list_reminders",
      description: "List the pending reminders of the person who asked (theirs only).",
      scope: SCHEDULE_SCOPE,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const list = await listReminders(ctx.db, requester, ctx.orgId);
          if (list.length === 0) return { content: "No pending reminders." };
          return { content: list.map((r) => `${r.id} — ${r.description}: ${r.message}`).join("\n") };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "cancel_reminder",
      description: "Cancel one of the asking person's reminders (by id from list_reminders).",
      scope: SCHEDULE_SCOPE,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", minLength: 36, maxLength: 36 } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const r = await cancelReminder(ctx.db, requester, ctx.orgId, str(input.id));
          return { content: `Cancelled the reminder for ${r.description}: ${r.message}` };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "schedule", tools: async () => tools };
}
