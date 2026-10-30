import {
  applyImport,
  attachmentDisposition,
  exportBundle,
  IMPORT_LIMITS,
  NEW_AGENT_DEFAULTS,
  NOTE_KINDS,
  readGithubImport,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Agents"];

const ImportedFiles = z
  .object({
    files: z.array(
      z.object({
        path: z.string().openapi({ description: "Relative to the linked folder, or the file's name." }),
        text: z.string(),
      }),
    ),
    skipped: z
      .array(z.string())
      .optional()
      .openapi({ description: "Files that fit the list but not the limits (200 files, 8 MB), not read." }),
  })
  .openapi("AgentImportFiles");

const Key = z.string().min(1).max(200);

/** Like the routines' schedule rule, but as other apps write it (nulls, no zone); the engine checks it. */
const BundleRule = z.object({
  freq: z.enum(["once", "hourly", "daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().optional(),
  byWeekday: z.array(z.string().max(8)).max(14).optional(),
  byMonthDay: z.array(z.number().int()).max(31).optional(),
  byMonth: z.array(z.number().int()).max(12).optional(),
  bySetPos: z
    .union([z.number().int(), z.array(z.number().int()).max(10)])
    .nullable()
    .optional(),
  time: z.string().max(5).optional(),
  times: z.array(z.string().max(5)).max(24).optional(),
  timezone: z.string().max(64).nullable().optional(),
  start: z.string().max(10).nullable().optional(),
  until: z.string().max(10).nullable().optional(),
  count: z.number().int().nullable().optional(),
});

/**
 * `MigrationBundle` (ADR 0055). Text may be longer than our limits (the
 * import cuts it and reports `trimmed`); these caps only bound the request.
 */
const Bundle = z
  .object({
    format: z.literal("agenteschat.bundle"),
    version: z.literal(1),
    source: z.object({
      app: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/),
      ref: z.string().min(1).max(500),
      name: z.string().max(1000),
      files: z.array(z.string().max(1000)).max(10_000),
    }),
    agents: z
      .array(
        z.object({
          key: Key,
          name: z.string().max(1000),
          handle: z.string().max(200),
          role: z.string().max(10_000),
          instructions: z.string().max(1_000_000),
          model: z.string().max(200).nullable(),
          appearance: z.object({
            color: z.string().max(40).optional(),
            eyes: z.string().max(40).optional(),
            accessory: z.string().max(40).optional(),
          }),
          skills: z.array(Key).max(IMPORT_LIMITS.skills),
        }),
      )
      .max(IMPORT_LIMITS.agents),
    skills: z.array(z.object({ key: Key, markdown: z.string().max(1_000_000) })).max(IMPORT_LIMITS.skills),
    channels: z
      .array(
        z.object({
          key: Key,
          name: z.string().max(200),
          topic: z.string().max(100_000),
          agents: z.array(z.object({ key: Key, autoReply: z.boolean() })).max(IMPORT_LIMITS.agents),
        }),
      )
      .max(IMPORT_LIMITS.channels),
    routines: z
      .array(
        z.object({
          key: Key,
          name: z.string().max(1000),
          agent: Key,
          prompt: z.string().max(100_000),
          channel: Key.nullable(),
          trigger: z.union([
            z.object({ cron: z.string().max(200), timezone: z.string().max(64).nullable() }),
            z.object({ rule: BundleRule }),
            z.object({ at: z.string().max(40) }),
          ]),
        }),
      )
      .max(IMPORT_LIMITS.routines),
    notes: z
      .array(
        z.object({
          key: Key,
          agent: Key.nullable(),
          kind: z.enum(NOTE_KINDS),
          title: z.string().max(10_000).optional(),
          content: z.string().max(100_000),
        }),
      )
      .max(IMPORT_LIMITS.notes),
    todo: z
      .array(
        z.object({
          kind: z.enum(["connection", "app", "secret", "model", "file"]),
          label: z.string().max(500),
          url: z.string().max(2000).optional(),
          agents: z.array(Key).max(IMPORT_LIMITS.agents),
        }),
      )
      .max(1000),
    leftOut: z.array(z.object({ kind: z.string().max(40), label: z.string().max(500) })).max(100_000),
  })
  .openapi("MigrationBundle");

const ImportPlan = z
  .object({
    items: z.array(
      z.object({
        kind: z.enum(["agent", "skill", "channel", "routine", "note"]),
        key: z.string(),
        label: z.string(),
        action: z.enum(["create", "update", "unchanged", "skip"]),
        reason: z
          .enum([
            "exists",
            "model_not_in_catalog",
            "invalid_skill",
            "schedule_unsupported",
            "schedule_in_past",
            "secret_like",
            "agent_not_picked",
            "channel_not_picked",
            "invalid",
            "failed",
          ])
          .optional()
          .openapi({
            description: "Why it is skipped; on a create or update, a note (default model, channel joined).",
          }),
        trimmed: z.array(z.string()).optional().openapi({ description: "Fields cut to fit our limits." }),
        renamedTo: z.string().optional().openapi({
          description: "The @handle an agent gets when it isn't the bundle's: that one was taken, or is an id.",
        }),
        targetId: z.string().optional(),
      }),
    ),
  })
  .openapi("ImportPlan");

/**
 * Bring agents and what's around them from another app (or another
 * agentes.chat): the backend reads the files behind a GitHub link (only
 * github.com and raw.githubusercontent.com over HTTPS, 15 s per request);
 * the web app parses them into a bundle, plans it here and applies the
 * items picked. Admins also download this workspace as a bundle.
 */
export function agentImportRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use(
    "/organizations/:orgId/imports",
    bodyLimit({
      maxSize: IMPORT_LIMITS.bodyBytes,
      onError: (c) => apiError(c, 413, "import.too_large", "The import is too large (max 32 MB)"),
    }),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-imports/github",
      tags,
      security,
      summary: "Read the files behind a GitHub link to import (nothing is saved)",
      description:
        "A file link reads that file. A folder link reads, relative to the folder: its Markdown/JSON/YAML, `agents/` (one level of folders), `skills/` (SKILL.md and other Markdown), `cron/jobs.json` and `memory/*.md` (newest first), up to 200 files and 8 MB (4 MB per file).",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            url: z
              .string()
              .max(2000)
              .refine((value) => {
                try {
                  const u = new URL(value);
                  return u.protocol === "https:" && ["github.com", "raw.githubusercontent.com"].includes(u.hostname);
                } catch {
                  return false;
                }
              }, "Only https://github.com or https://raw.githubusercontent.com links"),
          }),
        ),
      },
      responses: { 200: json(ImportedFiles), ...errors },
    }),
    async (c) => {
      const result = await readGithubImport(
        { db: deps.db, fetch: deps.extras?.http, resolveHost: deps.extras?.resolveHost },
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json").url,
      );
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/imports",
      tags,
      security,
      summary: "Plan (dryRun) or apply an import (admins)",
      description: `Every item comes back as create, update (made by an earlier import of this package and changed), unchanged or skip with the reason. Applying never brings chat history; routines land paused and skills off (unless in \`enableSkills\`). One apply creates or updates at most ${IMPORT_LIMITS.perApply} items (\`import.too_many_items\`): apply a big import in chunks of \`pick\`, in the plan's order; each call is safe to repeat.`,
      request: {
        params: OrgParams,
        body: body(
          z.object({
            bundle: Bundle,
            dryRun: z.boolean(),
            pick: z
              .array(z.string().max(300))
              .max(20_000)
              .optional()
              .openapi({ description: "`kind:key` of the items to apply; default every item." }),
            enableSkills: z
              .array(z.string().max(300))
              .max(IMPORT_LIMITS.skills)
              .optional()
              .openapi({ description: "`skill:key` of the skills to turn on for the agents that had them." }),
          }),
        ),
      },
      responses: { 200: json(ImportPlan), ...errors, 413: errorResponse("Over 32 MB") },
    }),
    async (c) => {
      const blobs = deps.extras?.artifacts?.blobs;
      if (!blobs) throw new Error("storage is not configured on this server");
      const plan = await applyImport(
        { db: deps.db, blobs, pubsub: deps.adapters.pubsub },
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
        NEW_AGENT_DEFAULTS,
      );
      return c.json(plan, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/export",
      tags,
      security,
      summary: "Download this workspace as an import bundle (admins)",
      description:
        "Agents, skills (SKILL.md), public channels with their agents, scheduled routines and the memory everyone can see. Never keys, connections, computers, runs, usage, audit or messages.",
      request: { params: OrgParams },
      responses: { 200: json(Bundle), ...errors },
    }),
    async (c) => {
      const bundle = await exportBundle(deps.db, c.get("user").id, c.req.valid("param").orgId);
      const day = new Date().toISOString().slice(0, 10);
      return c.json(bundle, 200, { "content-disposition": attachmentDisposition(`agentes-chat-${day}.json`) });
    },
  );

  return app;
}
