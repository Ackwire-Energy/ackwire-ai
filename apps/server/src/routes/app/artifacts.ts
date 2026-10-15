import {
  ARTIFACT_LIMITS,
  type ArtifactDeps,
  addFileVersion,
  artifactDownload,
  artifactFile,
  attachmentDisposition,
  createArtifact,
  createFileArtifact,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  listArtifactVersions,
  listDeletedArtifacts,
  restoreArtifact,
  updateArtifact,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Drive"];
const Kind = z.enum(["document", "table", "diff", "html", "diagram", "file"]);
const Author = z.object({ type: z.enum(["agent", "person"]), id: z.string() });

const textContents = [
  z.object({ kind: z.literal("document"), markdown: z.string() }),
  z.object({ kind: z.literal("table"), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ kind: z.literal("diff"), files: z.array(z.object({ path: z.string(), patch: z.string() })) }),
  z.object({ kind: z.literal("diagram"), mermaid: z.string() }),
  z.object({ kind: z.literal("html"), html: z.string() }),
] as const;

/** What people send to create or edit: never a `file` (those are uploads). */
const ContentInput = z.discriminatedUnion("kind", [...textContents]).openapi("ArtifactContentInput");

const FileContent = z
  .object({
    kind: z.literal("file"),
    name: z.string().openapi({ description: "Original file name." }),
    contentType: z.string(),
    size: z.number().openapi({ description: "Bytes." }),
    sha256: z.string(),
    text: z.string().optional().openapi({ description: "Small UTF-8 text files only (≤ 40k characters)." }),
  })
  .openapi("ArtifactFileContent", {
    description: "An uploaded file as is: metadata only; the bytes come from the download link.",
  });

const Content = z.discriminatedUnion("kind", [...textContents, FileContent]).openapi("ArtifactContent");

/** A file upload (multipart): at most 50 MB. */
const fileField = z.any().openapi({ type: "string", format: "binary", description: "The file (≤ 50 MB)." });
/** Multipart overhead allowed on top of the file itself. */
const MULTIPART_SLACK_BYTES = 64 * 1024;
const multipart = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "multipart/form-data": { schema } },
});

const Artifact = z
  .object({
    id: z.uuid(),
    kind: Kind,
    title: z.string(),
    version: z.number(),
    channelId: z.uuid().nullable(),
    threadId: z.uuid().nullable(),
    createdBy: Author,
    updatedBy: Author,
    createdAt: z.string(),
    updatedAt: z.string(),
    canEdit: z.boolean(),
    untrusted: z.boolean().openapi({
      description:
        "HTML and files: never rendered on the app's origin (sandboxed iframe on another origin, or download).",
    }),
  })
  .openapi("Artifact");

const ArtifactDetail = Artifact.extend({ shownVersion: z.number(), content: Content }).openapi("ArtifactDetail");

const ArtifactParams = OrgParams.extend({ artifactId: z.uuid() });
const VersionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

/**
 * The Drive: files people and agents make (documents, tables, diffs, HTML
 * pages, diagrams, uploaded files), visible like the channel they came
 * from. Content lives in the org's storage; downloads are short-lived
 * signed links.
 */
export function artifactRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps, {
    multipart: (path) => /\/organizations\/[^/]+\/artifacts(\/[^/]+)?\/files$/.test(path),
  });
  app.use("/organizations/*", requireSession(deps.auth));
  // Uploads: refuse what is too large before reading the body.
  const sizeGuard = createMiddleware(async (c, next) => {
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > ARTIFACT_LIMITS.fileBytes + MULTIPART_SLACK_BYTES) {
      const maxMb = ARTIFACT_LIMITS.fileBytes / 1024 / 1024;
      return apiError(c, 413, "artifact.file_too_large", `The file is too large (max ${maxMb} MB)`, { maxMb });
    }
    return next();
  });
  app.use("/organizations/:orgId/artifacts/files", sizeGuard);
  app.use("/organizations/:orgId/artifacts/:artifactId/files", sizeGuard);
  /** The `file` field of an upload, checked, as bytes. */
  const uploaded = async (value: unknown) => {
    if (!(value instanceof File))
      throw new ValidationError("send the file in the field file", "artifact.file_required");
    if (value.size > ARTIFACT_LIMITS.fileBytes) {
      const maxMb = ARTIFACT_LIMITS.fileBytes / 1024 / 1024;
      throw new ValidationError(`the file is too large (max ${maxMb} MB)`, "artifact.file_too_large", { maxMb });
    }
    return { name: value.name, contentType: value.type || null, bytes: new Uint8Array(await value.arrayBuffer()) };
  };
  const artifacts = (): ArtifactDeps => {
    const a = deps.extras?.artifacts;
    if (!a) throw new Error("artifacts are not configured on this server");
    return a;
  };
  const person = (userId: string) => ({ type: "person" as const, userId });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/artifacts",
      tags,
      security,
      summary: "Files you can see, newest update first",
      request: {
        params: OrgParams,
        query: z.object({
          q: z.string().max(200).optional(),
          kind: Kind.optional(),
          channelId: z.uuid().optional(),
          authorType: z.enum(["agent", "person"]).optional(),
          authorId: z.string().optional(),
        }),
      },
      responses: { 200: json(z.object({ artifacts: z.array(Artifact) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const query = c.req.valid("query");
      const author = query.authorType && query.authorId ? { type: query.authorType, id: query.authorId } : undefined;
      const list = await listArtifacts(db, person(c.get("user").id), orgId, {
        q: query.q,
        kind: query.kind,
        channelId: query.channelId,
        author,
      });
      return c.json({ artifacts: list }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts",
      tags,
      security,
      summary: "Create a file (in the Drive, or in a channel you belong to)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            title: z.string().min(1).max(200),
            channelId: z.uuid().nullable().optional(),
            content: ContentInput,
          }),
        ),
      },
      responses: { 201: json(ArtifactDetail, "Created"), ...errors },
    }),
    async (c) => {
      const created = await createArtifact(
        artifacts(),
        person(c.get("user").id),
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/files",
      tags,
      security,
      summary: "Upload a file as is (any type, ≤ 50 MB) to the Drive, or to a channel you belong to",
      request: {
        params: OrgParams,
        body: multipart(
          z.object({
            file: fileField,
            title: z.string().max(200).optional().openapi({ description: "Default: the file name." }),
            channelId: z.uuid().optional(),
            threadId: z.uuid().optional(),
          }),
        ),
      },
      responses: { 201: json(ArtifactDetail, "Created"), 413: errorResponse("The file is too large"), ...errors },
    }),
    async (c) => {
      const form = c.req.valid("form");
      const file = await uploaded(form.file);
      const created = await createFileArtifact(artifacts(), person(c.get("user").id), c.req.valid("param").orgId, {
        ...file,
        title: form.title?.trim() || file.name,
        channelId: form.channelId ?? null,
        threadId: form.threadId ?? null,
      });
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/files",
      tags,
      security,
      summary: "Upload a new version of a file (≤ 50 MB)",
      request: {
        params: ArtifactParams,
        body: multipart(z.object({ file: fileField, note: z.string().max(500).optional() })),
      },
      responses: { 200: json(ArtifactDetail), 413: errorResponse("The file is too large"), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const form = c.req.valid("form");
      const file = await uploaded(form.file);
      const saved = await addFileVersion(artifacts(), person(c.get("user").id), orgId, artifactId, {
        ...file,
        note: form.note ?? null,
      });
      return c.json(saved, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/artifacts/{artifactId}",
      tags,
      security,
      summary: "A file at a version (default: latest), with content",
      request: { params: ArtifactParams, query: VersionQuery },
      responses: { 200: json(ArtifactDetail), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const { version } = c.req.valid("query");
      return c.json(await getArtifact(artifacts(), person(c.get("user").id), orgId, artifactId, version), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/artifacts/{artifactId}/versions",
      tags,
      security,
      summary: "Versions, newest first, with who made each and why",
      request: { params: ArtifactParams },
      responses: {
        200: json(
          z.object({
            versions: z.array(
              z.object({ version: z.number(), author: Author, note: z.string().nullable(), createdAt: z.string() }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const versions = await listArtifactVersions(artifacts(), person(c.get("user").id), orgId, artifactId);
      return c.json({ versions }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/versions",
      tags,
      security,
      summary: "Save a new version (documents and tables; files: upload to …/files); a stale baseVersion is 409",
      request: {
        params: ArtifactParams,
        body: body(
          z.object({
            content: ContentInput,
            note: z.string().max(500).nullable().optional(),
            baseVersion: z.number().int().min(1),
            title: z.string().min(1).max(200).optional(),
          }),
        ),
      },
      responses: { 200: json(ArtifactDetail), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const saved = await updateArtifact(artifacts(), person(c.get("user").id), orgId, artifactId, c.req.valid("json"));
      return c.json(saved, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/artifacts/{artifactId}/download",
      tags,
      security,
      summary: "A short-lived download link (signed by the bucket, or served by us)",
      request: { params: ArtifactParams, query: VersionQuery },
      responses: { 200: json(z.object({ url: z.string(), expiresAt: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const { version } = c.req.valid("query");
      return c.json(await artifactDownload(artifacts(), c.get("user").id, orgId, artifactId, version), 200);
    },
  );

  // The bytes, always as an attachment (HTML and uploaded files are never rendered on our origin).
  app.get("/organizations/:orgId/artifacts/:artifactId/file", async (c) => {
    const version = c.req.query("version");
    const format = c.req.query("format");
    const file = await artifactFile(artifacts(), c.get("user").id, c.req.param("orgId"), c.req.param("artifactId"), {
      version: version ? Number(version) : undefined,
      format: format === "csv" || format === "patch" || format === "pdf" || format === "docx" ? format : undefined,
    });
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-disposition": attachmentDisposition(file.filename),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, no-store",
      },
    });
  });

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/artifacts/{artifactId}",
      tags,
      security,
      summary:
        "Delete a file (who created it, who asked the agent, the agent's owner, or an admin). Restorable for 30 days",
      request: { params: ArtifactParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      await deleteArtifact(artifacts(), c.get("user").id, orgId, artifactId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/restore",
      tags,
      security,
      summary: "Restore a deleted file (within 30 days)",
      request: { params: ArtifactParams },
      responses: { 200: json(z.object({ id: z.uuid(), title: z.string() }).passthrough()), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      return c.json(await restoreArtifact(artifacts(), c.get("user").id, orgId, artifactId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/artifacts-trash",
      tags,
      security,
      summary: "Lixeira: files deleted in the last 30 days that I may restore",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            files: z.array(
              z.object({
                id: z.uuid(),
                title: z.string(),
                kind: z.string(),
                channelId: z.uuid().nullable(),
                createdBy: z.object({ type: z.enum(["person", "agent"]), id: z.string() }),
                deletedAt: z.string(),
                purgeAt: z.string().openapi({ description: "When its contents go for good." }),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ files: await listDeletedArtifacts(db, c.get("user").id, orgId) }, 200);
    },
  );

  return app;
}
