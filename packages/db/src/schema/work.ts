import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

export const issueStatusEnum = pgEnum("issue_status", ["todo", "in_progress", "in_review", "done", "canceled"]);
export const issuePriorityEnum = pgEnum("issue_priority", ["low", "normal", "high"]);

/** Next issue number per organization (#1, #2…), taken atomically. */
export const issueCounters = pgTable("issue_counters", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  last: integer().notNull().default(0),
});

/**
 * Native issues (D28). Visible to the whole org, or like the channel they
 * came from (`channel_id`, e.g. "Transformar em issue" in a private
 * channel). Acceptance criteria are a checklist; assignee is a person or an
 * agent.
 */
export const issues = pgTable(
  "issues",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    status: issueStatusEnum().notNull().default("todo"),
    priority: issuePriorityEnum().notNull().default("normal"),
    /** `person` or `agent`. */
    assigneeType: text(),
    assigneeId: text(),
    labels: text().array().notNull().default(sql`'{}'::text[]`),
    dueDate: date({ mode: "string" }),
    /** `[{ id, text, done }]`. */
    /** `doneBy`: who checked it (`{ type, id }`), when done. */
    criteria: jsonb()
      .$type<{ id: string; text: string; done: boolean; doneBy?: { type: "person" | "agent"; id: string } | null }[]>()
      .notNull()
      .default([]),
    /** `{ type: "manual" | "message" | "forum" | "agent" | "webhook", … }`. */
    source: jsonb().$type<Record<string, unknown>>().notNull().default({ type: "manual" }),
    channelId: uuid(),
    /** A sub-issue of this one (e.g. a step of a plan the forum made for it, D45). */
    parentIssueId: uuid().references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
    /** `[{ number, url, openedBy }]`. */
    pullRequests: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
    artifactIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    createdByType: text().notNull(),
    createdById: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.orgId, t.number),
    index().on(t.orgId, t.status),
    index().on(t.orgId, t.dueDate),
    index().on(t.parentIssueId),
  ],
);

/** Comments (people and agents) and events ("asked Ada to implement") of an issue. */
export const issueActivity = pgTable(
  "issue_activity",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    issueId: uuid()
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    /** `comment` or `event`. */
    kind: text().notNull(),
    authorType: text().notNull(),
    authorId: text().notNull(),
    text: text().notNull(),
    /** Machine form of an event: `status_changed`, `assigned`, `agent_asked`… */
    event: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.issueId, t.createdAt)],
);

/**
 * Routines (D28): an agent runs `prompt` on a schedule (cron in the org's
 * time zone, from a phrase) or when an event happens (webhooks, new issue),
 * and delivers to a channel, a DM with the creator, or a Drive file.
 */
export const routines = pgTable(
  "routines",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    name: text().notNull(),
    prompt: text().notNull(),
    /** `{ type: "channel", channelId }`, `{ type: "dm" }` or `{ type: "artifact" }`. */
    target: jsonb().$type<Record<string, unknown>>().notNull(),
    /** `schedule` or `event`. */
    triggerType: text().notNull(),
    phrase: text(),
    cron: text(),
    timezone: text(),
    description: text(),
    event: text(),
    /** A structured schedule (`ScheduleRule`): wins over `cron`, which is kept when it can express it. */
    rule: jsonb().$type<Record<string, unknown>>(),
    active: boolean().notNull().default(true),
    nextRunAt: timestamp({ withTimezone: true }),
    lastRunAt: timestamp({ withTimezone: true }),
    /** Spend cap of this routine's runs per calendar month (UTC), nano-USD; null = only the agent's budget. */
    monthlyBudgetNanoUsd: bigint({ mode: "number" }),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Deleted: never fires again; its run history stays. */
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId), index().on(t.active, t.nextRunAt)],
);

/** One firing of a routine; `(routine_id, at)` is unique, so a slot never fires twice. */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    routineId: uuid()
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    /** The scheduled slot (or the moment of a manual or event run). */
    at: timestamp({ withTimezone: true }).notNull(),
    /** `schedule`, `manual` or `event`. */
    trigger: text().notNull(),
    agentRunId: uuid(),
    /** `queued`, `started`, `skipped` or `failed` (a started run's outcome comes from its agent run). */
    status: text().notNull().default("queued"),
    summary: text().notNull().default(""),
    event: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.routineId, t.at), index().on(t.routineId, t.createdAt)],
);

/**
 * Incoming webhooks of an organization (GitHub, Sentry). The signing secret
 * is sealed; each request's signature is checked before anything runs.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    secretCiphertext: text().notNull(),
    wrappedDataKey: text().notNull(),
    kekId: text().notNull(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * Native calendar (D28): events people create (agents only propose), with
 * attendees (people and agents) and their RSVP, a linked channel or issue,
 * and a simple recurrence.
 */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text().notNull().default(""),
    startAt: timestamp({ withTimezone: true }).notNull(),
    endAt: timestamp({ withTimezone: true }).notNull(),
    allDay: boolean().notNull().default(false),
    location: text(),
    timezone: text().notNull().default("UTC"),
    /** `none`, `weekdays`, `weekly` or `monthly` (stored as an RRULE in `rrule`). */
    recurrence: text().notNull().default("none"),
    rrule: text(),
    /** The series rule (`ScheduleRule`, no times: the event's own); null = the legacy `recurrence`. */
    rule: jsonb().$type<Record<string, unknown>>(),
    /** Original starts (ISO) of occurrences removed from the series ("only this one"). */
    exdates: jsonb().$type<string[]>().notNull().default([]),
    /** An edited occurrence ("only this one"): the series it belongs to, and that occurrence's original start. */
    overrideOf: uuid(),
    originalStart: timestamp({ withTimezone: true }),
    channelId: uuid(),
    issueId: uuid(),
    createdByType: text().notNull(),
    createdById: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.startAt)],
);

export const calendarAttendees = pgTable(
  "calendar_attendees",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    eventId: uuid()
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    /** `person` or `agent`. */
    attendeeType: text().notNull(),
    attendeeId: text().notNull(),
    /** `needs_action`, `accepted` or `declined`. */
    status: text().notNull().default("needs_action"),
    respondedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.eventId, t.attendeeType, t.attendeeId), index().on(t.orgId, t.attendeeId)],
);

/** A slot an agent suggested; nothing is created until the person who asked confirms it. */
export const calendarProposals = pgTable(
  "calendar_proposals",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    runId: uuid(),
    requesterUserId: text().notNull(),
    channelId: uuid().notNull(),
    messageId: uuid(),
    title: text().notNull(),
    description: text().notNull().default(""),
    startAt: timestamp({ withTimezone: true }).notNull(),
    endAt: timestamp({ withTimezone: true }).notNull(),
    participants: jsonb().$type<{ type: string; id: string }[]>().notNull().default([]),
    /** A repeating proposal (`ScheduleRule`). */
    rule: jsonb().$type<Record<string, unknown>>(),
    note: text(),
    /** `pending`, `confirmed` or `dismissed`. */
    status: text().notNull().default("pending"),
    eventId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.requesterUserId, t.status)],
);
