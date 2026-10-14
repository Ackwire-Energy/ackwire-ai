import {
  type Agent as AgentRow,
  agentView,
  archiveAgent,
  createAgent,
  createCredential,
  listAgents,
  listCredentials,
  revokeCredential,
  updateAgent,
  usageSummary,
} from "@agenteschat/engine";
import { MODEL_CATALOG, nanoUsdToUsd, usdToNanoUsd } from "@agenteschat/providers";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  iso,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { Agent, Credential, Model, Usage } from "./schemas";

const tags = ["Agents"];

const toAgent = (a: AgentRow) => {
  const v = agentView(a);
  const { monthlyBudgetNanoUsd, ...rest } = v;
  return {
    ...rest,
    monthlyBudgetUsd: monthlyBudgetNanoUsd === null ? null : nanoUsdToUsd(monthlyBudgetNanoUsd),
    createdAt: v.createdAt.toISOString(),
  };
};

const AgentFields = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().max(200).optional(),
  instructions: z.string().max(50_000).optional(),
  model: z.string().optional().openapi({ description: "Defaults to AGENT_DEFAULT_MODEL." }),
  credentialId: z
    .uuid()
    .nullable()
    .optional()
    .openapi({ description: "Provider credential of this organization. Null = platform key (Cloud only)." }),
  ownerUserId: z.string().nullable().optional(),
  monthlyBudgetUsd: z
    .number()
    .min(0)
    .nullable()
    .optional()
    .openapi({ description: "Spend cap per calendar month (UTC). Null = no cap." }),
});

const budget = (usd: number | null | undefined) =>
  usd === undefined ? undefined : usd === null ? null : usdToNanoUsd(usd);

/** Provider credentials, agents, usage and the model catalog. */
export function agentRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use("/models", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/models",
      tags,
      security,
      summary: "Models agents can use, with prices",
      responses: { 200: json(z.object({ models: z.array(Model), defaultModel: z.string() })), 401: errors[401] },
    }),
    (c) =>
      c.json(
        {
          defaultModel: config.AGENT_DEFAULT_MODEL,
          models: Object.entries(MODEL_CATALOG).map(([id, m]) => ({
            id,
            label: m.label,
            provider: m.provider,
            inputUsdPerMTok: m.prices.input / 1000,
            outputUsdPerMTok: m.prices.output / 1000,
          })),
        },
        200,
      ),
  );

  // ── Credentials ───────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/credentials",
      tags,
      security,
      summary: "Provider credentials (metadata only)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ credentials: z.array(Credential) })), ...errors },
    }),
    async (c) => {
      const rows = await listCredentials(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        { credentials: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), revokedAt: iso(r.revokedAt) })) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/credentials",
      tags,
      security,
      summary: "Add a provider API key",
      description: "The key is encrypted at rest and never returned by any endpoint.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            provider: z.enum(["anthropic"]),
            label: z.string().trim().min(1).max(80),
            apiKey: z.string().min(8).max(500),
          }),
        ),
      },
      responses: { 201: json(Credential, "Created"), ...errors },
    }),
    async (c) => {
      const row = await createCredential(
        db,
        adapters.keyWrapper,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json({ ...row, createdAt: row.createdAt.toISOString(), revokedAt: iso(row.revokedAt) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/credentials/{credentialId}",
      tags,
      security,
      summary: "Revoke a provider API key",
      request: { params: OrgParams.extend({ credentialId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, credentialId } = c.req.valid("param");
      await revokeCredential(db, c.get("user").id, orgId, credentialId);
      return c.body(null, 204);
    },
  );

  // ── Agents ────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents",
      tags,
      security,
      summary: "Agents of the organization",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ agents: z.array(Agent) })), ...errors },
    }),
    async (c) =>
      c.json({ agents: (await listAgents(db, c.get("user").id, c.req.valid("param").orgId)).map(toAgent) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents",
      tags,
      security,
      summary: "Create an agent",
      request: { params: OrgParams, body: body(AgentFields.extend({ handle: z.string().min(2).max(32) })) },
      responses: { 201: json(Agent, "Created"), ...errors },
    }),
    async (c) => {
      const { monthlyBudgetUsd, ...input } = c.req.valid("json");
      const agent = await createAgent(
        db,
        c.get("user").id,
        c.req.valid("param").orgId,
        { ...input, monthlyBudgetNanoUsd: budget(monthlyBudgetUsd) },
        { model: config.AGENT_DEFAULT_MODEL },
      );
      return c.json(toAgent(agent), 201);
    },
  );

  const AgentParams = OrgParams.extend({ agentId: z.uuid() });
  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/agents/{agentId}",
      tags,
      security,
      summary: "Edit an agent",
      request: { params: AgentParams, body: body(AgentFields.partial()) },
      responses: { 200: json(Agent), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const { monthlyBudgetUsd, ...input } = c.req.valid("json");
      const agent = await updateAgent(db, c.get("user").id, orgId, agentId, {
        ...input,
        monthlyBudgetNanoUsd: budget(monthlyBudgetUsd),
      });
      return c.json(toAgent(agent), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agents/{agentId}",
      tags,
      security,
      summary: "Archive an agent",
      request: { params: AgentParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await archiveAgent(db, c.get("user").id, orgId, agentId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage",
      tags,
      security,
      summary: "Tokens and cost per agent this month",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ usage: z.array(Usage) })), ...errors },
    }),
    async (c) => {
      const rows = await usageSummary(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        { usage: rows.map(({ costNanoUsd, ...r }) => ({ ...r, costUsd: nanoUsdToUsd(costNanoUsd) })) },
        200,
      );
    },
  );

  return app;
}
