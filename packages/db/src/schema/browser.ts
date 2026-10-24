import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { machines } from "./machines";
import { agentRuns } from "./runtime";
import { organizations } from "./tenancy";

/**
 * A person's turn on one of an agent's screens (ADR 0040 §6): the agent
 * asked (`ask`, from `browser_ask_person`, its run suspended) or a person
 * watching took over (`takeover`). One record per handoff: who, when, the
 * result. Frames and what the person typed are never stored.
 */
export const browserHandoffs = pgTable(
  "browser_handoffs",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    /** The run waiting on it (`ask`); null for a take over outside a run. */
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    machineId: uuid().notNull(),
    /** Which screen: the machine protocol's `ScreenKind` (this package can't import it). */
    screen: text().$type<"browser" | "desktop">().notNull().default("browser"),
    kind: text().$type<"ask" | "takeover">().notNull(),
    /** What the agent asked for, in its words ("Sign in to Stripe with the shop's test account"). */
    instructions: text().notNull().default(""),
    /** `pending` (nobody opened it), `active` (a person in control), then `done | failed | expired | cancelled`. */
    status: text()
      .$type<"pending" | "active" | "done" | "failed" | "expired" | "cancelled">()
      .notNull()
      .default("pending"),
    /** Who it was asked of (whoever asked for the work, else the agent's owner). */
    requestedForUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Who is (or was) in control. */
    controllerUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** The person's note when it failed ("it asked for Ana's phone code"). */
    note: text(),
    /**
     * While `pending`: the agent's deadline (nobody opened it). While
     * `active`: there is no deadline; this is how long control survives the
     * controller's live view going away (pushed while they watch).
     */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /**
     * When the agent read its page after a person had control (ended). Until
     * then its other browser tools refuse: the page changed under it.
     */
    pageReadAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }),
    index().on(t.orgId, t.status),
    index().on(t.agentId, t.status),
    // One open handoff per agent's screen: two people (or a person and the agent) can't race in.
    uniqueIndex("browser_handoffs_one_open").on(t.agentId, t.screen).where(sql`${t.status} in ('pending', 'active')`),
  ],
);
