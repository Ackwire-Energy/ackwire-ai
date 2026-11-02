import { connectorOAuthApps, githubAppConfig } from "@agenteschat/config";
import {
  agentMadeSkills,
  agentSkillList,
  deleteSkill,
  getSkill,
  getSkillFile,
  importPickedSkills,
  importSkillFromUrl,
  importSkillZip,
  listSkills,
  parseSkillMarkdown,
  reimportSkill,
  restoreSkill,
  revertSkillChange,
  type SkillDeps,
  saveSkill,
  setAgentSkills,
  setSkillLocked,
  updateSkill,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
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

const tags = ["Skills"];
const Skill = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    version: z.number(),
    source: z.string().openapi({ description: "`upload`, `url` or `manual`." }),
    sourceUrl: z.string().nullable(),
    sourceVia: z.enum(["github_app", "github"]).nullable().openapi({
      description:
        "Which of the workspace's GitHub connections read its private repository (the GitHub App, or the GitHub connector): updating reads through it first, then through the other, and keeps the one that read it. Null: read with no credentials.",
    }),
    defaultForNewAgents: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
    origin: z.enum(["person", "agent"]).openapi({ description: "`agent`: promoted from an agent's how-tos." }),
    ownerAgentId: z
      .uuid()
      .nullable()
      .openapi({ description: "An agent-made skill's agent (the only one that changes it)." }),
    locked: z.boolean().openapi({ description: "Agents can't change it; never archived for disuse." }),
    useCount: z.number(),
    lastUsedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Skill");
const SkillDetail = Skill.extend({
  body: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number(),
      mime: z.string(),
      status: z.enum(["stored", "script", "ignored"]).openapi({
        description:
          "`stored`: text agents can read; `script`: runs only on the agent's computer, never shown; `ignored`: binary.",
      }),
    }),
  ),
}).openapi("SkillDetail");
const SkillChoice = z
  .object({
    path: z.string().openapi({ description: "The skill's folder from the repository's root: what `paths` sends." }),
    name: z.string(),
    description: z.string(),
  })
  .openapi("SkillChoice");
const SkillSkipped = z
  .object({
    path: z.string(),
    code: z.string().openapi({ description: "Why it can't be installed: stable, the app translates it." }),
    message: z.string().openapi({ description: "English fallback." }),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("SkillSkipped");
const SkillParams = OrgParams.extend({ skillId: z.uuid() });
const SkillListItem = Skill.extend({
  agentsCount: z.number().openapi({ description: "Active agents with this skill turned on." }),
}).openapi("SkillListItem");

/** Reading a link downloads the repository's archive (up to 50 MB): to list its skills, install or update one. */
const LINK_READS = { limit: 60, windowMs: 3600_000 };

/**
 * Skills in Markdown (`SKILL.md`, ADR 0020): install by zip, GitHub URL or by
 * hand (admins, `manage_agents`), and turn them on per agent. No code runs:
 * scripts are listed as ignored.
 */
export function skillRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  // Private repositories are read with the workspace's GitHub: the GitHub App's token for the repository, else the
  // GitHub connection's. Tokens stay here.
  const github = {
    connectors: {
      db,
      keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers],
      oauthApps: connectorOAuthApps(deps.config),
      publicUrl: deps.config.PUBLIC_URL,
      http: deps.extras?.http,
    },
    app: githubAppConfig(deps.config),
  };
  const skills = (): SkillDeps => {
    const blobs = deps.extras?.artifacts?.blobs;
    if (!blobs) throw new Error("storage is not configured on this server");
    return { db, blobs, fetch: deps.extras?.http, resolveHost: deps.extras?.resolveHost, github };
  };
  const linkReadAllowed = async (userId: string) =>
    (await deps.adapters.rateLimiter.consume(`skill-link:${userId}`, LINK_READS)).allowed;
  const tooManyReads = "Too many skill links read. Try again later.";

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/skills",
      tags,
      security,
      summary: "The organization's skills",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ skills: z.array(SkillListItem) })), ...errors },
    }),
    async (c) => c.json({ skills: await listSkills(db, c.get("user").id, c.req.valid("param").orgId) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills",
      tags,
      security,
      summary: "Create a skill by hand: a SKILL.md text, or name + description + body",
      request: {
        params: OrgParams,
        body: body(
          z.union([
            z.object({ markdown: z.string().max(250_000), defaultForNewAgents: z.boolean().optional() }),
            z.object({
              name: z.string().max(64),
              description: z.string().max(1024),
              body: z.string().max(200_000),
              defaultForNewAgents: z.boolean().optional(),
            }),
          ]),
        ),
      },
      responses: { 201: json(SkillDetail, "Created"), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const parsed =
        "markdown" in input
          ? parseSkillMarkdown(input.markdown)
          : { name: input.name.trim(), description: input.description.trim(), body: input.body, metadata: {} };
      const saved = await saveSkill(skills(), c.get("user").id, c.req.valid("param").orgId, {
        ...parsed,
        source: "manual",
        defaultForNewAgents: input.defaultForNewAgents,
      });
      return c.json(saved, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/import",
      tags,
      security,
      summary:
        "Import a skill: a GitHub link (a skill's folder or a file in it, or a folder holding several to pick from) or a zip of the folder (base64)",
      description:
        "A private repository (github.com answers 404) is read through the workspace's GitHub: the GitHub App's token for it, else the GitHub connection's, never sent to the app. `github.repo_missing` says in `connection` how the GitHub connection fared (`none`; `refused`: GitHub no longer takes its token; `ok`: it works and can't see the repository) and in `app` whether the GitHub App is installed on some account for the workspace. `github.unreachable`: GitHub didn't answer, try again.",
      request: {
        params: OrgParams,
        body: body(
          z.union([
            z.object({
              url: z.string().url().max(500),
              paths: z
                .array(z.string().max(500))
                .min(1)
                .max(100)
                .optional()
                .openapi({ description: "The skills picked among the link's `choices` (their `path`)." }),
              list: z.boolean().optional().openapi({
                description: "Answer with the skills the link holds to pick, even one, installing none.",
              }),
            }),
            z.object({
              zipBase64: z
                .string()
                .max(4_000_000)
                .openapi({ description: "The skill folder as a zip, base64 (≤ 2 MB unzipped)." }),
            }),
          ]),
        ),
      },
      responses: {
        200: json(
          z.object({
            choices: z.array(SkillChoice),
            skipped: z.array(SkillSkipped).optional(),
            via: z.enum(["github_app", "github"]).optional(),
          }),
          "The link holds several skills (or `list`): nothing installed, send the ones picked in `paths`. `skipped`: those that can't be installed, with why. `via`: which of the workspace's GitHub connections read it",
        ),
        201: json(
          z.union([SkillDetail, z.object({ skills: z.array(SkillDetail) })]),
          "Created: the skill, or `{ skills }` for `paths`",
        ),
        429: errorResponse("Too many links read, or GitHub limiting this server"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const actor = c.get("user").id;
      if ("url" in input) {
        if (!(await linkReadAllowed(actor))) return apiError(c, 429, "rate_limited", tooManyReads);
        if (input.paths) {
          return c.json({ skills: await importPickedSkills(skills(), actor, orgId, input.url, input.paths) }, 201);
        }
        const result = await importSkillFromUrl(skills(), actor, orgId, input.url, { list: input.list });
        return "choices" in result ? c.json(result, 200) : c.json(result, 201);
      }
      let zip: Uint8Array;
      try {
        zip = new Uint8Array(Buffer.from(input.zipBase64, "base64"));
      } catch {
        throw new ValidationError("zipBase64 is not valid base64");
      }
      return c.json(await importSkillZip(skills(), actor, orgId, zip), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/skills/{skillId}",
      tags,
      security,
      summary: "A skill with its body and files",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await getSkill(db, c.get("user").id, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/skills/{skillId}/files/{path}",
      tags,
      security,
      summary: "A stored text file of the skill (scripts and binaries are ignored: 404)",
      request: {
        params: SkillParams.extend({
          path: z
            .string()
            .min(1)
            .max(300)
            .openapi({ description: "The file's path inside the skill, URL-encoded (`templates%2Frelatorio.md`)." }),
        }),
        query: z.object({
          version: z.coerce.number().int().min(1).optional().openapi({ description: "Default: the current one." }),
        }),
      },
      responses: {
        200: json(z.object({ path: z.string(), version: z.number(), mime: z.string(), content: z.string() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, skillId, path } = c.req.valid("param");
      const { version } = c.req.valid("query");
      return c.json(await getSkillFile(skills(), c.get("user").id, orgId, skillId, path, version), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/skills/{skillId}",
      tags,
      security,
      summary: "Edit a skill (a new version), or toggle 'default for new agents'",
      request: {
        params: SkillParams,
        body: body(
          z.object({
            description: z.string().max(1024).optional(),
            body: z.string().max(200_000).optional(),
            defaultForNewAgents: z.boolean().optional(),
            locked: z.boolean().optional().openapi({ description: "Freeze it: agents can't change it." }),
          }),
        ),
      },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      const { locked, ...rest } = c.req.valid("json");
      const actor = c.get("user").id;
      if (locked !== undefined) {
        const detail = await setSkillLocked(db, actor, orgId, skillId, locked);
        if (Object.values(rest).every((v) => v === undefined)) return c.json(detail, 200);
      }
      return c.json(await updateSkill(skills(), actor, orgId, skillId, rest), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/restore",
      tags,
      security,
      summary: "Bring back a skill archived for disuse (or deleted), with its agents' assignments",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await restoreSkill(db, c.get("user").id, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/revert",
      tags,
      security,
      summary: "Undo an agent's last change to its own skill (its owner or admins)",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      const actor = c.get("user").id;
      await revertSkillChange(db, actor, orgId, skillId);
      return c.json(await getSkill(db, actor, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/reimport",
      tags,
      security,
      summary: "Import again from its URL (a new version)",
      request: { params: SkillParams },
      responses: {
        200: json(SkillDetail),
        429: errorResponse("Too many links read, or GitHub limiting this server"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      const actor = c.get("user").id;
      if (!(await linkReadAllowed(actor))) return apiError(c, 429, "rate_limited", tooManyReads);
      return c.json(await reimportSkill(skills(), actor, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/skills/{skillId}",
      tags,
      security,
      summary: "Delete a skill (agents lose it; installing the same name again brings it back with its assignments)",
      request: { params: SkillParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      await deleteSkill(db, c.get("user").id, orgId, skillId);
      return c.body(null, 204);
    },
  );

  const AgentParams = OrgParams.extend({ agentId: z.uuid() });
  const AgentSkill = Skill.extend({ enabled: z.boolean() });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/learned-skills",
      tags,
      security,
      summary: "Skills the agent made from its own how-tos, archived ones too, newest first",
      request: { params: AgentParams },
      responses: {
        200: json(z.object({ skills: z.array(Skill.extend({ body: z.string(), archived: z.boolean() })) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ skills: await agentMadeSkills(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/skills",
      tags,
      security,
      summary: "The org's skills with whether this agent has each one on",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ skills: z.array(AgentSkill) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ skills: await agentSkillList(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/skills",
      tags,
      security,
      summary: "Turn skills on or off for an agent (admins or its owner)",
      request: {
        params: AgentParams,
        body: body(z.object({ skills: z.array(z.object({ skillId: z.uuid(), enabled: z.boolean() })).max(500) })),
      },
      responses: { 200: json(z.object({ skills: z.array(AgentSkill) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const list = await setAgentSkills(db, c.get("user").id, orgId, agentId, c.req.valid("json").skills);
      return c.json({ skills: list }, 200);
    },
  );

  return app;
}
