import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { type ArtifactDeps, getArtifact } from "./artifacts";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { requireChannelAccess } from "./channels";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { getForumTopic } from "./forum";
import { getMessage } from "./messages";
import { can, getMembership, type Membership } from "./organizations";
import { enqueueIndex, registerDocumentBuilder, registerReindexSource, type SearchDeps, searchVisible } from "./search";
import { pagesBySlug, parseWikiLinks, syncWikiLinks, wikiSlug } from "./wiki-links";

const {
  wikiPages,
  wikiPageVersions,
  wikiLinks,
  users,
  agents,
  messages,
  channels,
  channelMembers,
  issues,
  forumTopics,
} = schema;

type PageRow = typeof wikiPages.$inferSelect;

/** Who writes: a person, or an agent on a person's request ("por Theo, a pedido de Walter"). */
export type WikiActor =
  | { type: "person"; userId: string }
  | { type: "agent"; agentId: string; requestedByUserId: string | null };

export interface WikiDeps {
  db: Database;
  pubsub?: PubSub;
  /** Search over the wiki (else a title/body match). */
  search?: SearchDeps;
  /** For "Salvar na wiki" from a forum synthesis (a Drive document). */
  artifacts?: ArtifactDeps;
}

export interface WikiAuthor {
  type: "person" | "agent";
  id: string;
  /** For agents: the person who asked. */
  onBehalfOf: string | null;
}

export interface WikiPageSummary {
  id: string;
  slug: string;
  title: string;
  folder: string;
  tags: string[];
  version: number;
  locked: boolean;
  updatedAt: string;
  updatedBy: WikiAuthor;
}

export type WikiBacklink =
  | { kind: "page"; slug: string; title: string }
  | { kind: "message"; channelId: string; messageId: string; channelName: string; excerpt: string; at: string }
  | { kind: "forum"; topicId: string; title: string }
  | { kind: "issue"; number: number; title: string };

export interface WikiPageView extends WikiPageSummary {
  body: string;
  createdAt: string;
  createdBy: WikiAuthor;
  /** Everyone who wrote it, most recent first. */
  authors: WikiAuthor[];
  backlinks: WikiBacklink[];
  /** Its own `[[…]]` links, resolved. */
  links: { target: string; slug: string; title: string | null; exists: boolean }[];
  source: { type: string; id: string; channelId?: string } | null;
  deletedAt: string | null;
}

export interface WikiVersionView {
  version: number;
  at: string;
  author: WikiAuthor;
  note: string | null;
  title: string;
}

export const WIKI_LIMITS = { body: 200_000, title: 200, folder: 200, tags: 20 };

/** Raised when the page moved past the version being edited (409 `version_conflict`). */
export class WikiVersionConflictError extends ConflictError {
  constructor(readonly currentVersion: number) {
    super(
      `Alguém editou esta página enquanto você escrevia (agora está na versão ${currentVersion}).`,
      "version_conflict",
    );
  }
}

// ── Normalization ────────────────────────────────────────────────────────────

function cleanTitle(title: string) {
  const t = title.replace(/\s+/g, " ").trim().slice(0, WIKI_LIMITS.title);
  if (!t) throw new ValidationError("A title is required", "wiki.title_required");
  if (/[[\]|#]/.test(t)) throw new ValidationError("The title can't contain [ ] | or #", "wiki.title_characters");
  return t;
}

/** " Processos / Vendas/ " → "Processos/Vendas". */
export function cleanFolder(folder: string | undefined | null) {
  if (!folder) return "";
  const parts = folder
    .split("/")
    .map((p) => p.replace(/\s+/g, " ").trim().slice(0, 80))
    .filter(Boolean);
  if (parts.length > 8) throw new ValidationError("At most 8 folder levels", "wiki.folder_depth", { max: 8 });
  return parts.join("/").slice(0, WIKI_LIMITS.folder);
}

function cleanTags(tags: string[] | undefined) {
  if (!tags) return undefined;
  return [...new Set(tags.map((t) => t.trim().replace(/^#/, "").toLowerCase().slice(0, 40)).filter(Boolean))].slice(
    0,
    WIKI_LIMITS.tags,
  );
}

function cleanBody(body: string | undefined) {
  const b = body ?? "";
  if (b.length > WIKI_LIMITS.body)
    throw new ValidationError("A page can have up to 200,000 characters", "wiki.body_too_long", { max: 200_000 });
  return b;
}

// ── Access ───────────────────────────────────────────────────────────────────

/** Every member reads; agents of the org read. Returns the person's membership. */
async function requireReader(db: Database, actor: WikiActor, orgId: string): Promise<Membership | null> {
  if (actor.type === "agent") {
    const agent = await getAgent(db, orgId, actor.agentId);
    if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
    return null;
  }
  const membership = await getMembership(db, actor.userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  return membership;
}

/** Members create and edit; a locked page only admins (never agents). */
async function requireWriter(db: Database, actor: WikiActor, orgId: string, page?: PageRow) {
  const membership = await requireReader(db, actor, orgId);
  if (membership && !can(membership.role, "post")) throw new ForbiddenError();
  if (page?.locked && !(membership && can(membership.role, "configure"))) {
    throw new ForbiddenError("This page is locked: only admins edit it", "wiki.locked");
  }
  return membership;
}

const authorCols = (actor: WikiActor) =>
  actor.type === "person"
    ? { type: "person", id: actor.userId, requestedBy: null }
    : { type: "agent", id: actor.agentId, requestedBy: actor.requestedByUserId };

const auditActor = (actor: WikiActor) =>
  actor.type === "person"
    ? { type: "person" as const, id: actor.userId }
    : { type: "agent" as const, id: actor.agentId };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A live page by id, slug or an earlier slug (or a deleted one with `deleted`). */
async function findPage(db: Executor, orgId: string, ref: string, options: { deleted?: boolean } = {}) {
  const key = ref.trim();
  if (UUID.test(key)) {
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.id, key)));
    if (row && (options.deleted ? row.deletedAt : !row.deletedAt)) return row;
    throw new NotFoundError("Page not found", "wiki.page_not_found");
  }
  const slug = wikiSlug(key) || key;
  if (options.deleted) {
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, slug), sql`${wikiPages.deletedAt} is not null`))
      .orderBy(desc(wikiPages.deletedAt))
      .limit(1);
    if (!row) throw new NotFoundError("Page not found", "wiki.page_not_found");
    return row;
  }
  const page = (await pagesBySlug(db, orgId, [slug])).get(slug);
  if (!page) throw new NotFoundError("Page not found", "wiki.page_not_found");
  const [row] = await db.select().from(wikiPages).where(eq(wikiPages.id, page.id));
  if (!row) throw new NotFoundError("Page not found", "wiki.page_not_found");
  return row;
}

// ── Views ────────────────────────────────────────────────────────────────────

async function summaries(db: Executor, rows: PageRow[]): Promise<WikiPageSummary[]> {
  if (rows.length === 0) return [];
  const latest = await db
    .select({ pageId: wikiPageVersions.pageId, requestedBy: wikiPageVersions.requestedByUserId })
    .from(wikiPageVersions)
    .where(
      and(
        inArray(
          wikiPageVersions.pageId,
          rows.map((r) => r.id),
        ),
        sql`${wikiPageVersions.version} = (select p.version from wiki_pages p where p.id = ${wikiPageVersions.pageId})`,
      ),
    );
  const behalf = new Map(latest.map((l) => [l.pageId, l.requestedBy]));
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    folder: r.folder,
    tags: r.tags,
    version: r.version,
    locked: r.locked,
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: {
      type: r.updatedByType as WikiAuthor["type"],
      id: r.updatedById,
      onBehalfOf: r.updatedByType === "agent" ? (behalf.get(r.id) ?? null) : null,
    },
  }));
}

async function summaryOf(db: Executor, row: PageRow) {
  const [s] = await summaries(db, [row]);
  if (!s) throw new Error("wiki summary missing");
  return s;
}

async function backlinksOf(db: Database, actor: WikiActor, page: PageRow): Promise<WikiBacklink[]> {
  const rows = await db
    .select()
    .from(wikiLinks)
    .where(and(eq(wikiLinks.orgId, page.orgId), eq(wikiLinks.toPageId, page.id)))
    .orderBy(desc(wikiLinks.createdAt))
    .limit(200);
  const out: WikiBacklink[] = [];
  const pageIds = rows.filter((r) => r.fromType === "page" && r.fromId !== page.id).map((r) => r.fromId);
  if (pageIds.length) {
    const from = await db
      .select({ slug: wikiPages.slug, title: wikiPages.title })
      .from(wikiPages)
      .where(and(inArray(wikiPages.id, pageIds), isNull(wikiPages.deletedAt)))
      .orderBy(asc(wikiPages.title));
    for (const p of from) out.push({ kind: "page", slug: p.slug, title: p.title });
  }
  // Messages and issues only where the reader can see them (people: their channels and public ones).
  const viewer = actor.type === "person" ? actor.userId : null;
  const messageIds = rows.filter((r) => r.fromType === "message").map((r) => r.fromId);
  if (messageIds.length && viewer) {
    const found = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        body: messages.body,
        createdAt: messages.createdAt,
        channelName: channels.name,
        kind: channels.kind,
        visibility: channels.visibility,
        memberId: channelMembers.id,
        topicId: forumTopics.id,
        topicTitle: forumTopics.title,
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, viewer)))
      .leftJoin(forumTopics, eq(forumTopics.channelId, channels.id))
      .where(
        and(
          eq(messages.orgId, page.orgId),
          inArray(messages.id, messageIds),
          isNull(messages.deletedAt),
          isNull(channels.archivedAt),
        ),
      )
      .orderBy(desc(messages.createdAt));
    const topics = new Set<string>();
    for (const m of found) {
      if (m.kind === "forum" && m.topicId) {
        if (topics.has(m.topicId)) continue;
        topics.add(m.topicId);
        out.push({ kind: "forum", topicId: m.topicId, title: m.topicTitle ?? "" });
        continue;
      }
      if (!(m.memberId || (m.visibility === "public" && m.kind === "channel"))) continue;
      out.push({
        kind: "message",
        channelId: m.channelId,
        messageId: m.id,
        channelName: m.channelName,
        excerpt: excerpt(m.body, page),
        at: m.createdAt.toISOString(),
      });
    }
  }
  const issueIds = rows.filter((r) => r.fromType === "issue").map((r) => r.fromId);
  if (issueIds.length && viewer) {
    const found = await db
      .select({
        number: issues.number,
        title: issues.title,
        channelId: issues.channelId,
        visibility: channels.visibility,
        memberId: channelMembers.id,
      })
      .from(issues)
      .leftJoin(channels, eq(channels.id, issues.channelId))
      .leftJoin(channelMembers, and(eq(channelMembers.channelId, issues.channelId), eq(channelMembers.userId, viewer)))
      .where(and(eq(issues.orgId, page.orgId), inArray(issues.id, issueIds)))
      .orderBy(desc(issues.number));
    for (const i of found) {
      if (i.channelId && !(i.memberId || i.visibility === "public")) continue;
      out.push({ kind: "issue", number: i.number, title: i.title });
    }
  }
  return out;
}

/** About 160 characters around the link. */
function excerpt(body: string, page: Pick<PageRow, "slug" | "aliases">) {
  const slugs = new Set([page.slug, ...page.aliases]);
  const ref = parseWikiLinks(body).find((r) => slugs.has(r.slug));
  const at = ref ? body.indexOf(`[[${ref.target}`) : -1;
  const start = Math.max(0, at - 60);
  const text = body.slice(start, start + 160).replace(/\s+/g, " ");
  return `${start > 0 ? "…" : ""}${text}${start + 160 < body.length ? "…" : ""}`;
}

async function detail(db: Database, actor: WikiActor, row: PageRow): Promise<WikiPageView> {
  const [summary, versions, backlinks, links] = await Promise.all([
    summaryOf(db, row),
    db
      .select({
        type: wikiPageVersions.authorType,
        id: wikiPageVersions.authorId,
        requestedBy: wikiPageVersions.requestedByUserId,
        version: wikiPageVersions.version,
      })
      .from(wikiPageVersions)
      .where(eq(wikiPageVersions.pageId, row.id))
      .orderBy(desc(wikiPageVersions.version))
      .limit(500),
    backlinksOf(db, actor, row),
    resolveOwnLinks(db, row),
  ]);
  const authors: WikiAuthor[] = [];
  const seen = new Set<string>();
  for (const v of versions) {
    const key = `${v.type}:${v.id}:${v.requestedBy ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push({
      type: v.type as WikiAuthor["type"],
      id: v.id,
      onBehalfOf: v.type === "agent" ? v.requestedBy : null,
    });
  }
  const first = versions.at(-1);
  return {
    ...summary,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    createdBy: {
      type: row.createdByType as WikiAuthor["type"],
      id: row.createdById,
      onBehalfOf: row.createdByType === "agent" && first?.version === 1 ? first.requestedBy : null,
    },
    authors,
    backlinks,
    links,
    source: row.source ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

async function resolveOwnLinks(db: Executor, row: PageRow) {
  const refs = parseWikiLinks(row.body);
  const pages = await pagesBySlug(
    db,
    row.orgId,
    refs.map((r) => r.slug),
  );
  return refs.map((r) => {
    const p = pages.get(r.slug);
    return { target: r.target, slug: p?.slug ?? r.slug, title: p?.title ?? null, exists: Boolean(p) };
  });
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function addVersion(tx: Executor, page: PageRow, actor: WikiActor, note: string) {
  const author = authorCols(actor);
  await tx.insert(wikiPageVersions).values({
    orgId: page.orgId,
    pageId: page.id,
    version: page.version,
    title: page.title,
    body: page.body,
    folder: page.folder,
    tags: page.tags,
    authorType: author.type,
    authorId: author.id,
    requestedByUserId: author.requestedBy,
    note: note.slice(0, 500),
  });
}

/** Links that waited for this page (by its slug or earlier ones) now point to it. */
async function claimLinks(tx: Executor, page: Pick<PageRow, "id" | "orgId" | "slug" | "aliases">) {
  await tx
    .update(wikiLinks)
    .set({ toPageId: page.id })
    .where(
      and(
        eq(wikiLinks.orgId, page.orgId),
        isNull(wikiLinks.toPageId),
        inArray(wikiLinks.toSlug, [page.slug, ...page.aliases]),
      ),
    );
}

async function announce(
  deps: WikiDeps,
  orgId: string,
  page: WikiPageSummary,
  action: "created" | "updated" | "renamed" | "moved" | "deleted" | "restored" | "locked" | "unlocked",
  extra: Record<string, unknown> = {},
) {
  caches.contextPresence.delete(`${orgId}:wiki`);
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "wiki.page.updated", action, page, ...extra },
  });
}

/** A free slug for a new page: `deploy`, `deploy-2`… */
async function freeSlug(tx: Executor, orgId: string, wanted: string) {
  const base = wanted || "pagina";
  for (let n = 1; n < 200; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 76)}-${n}`;
    const [taken] = await tx
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, slug), isNull(wikiPages.deletedAt)));
    if (!taken) return slug;
  }
  throw new ConflictError("No free address for this page", "wiki.no_free_slug");
}

export interface WikiPageInput {
  title: string;
  body?: string;
  folder?: string;
  tags?: string[];
  /** Change note for the first version. */
  note?: string;
  source?: { type: string; id: string; channelId?: string } | null;
}

/** Creates a page. A title already in use gets `-2` etc. in its slug only when `allowDuplicate`. */
export async function createWikiPage(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  input: WikiPageInput,
  options: { allowDuplicate?: boolean } = {},
): Promise<WikiPageView> {
  const { db } = deps;
  await requireWriter(db, actor, orgId);
  const title = cleanTitle(input.title);
  const body = cleanBody(input.body);
  const folder = cleanFolder(
    input.folder ?? (input.title.includes("/") ? input.title.split("/").slice(0, -1).join("/") : ""),
  );
  const leafTitle = cleanTitle(title.split("/").pop() ?? title);
  const author = authorCols(actor);
  const row = await db.transaction(async (tx) => {
    const wanted = wikiSlug(leafTitle);
    if (!wanted) throw new ValidationError("The title needs letters or numbers", "wiki.title_empty_slug");
    const existing = (await pagesBySlug(tx, orgId, [wanted])).get(wanted);
    if (existing && existing.slug === wanted && !options.allowDuplicate) {
      throw new ConflictError(`A page "${existing.title}" already exists`, "slug_taken", {
        title: existing.title,
        slug: existing.slug,
      });
    }
    const slug = existing && existing.slug === wanted ? await freeSlug(tx, orgId, wanted) : wanted;
    const [page] = await tx
      .insert(wikiPages)
      .values({
        orgId,
        slug,
        title: leafTitle,
        body,
        folder,
        tags: cleanTags(input.tags) ?? [],
        source: input.source ?? null,
        createdByType: author.type,
        createdById: author.id,
        updatedByType: author.type,
        updatedById: author.id,
      })
      .returning();
    if (!page) throw new Error("wiki insert returned nothing");
    await addVersion(tx, page, actor, input.note ?? (await defaultNote(tx, actor, "criou a página")));
    await syncWikiLinks(tx, orgId, { type: "page", id: page.id }, body);
    await claimLinks(tx, page);
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_created",
      target: { type: "wiki_page", id: page.id },
      details: { slug, title: leafTitle, ...(actor.type === "agent" ? { requestedBy: actor.requestedByUserId } : {}) },
    });
    return page;
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "created");
  return view;
}

/** "por Theo, a pedido de Walter: …" for agent edits; the given text for people. */
async function defaultNote(db: Executor, actor: WikiActor, what: string) {
  if (actor.type === "person") return what;
  const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, actor.agentId));
  const [person] = actor.requestedByUserId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, actor.requestedByUserId))
    : [];
  return `por ${agent?.name ?? "agente"}${person ? `, a pedido de ${person.name}` : ""}: ${what}`;
}

export interface WikiPagePatch {
  /** The version being edited; a newer one on the server is a conflict. */
  baseVersion: number;
  title?: string;
  body?: string;
  folder?: string;
  tags?: string[];
  note?: string;
}

/** Saves an edit as a new version, if nobody saved since `baseVersion`. A new title doesn't change the slug (see rename). */
export async function updateWikiPage(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  ref: string,
  patch: WikiPagePatch,
): Promise<WikiPageView> {
  const { db } = deps;
  const current = await findPage(db, orgId, ref);
  await requireWriter(db, actor, orgId, current);
  if (current.version !== patch.baseVersion) throw new WikiVersionConflictError(current.version);
  const next = {
    title: patch.title !== undefined ? cleanTitle(patch.title) : current.title,
    body: patch.body !== undefined ? cleanBody(patch.body) : current.body,
    folder: patch.folder !== undefined ? cleanFolder(patch.folder) : current.folder,
    tags: cleanTags(patch.tags) ?? current.tags,
  };
  const unchanged =
    next.title === current.title &&
    next.body === current.body &&
    next.folder === current.folder &&
    next.tags.join("\n") === current.tags.join("\n");
  if (unchanged) return detail(db, actor, current);
  const author = authorCols(actor);
  const row = await db.transaction(async (tx) => {
    const [page] = await tx
      .update(wikiPages)
      .set({
        ...next,
        version: sql`${wikiPages.version} + 1`,
        updatedByType: author.type,
        updatedById: author.id,
        updatedAt: new Date(),
      })
      .where(and(eq(wikiPages.id, current.id), eq(wikiPages.version, patch.baseVersion), isNull(wikiPages.deletedAt)))
      .returning();
    if (!page) {
      const [now] = await tx.select({ version: wikiPages.version }).from(wikiPages).where(eq(wikiPages.id, current.id));
      throw new WikiVersionConflictError(now?.version ?? current.version);
    }
    await addVersion(tx, page, actor, patch.note?.trim() || (await defaultNote(tx, actor, "editou")));
    if (next.body !== current.body) await syncWikiLinks(tx, orgId, { type: "page", id: page.id }, next.body);
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_updated",
      target: { type: "wiki_page", id: page.id },
      details: { version: page.version, ...(actor.type === "agent" ? { requestedBy: actor.requestedByUserId } : {}) },
    });
    return page;
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "updated");
  return view;
}

/** The body with `text` added: at the end, or at the end of the section `section` (created if missing). */
export function appendToSection(body: string, text: string, section?: string | null) {
  const add = text.trim();
  if (!section) return body.trim() ? `${body.replace(/\s+$/, "")}\n\n${add}\n` : `${add}\n`;
  const range = findSection(body, section);
  if (!range) return `${body.replace(/\s+$/, "")}${body.trim() ? "\n\n" : ""}## ${section.trim()}\n\n${add}\n`;
  const before = body.slice(0, range.end).replace(/\s+$/, "");
  const after = body.slice(range.end);
  return `${before}\n\n${add}\n${after ? `\n${after.replace(/^\s+/, "")}` : ""}`;
}

/** The body with the section's content replaced (heading kept; added at the end if missing). */
export function replaceSection(body: string, section: string, text: string) {
  const range = findSection(body, section);
  if (!range) return appendToSection(body, text, section);
  const after = body.slice(range.end);
  return `${body.slice(0, range.contentStart)}\n${text.trim()}\n${after ? `\n${after.replace(/^\s+/, "")}` : ""}`;
}

/** Where a `#`-heading section is: from its line to the next heading of the same or a higher level. */
function findSection(body: string, section: string) {
  const want = section.trim().toLowerCase();
  const lines = body.split("\n");
  let offset = 0;
  let start = -1;
  let level = 0;
  let contentStart = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const hl = (h[1] as string).length;
      if (start >= 0 && hl <= level) return { start, contentStart, end: offset };
      if (start < 0 && (h[2] as string).trim().toLowerCase() === want) {
        start = offset;
        level = hl;
        contentStart = offset + line.length;
      }
    }
    offset += line.length + 1;
  }
  return start >= 0 ? { start, contentStart, end: body.length } : null;
}

/** Appends a block to a page (as a new version): agents, and "Salvar na wiki". */
export async function appendToWikiPage(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  ref: string,
  input: { text: string; section?: string | null; mode?: "append" | "replace_section"; note?: string },
) {
  const page = await findPage(deps.db, orgId, ref);
  const body =
    input.mode === "replace_section" && input.section
      ? replaceSection(page.body, input.section, input.text)
      : appendToSection(page.body, input.text, input.section);
  return updateWikiPage(deps, actor, orgId, page.id, {
    baseVersion: page.version,
    body,
    note:
      input.note ??
      (await defaultNote(
        deps.db,
        actor,
        input.mode === "replace_section" ? `reescreveu a seção "${input.section}"` : "acrescentou um trecho",
      )),
  });
}

/**
 * New title (and slug). Old links keep working (the old slug becomes an
 * alias) and the `[[…]]` in other pages are rewritten to the new title.
 */
export async function renameWikiPage(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  ref: string,
  input: { title: string },
): Promise<WikiPageView> {
  const { db } = deps;
  const current = await findPage(db, orgId, ref);
  await requireWriter(db, actor, orgId, current);
  const title = cleanTitle(input.title.split("/").pop() ?? input.title);
  const wanted = wikiSlug(title);
  if (!wanted) throw new ValidationError("The title needs letters or numbers", "wiki.title_empty_slug");
  const author = authorCols(actor);
  const oldSlugs = new Set([current.slug, ...current.aliases]);
  const { row, touched } = await db.transaction(async (tx) => {
    let slug = current.slug;
    if (wanted !== current.slug) {
      const [taken] = await tx
        .select({ id: wikiPages.id, title: wikiPages.title })
        .from(wikiPages)
        .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, wanted), isNull(wikiPages.deletedAt)));
      if (taken)
        throw new ConflictError(`A page "${taken.title}" already uses this address`, "slug_taken", {
          title: taken.title,
        });
      slug = wanted;
    }
    const aliases = [...new Set([...current.aliases, current.slug])].filter((a) => a !== slug).slice(-20);
    const [page] = await tx
      .update(wikiPages)
      .set({
        title,
        slug,
        aliases,
        version: sql`${wikiPages.version} + 1`,
        updatedByType: author.type,
        updatedById: author.id,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, current.id))
      .returning();
    if (!page) throw new NotFoundError("Page not found", "wiki.page_not_found");
    await addVersion(tx, page, actor, await defaultNote(tx, actor, `renomeou de "${current.title}" para "${title}"`));
    await claimLinks(tx, page);
    // Pages that link here: rewrite their `[[…]]` to the new title, as a new version each.
    const linking = await tx
      .select({ id: wikiLinks.fromId })
      .from(wikiLinks)
      .where(and(eq(wikiLinks.orgId, orgId), eq(wikiLinks.fromType, "page"), eq(wikiLinks.toPageId, page.id)));
    const touched: string[] = [];
    for (const { id } of linking) {
      const [other] = await tx
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.id, id), isNull(wikiPages.deletedAt)));
      if (!other) continue;
      const body = rewriteLinks(other.body, oldSlugs, title);
      if (body === other.body) continue;
      const [saved] = await tx
        .update(wikiPages)
        .set({ body, version: sql`${wikiPages.version} + 1`, updatedAt: new Date() })
        .where(eq(wikiPages.id, other.id))
        .returning();
      if (!saved) continue;
      await addVersion(tx, saved, actor, `link atualizado: "${current.title}" → "${title}"`);
      await syncWikiLinks(tx, orgId, { type: "page", id: saved.id }, saved.body);
      await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: saved.id });
      touched.push(saved.id);
    }
    // The page's own row, re-read in case it linked to itself.
    const [fresh] = await tx.select().from(wikiPages).where(eq(wikiPages.id, page.id));
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_renamed",
      target: { type: "wiki_page", id: page.id },
      details: {
        from: { title: current.title, slug: current.slug },
        to: { title, slug },
        linksUpdated: touched.length,
      },
    });
    return { row: fresh ?? page, touched };
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "renamed", { previousSlug: current.slug, updatedPageIds: touched });
  return view;
}

/** `[[Antigo#seção|texto]]` → `[[Novo#seção|texto]]` for links to any of `slugs` (code is left alone). */
export function rewriteLinks(body: string, slugs: Set<string>, newTitle: string) {
  const parts = body.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[\[([^[\]\n]+)\]\]/g, (whole, inner: string) => {
            const bar = inner.indexOf("|");
            const target = bar >= 0 ? inner.slice(0, bar) : inner;
            const hash = target.indexOf("#");
            const title = (hash >= 0 ? target.slice(0, hash) : target).trim();
            if (!slugs.has(wikiSlug(title))) return whole;
            const folder = title.includes("/") ? `${title.split("/").slice(0, -1).join("/")}/` : "";
            const section = hash >= 0 ? target.slice(hash) : "";
            const label = bar >= 0 ? inner.slice(bar) : "";
            return `[[${folder}${newTitle}${section}${label}]]`;
          }),
    )
    .join("");
}

/** Moves a page to another folder ("" = the root). */
export async function moveWikiPage(deps: WikiDeps, actor: WikiActor, orgId: string, ref: string, folder: string) {
  const page = await findPage(deps.db, orgId, ref);
  const view = await updateWikiPage(deps, actor, orgId, page.id, {
    baseVersion: page.version,
    folder,
    note: await defaultNote(deps.db, actor, `moveu para "${cleanFolder(folder) || "a raiz"}"`),
  });
  await recordAudit(deps.db, {
    orgId,
    actor: auditActor(actor),
    action: "wiki.page_moved",
    target: { type: "wiki_page", id: page.id },
    details: { from: page.folder, to: view.folder },
  });
  return view;
}

/** Soft delete: links to it show as missing; restore brings it back. */
export async function deleteWikiPage(deps: WikiDeps, actor: WikiActor, orgId: string, ref: string) {
  const { db } = deps;
  const page = await findPage(db, orgId, ref);
  await requireWriter(db, actor, orgId, page);
  const row = await db.transaction(async (tx) => {
    const [deleted] = await tx
      .update(wikiPages)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(wikiPages.id, page.id))
      .returning();
    await tx.update(wikiLinks).set({ toPageId: null }).where(eq(wikiLinks.toPageId, page.id));
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_deleted",
      target: { type: "wiki_page", id: page.id },
      details: { slug: page.slug, title: page.title },
    });
    return deleted ?? page;
  });
  await announce(deps, orgId, await summaryOf(db, row), "deleted");
}

/** Brings a deleted page back (by id, or the most recently deleted page with that slug). */
export async function restoreWikiPage(deps: WikiDeps, actor: WikiActor, orgId: string, ref: string) {
  const { db } = deps;
  const page = await findPage(db, orgId, ref, { deleted: true });
  await requireWriter(db, actor, orgId, page);
  const row = await db.transaction(async (tx) => {
    const [taken] = await tx
      .select({ title: wikiPages.title })
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, page.slug), isNull(wikiPages.deletedAt)));
    if (taken)
      throw new ConflictError(
        `Another page uses this address ("${taken.title}"): rename it first`,
        "wiki.restore_slug_taken",
        { title: taken.title },
      );
    const [restored] = await tx
      .update(wikiPages)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(wikiPages.id, page.id))
      .returning();
    if (!restored) throw new NotFoundError("Page not found", "wiki.page_not_found");
    await claimLinks(tx, restored);
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_restored",
      target: { type: "wiki_page", id: page.id },
      details: { slug: page.slug },
    });
    return restored;
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "restored");
  return view;
}

/** Admins lock (only admins edit) or unlock a page. */
export async function setWikiPageLock(deps: WikiDeps, userId: string, orgId: string, ref: string, locked: boolean) {
  const { db } = deps;
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  if (!can(membership.role, "configure")) throw new ForbiddenError("Only admins lock pages", "wiki.lock_admins_only");
  const page = await findPage(db, orgId, ref);
  const [row] = await db.update(wikiPages).set({ locked }).where(eq(wikiPages.id, page.id)).returning();
  if (!row) throw new NotFoundError("Page not found", "wiki.page_not_found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: locked ? "wiki.page_locked" : "wiki.page_unlocked",
    target: { type: "wiki_page", id: page.id },
    details: { slug: page.slug },
  });
  const view = await detail(db, { type: "person", userId }, row);
  await announce(deps, orgId, view, locked ? "locked" : "unlocked");
  return view;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getWikiPage(db: Database, actor: WikiActor, orgId: string, ref: string) {
  await requireReader(db, actor, orgId);
  return detail(db, actor, await findPage(db, orgId, ref));
}

/** Pages (no bodies): all of them, or by folder (and its subfolders), tag or title words; most recent first. */
export async function listWikiPages(
  db: Database,
  actor: WikiActor,
  orgId: string,
  filters: { folder?: string; tag?: string; q?: string; deleted?: boolean; limit?: number } = {},
): Promise<WikiPageSummary[]> {
  await requireReader(db, actor, orgId);
  const folder = filters.folder !== undefined ? cleanFolder(filters.folder) : undefined;
  const q = filters.q?.trim();
  const rows = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.orgId, orgId),
        filters.deleted ? sql`${wikiPages.deletedAt} is not null` : isNull(wikiPages.deletedAt),
        folder !== undefined && folder !== ""
          ? or(eq(wikiPages.folder, folder), sql`${wikiPages.folder} like ${`${folder.replace(/[%_\\]/g, "\\$&")}/%`}`)
          : undefined,
        filters.tag ? sql`${filters.tag.trim().replace(/^#/, "").toLowerCase()} = any(${wikiPages.tags})` : undefined,
        q ? sql`${wikiPages.title} ilike ${`%${q.replace(/[%_\\]/g, "\\$&")}%`}` : undefined,
      ),
    )
    .orderBy(desc(wikiPages.updatedAt))
    .limit(Math.min(filters.limit ?? 2000, 5000));
  return summaries(db, rows);
}

/** Folders and tags with counts, plus the latest pages (the sidebar). */
export async function wikiTree(db: Database, actor: WikiActor, orgId: string) {
  const pages = await listWikiPages(db, actor, orgId);
  const folders = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const p of pages) {
    const parts = p.folder ? p.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      folders.set(path, (folders.get(path) ?? 0) + 1);
    }
    for (const t of p.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  return {
    pages,
    folders: [...folders].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
    tags: [...tags]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    recent: pages.slice(0, 10),
  };
}

/** Title autocomplete for `[[`: titles starting with the text first, then containing it. */
export async function suggestWikiPages(db: Database, actor: WikiActor, orgId: string, text: string, limit = 10) {
  await requireReader(db, actor, orgId);
  const q = text.trim().split("/").pop()?.trim() ?? "";
  const esc = q.replace(/[%_\\]/g, "\\$&");
  const rows = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.orgId, orgId),
        isNull(wikiPages.deletedAt),
        q
          ? or(sql`${wikiPages.title} ilike ${`%${esc}%`}`, sql`${wikiPages.slug} like ${`%${wikiSlug(q) || esc}%`}`)
          : undefined,
      ),
    )
    .orderBy(
      q ? sql`case when ${wikiPages.title} ilike ${`${esc}%`} then 0 else 1 end` : sql`0`,
      desc(wikiPages.updatedAt),
    )
    .limit(Math.min(limit, 50));
  return summaries(db, rows);
}

export async function listWikiVersions(db: Database, actor: WikiActor, orgId: string, ref: string) {
  await requireReader(db, actor, orgId);
  const page = await findPage(db, orgId, ref);
  const rows = await db
    .select()
    .from(wikiPageVersions)
    .where(eq(wikiPageVersions.pageId, page.id))
    .orderBy(desc(wikiPageVersions.version))
    .limit(500);
  return rows.map(
    (v): WikiVersionView => ({
      version: v.version,
      at: v.createdAt.toISOString(),
      author: {
        type: v.authorType as WikiAuthor["type"],
        id: v.authorId,
        onBehalfOf: v.authorType === "agent" ? v.requestedByUserId : null,
      },
      note: v.note || null,
      title: v.title,
    }),
  );
}

export async function getWikiVersion(db: Database, actor: WikiActor, orgId: string, ref: string, version: number) {
  await requireReader(db, actor, orgId);
  const page = await findPage(db, orgId, ref);
  const [v] = await db
    .select()
    .from(wikiPageVersions)
    .where(and(eq(wikiPageVersions.pageId, page.id), eq(wikiPageVersions.version, version)));
  if (!v) throw new NotFoundError("Version not found", "wiki.version_not_found");
  return {
    version: v.version,
    title: v.title,
    body: v.body,
    folder: v.folder,
    tags: v.tags,
    at: v.createdAt.toISOString(),
    author: {
      type: v.authorType as WikiAuthor["type"],
      id: v.authorId,
      onBehalfOf: v.authorType === "agent" ? v.requestedByUserId : null,
    },
    note: v.note || null,
  };
}

/** What changed between two versions: lines and a unified patch. */
export async function diffWikiVersions(
  db: Database,
  actor: WikiActor,
  orgId: string,
  ref: string,
  from: number,
  to: number,
) {
  const [a, b] = await Promise.all([
    getWikiVersion(db, actor, orgId, ref, from),
    getWikiVersion(db, actor, orgId, ref, to),
  ]);
  const lines = diffLines(a.body, b.body);
  return {
    from,
    to,
    titleChanged: a.title !== b.title ? { from: a.title, to: b.title } : null,
    added: lines.filter((l) => l.type === "add").length,
    removed: lines.filter((l) => l.type === "del").length,
    lines,
    patch: unifiedPatch(lines, `v${from}`, `v${to}`),
  };
}

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** Line diff (longest common subsequence; large texts fall back to prefix/suffix trimming). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ type: "same", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ type: "same", text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  let middle: DiffLine[];
  if (x.length * y.length > 4_000_000) {
    middle = [
      ...x.map((text): DiffLine => ({ type: "del", text })),
      ...y.map((text): DiffLine => ({ type: "add", text })),
    ];
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        lcs[i * w + j] =
          x[i] === y[j]
            ? (lcs[(i + 1) * w + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        middle.push({ type: "same", text: x[i] as string });
        i++;
        j++;
      } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) {
        middle.push({ type: "del", text: x[i++] as string });
      } else {
        middle.push({ type: "add", text: y[j++] as string });
      }
    }
    while (i < x.length) middle.push({ type: "del", text: x[i++] as string });
    while (j < y.length) middle.push({ type: "add", text: y[j++] as string });
  }
  return [...head, ...middle, ...tail];
}

/** A unified patch (3 lines of context) from `diffLines`. */
export function unifiedPatch(lines: DiffLine[], fromName: string, toName: string) {
  const changed = lines.map((l, i) => (l.type !== "same" ? i : -1)).filter((i) => i >= 0);
  if (changed.length === 0) return "";
  const out = [`--- ${fromName}`, `+++ ${toName}`];
  let k = 0;
  while (k < changed.length) {
    const first = changed[k] as number;
    let last = first;
    while (k + 1 < changed.length && (changed[k + 1] as number) - last <= 6) last = changed[++k] as number;
    k++;
    const from = Math.max(0, first - 3);
    const to = Math.min(lines.length, last + 4);
    let aLine = 1;
    let bLine = 1;
    for (let i = 0; i < from; i++) {
      if (lines[i]?.type !== "add") aLine++;
      if (lines[i]?.type !== "del") bLine++;
    }
    const hunk = lines.slice(from, to);
    const aCount = hunk.filter((l) => l.type !== "add").length;
    const bCount = hunk.filter((l) => l.type !== "del").length;
    out.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (const l of hunk) out.push(`${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`);
  }
  return `${out.join("\n")}\n`;
}

/** Pages and their links (only between existing pages); `unresolved` lists links to pages not written yet. */
export async function wikiGraph(db: Database, actor: WikiActor, orgId: string) {
  await requireReader(db, actor, orgId);
  const pages = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      folder: wikiPages.folder,
      tags: wikiPages.tags,
      createdByType: wikiPages.createdByType,
      createdById: wikiPages.createdById,
    })
    .from(wikiPages)
    .where(and(eq(wikiPages.orgId, orgId), isNull(wikiPages.deletedAt)))
    .limit(5000);
  const links = await db
    .select({ from: wikiLinks.fromId, to: wikiLinks.toPageId, toSlug: wikiLinks.toSlug })
    .from(wikiLinks)
    .where(and(eq(wikiLinks.orgId, orgId), eq(wikiLinks.fromType, "page")))
    .limit(50_000);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const edges: { from: string; to: string }[] = [];
  const unresolved: { from: string; toSlug: string }[] = [];
  for (const l of links) {
    const from = byId.get(l.from);
    if (!from) continue;
    const to = l.to ? byId.get(l.to) : undefined;
    if (to) {
      if (to.id !== from.id) edges.push({ from: from.slug, to: to.slug });
    } else unresolved.push({ from: from.slug, toSlug: l.toSlug });
  }
  return {
    nodes: pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      folder: p.folder,
      tags: p.tags,
      agentId: p.createdByType === "agent" ? p.createdById : null,
    })),
    edges,
    unresolved,
  };
}

/** Wiki search: hybrid search when available, else title and body words. */
export async function searchWiki(deps: WikiDeps, actor: WikiActor, orgId: string, text: string, limit = 8) {
  await requireReader(deps.db, actor, orgId);
  return searchPages(deps, orgId, text, limit);
}

async function searchPages(deps: WikiDeps, orgId: string, text: string, limit: number): Promise<PageRow[]> {
  const q = text.trim();
  if (!q) return [];
  if (deps.search) {
    const hits = await searchVisible(deps.search, {
      orgId,
      text: q.slice(0, 500),
      visibleChannelIds: [],
      kinds: ["wiki"],
      limit,
      match: "any",
    }).catch(() => []);
    if (hits.length > 0) {
      const rows = await deps.db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.orgId, orgId),
            isNull(wikiPages.deletedAt),
            inArray(
              wikiPages.id,
              hits.map((h) => h.sourceId),
            ),
          ),
        );
      const rank = new Map(hits.map((h, i) => [h.sourceId, i]));
      return rows.sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
    }
  }
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 8);
  if (words.length === 0) return [];
  const match = or(
    ...words.map((w) => {
      const like = `%${w.replace(/[%_\\]/g, "\\$&")}%`;
      return or(sql`${wikiPages.title} ilike ${like}`, sql`${wikiPages.body} ilike ${like}`);
    }),
  );
  return deps.db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.orgId, orgId), isNull(wikiPages.deletedAt), match))
    .orderBy(desc(wikiPages.updatedAt))
    .limit(limit);
}

// ── "Salvar na wiki" ─────────────────────────────────────────────────────────

export type WikiSaveSource =
  | { kind: "message"; channelId: string; messageId: string }
  | { kind: "forum"; topicId: string };

/** The text of a message or a forum synthesis, with a line saying where it came from. */
async function sourceBlock(deps: WikiDeps, userId: string, orgId: string, source: WikiSaveSource) {
  const { db } = deps;
  if (source.kind === "message") {
    await requireChannelAccess(db, userId, orgId, source.channelId);
    const m = await getMessage(db, orgId, source.messageId);
    if (!m || m.deletedAt || m.channelId !== source.channelId)
      throw new NotFoundError("Message not found", "message.not_found");
    const [channel] = await db
      .select({ name: channels.name, kind: channels.kind })
      .from(channels)
      .where(eq(channels.id, m.channelId));
    const [author] =
      m.authorType === "agent" && m.authorAgentId
        ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, m.authorAgentId))
        : m.authorUserId
          ? await db.select({ name: users.name }).from(users).where(eq(users.id, m.authorUserId))
          : [];
    const where = channel?.kind === "dm" ? "uma DM" : `#${channel?.name ?? "canal"}`;
    const date = m.createdAt.toISOString().slice(0, 10);
    return {
      text: `${m.body.trim()}\n\n_Salvo de uma mensagem de ${author?.name ?? "alguém"} em ${where} (${date})._`,
      source: { type: "message", id: m.id, channelId: m.channelId },
      title:
        m.body
          .split("\n")[0]
          ?.replace(/[#*_`[\]|]/g, "")
          .trim()
          .slice(0, 80) || "Nota",
    };
  }
  const topic = await getForumTopic(db, userId, orgId, source.topicId);
  if (!topic.synthesis) throw new ValidationError("This topic has no synthesis yet", "forum.no_synthesis");
  if (!deps.artifacts) throw new ValidationError("Files aren't available on this server", "drive.unavailable");
  const doc = await getArtifact(deps.artifacts, { type: "person", userId }, orgId, topic.synthesis.artifactId);
  const markdown = doc.content.kind === "document" ? doc.content.markdown : "";
  return {
    text: `${markdown.trim()}\n\n_Síntese do fórum "${topic.title}" (${topic.lastActivityAt.slice(0, 10)})._`,
    source: { type: "forum_topic", id: topic.id, channelId: topic.channelId },
    title: topic.title.replace(/[#[\]|]/g, "").slice(0, 120),
  };
}

/** "Salvar na wiki": appends the message or synthesis to a page, with where it came from. */
export async function appendSourceToWiki(
  deps: WikiDeps,
  userId: string,
  orgId: string,
  ref: string,
  input: { source: WikiSaveSource; text?: string; section?: string | null },
) {
  const block = await sourceBlock(deps, userId, orgId, input.source);
  const text = input.text?.trim() ? `${input.text.trim()}\n\n${block.text.split("\n").at(-1)}` : block.text;
  return appendToWikiPage(deps, { type: "person", userId }, orgId, ref, {
    text,
    section: input.section,
    note: input.source.kind === "message" ? "salvou uma mensagem" : "salvou a síntese do fórum",
  });
}

/** "Salvar na wiki" on a new page: the message or synthesis becomes the page, with its source. */
export async function createPageFromSource(
  deps: WikiDeps,
  userId: string,
  orgId: string,
  input: { source: WikiSaveSource; title?: string; folder?: string; tags?: string[] },
) {
  const block = await sourceBlock(deps, userId, orgId, input.source);
  return createWikiPage(
    deps,
    { type: "person", userId },
    orgId,
    {
      title: input.title?.trim() || block.title,
      body: block.text,
      folder: input.folder,
      tags: input.tags,
      source: block.source,
      note: input.source.kind === "message" ? "criou a partir de uma mensagem" : "criou a partir da síntese do fórum",
    },
    { allowDuplicate: true },
  );
}

// ── Agents' context ──────────────────────────────────────────────────────────

/**
 * Wiki pages relevant to the trigger message, for the run's prompt (a trusted
 * source written by the team). Pages the message links with `[[…]]` come
 * first. An org without a wiki costs one cached lookup.
 */
export async function retrieveWikiForRun(
  deps: WikiDeps,
  input: { orgId: string; agentId: string; text: string; budgetChars?: number },
): Promise<{ text: string; pageIds: string[] }> {
  const { db } = deps;
  const hasAny = (await caches.contextPresence.getOrLoad(`${input.orgId}:wiki`, async () => {
    const [row] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, input.orgId), isNull(wikiPages.deletedAt)))
      .limit(1);
    return Boolean(row);
  })) as boolean;
  if (!hasAny || !input.text.trim()) return { text: "", pageIds: [] };
  const linked = parseWikiLinks(input.text);
  const named = linked.length
    ? [
        ...(
          await pagesBySlug(
            db,
            input.orgId,
            linked.map((l) => l.slug),
          )
        ).values(),
      ].map((p) => p.id)
    : [];
  const namedRows = named.length
    ? await db
        .select()
        .from(wikiPages)
        .where(and(inArray(wikiPages.id, named), isNull(wikiPages.deletedAt)))
    : [];
  const found = await searchPages(deps, input.orgId, input.text, 5).catch(() => [] as PageRow[]);
  const budget = input.budgetChars ?? 6000;
  const lines: string[] = [];
  const ids: string[] = [];
  let used = 0;
  for (const p of [...namedRows, ...found]) {
    if (ids.includes(p.id)) continue;
    const room = Math.min(2500, budget - used);
    if (room < 300) break;
    const body = p.body.trim();
    const text = `## [[${p.title}]] (${p.folder ? `${p.folder}/` : ""}${p.slug}, v${p.version})\n${body.length > room ? `${body.slice(0, room)}\n[… continua: leia com read_wiki_page]` : body}`;
    lines.push(text);
    ids.push(p.id);
    used += text.length;
  }
  return { text: lines.join("\n\n"), pageIds: ids };
}

// ── Search index ─────────────────────────────────────────────────────────────

registerDocumentBuilder("wiki", async (db, orgId, id) => {
  const [p] = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.id, id), eq(wikiPages.orgId, orgId)));
  if (!p || p.deletedAt) return null;
  return {
    orgId,
    kind: "wiki",
    sourceId: p.id,
    // The whole org reads the wiki.
    channelIds: [],
    title: `${p.folder ? `${p.folder}/` : ""}${p.title}`,
    body: [p.tags.length ? `#${p.tags.join(" #")}` : "", p.body].filter(Boolean).join("\n").slice(0, 20_000),
    createdAt: p.createdAt,
  };
});

registerReindexSource("wiki", async (db, orgId) =>
  (
    await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), isNull(wikiPages.deletedAt)))
  ).map((r) => r.id),
);
