import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * The org wiki (D34): markdown pages every member reads, linked with
 * `[[Title]]`, `[[slug|text]]` or `[[Page#section]]`. Agents write only when
 * a person asks. Every save is a version; links are parsed on save into
 * `wiki_links` (backlinks and the graph).
 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `guia-de-deploy`: unique among live pages of the org. */
    slug: text().notNull(),
    /** Earlier slugs (renames), so old links still resolve. */
    aliases: text().array().notNull().default(sql`'{}'::text[]`),
    title: text().notNull(),
    body: text().notNull().default(""),
    /** `Engenharia/Backend`; empty = the root. */
    folder: text().notNull().default(""),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    /** Bumped on every save (optimistic concurrency). */
    version: integer().notNull().default(1),
    /** Admins lock a page: only admins edit it. */
    locked: boolean().notNull().default(false),
    /** Where it came from ("Salvar na wiki"): `{ type: "message" | "forum_topic", id }`. */
    source: jsonb().$type<{ type: string; id: string; channelId?: string }>(),
    /** `person` or `agent`. */
    createdByType: text().notNull(),
    createdById: text().notNull(),
    updatedByType: text().notNull(),
    updatedById: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("wiki_pages_org_slug").on(t.orgId, t.slug).where(sql`${t.deletedAt} is null`),
    index().on(t.orgId, t.updatedAt),
  ],
);

/** Full history: one row per save, with who wrote it (and for whom, for agents) and a note. */
export const wikiPageVersions = pgTable(
  "wiki_page_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    pageId: uuid()
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    folder: text().notNull().default(""),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    authorType: text().notNull(),
    authorId: text().notNull(),
    /** The person an agent wrote it for ("by Theo, at Walter's request"). */
    requestedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    note: text().notNull().default(""),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.pageId, t.version), index().on(t.orgId)],
);

/**
 * `[[…]]` links, from a page or from anything else that can mention one (a
 * message, a forum post, an issue). `toPageId` is null while the target
 * doesn't exist. Backlinks and the graph come from here.
 */
export const wikiLinks = pgTable(
  "wiki_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    /** `page`, `message` or `issue`. */
    fromType: text().notNull(),
    fromId: uuid().notNull(),
    /** Set for page links (removed with the page). */
    fromPageId: uuid().references(() => wikiPages.id, { onDelete: "cascade" }),
    /** Where a message link lives (who may see the backlink). */
    channelId: uuid(),
    toSlug: text().notNull(),
    toPageId: uuid().references(() => wikiPages.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.fromType, t.fromId, t.toSlug),
    index().on(t.orgId, t.toSlug),
    index().on(t.toPageId),
    index().on(t.fromPageId),
  ],
);
