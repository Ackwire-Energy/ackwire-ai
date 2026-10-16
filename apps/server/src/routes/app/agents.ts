import {
  type Agent as AgentRow,
  agentBudgetsThisMonth,
  agentView,
  archiveAgent,
  audienceOf,
  budgetPercent,
  canTalkTo,
  canViewCost,
  createAgent,
  createCredential,
  deleteCredential,
  getAgent,
  listAgents,
  listCredentials,
  NotFoundError,
  revokeCredential,
  setAgentAppearance,
  setAgentAudience,
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
import { Agent, AgentAppearance, AgentAudience, Credential, Model, Usage } from "./schemas";

const tags = ["Agents"];

/** An agent as this person may see it: its budget is money, so admins only (`seesCost`). */
const toAgent = (a: AgentRow, viewerId: string, seesCost: boolean, budgetUsedPercent?: number) => {
  const v = agentView(a);
  const { monthlyBudgetNanoUsd, ...rest } = v;
  return {
    ...rest,
    ...(budgetUsedPercent !== undefined ? { budgetUsedPercent } : {}),
    ...(seesCost
      ? { monthlyBudgetUsd: monthlyBudgetNanoUsd === null ? null : nanoUsdToUsd(monthlyBudgetNanoUsd) }
      : {}),
    createdAt: v.createdAt.toISOString(),
    audience: audienceOf(a),
    audienceMode: a.audienceMode,
    canTalk: canTalkTo(a, viewerId),
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
  monthlyBudgetUsd: z.number().min(0).nullable().optional().openapi({
    description:
      "Spend cap per calendar month (UTC), admins only. Null = the workspace default (every agent has a budget).",
  }),
  audience: AgentAudience.optional().openapi({
    description: "Who can talk to it. The agent's owner or admins can change it.",
  }),
  appearance: AgentAppearance.nullable().optional().openapi({
    description: "Its look (fixed allow-list). The agent's owner or admins can change it; null = the default.",
  }),
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
            provider: z.enum(["anthropic", "openai"]),
            label: z.string().trim().min(1).max(80),
            apiKey: z.string().min(8).max(500),
            workspaceId: z
              .string()
              .max(128)
              .nullable()
              .optional()
              .openapi({ description: "Anthropic workspace, for keys not scoped to one (`anthropic-workspace-id`)." }),
            organization: z.string().max(128).nullable().optional().openapi({ description: "OpenAI organization id." }),
            project: z.string().max(128).nullable().optional().openapi({ description: "OpenAI project id." }),
            makeDefault: z
              .boolean()
              .optional()
              .openapi({ description: "Make it the workspace's default key in the same call (onboarding)." }),
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
      summary: "Revoke a provider API key (or delete it for good with ?purge=true)",
      description: "Purging is refused while agents use the key, so they never fall back to the platform key silently.",
      request: {
        params: OrgParams.extend({ credentialId: z.uuid() }),
        query: z.object({ purge: z.stringbool().optional() }),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, credentialId } = c.req.valid("param");
      if (c.req.valid("query").purge) await deleteCredential(db, c.get("user").id, orgId, credentialId);
      else await revokeCredential(db, c.get("user").id, orgId, credentialId);
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
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      const list = await listAgents(db, actor, orgId);
      const [seesCost, budgets] = await Promise.all([canViewCost(db, actor, orgId), agentBudgetsThisMonth(db, orgId)]);
      const percent = (id: string) => {
        const b = budgets.get(id);
        return b ? budgetPercent(b.spentNanoUsd, b.budgetNanoUsd) : 0;
      };
      return c.json({ agents: list.map((a) => toAgent(a, actor, seesCost, percent(a.id))) }, 200);
    },
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
      const { monthlyBudgetUsd, audience, appearance, ...input } = c.req.valid("json");
      const orgId = c.req.valid("param").orgId;
      let agent = await createAgent(
        db,
        c.get("user").id,
        orgId,
        { ...input, monthlyBudgetNanoUsd: budget(monthlyBudgetUsd) },
        { model: config.AGENT_DEFAULT_MODEL },
      );
      if (audience) agent = await setAgentAudience(db, c.get("user").id, orgId, agent.id, audience);
      if (appearance) agent = await setAgentAppearance(db, c.get("user").id, orgId, agent.id, appearance);
      return c.json(toAgent(agent, c.get("user").id, await canViewCost(db, c.get("user").id, orgId)), 201);
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
      const { monthlyBudgetUsd, audience, appearance, ...input } = c.req.valid("json");
      const actor = c.get("user").id;
      // The audience and the look can be changed by the agent's owner too; everything else needs an admin.
      const other =
        (!audience && appearance === undefined) ||
        Object.values(input).some((v) => v !== undefined) ||
        monthlyBudgetUsd !== undefined;
      let agent = other
        ? await updateAgent(db, actor, orgId, agentId, { ...input, monthlyBudgetNanoUsd: budget(monthlyBudgetUsd) })
        : null;
      if (audience) agent = await setAgentAudience(db, actor, orgId, agentId, audience);
      if (appearance !== undefined) agent = await setAgentAppearance(db, actor, orgId, agentId, appearance);
      if (!agent) {
        agent = await getAgent(db, orgId, agentId);
        if (!agent) throw new NotFoundError("Agent not found");
      }
      return c.json(toAgent(agent, actor, await canViewCost(db, actor, orgId)), 200);
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
