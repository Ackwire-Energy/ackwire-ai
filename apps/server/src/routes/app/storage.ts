import type { Config } from "@agenteschat/config";
import {
  getMigration,
  getStorage,
  type StorageDeps,
  saveStorage,
  startMigration,
  testStorage,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { installMode } from "../../telemetry";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Storage"];

const S3Input = z
  .object({
    endpoint: z.string().min(1).max(500),
    region: z.string().max(64),
    bucket: z.string().min(1).max(63),
    prefix: z.string().max(200).nullable(),
    pathStyle: z.boolean(),
    accessKeyId: z.string().max(200).optional(),
    secretAccessKey: z.string().max(500).optional(),
  })
  .openapi("S3Input", { description: "Empty keys = keep the stored ones." });

const Migration = z
  .object({
    status: z.enum(["running", "failed", "done"]),
    copied: z.number(),
    total: z.number(),
    error: z.string().nullable(),
  })
  .openapi("StorageMigration");

const StorageConfig = z
  .object({
    kind: z.enum(["agentes", "s3"]),
    s3: z
      .object({
        endpoint: z.string(),
        region: z.string(),
        bucket: z.string(),
        prefix: z.string().nullable(),
        pathStyle: z.boolean(),
        accessKeyIdHint: z.string(),
        secretHint: z.string(),
      })
      .nullable(),
    migration: Migration.nullable(),
    platform: z
      .object({ kind: z.enum(["disk", "database", "bucket"]), folder: z.string().nullable() })
      .openapi("StoragePlatform", {
        description:
          "Where this server keeps the files of organizations without a bucket of their own. `folder`: the disk's folder, only where the server isn't in a container.",
      }),
  })
  .openapi("StorageConfig");

/** The server's own store as people read it (its disk, database or bucket), and its folder where that path is theirs. */
export function storagePlatform(
  storeKind: string,
  config: Pick<Config, "FILES_DIR" | "INSTALL_MODE">,
  container?: boolean,
): { kind: "disk" | "database" | "bucket"; folder: string | null } {
  const kind = storeKind === "postgres" ? "database" : storeKind === "s3" ? "bucket" : "disk";
  // Inside Docker the path is the container's, which nobody on the host could open.
  const folder = kind === "disk" && installMode(config, container) !== "docker" ? (config.FILES_DIR ?? null) : null;
  return { kind, folder };
}

const TestResult = z
  .object({
    ok: z.boolean(),
    steps: z.array(
      z.object({ step: z.enum(["write", "read", "list", "delete"]), ok: z.boolean(), error: z.string().nullable() }),
    ),
  })
  .openapi("StorageTestResult");

/**
 * Where an organization's files live (admins): platform storage or its own
 * S3-compatible bucket. Keys are never returned, only hints; switching on a
 * bucket needs a passing test; every change is audited.
 */
export function storageRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const storage = (): StorageDeps => {
    const s = deps.extras?.storage;
    if (!s) throw new Error("storage is not configured on this server");
    return s;
  };
  const platform = storagePlatform(deps.adapters.platformBlobs.kind, deps.config);

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/storage",
      tags,
      security,
      summary: "Current file storage (keys as hints only)",
      request: { params: OrgParams },
      responses: { 200: json(StorageConfig), ...errors },
    }),
    async (c) => c.json({ ...(await getStorage(db, c.get("user").id, c.req.valid("param").orgId)), platform }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/storage/test",
      tags,
      security,
      summary: "Check a bucket: write, read, list and delete a small test object",
      request: { params: OrgParams, body: body(S3Input) },
      responses: { 200: json(TestResult), ...errors },
    }),
    async (c) => {
      const result = await testStorage(storage(), c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/storage",
      tags,
      security,
      summary: "Switch storage: back to agentes, or to a bucket that passed the test",
      request: {
        params: OrgParams,
        body: body(
          z.union([
            z.object({ kind: z.enum(["agentes", "platform"]) }),
            z.object({ kind: z.literal("s3"), s3: S3Input }),
          ]),
        ),
      },
      responses: { 200: json(StorageConfig), ...errors },
    }),
    async (c) => {
      const saved = await saveStorage(storage(), c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json({ ...saved, platform }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/storage/migrate",
      tags,
      security,
      summary: "Copy existing files to the current storage (starts or resumes)",
      request: { params: OrgParams },
      responses: { 200: json(Migration), ...errors },
    }),
    async (c) => {
      const migration = await startMigration(storage(), c.get("user").id, c.req.valid("param").orgId);
      deps.wakeWorkers?.();
      return c.json(migration, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/storage/migration",
      tags,
      security,
      summary: "Progress of the latest copy (null if none)",
      request: { params: OrgParams },
      responses: { 200: json(Migration.nullable()), ...errors },
    }),
    async (c) => c.json(await getMigration(db, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  return app;
}
