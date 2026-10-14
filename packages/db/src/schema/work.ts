import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
    criteria: jsonb().$type<{ id: string; text: string; done: boolean }[]>().notNull().default([]),
    /** `{ type: "manual" | "message" | "forum" | "agent" | "webhook", … }`. */
    source: jsonb().$type<Record<string, unknown>>().notNull().default({ type: "manual" }),
    channelId: uuid(),
    /** `[{ number, url, openedBy }]`. */
    pullRequests: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
    artifactIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    createdByType: text().notNull(),
    createdById: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.orgId, t.number), index().on(t.orgId, t.status), index().on(t.orgId, t.dueDate)],
);

/** Comments (people and agents) and events ("pediu à Ada para implementar") of an issue. */
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
