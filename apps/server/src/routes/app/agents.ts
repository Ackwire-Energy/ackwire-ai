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
  createAgentFromProposal,
  createAgentGroup,
  createCredential,
  deleteAgent,
  deleteAgentGroup,
  deleteCredential,
  denyAgentProposal,
  getAgent,
  getAgentBrain,
  getAgentProposal,
  getTeam,
  listAgentGroups,
  listAgents,
  listCredentials,
  listFormerAgents,
  moveAgentToGroup,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  newAgentBrainMachines,
  orgAiStatus,
  orgRouting,
  publishMachineAgentsChanged,
  requirePermission,
  revokeCredential,
  setAgentAppearance,
  setAgentAudience,
  setAgentBrain,
  talksToAgents,
  updateAgent,
  updateAgentGroup,
  usageSummary,
} from "@agenteschat/engine";
import { MODEL_CATALOG, nanoUsdToUsd, pricesAt, usdToNanoUsd } from "@agenteschat/providers";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  aiStatusDeps,
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
  BrainMachine,
  Credential,
  FormerAgent,
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
  /** Whether the viewer's roles let them talk to agents (`talksToAgents`, ADR 0085). */
  talks = true,
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
    canTalk: canTalkTo(a, viewerId, talks),
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

const ProposalParams = OrgParams.extend({ messageId: z.uuid() });
const AgentProposal = z
  .object({
    kind: z.literal("agent_proposal"),
    messageId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    proposedByAgentId: z.uuid(),
    forUserId: z.string().nullable(),
    params: z.object({
      draft: z.object({
        name: z.string(),
        handle: z.string(),
        role: z.string(),
        instructions: z.string(),
        appearance: AgentAppearance.nullable(),
        channelIds: z.array(z.uuid()),
        access: z.array(z.object({ connectionId: z.uuid(), level: z.enum(["read", "write"]) })),
        ai: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("account"),
            brain: z.enum(["claude_code", "codex"]),
            machineId: z.uuid(),
            accountId: z.uuid(),
            label: z.string(),
          }),
          z.object({ kind: z.literal("model") }),
          z.object({ kind: z.literal("none") }),
        ]),
      }),
      why: z.string(),
    }),
    state: z.enum(["pending", "creating", "created", "denied"]),
    agentId: z.uuid().nullable(),
    decidedByUserId: z.string().nullable(),
    decidedAt: z.string().nullable(),
    expiresAt: z.string(),
    expired: z.boolean(),
    canDecide: z.boolean(),
  })
  .openapi("AgentProposal", {
    description:
      "An agent's proposal of a new agent (`meta.actionCard` of its card, ADR 0081): the draft, the AI it suggests and what was decided.",
  });

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
            inputUsdPerMTok: pricesAt(m).input / 1000,
            outputUsdPerMTok: pricesAt(m).output / 1000,
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
            workspaceId: z.string().max(128).nullable().optional().openapi({
              description:
                "Claude Console workspace ID, for a key that works in more than one workspace (sent as `anthropic-workspace-id`).",
            }),
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
      const [seesCost, budgets, brains, talks] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBudgetsThisMonth(db, orgId),
        agentBrainSummaries(db, actor, orgId, list),
        talksToAgents(db, orgId, actor),
      ]);
      const percent = (id: string) => {
        const b = budgets.get(id);
        return b ? budgetPercent(b.spentNanoUsd, b.budgetNanoUsd) : 0;
      };
      return c.json(
        { agents: list.map((a) => toAgent(a, actor, seesCost, percent(a.id), brains.get(a.id), talks)) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/former-agents",
      tags,
      security,
      summary: "Agents no longer in the team (archived or deleted): the name, role and look their messages still show",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ agents: z.array(FormerAgent) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ agents: await listFormerAgents(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/ai-status",
      tags,
      security,
      summary: "Whether each agent has an AI to think with, whether the organization has any, and who picks the agents",
      description:
        "Per agent: `ready`; `no_ai` with why (`no_key`, `not_signed_in`, `no_computer`, `cli_missing`: nothing to think with, and no fallback); `waiting` (its computer is away for now). `any`: an agent that isn't archived is ready or waiting. `routing` (ADR 0074): who picks the agents for a message nobody mentioned, for the workspace (`by`) and for the caller's own messages (`mine`): Jev, the organization's small model (`model`), people's own plans (only for their own messages), rules, or `off` (only mentions). `noSmallModel`: with `rules`, the default key's provider, which has no small model. `apiKey`: a key of its own, or the server's own Claude key. Computed on each request; no key is read.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            any: z.boolean(),
            agents: z.array(
              z.object({
                agentId: z.uuid(),
                state: z.enum(["ready", "no_ai", "waiting"]),
                reason: z.enum(["no_key", "not_signed_in", "no_computer", "cli_missing"]).optional(),
              }),
            ),
            routing: z.object({
              by: z.enum(["jev", "model", "plans", "rules", "off"]),
              mine: z.enum(["jev", "model", "plan", "rules", "off"]),
              model: z.string().nullable(),
              noSmallModel: z.string().nullable(),
            }),
            apiKey: z.boolean(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      await requirePermission(db, userId, orgId, "read");
      const status = aiStatusDeps(deps);
      const [ai, routing] = await Promise.all([
        orgAiStatus(status, orgId),
        orgRouting(status, deps.extras?.router?.routing ?? null, orgId, userId),
      ]);
      return c.json({ ...ai, ...routing }, 200);
    },
  );

  const TeamAgent = z.object({
    id: z.uuid(),
    name: z.string(),
    handle: z.string(),
    role: z.string(),
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
      request: {
        params: OrgParams,
        body: body(
          AgentFields.extend({
            handle: z.string().min(2).max(32),
            proposal: z.uuid().optional().openapi({
              description: "The card of an agent's proposal it comes from (ADR 0081): it is marked created.",
            }),
          }),
        ),
      },
      responses: { 201: json(Agent, "Created"), ...errors },
    }),
    async (c) => {
      const { monthlyBudgetUsd, audience, appearance, proposal, ...input } = c.req.valid("json");
      const orgId = c.req.valid("param").orgId;
      const make = () =>
        createAgent(
          db,
          c.get("user").id,
          orgId,
          { ...input, monthlyBudgetNanoUsd: budget(monthlyBudgetUsd) },
          // New agents start on "Automático".
          NEW_AGENT_DEFAULTS,
        );
      let agent = proposal
        ? await createAgentFromProposal({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, proposal, make)
        : await make();
      if (audience) agent = await setAgentAudience(db, c.get("user").id, orgId, agent.id, audience);
      if (appearance) agent = await setAgentAppearance(db, c.get("user").id, orgId, agent.id, appearance);
      // Born on the workspace's own computer: it lists its agents again.
      if (agent.machineId) await publishMachineAgentsChanged(adapters.pubsub, orgId);
      return c.json(toAgent(agent, c.get("user").id, await canViewCost(db, c.get("user").id, orgId)), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-proposals/{messageId}",
      tags,
      security,
      summary: "An agent's proposal of a new agent (its card's message), for whoever reads its conversation",
      request: { params: ProposalParams },
      responses: { 200: json(AgentProposal), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const gateway = deps.extras?.context?.gateway;
      return c.json(await getAgentProposal({ db, gateway }, c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-proposals/{messageId}/deny",
      tags,
      security,
      summary: "Say no to an agent's proposal of a new agent (who may create agents): the card stays, marked denied",
      request: { params: ProposalParams },
      responses: { 200: json(AgentProposal), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await denyAgentProposal({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, messageId), 200);
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
      request: {
        params: AgentParams,
        body: body(
          AgentFields.partial().extend({
            acceptPlanTerms: z.boolean().optional().openapi({
              deprecated: true,
              description: "Ignored. Older apps send it when an agent on a plan replies to everyone.",
            }),
          }),
        ),
      },
      responses: { 200: json(Agent), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const { monthlyBudgetUsd, audience, appearance, acceptPlanTerms: _, ...input } = c.req.valid("json");
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
      // Its computer shows its name and look (the desktop app, ADR 0036), and a new owner may take its plan away.
      if (
        agent.machineId &&
        (input.name !== undefined || appearance !== undefined || input.ownerUserId !== undefined)
      ) {
        await publishMachineAgentsChanged(adapters.pubsub, orgId);
      }
      const [seesCost, brains, talks] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBrainSummaries(db, actor, orgId, [agent]),
        talksToAgents(db, orgId, actor),
      ]);
      return c.json(toAgent(agent, actor, seesCost, undefined, brains.get(agent.id), talks), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agents/{agentId}",
      tags,
      security,
      summary: "Archive an agent (or delete it for good with ?purge=true)",
      description:
        "Deleting (ADR 0082) is permanent and works on archived agents too: its instructions, memory, routines, grants, budget, channels and login on its computer go, its work stops and its DMs close; its messages, usage and audit rows stay, named by a tombstone that frees its handle. Owners and admins.",
      request: { params: AgentParams, query: z.object({ purge: z.stringbool().optional() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const actor = c.get("user").id;
      if (c.req.valid("query").purge) {
        const hub = deps.extras?.sandbox?.machines?.hub ?? null;
        await deleteAgent({ db, pubsub: adapters.pubsub, hub, mail: adapters.mail }, actor, orgId, agentId);
        return c.body(null, 204);
      }
      await archiveAgent(db, actor, orgId, agentId);
      await publishMachineAgentsChanged(adapters.pubsub, orgId);
      return c.body(null, 204);
    },
  );

  // ── Agent groups (ADR 0083) ───────────────────────────────────────────────
  // Every write answers with every group and tells the workspace's open apps (`agent.groups`).
  const groups = { db, pubsub: adapters.pubsub };
  const Groups = z.object({
    groups: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        agentIds: z.array(z.uuid()).openapi({ description: "Its agents in order (archived ones left out)." }),
      }),
    ),
  });
  const GroupParams = OrgParams.extend({ groupId: z.uuid() });
  const GroupName = z.string().trim().min(1).max(80);

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-groups",
      tags,
      security,
      summary: "The workspace's groups of agents, in order; an agent is in one at most",
      request: { params: OrgParams },
      responses: { 200: json(Groups), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ groups: await listAgentGroups(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-groups",
      tags,
      security,
      summary: "Add a group after the others, with these agents in it in order (owners and admins)",
      request: {
        params: OrgParams,
        body: body(z.object({ name: GroupName, agentIds: z.array(z.uuid()).max(200).optional() })),
      },
      responses: { 201: json(Groups, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ groups: await createAgentGroup(groups, c.get("user").id, orgId, c.req.valid("json")) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/agent-groups/{groupId}",
      tags,
      security,
      summary: "Rename a group, or move it among the groups (`index`) (owners and admins)",
      request: {
        params: GroupParams,
        body: body(z.object({ name: GroupName.optional(), index: z.number().int().min(0).optional() })),
      },
      responses: { 200: json(Groups), ...errors },
    }),
    async (c) => {
      const { orgId, groupId } = c.req.valid("param");
      return c.json(
        { groups: await updateAgentGroup(groups, c.get("user").id, orgId, groupId, c.req.valid("json")) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agent-groups/{groupId}",
      tags,
      security,
      summary: "Delete a group; its agents go back to no group (owners and admins)",
      request: { params: GroupParams },
      responses: { 200: json(Groups), ...errors },
    }),
    async (c) => {
      const { orgId, groupId } = c.req.valid("param");
      return c.json({ groups: await deleteAgentGroup(groups, c.get("user").id, orgId, groupId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/group",
      tags,
      security,
      summary:
        "Move an agent into a group (at `index` among its agents, else at the end) or out of any (owners and admins)",
      request: {
        params: AgentParams,
        body: body(z.object({ groupId: z.uuid().nullable(), index: z.number().int().min(0).optional() })),
      },
      responses: { 200: json(Groups), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(
        { groups: await moveAgentToGroup(groups, c.get("user").id, orgId, agentId, c.req.valid("json")) },
        200,
      );
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
      path: "/organizations/{orgId}/brain-machines",
      tags,
      security,
      summary:
        '"Quem pensa" for an agent still being created: every computer of the workspace with what it offers (Claude Code, Codex). Admins (who create agents).',
      request: { params: OrgParams },
      responses: { 200: json(z.object({ machines: z.array(BrainMachine) })), ...errors },
    }),
    async (c) => {
      const machines = await newAgentBrainMachines({ db }, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ machines }, 200);
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
        "Choose who thinks for the agent (an admin or the agent's owner; audited); only what its computer has can be chosen. A plan (Claude Code or Codex) answers only the agent's owner at first; letting others talk to it is the owner's choice (`onlyOwner: false`).",
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
            onlyOwner: z.boolean().optional().openapi({
              description:
                "\"Atende outras pessoas\" turned off (ADR 0059): true, only its owner talks to it; false, whoever its audience's people list lets in, everyone with no list (on a plan only its owner sets it, `audience.plan_owner_only`). Omitted = keep; switching onto a plan makes it the owner's only. Audited as `agent.audience_changed`.",
            }),
            acceptPlanTerms: z.boolean().optional().openapi({
              deprecated: true,
              description: "Ignored. Older apps send it with `onlyOwner: false`.",
            }),
            account: z.uuid().nullable().optional().openapi({
              description:
                "An account on the agent's computer of the brain's kind (ADR 0041); null = the computer's own sign-in; omitted = keep (cleared when the brain kind changes). Only the owner of both the agent and the account chooses it (`account.not_owner`).",
            }),
            moveAccount: z.boolean().optional().openapi({
              description: "The account thinks for another agent (`account.in_use`): take it from that one (audited).",
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
      const view = await setAgentBrain({ db }, c.get("user").id, orgId, agentId, c.req.valid("json"));
      // Its computer hears which account each agent thinks with (system mode lends the folders by it).
      if (view.computer) await publishMachineAgentsChanged(adapters.pubsub, orgId);
      return c.json(view, 200);
    },
  );

  return app;
}
