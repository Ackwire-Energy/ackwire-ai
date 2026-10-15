import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { channels } from "./chat";
import { organizations } from "./tenancy";

/**
 * The forum (D33): agents (and people) discuss a question in rounds,
 * asynchronously, ending in a synthesis document. Each topic has its own
 * channel (`kind = 'forum'`): posts are that channel's messages, so agents run
 * there with the normal executor, tools, approvals and live states. The
 * worker drives the turns (one run per agent per round, in order).
 */
export const forumTopics = pgTable(
  "forum_topics",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text().notNull(),
    goal: text().notNull(),
    /** `open`, `done` or `canceled`. */
    status: text().notNull().default("open"),
    /** `discussing`, `synthesizing` or `finished`. */
    phase: text().notNull().default("discussing"),
    /** Round in progress, from 1 (0 = not started). */
    round: integer().notNull().default(0),
    /** Whose turn in the round (index in the agents' order). */
    turn: integer().notNull().default(0),
    maxRounds: integer().notNull().default(3),
    /** Spend cap of the whole discussion; null = only the agents' own budgets. */
    budgetNanoUsd: bigint({ mode: "number" }),
    deadline: timestamp({ withTimezone: true }),
    /** `person` or `agent`. */
    createdByType: text().notNull(),
    createdById: text().notNull(),
    /** The person behind it (who asked an agent to open it, or the routine's creator). */
    requesterUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Writes the synthesis; null = the first agent. */
    ownerAgentId: uuid(),
    originChannelId: uuid(),
    originMessageId: uuid(),
    /** The run whose turn it is (or the synthesis run). */
    currentRunId: uuid(),
    /** A person posted: the round ends early and the next one reads it. */
    pendingPerson: boolean().notNull().default(false),
    /** "Concluir": stop after the current turn and write the synthesis. */
    stopRequested: boolean().notNull().default(false),
    synthesisArtifactId: uuid(),
    synthesisVersion: integer(),
    suggestedIssues: jsonb().$type<{ title: string; description: string }[]>().notNull().default(sql`'[]'::jsonb`),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    concludedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.status, t.lastActivityAt), uniqueIndex().on(t.channelId)],
);

/** Agents and people in a topic; agents take turns in `position` order. */
export const forumParticipants = pgTable(
  "forum_participants",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    topicId: uuid()
      .notNull()
      .references(() => forumTopics.id, { onDelete: "cascade" }),
    agentId: uuid(),
    userId: text(),
    position: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("forum_participants_agent").on(t.topicId, t.agentId).where(sql`${t.agentId} is not null`),
    uniqueIndex("forum_participants_user").on(t.topicId, t.userId).where(sql`${t.userId} is not null`),
    index().on(t.orgId),
  ],
);
