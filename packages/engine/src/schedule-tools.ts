import { and, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { type AgentActionParams, recordAgentActions } from "./agent-actions";
import { routineRow, routineSnapshot } from "./agent-undo";
import { canTalkTo } from "./audience";
import { runAuthorityById } from "./authority";
import { consultationOrigin } from "./consultations";
import { getChannelCached } from "./context";
import { schedulesOf } from "./context/summaries";
import { isAgentOnlyDm } from "./dms";
import { ROUTINE_ACCESS, ROUTINE_REPORT, routineAccessOf, routineReportOf } from "./routine-brief";
import {
  cancelReminder,
  createReminder,
  createRoutine,
  deleteRoutine,
  listOrgRoutines,
  listReminders,
  ROUTINE_EVENTS,
  type RoutineDeps,
  type RoutineEvent,
  type RoutineRunView,
  type RoutineTarget,
  type RoutineTrigger,
  type RoutineTriggerInput,
  type RoutineView,
  routineTimezone,
  runRoutineNow,
  updateRoutine,
} from "./routines";
import { timezoneName } from "./rrule";
import { replyThreadOf } from "./runs";
import { describeWhen, parseWhen } from "./schedule";
import { localDateTimeOf } from "./schedule-reader";
import { hasScope } from "./tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

export const SCHEDULE_SCOPE = "schedule:write";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/**
 * The person this run acts for (authority.ts): reminders and routines are
 * theirs, in their time zone. Null when nobody is behind the run (a routine's
 * work, the run its report woke, a note from another agent): then nothing is
 * scheduled or changed (the run policy refuses these tools there anyway).
 */
async function requesterOf(ctx: ToolContext) {
  const authority = await runAuthorityById(ctx.db, ctx.orgId, ctx.runId);
  return authority.kind === "person" ? authority.personId : null;
}

/**
 * This conversation: the thread in a channel, or the DM itself (flat). A run
 * answering a consultation lives in the agents' private DM, which no person
 * reads: there it is the conversation where the person asked.
 */
async function conversationOf(ctx: ToolContext) {
  const channel = await getChannelCached(ctx.db, ctx.orgId, ctx.channelId);
  if (channel && isAgentOnlyDm(channel)) {
    const origin = await consultationOrigin(ctx.db, ctx.orgId, ctx.runId);
    if (origin) {
      const home = await getChannelCached(ctx.db, ctx.orgId, origin.channelId);
      return { channelId: origin.channelId, threadId: home?.kind === "dm" ? null : origin.threadId };
    }
  }
  return { channelId: ctx.channelId, threadId: channel?.kind === "dm" ? null : replyThreadOf(ctx) };
}

/**
 * A channel by name for a routine to report in: one the person who asked is
 * in (not in it = not found, so private channels stay hidden). Being in it is
 * the agent's part, checked when the routine is saved.
 */
async function channelTarget(ctx: ToolContext, requester: string, raw: string) {
  const name = raw.trim().replace(/^#/, "").toLowerCase();
  const { channels, channelMembers } = schema;
  const [channel] = await ctx.db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(
      and(
        eq(channels.orgId, ctx.orgId),
        eq(channels.name, name),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
        eq(channelMembers.userId, requester),
      ),
    );
  if (!channel) throw new Error(`No channel #${name} that the person who asked is in.`);
  return { target: { type: "channel", channelId: channel.id } satisfies RoutineTarget, name: channel.name };
}

/** Where a routine reports, for the agent to tell the person. */
async function whereOf(ctx: ToolContext, r: RoutineView) {
  const t = r.target;
  if (t.type === "channel" || t.type === "conversation") {
    if (t.channelId === ctx.channelId) return "this conversation";
    const channel = await getChannelCached(ctx.db, ctx.orgId, t.channelId);
    return channel?.kind === "channel" ? `#${channel.name}` : "a direct message";
  }
  return t.type === "forum" ? "a forum topic" : t.type === "artifact" ? "a file in the Drive" : "a direct message";
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
  content:
    "Only a person's request can schedule or change routines and reminders, and no person is behind this run (a routine's work, its report, a note from another agent, or an agent's own message).",
  isError: true,
};

/** Events a routine can wait for instead of polling (mail comes through an email trigger: it needs a mailbox). */
const TOOL_EVENTS: readonly RoutineEvent[] = ROUTINE_EVENTS.filter((e) => e !== "email.received");

/** What each event means, for the model and its answers (English). */
const EVENT_WORDS: Record<RoutineEvent, string> = {
  "sentry.issue_created": "a new error comes in from Sentry",
  "github.pr_opened": "a pull request is opened on GitHub",
  "issue.created": "a task is created here",
  "deploy.succeeded": "a deploy succeeds",
  "email.received": "new mail arrives",
};

/** The zone a routine's times are read in (schedules and one-offs have their own). */
const zoneOf = (t: RoutineTrigger) => (t.type === "schedule" || t.type === "once" ? t.timezone : "UTC");

/** When a routine runs, in English for the model ("Every week, Mon, at 09:00 (Brasília time)", "when …"). */
function whenText(t: RoutineTrigger) {
  if (t.type === "schedule") {
    const zone = `(${timezoneName(t.timezone)})`;
    return t.description.includes(zone) ? t.description : `${t.description} ${zone}`;
  }
  if (t.type === "once") return `once, ${t.description}`;
  if (t.type === "event") return `when ${EVENT_WORDS[t.event]}`;
  const from = t.filter.from?.length ? ` from ${t.filter.from.join(", ")}` : "";
  const subject = t.filter.subject ? ` with "${t.filter.subject}" in the subject` : "";
  return `when new mail arrives in ${t.folder}${from}${subject}`;
}

/**
 * When a routine runs, for its receipt: the rule itself (the app words it in
 * the person's language), the moment, the event or the mailbox folder; never
 * the English description.
 */
function whenParams(t: RoutineTrigger): AgentActionParams {
  switch (t.type) {
    case "schedule":
      return {
        trigger: "schedule",
        rule: t.rule ? { ...t.rule } : null,
        cron: t.rule ? null : t.cron,
        timezone: t.timezone,
      };
    case "once":
      return { trigger: "once", at: t.at, timezone: t.timezone };
    case "event":
      return { trigger: "event", event: t.event };
    case "email":
      return { trigger: "email", folder: t.folder };
  }
}

const accessText = (r: RoutineView) =>
  r.access === "act" ? "may act (changes inside agentes.chat; asks before changing connected apps)" : "only reads";
const reportText = (r: RoutineView) =>
  r.report === "always" ? "reports every run" : "reports only when there is something new";

/** What a routine is doing now, in words for the model. */
function stateText(r: RoutineView) {
  switch (r.state) {
    case "paused":
      return r.pausedReason ? `paused: ${r.pausedReason}` : "paused";
    case "running":
      return "running now";
    case "waiting_computer":
      return `waiting for the computer ${r.waitingFor?.machineName ?? ""}`.trim();
    case "waiting_person":
      return "waiting for a person (an approval or an answer)";
    case "failing":
      return `failing (${r.failuresInRow} in a row)`;
    default:
      return "active";
  }
}

/** One run, coded: "2026-10-20 09:00 failed (provider_error)". */
function runText(run: RoutineRunView, zone: string) {
  const at = localDateTimeOf(new Date(run.at), zone).replace("T", " ");
  const by = run.codeParams?.by ? ` by ${run.codeParams.by}` : "";
  return `${at} ${run.status}${run.code ? ` (${run.code}${by})` : ""}`;
}

/** How many of a routine's last runs `list_routines` shows. */
const LISTED_RUNS = 5;

function routineLine(r: RoutineView, where: string, handle: string | null, prompt: string | null, full = false) {
  const zone = zoneOf(r.trigger);
  const next = r.nextRunAt ? describeWhen(new Date(r.nextRunAt), zone) : "none";
  const text =
    prompt === null
      ? "(instructions private: it reports in a conversation you and the person aren't in)"
      : full
        ? prompt
        : prompt.replace(/\s+/g, " ").slice(0, 300);
  const runs = r.recentRuns.slice(0, LISTED_RUNS).map((run) => runText(run, zone));
  return [
    `${r.id} — ${handle ? `@${handle} ` : ""}"${r.name}" (${stateText(r)}): ${whenText(r.trigger)}; next: ${next}; reports in ${where}; ${reportText(r)}; ${accessText(r)}`,
    `  ${text}`,
    ...(runs.length > 0 ? [`  last runs: ${runs.join("; ")}`] : []),
  ].join("\n");
}

/** Reminders are a person's own: never listed as routines. */
const isRoutine = (r: RoutineView) =>
  r.trigger.type !== "once" && !(r.target.type === "conversation" && r.target.reminder);

/**
 * Conversations whose routines' instructions a reader may see: public
 * channels, and channels and DMs where this agent or the person it acts for
 * is a member. Everything else shows the routine without its instructions.
 */
async function readableChannels(ctx: ToolContext, channelIds: string[], person: string | null) {
  if (channelIds.length === 0) return new Set<string>();
  const { channels, channelMembers } = schema;
  const rows = await ctx.db
    .selectDistinct({ id: channels.id })
    .from(channels)
    .leftJoin(
      channelMembers,
      and(
        eq(channelMembers.channelId, channels.id),
        or(eq(channelMembers.agentId, ctx.agentId), person ? eq(channelMembers.userId, person) : sql`false`),
      ),
    )
    .where(
      and(
        eq(channels.orgId, ctx.orgId),
        inArray(channels.id, channelIds),
        or(
          and(eq(channels.kind, "channel"), eq(channels.visibility, "public")),
          sql`${channelMembers.channelId} is not null`,
        ),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * The mailbox an email trigger watches: one this agent may read, by its
 * address or label; left out, the only one it may read.
 */
async function mailboxOf(ctx: ToolContext, raw: string) {
  const { mailAccounts } = schema;
  const accounts = await ctx.db
    .select({ id: mailAccounts.id, address: mailAccounts.address, label: mailAccounts.label })
    .from(mailAccounts)
    .where(
      and(eq(mailAccounts.orgId, ctx.orgId), isNull(mailAccounts.revokedAt), sql`${mailAccounts.status} <> 'pending'`),
    );
  const readable: typeof accounts = [];
  for (const a of accounts) {
    if (await hasScope(ctx.db, ctx.orgId, ctx.agentId, a.id, "mail:read")) readable.push(a);
  }
  const want = raw.trim().toLowerCase();
  const found = want
    ? readable.filter((a) => a.address.toLowerCase() === want || a.label.toLowerCase() === want)
    : readable;
  if (found.length === 1 && found[0]) return found[0].id;
  if (readable.length === 0) {
    throw new Error("You can't read any mailbox: a person must connect one and let you read it first.");
  }
  throw new Error(
    want
      ? `You can't read a mailbox "${raw}". The ones you can: ${readable.map((a) => a.address).join(", ")}.`
      : `Say which mailbox to watch (mailbox): ${readable.map((a) => a.address).join(", ")}.`,
  );
}

/** A tool's `trigger` (an email filter or an event) as the routine's trigger. */
async function triggerOf(ctx: ToolContext, raw: Record<string, unknown>): Promise<RoutineTriggerInput> {
  if (raw.type === "email") {
    const from = Array.isArray(raw.from) ? raw.from.filter((v): v is string => typeof v === "string") : [];
    return {
      type: "email",
      accountId: await mailboxOf(ctx, str(raw.mailbox)),
      ...(str(raw.folder).trim() ? { folder: str(raw.folder).trim() } : {}),
      filter: {
        ...(from.length > 0 ? { from } : {}),
        ...(str(raw.subject).trim() ? { subject: str(raw.subject).trim() } : {}),
        ...(str(raw.text).trim() ? { text: str(raw.text).trim() } : {}),
      },
    };
  }
  const event = str(raw.event) as RoutineEvent;
  if (!TOOL_EVENTS.includes(event)) throw new Error(`Say which event (event): one of ${TOOL_EVENTS.join(", ")}.`);
  return { type: "event", event };
}

/** One of this agent's routines (by id), or why not. */
async function ownRoutine(ctx: ToolContext, id: string) {
  const row = await routineRow(ctx.db, ctx.orgId, id);
  if (!row || row.deletedAt) return { row: null, error: `You have no routine ${id}. Use list_routines.` };
  if (row.agentId !== ctx.agentId) {
    return {
      row: null,
      error: `Routine ${id} is another agent's: only that agent changes it, when a person asks it. Don't ask it to on the person's behalf if the person already asked it directly.`,
    };
  }
  return { row, error: "" };
}

const TRIGGER_SCHEMA = {
  type: "object",
  description:
    'Instead of a schedule: run when something happens. `type: "email"` with `mailbox` (its address; left out, the only one you can read), `folder` (default the inbox) and optional filters `from` (addresses or @domains), `subject` and `text` (words). `type: "event"` with `event`.',
  properties: {
    type: { type: "string", enum: ["email", "event"] },
    event: {
      type: "string",
      enum: TOOL_EVENTS,
      description: TOOL_EVENTS.map((e) => `${e}: ${EVENT_WORDS[e]}`).join("; "),
    },
    mailbox: { type: "string", maxLength: 320 },
    folder: { type: "string", maxLength: 300 },
    from: { type: "array", items: { type: "string", maxLength: 320 }, maxItems: 50 },
    subject: { type: "string", maxLength: 200 },
    text: { type: "string", maxLength: 200 },
  },
  required: ["type"],
  additionalProperties: false,
};
const REPORT_SCHEMA = {
  type: "string",
  enum: ROUTINE_REPORT,
  description: '"when_new" (default): only when there is something new; "always": a report every run.',
};
const ACCESS_SCHEMA = {
  type: "string",
  enum: ROUTINE_ACCESS,
  description:
    '"read" (default): only look and report. "act": may also change things (tasks, memory, wiki, Drive, its own branches and PRs; changes in connected apps still ask first). Only when the person clearly wants changes made.',
};

/** The routine in one line for the agent to confirm. */
const summaryOf = async (ctx: ToolContext, r: RoutineView) => {
  const next = r.nextRunAt ? `; next: ${describeWhen(new Date(r.nextRunAt), zoneOf(r.trigger))}` : "";
  return `"${r.name}" (${r.active ? "active" : "paused"}): ${whenText(r.trigger)}${next}; reports in ${await whereOf(ctx, r)}; ${reportText(r)}; ${accessText(r)}`;
};

/**
 * Scheduling from the chat (scope `schedule:write`, on by default):
 * `schedule_reminder`, `create_routine`, `list_routines`, `update_routine`,
 * `delete_routine`, `run_routine_now`, `list_reminders`, `cancel_reminder`.
 * Everything belongs to the person who asked, in their time zone, in this
 * conversation; reminders are one-off routines, so they show in Routines.
 * A routine is the agent's background work (ADR 0053): it speaks only by
 * handing its findings off to the conversation it reports to.
 */
export function createScheduleToolSource(deps: Omit<RoutineDeps, "db">): ToolSource {
  const routineDeps = (ctx: ToolContext): RoutineDeps => ({ ...deps, db: ctx.db });
  const tools: ToolDefinition[] = [
    {
      name: "schedule_reminder",
      description:
        'Schedule a one-off reminder in this conversation: at that time you post "Reminder: …" mentioning the person (the app shows it as a reminder in their language). `when` is what the person said, in their words and language ("amanhã às 9h", "tomorrow at 9am", "in 2 hours"), read in their time zone, or ISO 8601. Write `message` in the person\'s language. Set ask_agent when, at that time, you should do something (not just remind). If the time is ambiguous, ask with ask_user first.',
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
          const reader = deps.context ? schedulesOf(deps.context) : null;
          const when = await parseWhen(reader, { orgId: ctx.orgId, text: str(input.when), timezone });
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
            content: `Scheduled reminder ${r.id} for ${when.description}. Confirm it to the person with that day, date, time and time zone, in their language.`,
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
        'Create a routine: work you do on your own, in the background, on a schedule ("toda segunda às 9h", "dias úteis às 18h", "every hour") or when something happens (`trigger`). Each run gets `prompt` as its instructions and nobody watches it: it speaks only by handing its findings off to the conversation it reports to, where you then tell the people. That is this conversation by default; set `channel` (its name, with or without #) when the person wants it in a channel ("manda no #general"). `report` says when it speaks, `access` what it may do on its own. When the person says "when a new email arrives" or "when a new error comes in", use `trigger` (an email filter or an event), never a schedule that checks again and again. A routine runs at most every 15 minutes. Only admins or your owner can create routines; the person sees it with Undo.',
      scope: SCHEDULE_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          schedule: { type: "string", minLength: 1, maxLength: 300 },
          trigger: TRIGGER_SCHEMA,
          prompt: { type: "string", minLength: 1, maxLength: 10_000 },
          title: { type: "string", maxLength: 120 },
          channel: { type: "string", maxLength: 100, description: "Report in this channel instead of here" },
          report: REPORT_SCHEMA,
          access: ACCESS_SCHEMA,
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const hasSchedule = Boolean(str(input.schedule).trim());
          const rawTrigger = input.trigger as Record<string, unknown> | undefined;
          if (hasSchedule === Boolean(rawTrigger)) {
            return {
              content: "Give either `schedule` (when it runs) or `trigger` (what starts it), not both.",
              isError: true,
            };
          }
          const trigger: RoutineTriggerInput = rawTrigger
            ? await triggerOf(ctx, rawTrigger)
            : { type: "schedule", phrase: str(input.schedule) };
          const channel = str(input.channel).trim() ? await channelTarget(ctx, requester, str(input.channel)) : null;
          const conv =
            channel && channel.target.channelId !== ctx.channelId
              ? { channelId: channel.target.channelId, threadId: null }
              : await conversationOf(ctx);
          const existing = await sameRoutine(ctx, conv, str(input.prompt));
          if (existing) {
            const next = existing.nextRunAt ? describeWhen(existing.nextRunAt, existing.timezone ?? "UTC") : "";
            return {
              content: `Routine ${existing.id} "${existing.name}" already exists in this conversation with these instructions${next ? ` (next: ${next})` : ""}. Don't create another: tell the person it's already set up. To change it, use update_routine or they edit it in Routines.`,
              data: { routine: { id: existing.id }, existing: true },
            };
          }
          const routine = await createRoutine(routineDeps(ctx), requester, ctx.orgId, {
            name: str(input.title) || undefined,
            agentId: ctx.agentId,
            prompt: str(input.prompt),
            target:
              channel && channel.target.channelId !== ctx.channelId
                ? channel.target
                : { type: "conversation", ...conv, reminder: false },
            trigger,
            access: routineAccessOf(input.access),
            report: routineReportOf(input.report),
          });
          // Recorded right after (reading the schedule may call a model: no transaction held around it).
          const row = await routineRow(ctx.db, ctx.orgId, routine.id);
          if (row) {
            await recordAgentActions(ctx.db, ctx, [
              {
                kind: "routine.created",
                target: { type: "routine", id: routine.id, title: routine.name },
                params: {
                  name: routine.name,
                  active: routine.active,
                  access: routine.access,
                  report: routine.report,
                  ...whenParams(routine.trigger),
                },
                after: routineSnapshot(row),
              },
            ]);
          }
          return {
            content: `Created routine ${routine.id} ${await summaryOf(ctx, routine)}. Confirm it to the person.`,
            data: { routine: { id: routine.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "list_routines",
      description:
        "List routines (recurring, not reminders): yours by default; another agent's with `agent` (its handle, e.g. @atlas), or every agent's with `agent: \"all\"`, to check what they do before you answer about them. Shows each one's state (active, paused and why, running, waiting for its computer, failing), when it runs and its next run, where it reports, its instructions and its last 5 runs with their coded outcome (reported, silent, failed, skipped… and why). `id` shows one in full. Read only: you change only your own routines, when a person asks.",
      scope: SCHEDULE_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", maxLength: 40, description: 'An agent\'s handle (@atlas), or "all"' },
          id: { type: "string", minLength: 36, maxLength: 36 },
        },
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const person = await requesterOf(ctx);
          const handle = str(input.agent).trim().replace(/^@/, "").toLowerCase();
          const { agents } = schema;
          const team = await ctx.db
            .select({
              id: agents.id,
              handle: agents.handle,
              audienceMode: agents.audienceMode,
              audienceUserIds: agents.audienceUserIds,
              ownerUserId: agents.ownerUserId,
              brain: agents.brain,
            })
            .from(agents)
            .where(and(eq(agents.orgId, ctx.orgId), isNull(agents.archivedAt)));
          const byId = new Map(team.map((a) => [a.id, a]));
          let agentId: string | undefined = ctx.agentId;
          if (handle === "all") agentId = undefined;
          else if (handle) {
            const found = team.find((a) => a.handle === handle);
            if (!found) return { content: `There is no agent @${handle} in this organization.`, isError: true };
            agentId = found.id;
          }
          const mineOnly = agentId === ctx.agentId;
          const list = (await listOrgRoutines(ctx.db, ctx.orgId, agentId ? { agentId } : {})).filter(
            (r) =>
              isRoutine(r) &&
              (!str(input.id) || r.id === str(input.id)) &&
              // Another agent's routines only when the person behind this run may talk to it.
              (r.agentId === ctx.agentId ||
                (byId.has(r.agentId) && (!person || canTalkTo(byId.get(r.agentId) as (typeof team)[number], person)))),
          );
          if (list.length === 0) {
            if (str(input.id))
              return { content: `No routine ${str(input.id)} here. Use list_routines.`, isError: true };
            return {
              content: mineOnly
                ? "You have no routines."
                : handle === "all"
                  ? "No routines."
                  : `@${handle} has no routines.`,
            };
          }
          const channelOf = (r: RoutineView) =>
            r.target.type === "channel" || r.target.type === "conversation" ? r.target.channelId : null;
          const readable = await readableChannels(ctx, [...new Set(list.flatMap((r) => channelOf(r) ?? []))], person);
          const lines = await Promise.all(
            list.map(async (r) => {
              const channelId = channelOf(r);
              const visible =
                r.agentId === ctx.agentId ||
                (channelId ? readable.has(channelId) : r.target.type === "forum" || r.target.type === "artifact");
              return routineLine(
                r,
                await whereOf(ctx, r),
                mineOnly ? null : (byId.get(r.agentId)?.handle ?? null),
                visible ? (r.prompt ?? "") : null,
                Boolean(str(input.id)),
              );
            }),
          );
          return { content: lines.join("\n") };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "update_routine",
      description:
        'Change one of your routines (id from list_routines) when the person asks: `channel` moves where it reports ("manda no #general" — then nothing comes to the old conversation), `prompt` replaces its instructions, `schedule` its time ("dias úteis às 9h", "weekdays at 9am") or `trigger` what starts it (an email filter or an event instead of a schedule), `report` when it speaks, `access` what it may do on its own ("act" only when the person clearly wants changes made), `active` pauses or resumes it. Only who created it, your owner or an admin can change it; the person sees it with Undo.',
      scope: SCHEDULE_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 36, maxLength: 36 },
          channel: { type: "string", maxLength: 100 },
          prompt: { type: "string", minLength: 1, maxLength: 10_000 },
          schedule: { type: "string", minLength: 1, maxLength: 300 },
          trigger: TRIGGER_SCHEMA,
          title: { type: "string", minLength: 1, maxLength: 120 },
          report: REPORT_SCHEMA,
          access: ACCESS_SCHEMA,
          active: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const id = str(input.id);
          const own = await ownRoutine(ctx, id);
          if (!own.row) return { content: own.error, isError: true };
          const rawTrigger = input.trigger as Record<string, unknown> | undefined;
          if (rawTrigger && str(input.schedule)) {
            return { content: "Give either `schedule` or `trigger`, not both.", isError: true };
          }
          const trigger: RoutineTriggerInput | undefined = rawTrigger
            ? await triggerOf(ctx, rawTrigger)
            : str(input.schedule)
              ? { type: "schedule", phrase: str(input.schedule) }
              : undefined;
          const channel = str(input.channel).trim() ? await channelTarget(ctx, requester, str(input.channel)) : null;
          const routine = await updateRoutine(routineDeps(ctx), requester, ctx.orgId, id, {
            ...(channel ? { target: channel.target } : {}),
            ...(str(input.prompt) ? { prompt: str(input.prompt) } : {}),
            ...(str(input.title) ? { name: str(input.title) } : {}),
            ...(trigger ? { trigger } : {}),
            ...(input.report !== undefined ? { report: routineReportOf(input.report) } : {}),
            ...(input.access !== undefined ? { access: routineAccessOf(input.access) } : {}),
            ...(typeof input.active === "boolean" ? { active: input.active } : {}),
          });
          const afterRow = await routineRow(ctx.db, ctx.orgId, id);
          if (afterRow) {
            const was = routineSnapshot(own.row);
            const now = routineSnapshot(afterRow);
            const fields = Object.keys(now).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
            if (fields.length > 0) {
              const words = [
                ...new Set(
                  fields.map((f) =>
                    ["triggerType", "phrase", "cron", "timezone", "description", "event", "rule"].includes(f)
                      ? "schedule"
                      : f,
                  ),
                ),
              ];
              await recordAgentActions(ctx.db, ctx, [
                {
                  kind: "routine.updated",
                  target: { type: "routine", id: routine.id, title: routine.name },
                  params: {
                    name: routine.name,
                    // The app's words: name, prompt, schedule, where (target), access, report, paused/resumed (active).
                    fields: words,
                    active: routine.active,
                    access: routine.access,
                    report: routine.report,
                    ...(words.includes("schedule") ? whenParams(routine.trigger) : {}),
                  },
                  before: Object.fromEntries(fields.map((k) => [k, was[k]])),
                  after: Object.fromEntries(fields.map((k) => [k, now[k]])),
                },
              ]);
            }
          }
          return {
            content: `Updated routine ${routine.id} ${await summaryOf(ctx, routine)}. Tell the person what changed.`,
            data: { routine: { id: routine.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "delete_routine",
      description:
        "Delete one of your routines (id from list_routines) when the person asks: it stops for good (its history stays). The person sees it with Undo. To stop it for a while, pause it instead (update_routine with active false).",
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
          const id = str(input.id);
          const own = await ownRoutine(ctx, id);
          if (!own.row) return { content: own.error, isError: true };
          await deleteRoutine(routineDeps(ctx), requester, ctx.orgId, id);
          await recordAgentActions(ctx.db, ctx, [
            {
              kind: "routine.deleted",
              target: { type: "routine", id, title: own.row.name },
              params: { name: own.row.name },
              before: routineSnapshot(own.row),
            },
          ]);
          return { content: `Deleted routine ${id} "${own.row.name}". Tell the person (they can undo it).` };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "run_routine_now",
      description:
        "Run one of your routines now (id from list_routines), when the person asks to try it or wants a fresh run: it works in the background as on its schedule and speaks as its report setting says. It runs once at a time: if a run is still going, this one is skipped.",
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
          const id = str(input.id);
          const own = await ownRoutine(ctx, id);
          if (!own.row) return { content: own.error, isError: true };
          const routine = await runRoutineNow(routineDeps(ctx), requester, ctx.orgId, id);
          return {
            content: `Started a run of routine ${id} "${routine.name}": it works in the background and ${reportText(routine)}, in ${await whereOf(ctx, routine)}. Tell the person it's running; don't wait for it.`,
            data: { routine: { id } },
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
