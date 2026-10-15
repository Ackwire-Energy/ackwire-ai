import { createHash } from "node:crypto";
import type { BlobStoreResolver, PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, gte, inArray, isNull, or, rowsOf, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { markdownToDocx } from "./docx";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { can, getMembership } from "./organizations";
import { markdownToPdf } from "./pdf";
import { agentSearchChannels, enqueueIndex, registerDocumentBuilder } from "./search";

const { artifacts, artifactVersions, channels, channelMembers } = schema;

export type ArtifactKind = "document" | "table" | "diff" | "html" | "diagram";
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["document", "table", "diff", "html", "diagram"];

export type ArtifactContent =
  | { kind: "document"; markdown: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "diff"; files: { path: string; patch: string }[] }
  | { kind: "diagram"; mermaid: string }
  | { kind: "html"; html: string };

export interface ArtifactAuthor {
  type: "agent" | "person";
  id: string;
}

/** An artifact as the app lists it. */
export interface ArtifactView {
  id: string;
  kind: ArtifactKind;
  title: string;
  version: number;
  channelId: string | null;
  threadId: string | null;
  createdBy: ArtifactAuthor;
  updatedBy: ArtifactAuthor;
  createdAt: string;
  updatedAt: string;
  /** The viewer may save new versions (documents and tables). */
  canEdit: boolean;
  /** HTML pages: render only in a sandboxed iframe on another origin, never inline. */
  untrusted: boolean;
}

export interface ArtifactDetailView extends ArtifactView {
  shownVersion: number;
  content: ArtifactContent;
}

export interface ArtifactVersionView {
  version: number;
  author: ArtifactAuthor;
  note: string | null;
  createdAt: string;
}

/** Who acts: a person, or an agent during a run in a channel. */
export type ArtifactActor =
  | { type: "person"; userId: string }
  | { type: "agent"; agentId: string; channelId: string; threadId?: string | null; runId?: string | null };

export interface ArtifactDeps {
  db: Database;
  blobs: BlobStoreResolver;
  pubsub?: PubSub;
}

/** Limits per kind (bytes are UTF-8 of the stored form). */
export const ARTIFACT_LIMITS = {
  titleChars: 200,
  documentBytes: 1_000_000,
  htmlBytes: 2_000_000,
  diagramBytes: 200_000,
  tableRows: 10_000,
  tableColumns: 100,
  cellChars: 10_000,
  tableBytes: 5_000_000,
  diffFiles: 500,
  diffBytes: 2_000_000,
};

type ArtifactRow = typeof artifacts.$inferSelect;
type VersionRow = typeof artifactVersions.$inferSelect;

const sha256Hex = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Checks kind, shape and size; returns a clean copy. */
export function validateContent(raw: unknown): ArtifactContent {
  const c = (raw ?? {}) as Record<string, unknown>;
  const tooBig = (what: string) => new ValidationError(`${what} is too large`);
  switch (c.kind) {
    case "document": {
      if (typeof c.markdown !== "string") throw new ValidationError("document needs markdown");
      if (bytes(c.markdown) > ARTIFACT_LIMITS.documentBytes) throw tooBig("document");
      return { kind: "document", markdown: c.markdown };
    }
    case "html": {
      if (typeof c.html !== "string") throw new ValidationError("html needs html");
      if (bytes(c.html) > ARTIFACT_LIMITS.htmlBytes) throw tooBig("html page");
      return { kind: "html", html: c.html };
    }
    case "diagram": {
      if (typeof c.mermaid !== "string") throw new ValidationError("diagram needs mermaid source");
      if (bytes(c.mermaid) > ARTIFACT_LIMITS.diagramBytes) throw tooBig("diagram");
      return { kind: "diagram", mermaid: c.mermaid };
    }
    case "table": {
      const columns = c.columns;
      if (!isStringArray(columns) || columns.length === 0) throw new ValidationError("table needs columns");
      if (!Array.isArray(c.rows) || !c.rows.every(isStringArray)) throw new ValidationError("table rows: text cells");
      const rows = c.rows as string[][];
      if (columns.length > ARTIFACT_LIMITS.tableColumns || rows.length > ARTIFACT_LIMITS.tableRows) {
        throw tooBig("table");
      }
      const badCell = (r: string[]) => r.length > columns.length || r.some((x) => x.length > ARTIFACT_LIMITS.cellChars);
      if (rows.some(badCell)) throw new ValidationError("table rows: too many cells, or a cell is too long");
      const table: ArtifactContent = { kind: "table", columns: [...columns], rows: rows.map((r) => [...r]) };
      if (bytes(JSON.stringify(table)) > ARTIFACT_LIMITS.tableBytes) throw tooBig("table");
      return table;
    }
    case "diff": {
      const files = c.files;
      const ok = (f: unknown) => {
        const file = f as Record<string, unknown>;
        return typeof file?.path === "string" && file.path.length > 0 && typeof file.patch === "string";
      };
      if (!Array.isArray(files) || files.length === 0 || !files.every(ok)) {
        throw new ValidationError("diff needs files with path and patch");
      }
      if (files.length > ARTIFACT_LIMITS.diffFiles) throw tooBig("diff");
      const clean = (files as { path: string; patch: string }[]).map((f) => ({ path: f.path, patch: f.patch }));
      if (bytes(JSON.stringify(clean)) > ARTIFACT_LIMITS.diffBytes) throw tooBig("diff");
      return { kind: "diff", files: clean };
    }
    default:
      throw new ValidationError(`kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
  }
}

/** How each kind is stored: documents, pages and diagrams as text; tables and diffs as JSON. */
function encode(content: ArtifactContent): { body: Uint8Array; contentType: string } {
  const text = (s: string, contentType: string) => ({ body: new TextEncoder().encode(s), contentType });
  switch (content.kind) {
    case "document":
      return text(content.markdown, "text/markdown; charset=utf-8");
    case "html":
      return text(content.html, "text/html; charset=utf-8");
    case "diagram":
      return text(content.mermaid, "text/plain; charset=utf-8");
    case "table":
      return text(JSON.stringify({ columns: content.columns, rows: content.rows }), "application/json");
    case "diff":
      return text(JSON.stringify({ files: content.files }), "application/json");
  }
}

function decode(kind: ArtifactKind, body: Uint8Array): ArtifactContent {
  const s = new TextDecoder().decode(body);
  switch (kind) {
    case "document":
      return { kind, markdown: s };
    case "html":
      return { kind, html: s };
    case "diagram":
      return { kind, mermaid: s };
    case "table": {
      const t = JSON.parse(s) as { columns: string[]; rows: string[][] };
      return { kind, columns: t.columns, rows: t.rows };
    }
    case "diff":
      return { kind, files: (JSON.parse(s) as { files: { path: string; patch: string }[] }).files };
  }
}

const EXTENSIONS: Record<ArtifactKind, string> = {
  document: "md",
  html: "html",
  diagram: "mmd",
  table: "json",
  diff: "json",
};

/** Plain text for search: what a person would look for in the file. */
function excerptOf(content: ArtifactContent): string {
  const s =
    content.kind === "document"
      ? content.markdown
      : content.kind === "html"
        ? content.html.replace(/<[^>]+>/g, " ")
        : content.kind === "diagram"
          ? content.mermaid
          : content.kind === "table"
            ? [content.columns.join(" "), ...content.rows.map((r) => r.join(" "))].join("\n")
            : content.files.map((f) => f.path).join("\n");
  return s.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

/** CSV with RFC 4180 quoting. */
export function tableToCsv(columns: string[], rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/** A Markdown table (for PDF export of tables). */
function tableToMarkdown(columns: string[], rows: string[][]): string {
  const cell = (v: string) => v.replace(/\|/g, "/").replace(/\n/g, " ");
  const line = (r: string[]) => `| ${columns.map((_, i) => cell(r[i] ?? "")).join(" | ")} |`;
  return [line(columns), `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n");
}

/** One unified patch with `diff --git` headers per file. */
export function diffToPatch(files: { path: string; patch: string }[]): string {
  return files.map((f) => `diff --git a/${f.path} b/${f.path}\n${f.patch.replace(/\n?$/, "\n")}`).join("");
}

// ── Access ───────────────────────────────────────────────────────────────────

async function personCanRead(db: Database, userId: string, orgId: string, a: Pick<ArtifactRow, "channelId">) {
  if (!a.channelId) return true;
  const [row] = await db
    .select({ visibility: channels.visibility, kind: channels.kind, memberId: channelMembers.id })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)))
    .where(and(eq(channels.id, a.channelId), eq(channels.orgId, orgId)));
  if (!row) return false;
  return row.memberId !== null || (row.visibility === "public" && row.kind === "channel");
}

async function canRead(db: Database, actor: ArtifactActor, orgId: string, a: Pick<ArtifactRow, "channelId">) {
  if (actor.type === "person") return personCanRead(db, actor.userId, orgId, a);
  if (!a.channelId) return true;
  return (await agentSearchChannels(db, orgId, actor.agentId, actor.channelId)).includes(a.channelId);
}

async function requireMember(db: Database, actor: ArtifactActor, orgId: string) {
  if (actor.type !== "person") return null;
  const membership = await getMembership(db, actor.userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  return membership;
}

const authorOf = (actor: ArtifactActor): ArtifactAuthor =>
  actor.type === "person" ? { type: "person", id: actor.userId } : { type: "agent", id: actor.agentId };

function view(a: ArtifactRow, canEdit: boolean): ArtifactView {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    version: a.currentVersion,
    channelId: a.channelId,
    threadId: a.threadId,
    createdBy: { type: a.createdByType as ArtifactAuthor["type"], id: a.createdById },
    updatedBy: { type: a.updatedByType as ArtifactAuthor["type"], id: a.updatedById },
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    canEdit,
    untrusted: a.untrusted,
  };
}

const editableKind = (kind: ArtifactKind) => kind === "document" || kind === "table";

async function loadArtifact(db: Database, orgId: string, id: string) {
  const [a] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt)));
  return a ?? null;
}

async function readable(deps: ArtifactDeps, actor: ArtifactActor, orgId: string, id: string) {
  await requireMember(deps.db, actor, orgId);
  const a = await loadArtifact(deps.db, orgId, id);
  // Not visible = not found: don't reveal files of channels you can't see.
  if (!a || !(await canRead(deps.db, actor, orgId, a))) throw new NotFoundError("Artifact not found");
  return a;
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function writeBlob(deps: ArtifactDeps, orgId: string, artifactId: string, version: number, c: ArtifactContent) {
  const location = await deps.blobs.forOrg(orgId);
  const { body, contentType } = encode(c);
  const key = `${location.prefix}artifacts/${artifactId}/v${version}`;
  await location.store.put(key, body, { contentType });
  return { storageConfigId: location.storageConfigId, key, contentType, size: body.byteLength, sha: sha256Hex(body) };
}

/**
 * Creates an artifact (version 1). People create in the Drive (no channel:
 * the whole org sees it) or in a channel they belong to; agents create in
 * the channel and thread of their run. `html` is stored as is and marked
 * untrusted.
 */
export async function createArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  input: { title: string; content: unknown; channelId?: string | null; threadId?: string | null },
): Promise<ArtifactDetailView> {
  const { db } = deps;
  const membership = await requireMember(db, actor, orgId);
  if (membership && !can(membership.role, "post")) throw new ForbiddenError();
  const title = input.title.trim().slice(0, ARTIFACT_LIMITS.titleChars);
  if (!title) throw new ValidationError("title is required");
  const content = validateContent(input.content);
  const channelId = actor.type === "agent" ? actor.channelId : (input.channelId ?? null);
  const threadId = actor.type === "agent" ? (actor.threadId ?? null) : (input.threadId ?? null);
  if (channelId && actor.type === "person" && !(await personCanRead(db, actor.userId, orgId, { channelId }))) {
    throw new NotFoundError("Channel not found");
  }
  const id = Bun.randomUUIDv7();
  const blob = await writeBlob(deps, orgId, id, 1, content);
  const author = authorOf(actor);
  const row = await db.transaction(async (tx) => {
    const [a] = await tx
      .insert(artifacts)
      .values({
        id,
        orgId,
        kind: content.kind,
        title,
        channelId,
        threadId,
        untrusted: content.kind === "html",
        excerpt: excerptOf(content),
        currentVersion: 1,
        createdByType: author.type,
        createdById: author.id,
        updatedByType: author.type,
        updatedById: author.id,
      })
      .returning();
    if (!a) throw new Error("artifact insert returned nothing");
    await tx.insert(artifactVersions).values({
      orgId,
      artifactId: id,
      version: 1,
      storageConfigId: blob.storageConfigId,
      blobKey: blob.key,
      contentType: blob.contentType,
      size: blob.size,
      sha256: blob.sha,
      note: null,
      authorType: author.type,
      authorId: author.id,
      runId: actor.type === "agent" ? (actor.runId ?? null) : null,
    });
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: id });
    await recordAudit(tx, {
      orgId,
      actor: author,
      action: "artifact.created",
      target: { type: "artifact", id },
      details: { kind: content.kind, version: 1, size: blob.size },
    });
    return a;
  });
  const artifact = view(row, editableKind(row.kind));
  if (row.channelId) {
    await publishChannelEvent(deps.pubsub, { type: "artifact.created", channelId: row.channelId, artifact });
  }
  return { ...artifact, shownVersion: 1, content };
}

/**
 * Saves a new version (always; old versions stay). People pass the version
 * they edited (`baseVersion`): a newer one in between is a conflict (409).
 */
export async function updateArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
  input: { content: unknown; note?: string | null; baseVersion?: number; title?: string },
): Promise<ArtifactDetailView> {
  const { db } = deps;
  const current = await readable(deps, actor, orgId, artifactId);
  const content = validateContent(input.content);
  if (content.kind !== current.kind) throw new ValidationError(`this artifact is a ${current.kind}`);
  if (actor.type === "person" && !editableKind(current.kind)) {
    throw new ForbiddenError("Only documents and tables can be edited here");
  }
  if (input.baseVersion !== undefined && input.baseVersion !== current.currentVersion) {
    throw new ConflictError("Someone saved a newer version; reload and try again");
  }
  const version = current.currentVersion + 1;
  const blob = await writeBlob(deps, orgId, artifactId, version, content);
  const author = authorOf(actor);
  const title = input.title?.trim().slice(0, ARTIFACT_LIMITS.titleChars) || current.title;
  const note = input.note?.trim().slice(0, 500) || null;
  const row = await db.transaction(async (tx) => {
    const [a] = await tx
      .update(artifacts)
      .set({
        currentVersion: version,
        title,
        excerpt: excerptOf(content),
        updatedByType: author.type,
        updatedById: author.id,
        updatedAt: new Date(),
      })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.currentVersion, current.currentVersion)))
      .returning();
    if (!a) throw new ConflictError("Someone saved a newer version; reload and try again");
    await tx.insert(artifactVersions).values({
      orgId,
      artifactId,
      version,
      storageConfigId: blob.storageConfigId,
      blobKey: blob.key,
      contentType: blob.contentType,
      size: blob.size,
      sha256: blob.sha,
      note,
      authorType: author.type,
      authorId: author.id,
      runId: actor.type === "agent" ? (actor.runId ?? null) : null,
    });
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: artifactId });
    await recordAudit(tx, {
      orgId,
      actor: author,
      action: "artifact.version_created",
      target: { type: "artifact", id: artifactId },
      details: { version, size: blob.size, note },
    });
    return a;
  });
  const artifact = view(row, editableKind(row.kind));
  if (row.channelId) {
    await publishChannelEvent(deps.pubsub, { type: "artifact.updated", channelId: row.channelId, artifact });
  }
  return { ...artifact, shownVersion: version, content };
}

async function versionRow(db: Database, a: ArtifactRow, version?: number) {
  const [v] = await db
    .select()
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, a.id), eq(artifactVersions.version, version ?? a.currentVersion)));
  if (!v) throw new NotFoundError("Version not found");
  return v;
}

async function readVersion(deps: ArtifactDeps, a: ArtifactRow, v: VersionRow) {
  const store = await deps.blobs.forConfig(a.orgId, v.storageConfigId);
  const object = await store.get(v.blobKey);
  if (!object) throw new NotFoundError("The stored file is missing");
  return object;
}

/** One artifact at `version` (default: latest), with content. */
export async function getArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
  version?: number,
): Promise<ArtifactDetailView> {
  const a = await readable(deps, actor, orgId, artifactId);
  const v = await versionRow(deps.db, a, version);
  const object = await readVersion(deps, a, v);
  return { ...view(a, editableKind(a.kind)), shownVersion: v.version, content: decode(a.kind, object.body) };
}

export async function listArtifactVersions(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
): Promise<ArtifactVersionView[]> {
  const a = await readable(deps, actor, orgId, artifactId);
  const rows = await deps.db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, a.id))
    .orderBy(desc(artifactVersions.version));
  return rows.map((v) => ({
    version: v.version,
    author: { type: v.authorType as ArtifactAuthor["type"], id: v.authorId },
    note: v.note,
    createdAt: v.createdAt.toISOString(),
  }));
}

/**
 * Everything the actor can see, newest update first: org-wide files, files
 * of channels they belong to, and of public channels (people).
 */
export async function listArtifacts(
  db: Database,
  actor: ArtifactActor,
  orgId: string,
  filters: {
    q?: string;
    kind?: ArtifactKind;
    channelId?: string;
    author?: ArtifactAuthor;
    limit?: number;
    /** Updated at or after this time. */
    since?: Date;
    /** Agents: also the conversations this person shares with the agent (see `requesterSharedChannels`). */
    requesterUserId?: string | null;
  } = {},
): Promise<ArtifactView[]> {
  await requireMember(db, actor, orgId);
  let visible: string[];
  if (actor.type === "agent") {
    visible = await agentSearchChannels(db, orgId, actor.agentId, actor.channelId);
    if (filters.requesterUserId) {
      const shared = await requesterSharedChannels(db, orgId, actor.agentId, filters.requesterUserId);
      visible = [...new Set([...visible, ...shared])];
    }
  } else {
    const member = and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, actor.userId));
    const open = and(eq(channels.visibility, "public"), eq(channels.kind, "channel"));
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .leftJoin(channelMembers, member)
      .where(and(eq(channels.orgId, orgId), or(sql`${channelMembers.id} is not null`, open)));
    visible = rows.map((r) => r.id);
  }
  const q = filters.q?.trim();
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, orgId),
        isNull(artifacts.deletedAt),
        visible.length > 0
          ? or(isNull(artifacts.channelId), inArray(artifacts.channelId, visible))
          : isNull(artifacts.channelId),
        filters.kind ? eq(artifacts.kind, filters.kind) : undefined,
        filters.channelId ? eq(artifacts.channelId, filters.channelId) : undefined,
        filters.since ? gte(artifacts.updatedAt, filters.since) : undefined,
        filters.author
          ? and(eq(artifacts.createdByType, filters.author.type), eq(artifacts.createdById, filters.author.id))
          : undefined,
        q ? sql`(${artifacts.title} ilike ${`%${q}%`} or ${artifacts.excerpt} ilike ${`%${q}%`})` : undefined,
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
    .limit(Math.min(200, filters.limit ?? 100));
  return rows.map((a) => view(a, actor.type === "person" && editableKind(a.kind)));
}

/**
 * Conversations (channels and DMs, not archived) where both the agent and
 * this person are members: what the agent may look at on that person's
 * behalf, never more.
 */
export async function requesterSharedChannels(db: Database, orgId: string, agentId: string, userId: string) {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`select c.id from channels c
      where c.org_id = ${orgId}::uuid and c.archived_at is null
        and exists (select 1 from channel_members m where m.channel_id = c.id and m.agent_id = ${agentId}::uuid)
        and exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = ${userId})`),
  );
  return rows.map((r) => r.id);
}

/** Where artifacts came from, for agents picking one ("DM com Walter", "#general", "Drive"). */
export async function artifactOrigins(
  db: Database,
  orgId: string,
  list: Pick<ArtifactView, "channelId" | "createdBy">[],
) {
  const channelIds = [...new Set(list.flatMap((a) => (a.channelId ? [a.channelId] : [])))];
  const agentIds = [...new Set(list.flatMap((a) => (a.createdBy.type === "agent" ? [a.createdBy.id] : [])))];
  const userIds = [...new Set(list.flatMap((a) => (a.createdBy.type === "person" ? [a.createdBy.id] : [])))];
  const [chans, dmPeople, agentRows, userRows] = await Promise.all([
    channelIds.length
      ? db
          .select({ id: channels.id, kind: channels.kind, name: channels.name })
          .from(channels)
          .where(and(eq(channels.orgId, orgId), inArray(channels.id, channelIds)))
      : Promise.resolve([]),
    channelIds.length
      ? db
          .select({ channelId: channelMembers.channelId, name: schema.users.name })
          .from(channelMembers)
          .innerJoin(schema.users, eq(schema.users.id, channelMembers.userId))
          .where(inArray(channelMembers.channelId, channelIds))
      : Promise.resolve([]),
    agentIds.length
      ? db
          .select({ id: schema.agents.id, handle: schema.agents.handle })
          .from(schema.agents)
          .where(and(eq(schema.agents.orgId, orgId), inArray(schema.agents.id, agentIds)))
      : Promise.resolve([]),
    userIds.length
      ? db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, userIds))
      : Promise.resolve([]),
  ]);
  const channelLabel = new Map<string, string>(
    chans.map((c): [string, string] => {
      if (c.kind !== "dm") return [c.id, `#${c.name}`];
      const people = dmPeople.filter((p) => p.channelId === c.id).map((p) => p.name);
      return [c.id, people.length ? `DM com ${people.join(", ")}` : "DM"];
    }),
  );
  const creator = new Map<string, string>([
    ...agentRows.map((a) => [a.id, `@${a.handle}`] as [string, string]),
    ...userRows.map((u) => [u.id, u.name] as [string, string]),
  ]);
  return {
    origin: (a: Pick<ArtifactView, "channelId">) =>
      a.channelId ? (channelLabel.get(a.channelId) ?? "outra conversa") : "Drive (toda a organização)",
    creator: (a: Pick<ArtifactView, "createdBy">) => creator.get(a.createdBy.id) ?? a.createdBy.type,
  };
}

/**
 * An agent brings an artifact into its run's conversation (`share_artifact`):
 * allowed only when the person who asked can see where it came from (and the
 * agent was there too). Visible here already (same channel, org-wide or a
 * public channel): the same file is attached. From a DM or a private
 * channel: a copy is saved here, so the people here can open it; the
 * original stays where it was. Audited either way.
 */
export async function shareArtifact(
  deps: ArtifactDeps,
  actor: Extract<ArtifactActor, { type: "agent" }>,
  orgId: string,
  artifactId: string,
  input: { requesterUserId: string | null; note?: string | null },
): Promise<{ artifact: ArtifactView; copied: boolean; from: { channelId: string | null; kind: string | null } }> {
  const { db } = deps;
  const a = await loadArtifact(db, orgId, artifactId);
  if (!a) throw new NotFoundError("Artifact not found");
  const [origin] = a.channelId
    ? await db
        .select({ kind: channels.kind, visibility: channels.visibility })
        .from(channels)
        .where(and(eq(channels.id, a.channelId), eq(channels.orgId, orgId)))
    : [];
  const openHere =
    !a.channelId || a.channelId === actor.channelId || (origin?.kind === "channel" && origin.visibility === "public");
  if (!openHere) {
    // From a DM or a private channel: the requester and the agent must both be in it.
    const allowed =
      input.requesterUserId !== null &&
      (await requesterSharedChannels(db, orgId, actor.agentId, input.requesterUserId)).includes(a.channelId as string);
    // Not visible = not found: never reveal files of conversations the requester isn't in.
    if (!allowed) throw new NotFoundError("Artifact not found");
  }
  let shared: ArtifactView = view(a, editableKind(a.kind));
  let copied = false;
  if (!openHere) {
    const v = await versionRow(db, a, undefined);
    const content = decode(a.kind, (await readVersion(deps, a, v)).body);
    const copy = await createArtifact(deps, actor, orgId, { title: a.title, content });
    shared = copy;
    copied = true;
  }
  await recordAudit(db, {
    orgId,
    actor: { type: "agent", id: actor.agentId },
    action: "artifact.shared",
    target: { type: "artifact", id: a.id },
    details: {
      fromChannelId: a.channelId,
      toChannelId: actor.channelId,
      copyId: copied ? shared.id : null,
      requesterUserId: input.requesterUserId,
      note: input.note?.slice(0, 500) ?? null,
    },
  });
  return { artifact: shared, copied, from: { channelId: a.channelId, kind: origin?.kind ?? null } };
}

/** Deletes an artifact (its creator or an admin). Stored versions stay until purged. */
export async function deleteArtifact(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string) {
  const actor: ArtifactActor = { type: "person", userId };
  const membership = await requireMember(deps.db, actor, orgId);
  const a = await readable(deps, actor, orgId, artifactId);
  const creator = a.createdByType === "person" && a.createdById === userId;
  if (!creator && !(membership && can(membership.role, "configure"))) {
    throw new ForbiddenError("Only its creator or an admin can delete this");
  }
  await deps.db.transaction(async (tx) => {
    await tx.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, a.id));
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: a.id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "artifact.deleted",
      target: { type: "artifact", id: a.id },
    });
  });
}

const fileName = (a: ArtifactRow, version: number, ext: string) => {
  const slug =
    a.title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "arquivo";
  return `${slug}-v${version}.${ext}`;
};

export const DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * A short-lived download link, after the visibility check: a signed URL of
 * the bucket, or (stores that can't sign) our own streaming endpoint.
 */
export async function artifactDownload(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  version?: number,
): Promise<{ url: string; expiresAt: string }> {
  const a = await readable(deps, { type: "person", userId }, orgId, artifactId);
  const v = await versionRow(deps.db, a, version);
  const store = await deps.blobs.forConfig(orgId, v.storageConfigId);
  const filename = fileName(a, v.version, EXTENSIONS[a.kind]);
  const signed = await store.signedUrl(v.blobKey, { expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS, filename });
  const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString();
  const url = signed ?? `/api/app/organizations/${orgId}/artifacts/${artifactId}/file?version=${v.version}`;
  return { url, expiresAt };
}

/**
 * The stored bytes (streamed by the server), or an export: CSV for tables,
 * a `.patch` for diffs. Always an attachment; HTML is never served inline.
 */
export async function artifactFile(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  options: { version?: number; format?: "csv" | "patch" | "pdf" | "docx" } = {},
): Promise<{ body: Uint8Array; contentType: string; filename: string }> {
  const a = await readable(deps, { type: "person", userId }, orgId, artifactId);
  const v = await versionRow(deps.db, a, options.version);
  const object = await readVersion(deps, a, v);
  const content = decode(a.kind, object.body);
  if (options.format === "csv") {
    if (content.kind !== "table") throw new ValidationError("CSV export is for tables");
    const body = new TextEncoder().encode(tableToCsv(content.columns, content.rows));
    return { body, contentType: "text/csv; charset=utf-8", filename: fileName(a, v.version, "csv") };
  }
  if (options.format === "pdf" || options.format === "docx") {
    const markdown =
      content.kind === "document"
        ? content.markdown
        : content.kind === "table"
          ? tableToMarkdown(content.columns, content.rows)
          : null;
    if (markdown === null)
      throw new ValidationError(`${options.format.toUpperCase()} export is for documents and tables`);
    if (options.format === "docx") {
      return {
        body: markdownToDocx(markdown, { title: a.title }),
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: fileName(a, v.version, "docx"),
      };
    }
    const body = markdownToPdf(markdown, { title: a.title });
    return { body, contentType: "application/pdf", filename: fileName(a, v.version, "pdf") };
  }
  if (options.format === "patch") {
    if (content.kind !== "diff") throw new ValidationError("Patch export is for diffs");
    const body = new TextEncoder().encode(diffToPatch(content.files));
    return { body, contentType: "text/x-diff; charset=utf-8", filename: fileName(a, v.version, "patch") };
  }
  return { body: object.body, contentType: object.contentType, filename: fileName(a, v.version, EXTENSIONS[a.kind]) };
}

// Search: title and excerpt, visible like the channel it came from.
registerDocumentBuilder("file", async (db, orgId, id) => {
  const [a] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.orgId, orgId)));
  if (!a || a.deletedAt) return null;
  return {
    orgId,
    kind: "file",
    sourceId: a.id,
    channelIds: a.channelId ? [a.channelId] : [],
    title: a.title,
    body: a.excerpt,
    createdAt: a.createdAt,
  };
});
