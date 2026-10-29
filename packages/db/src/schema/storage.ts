import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * Platform blob storage in Postgres: the fallback when the deployment has
 * neither a bucket (S3_*) nor a folder on disk (FILES_DIR). Keys start with
 * `orgs/{org_id}/` or `org-logos/{org_id}/` (the row carries that org and is
 * deleted with it) or `avatars/{user_id}/` (a person's photo, shown in every
 * org they are in, so org_id is null). Content is base64 (artifacts are
 * small; big files belong in a bucket).
 */
export const blobs = pgTable(
  "blobs",
  {
    key: text().primaryKey(),
    orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
    contentType: text().notNull(),
    size: integer().notNull(),
    content: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);

/** `s3` = the org's own S3-compatible bucket. Planned: `google_drive`, `onedrive` (OAuth into a folder). */
export const storageKindEnum = pgEnum("storage_kind", ["s3", "google_drive", "onedrive"]);
/**
 * `tested`: passed the probe, waiting to be switched on; `failed`: the probe
 * failed; `active`: where new files go (one per org; none = platform storage);
 * `inactive`: replaced, still read for the files written to it.
 */
export const storageStatusEnum = pgEnum("storage_status", ["tested", "failed", "active", "inactive"]);

/**
 * An organization's own storage. Rows are never edited after the probe: new
 * settings are a new row, so every stored object keeps pointing at the
 * settings it was written with. The secret is envelope-encrypted like
 * provider keys and bound to (org_id, id); only hints come back.
 */
export const storageConfigs = pgTable(
  "storage_configs",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: storageKindEnum().notNull(),
    /** `s3`: `{ endpoint, region, bucket, prefix, pathStyle, accessKeyId }` (no secret). */
    options: jsonb().$type<Record<string, unknown>>().notNull(),
    secretCiphertext: text(),
    wrappedDataKey: text(),
    kekId: text(),
    accessKeyHint: text().notNull().default(""),
    secretHint: text().notNull().default(""),
    /** SHA-256 of the settings and keys, to match a save with the test that passed. */
    fingerprint: text().notNull(),
    status: storageStatusEnum().notNull(),
    lastError: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orgId, t.status),
    uniqueIndex("storage_configs_one_active").on(t.orgId).where(sql`${t.status} = 'active'`),
  ],
);

export const storageMigrationStatusEnum = pgEnum("storage_migration_status", ["running", "failed", "done"]);

/**
 * Copying an org's existing objects to its current storage (admin-started
 * job `storage.migrate`). Resumable: objects already at the target are
 * skipped, and `cursor` remembers how far it got.
 */
export const storageMigrations = pgTable(
  "storage_migrations",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Target; null = platform storage. */
    toStorageConfigId: uuid(),
    status: storageMigrationStatusEnum().notNull().default("running"),
    copied: integer().notNull().default(0),
    total: integer().notNull().default(0),
    /** Last artifact version id copied (ids are time-ordered). */
    cursor: uuid(),
    error: text(),
    startedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.createdAt)],
);

/**
 * Who changed what (storage settings, artifacts…). Append-only; read by
 * admins.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `person`, `agent` or `system`. */
    actorType: text().notNull(),
    actorId: text(),
    /** e.g. `storage.activated`, `artifact.version_created`. */
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: text(),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.createdAt)],
);

export const artifactKindEnum = pgEnum("artifact_kind", ["document", "table", "diff", "html", "diagram", "file"]);

/**
 * Files people and agents make (Drive): documents, tables, diffs, HTML
 * pages, diagrams, and binary files as is (`file`, ADR 0025). Visibility comes from the channel of origin (null =
 * the whole organization). Content lives in the blob store, one object per
 * version (`artifact_versions`).
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: artifactKindEnum().notNull(),
    title: text().notNull(),
    channelId: uuid(),
    threadId: uuid(),
    /** `html` is always untrusted: the app renders it only in a sandboxed iframe on another origin. */
    untrusted: boolean().notNull().default(false),
    /** Text for search (first part of the latest version). */
    excerpt: text().notNull().default(""),
    currentVersion: integer().notNull().default(1),
    createdByType: text().notNull(),
    createdById: text().notNull(),
    updatedByType: text().notNull(),
    updatedById: text().notNull(),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.updatedAt), index().on(t.channelId)],
);

/** One saved version of an artifact: where its bytes are, who made it and why. */
export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    artifactId: uuid()
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    /** The storage it was written to (null = platform). Never changes except by a migration. */
    storageConfigId: uuid(),
    blobKey: text().notNull(),
    contentType: text().notNull(),
    size: integer().notNull(),
    sha256: text().notNull(),
    /** `file` versions: the original file name (`report.pdf`). */
    fileName: text(),
    note: text(),
    authorType: text().notNull(),
    authorId: text().notNull(),
    runId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.artifactId, t.version), index().on(t.orgId, t.storageConfigId)],
);

/**
 * A one-time upload of a file from an agent's computer to the Drive
 * (`upload_file`, ADR 0025): pending until the machine pushes the bytes
 * (`PUT /api/machines/uploads/{id}`), then `done` with the artifact and
 * version it became. Expires after 10 minutes.
 */
export const artifactUploads = pgTable(
  "artifact_uploads",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    runId: uuid(),
    /** The run's channel and thread: completion acts as the agent there. */
    channelId: uuid().notNull(),
    threadId: uuid(),
    /** `machine:<machine id>`. */
    computer: text().notNull(),
    /** Only this machine may complete it. */
    machineId: uuid(),
    /** Workspace-relative path on the computer. */
    path: text().notNull(),
    title: text(),
    note: text(),
    /** Set: the upload is a new version of this `file` artifact. */
    targetArtifactId: uuid(),
    /** `pending`, `storing` (bytes arrived, being saved), `done` or `failed`. */
    status: text().notNull().default("pending"),
    maxBytes: integer().notNull(),
    artifactId: uuid(),
    version: integer(),
    error: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.orgId, t.createdAt),
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
  ],
);
