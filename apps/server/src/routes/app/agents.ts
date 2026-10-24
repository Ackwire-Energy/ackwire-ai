import {
  type AgentBrainSummary,
  type Agent as AgentRow,
  agentBrainSummaries,
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
  getAgentBrain,
  getTeam,
  listAgents,
  listCredentials,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  publishMachineAgentsChanged,
  revokeCredential,
  setAgentAppearance,
  setAgentAudience,
  setAgentBrain,
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
import {
  Agent,
  AgentAppearance,
  AgentAudience,
  AgentBrain,
  BrainEffortSetting,
  BrainKind,
  Credential,
  Model,
  ProviderId,
  Usage,
} from "./schemas";

const tags = ["Agents"];

/** An agent as this person may see it: its budget is money, so admins only (`seesCost`). */
const toAgent = (
  a: AgentRow,
  viewerId: string,
  seesCost: boolean,
  budgetUsedPercent?: number,
  brain?: AgentBrainSummary,
) => {
  const v = agentView(a);
  const { monthlyBudgetNanoUsd, ...rest } = v;
  return {
    ...rest,
    ...(brain ? { brain } : {}),
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
  model: z.string().optional().openapi({
    description: "A catalog model id, or `auto` (each run picks the model tier and effort). Defaults to `auto`.",
  }),
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
  const { db, adapters } = deps;
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
      responses: {
        200: json(
          z.object({
            models: z.array(Model),
            defaultModel: z.string().openapi({ description: "What a new agent gets when no model is chosen: `auto`." }),
          }),
        ),
        401: errors[401],
      },
    }),
    (c) =>
      c.json(
        {
          defaultModel: NEW_AGENT_DEFAULTS.model,
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
            provider: ProviderId,
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
      const [seesCost, budgets, brains] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBudgetsThisMonth(db, orgId),
        agentBrainSummaries(db, actor, orgId, list),
      ]);
      const percent = (id: string) => {
        const b = budgets.get(id);
        return b ? budgetPercent(b.spentNanoUsd, b.budgetNanoUsd) : 0;
      };
      return c.json({ agents: list.map((a) => toAgent(a, actor, seesCost, percent(a.id), brains.get(a.id))) }, 200);
    },
  );

  const TeamAgent = z.object({
    id: z.uuid(),
    name: z.string(),
    handle: z.string(),
    role: z.string(),
    callFor: z
      .string()
      .openapi({ description: "When to call it: its role, or the first sentence of its instructions." }),
    appearance: AgentAppearance.nullable(),
    ownerUserId: z.string().nullable(),
    capabilities: z
      .array(z.string())
      .openapi({ description: "What it can do, as stable group keys (`drive`, `github`, `calendar`, `custom`…)." }),
    busy: z.boolean().openapi({ description: "Working on something right now." }),
    canTalk: z.boolean(),
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/team",
      tags,
      security,
      summary: "The agents as a team: grouped by responsible person, with who consulted whom in the last day",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            agents: z.array(TeamAgent),
            people: z.array(z.object({ id: z.string(), name: z.string(), image: z.string().nullable() })),
            consultations: z.array(
              z.object({
                id: z.uuid(),
                askerAgentId: z.uuid(),
                targetAgentId: z.uuid(),
                status: z.string(),
                createdAt: z.string(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const team = await getTeam(db, c.get("user").id, orgId);
      return c.json(
        {
          ...team,
          consultations: team.consultations.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
        },
        200,
      );
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
        // New agents start on "Automático".
        NEW_AGENT_DEFAULTS,
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
      // Its computer shows its name and look (the desktop app, ADR 0036).
      if (agent.machineId && (input.name !== undefined || appearance !== undefined)) {
        await publishMachineAgentsChanged(adapters.pubsub, orgId);
      }
      const [seesCost, brains] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBrainSummaries(db, actor, orgId, [agent]),
      ]);
      return c.json(toAgent(agent, actor, seesCost, undefined, brains.get(agent.id)), 200);
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
      await publishMachineAgentsChanged(adapters.pubsub, orgId);
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

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/brain",
      tags,
      security,
      summary:
        '"Quem pensa" (ADR 0032): the model (API), Claude Code or Codex on its computer, the model and the fallback, with what its computer offers. An admin or the agent\'s owner.',
      request: { params: AgentParams },
      responses: { 200: json(AgentBrain), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await getAgentBrain({ db }, c.get("user").id, orgId, agentId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/brain",
      tags,
      security,
      summary:
        "Choose who thinks for the agent (an admin or the agent's owner; audited). Switching to Claude Code or Codex needs `acceptPlanTerms: true` (the person read that the subscription is personal and takes the risk); only what its computer has can be chosen.",
      request: {
        params: AgentParams,
        body: body(
          z.object({
            brain: BrainKind.optional(),
            model: z.string().max(80).nullable().optional().openapi({
              description:
                "Claude Code: `opus`, `sonnet`, `haiku`; Codex: a model name; `auto` (each run picks the tier). Null = the brain's default; omitted = keep (reset when the brain changes).",
            }),
            fallback: z.boolean().optional(),
            acceptPlanTerms: z.boolean().optional(),
            account: z.uuid().nullable().optional().openapi({
              description:
                "An account on the agent's computer of the brain's kind (ADR 0041); null = the computer's own sign-in; omitted = keep (cleared when the brain kind changes). Only the person who connected the computer may change it (`account.not_owner`).",
            }),
            effort: BrainEffortSetting.nullable()
              .optional()
              .openapi({ description: "`auto` = picked per run; null = the CLI's default; omitted = keep." }),
          }),
        ),
      },
      responses: { 200: json(AgentBrain), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await setAgentBrain({ db }, c.get("user").id, orgId, agentId, c.req.valid("json")), 200);
    },
  );

  return app;
}
