import {
  agentSkillList,
  deleteSkill,
  getSkill,
  getSkillFile,
  importSkillFromUrl,
  importSkillZip,
  listSkills,
  parseSkillMarkdown,
  reimportSkill,
  type SkillDeps,
  saveSkill,
  setAgentSkills,
  updateSkill,
  ValidationError,
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

const tags = ["Skills"];
const Skill = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    version: z.number(),
    source: z.string().openapi({ description: "`upload`, `url` or `manual`." }),
    sourceUrl: z.string().nullable(),
    defaultForNewAgents: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
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
const SkillParams = OrgParams.extend({ skillId: z.uuid() });
const SkillListItem = Skill.extend({
  agentsCount: z.number().openapi({ description: "Active agents with this skill turned on." }),
}).openapi("SkillListItem");

/**
 * Skills in Markdown (`SKILL.md`, ADR 0020): install by zip, GitHub URL or by
 * hand (admins, `manage_agents`), and turn them on per agent. No code runs:
 * scripts are listed as ignored.
 */
export function skillRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const skills = (): SkillDeps => {
    const blobs = deps.extras?.artifacts?.blobs;
    if (!blobs) throw new Error("storage is not configured on this server");
    return { db, blobs, fetch: deps.extras?.http, resolveHost: deps.extras?.resolveHost };
  };

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
      summary: "Import a skill: a GitHub URL (folder or SKILL.md) or a zip of the folder (base64)",
      request: {
        params: OrgParams,
        body: body(
          z.union([
            z.object({ url: z.string().url().max(500) }),
            z.object({
              zipBase64: z
                .string()
                .max(4_000_000)
                .openapi({ description: "The skill folder as a zip, base64 (≤ 2 MB unzipped)." }),
            }),
          ]),
        ),
      },
      responses: { 201: json(SkillDetail, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const actor = c.get("user").id;
      if ("url" in input) return c.json(await importSkillFromUrl(skills(), actor, orgId, input.url), 201);
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
          }),
        ),
      },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await updateSkill(skills(), c.get("user").id, orgId, skillId, c.req.valid("json")), 200);
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
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await reimportSkill(skills(), c.get("user").id, orgId, skillId), 200);
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
