import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * Skills in Markdown (Agent Skills `SKILL.md` format), per organization:
 * a name and description the agent sees, and a body it loads on demand
 * (`load_skill`). No code runs: scripts are kept as "ignored" until the
 * sandbox exists (ADR 0020).
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The skill's `name` (kebab-case, ≤ 64), unique in the org. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    body: text().notNull(),
    /** Other frontmatter fields, as given. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** `upload`, `url` or `manual`. */
    source: text().notNull(),
    sourceUrl: text(),
    /**
     * How a private repository was read (`github_app` or the `github` connection), which updating reads through
     * again. Null: read with no credentials.
     */
    sourceVia: text(),
    version: integer().notNull().default(1),
    /** Enabled for agents created later. */
    defaultForNewAgents: boolean().notNull().default(false),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.orgId, t.slug), index().on(t.orgId)],
);

/** A skill's supporting files (references, templates, examples), per version. Scripts are listed, never stored. */
export const skillFiles = pgTable(
  "skill_files",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    path: text().notNull(),
    size: integer().notNull(),
    mime: text().notNull(),
    /** `stored` (text the model may read), `script` (kept for the sandbox, never shown) or `ignored` (binaries, listed only). */
    status: text().notNull(),
    storageConfigId: uuid(),
    blobKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.skillId, t.version, t.path), index().on(t.orgId)],
);

/** Which skills an agent has. */
export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.agentId, t.skillId), index().on(t.orgId)],
);
