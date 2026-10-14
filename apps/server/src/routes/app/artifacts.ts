import {
  type ArtifactDeps,
  artifactDownload,
  artifactFile,
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  listArtifactVersions,
  updateArtifact,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
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
const Kind = z.enum(["document", "table", "diff", "html", "diagram"]);
const Author = z.object({ type: z.enum(["agent", "person"]), id: z.string() });

const Content = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("document"), markdown: z.string() }),
    z.object({ kind: z.literal("table"), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
    z.object({ kind: z.literal("diff"), files: z.array(z.object({ path: z.string(), patch: z.string() })) }),
    z.object({ kind: z.literal("diagram"), mermaid: z.string() }),
    z.object({ kind: z.literal("html"), html: z.string() }),
  ])
  .openapi("ArtifactContent");

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
    untrusted: z.boolean().openapi({ description: "HTML: render only in a sandboxed iframe on another origin." }),
  })
  .openapi("Artifact");

const ArtifactDetail = Artifact.extend({ shownVersion: z.number(), content: Content }).openapi("ArtifactDetail");

const ArtifactParams = OrgParams.extend({ artifactId: z.uuid() });
const VersionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

/**
 * The Drive: files people and agents make (documents, tables, diffs, HTML
 * pages, diagrams), visible like the channel they came from. Content lives
 * in the org's storage; downloads are short-lived signed links.
 */
export function artifactRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
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
          z.object({ title: z.string().min(1).max(200), channelId: z.uuid().nullable().optional(), content: Content }),
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
      summary: "Save a new version (documents and tables); a stale baseVersion is 409",
      request: {
        params: ArtifactParams,
        body: body(
          z.object({
            content: Content,
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

  // The bytes, always as an attachment (HTML is never rendered on our origin).
  app.get("/organizations/:orgId/artifacts/:artifactId/file", async (c) => {
    const version = c.req.query("version");
    const format = c.req.query("format");
    const file = await artifactFile(artifacts(), c.get("user").id, c.req.param("orgId"), c.req.param("artifactId"), {
      version: version ? Number(version) : undefined,
      format: format === "csv" || format === "patch" ? format : undefined,
    });
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="${file.filename}"`,
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
      summary: "Delete a file (its creator or an admin)",
      request: { params: ArtifactParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      await deleteArtifact(artifacts(), c.get("user").id, orgId, artifactId);
      return c.body(null, 204);
    },
  );

  return app;
}
