import {
  type AgentBrainSummary,
  type Agent as AgentRow,
  agentBrainSummaries,
  agentBudgetsThisMonth,
  agentStatuses,
  agentView,
  applyAgentSetup,
  archiveAgent,
  audienceOf,
  budgetPercent,
  canTalkTo,
  canViewCost,
  createAgent,
  createAgentFromProposal,
  createAgentGroup,
  createCredential,
  createProposedAgent,
  createProposedRoutine,
  deleteAgent,
  deleteAgentGroup,
  deleteCredential,
  denyAgentProposal,
  getAgent,
  getAgentBrain,
  getAgentProposal,
  getNewAgentSetup,
  getTeam,
  listAgentGroups,
  listAgents,
  listCredentials,
  listFormerAgents,
  moveAgentToGroup,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  newAgentBrainMachines,
  oldHandlesByAgent,
  orgAiStatus,
  orgRouting,
  pickerModels,
  publishMachineAgentsChanged,
  requirePermission,
  revokeCredential,
  SETUP_AGENTS_MAX,
  setAgentAppearance,
  setAgentAudience,
  setAgentBrain,
  setCoordinator,
  talksToAgents,
  updateAgent,
  updateAgentGroup,
  usageSummary,
} from "@agenteschat/engine";
import { contextWindowOf, nanoUsdToUsd, pricesAt, usdToNanoUsd } from "@agenteschat/providers";
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
  AgentSetup,
  AgentSetupResult,
  BrainEffortSetting,
  BrainKind,
  BrainMachine,
  CommandApproval,
  ContextLimit,
  Credential,
  FormerAgent,
  Model,
  NewAgentSetup,
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
    description:
      "A catalog model id, an OpenRouter model id (`maker/model`, ADR 0087), or `auto` (each run picks the model tier and effort). Defaults to `auto`.",
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
  mediaReplies: z.boolean().optional().openapi({
    description:
      "It may send a sticker or a GIF (ADR 0091): when someone asks for one, and after a light reply as often as the workspace's `agentMedia` allows; off: never. Like the other fields, editing it needs `manage_agents`. Default on.",
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
        mail: z
          .array(
            z.object({
              accountId: z.uuid(),
              address: z.string(),
              level: z.enum(["read", "write"]),
              ownerUserId: z.string(),
            }),
          )
          .optional()
          .openapi({ description: "Mailboxes of the person who asked: only a mailbox's owner gives an agent access." }),
        routine: z
          .object({
            name: z.string(),
            prompt: z.string(),
            schedule: z.string(),
            rule: z.record(z.string(), z.unknown()).nullable(),
            cron: z.string(),
            timezone: z.string(),
            description: z.string(),
            report: z.enum(["always", "when_new"]),
            access: z.enum(["read", "act"]),
            reportsIn: z.uuid().nullable().optional().openapi({
              description: "The channel it reports in, which the agent must be in first (null: the creator's DM).",
            }),
          })
          .nullable()
          .optional()
          .openapi({
            description:
              "A routine of its own, created with it (its schedule read when proposed: `rule`, else `cron`). It reports where the card is (a DM: the creator's DM with it).",
          }),
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
    applied: z
      .object({ channelIds: z.array(z.uuid()), connectionIds: z.array(z.uuid()), mailAccountIds: z.array(z.uuid()) })
      .optional()
      .openapi({
        description: "Created in one click: the lines of its draft it got (the rest waits for who may give it).",
      }),
    routineId: z.string().nullable().optional().openapi({ description: "The routine made with it." }),
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
      description:
        "The catalog's models, then OpenRouter's (ADR 0087) while a workspace on this server has an OpenRouter key: its good picks first (`pick: true`), then the rest of its list (`pick: false`).",
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
    async (c) =>
      c.json(
        {
          defaultModel: NEW_AGENT_DEFAULTS.model,
          models: (await pickerModels(db)).map(([id, m]) => ({
            id,
            label: m.label,
            provider: m.provider,
            contextWindow: contextWindowOf(id),
            inputUsdPerMTok: pricesAt(m).input / 1000,
            outputUsdPerMTok: pricesAt(m).output / 1000,
            ...(m.pick !== undefined ? { pick: m.pick } : {}),
            ...(m.tier ? { tier: m.tier } : {}),
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
      description:
        "The key is encrypted at rest and never returned by any endpoint. An OpenRouter key is checked with OpenRouter first, with no model call (ADR 0087): refused (`provider_key_invalid`) or a management key (`provider_key_management`) is never stored.",
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
        { fetch: deps.extras?.http },
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
      const [seesCost, budgets, brains, talks, old] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBudgetsThisMonth(db, orgId),
        agentBrainSummaries(db, actor, orgId, list),
        talksToAgents(db, orgId, actor),
        oldHandlesByAgent(db, orgId),
      ]);
      const percent = (id: string) => {
        const b = budgets.get(id);
        return b ? budgetPercent(b.spentNanoUsd, b.budgetNanoUsd) : 0;
      };
      return c.json(
        {
          agents: list.map((a) => ({
            ...toAgent(a, actor, seesCost, percent(a.id), brains.get(a.id), talks),
            previousHandles: old.get(a.id) ?? [],
          })),
        },
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
        "Per agent: `ready`; `no_ai` with why (`no_key`, `not_signed_in`, `no_computer`, `cli_missing`: nothing to think with, and no fallback; `own`: with `not_signed_in`, the CLI whose own sign-in isn't there on the computer, where the agent has no account); `waiting` (its computer is away for now). `any`: an agent that isn't archived is ready or waiting. `routing` (ADR 0074): who picks the agents for a message nobody mentioned, for the workspace (`by`) and for the caller's own messages (`mine`): Jev, the organization's small model (`model`), people's own plans (only for their own messages), rules, or `off` (only mentions). `noSmallModel`: with `rules`, the default key's provider, which has no small model. `apiKey`: a key of its own, or the server's own Claude key. Computed on each request; no key is read.",
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
                own: z.enum(["claude_code", "codex"]).optional(),
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

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-status",
      tags,
      security,
      summary: "Each agent's presence (online, busy, away, offline) and what it says it is doing",
      description:
        "From its work (ADR 0084): `busy` on a routine, a task, a run going for over 2 minutes or one rated heavy, or when it said so; `online` while answering, waiting on an answer or active in the last 30 minutes; `away` after that; `offline` when held. An agent with no AI is drawn offline by the apps (`ai-status`). `status`: its own words (`set_status`), a line picked for its run (`kind` + `subject`), or what its run waits on; gone when the run ends unless it set `until`. Refreshed on `agent.status` events and every 30 seconds while open.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            agents: z.array(
              z.object({
                agentId: z.uuid(),
                presence: z.enum(["online", "busy", "away", "offline"]),
                status: z
                  .object({
                    by: z.enum(["self", "auto", "wait"]).openapi({
                      description: "Its own words (`text`), a line picked for its run, or what its run waits on.",
                    }),
                    text: z.string().nullable(),
                    kind: z
                      .enum([
                        "task",
                        "routine",
                        "mission",
                        "channel",
                        "browsing",
                        "coding",
                        "files",
                        "wiki",
                        "planning",
                        "data",
                        "mail",
                        "connector",
                        "computer",
                        "waiting_approval",
                        "waiting_answer",
                        "waiting_computer",
                        "waiting_plan",
                        "waiting_budget",
                        "provider_down",
                      ])
                      .nullable()
                      .openapi({ description: "With `auto`/`wait`: what it does, worded by the app." }),
                    subject: z.string().nullable(),
                    emoji: z.string().nullable(),
                    until: z.string().nullable(),
                  })
                  .nullable(),
                activeAt: z.string().nullable(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ agents: await agentStatuses(db, c.get("user").id, orgId) }, 200);
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
            autonomy: CommandApproval.optional().openapi({
              description:
                "The Autonomia it starts with (ADR 0094, the last setup's). Default: low_risk_auto. Whoever may create it may set it: an admin, or its owner (without Manage agents, only your own agent).",
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
          // The person's Criar agente: what they pick is what the next one starts with (ADR 0094).
          { remember: true },
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
      path: "/organizations/{orgId}/agent-proposals/{messageId}/create",
      tags,
      security,
      summary: "Create a proposed agent as it is, in one click (who may create agents)",
      description:
        "The agent from the draft, owned by whoever creates it, with each line they may give it: its AI (an account of theirs), its channels, its access to the connected apps (an admin's), the mailboxes (only their owner's) and its routine. The card (`applied`, `routineId`) says what it got; the agent that proposed it is told what waits for whom.",
      request: { params: ProposalParams },
      responses: {
        201: json(
          z.object({
            agent: Agent,
            proposal: AgentProposal,
            ai: z.enum(["account", "model", "none"]).openapi({
              description: "What it thinks with now (the clicker's account, the workspace's model or nothing yet).",
            }),
          }),
          "Created",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const userId = c.get("user").id;
      const gateway = deps.extras?.context?.gateway;
      const made = await createProposedAgent({ db, pubsub: adapters.pubsub, gateway }, userId, orgId, messageId);
      if (made.agent.machineId) await publishMachineAgentsChanged(adapters.pubsub, orgId);
      return c.json(
        {
          agent: toAgent(made.agent, userId, await canViewCost(db, userId, orgId)),
          proposal: made.proposal,
          ai: made.ai,
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-proposals/{messageId}/routine",
      tags,
      security,
      summary: "Create the routine a proposal came with, for the agent created from it in the review",
      description:
        "After the review put the agent where the routine reports. Once (409 `agent_proposal.routine_made`); the routine's own rules apply (the agent's owner or an admin).",
      request: { params: ProposalParams },
      responses: { 200: json(AgentProposal), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(
        await createProposedRoutine({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, messageId),
        200,
      );
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
            handle: z.string().min(2).max(32).optional().openapi({
              description:
                "Its new @handle (admins): the one it leaves keeps reaching it. Taken by another agent (now or before) or a person: 409 `agent.handle_taken` with a free `suggestion`.",
            }),
            coordinator: z.boolean().optional().openapi({
              description:
                "It coordinates the team (ADR 0093): true takes it from whoever had it, false leaves the team with none. Admins (audited); the workspace's open apps hear `agent.coordinator`.",
            }),
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
      const { monthlyBudgetUsd, audience, appearance, coordinator, acceptPlanTerms: _, ...input } = c.req.valid("json");
      const actor = c.get("user").id;
      // The audience and the look can be changed by the agent's owner too, and who coordinates has its own call;
      // everything else needs an admin.
      const other =
        (!audience && appearance === undefined && coordinator === undefined) ||
        Object.values(input).some((v) => v !== undefined) ||
        monthlyBudgetUsd !== undefined;
      let agent = other
        ? await updateAgent(db, actor, orgId, agentId, { ...input, monthlyBudgetNanoUsd: budget(monthlyBudgetUsd) })
        : null;
      if (audience) agent = await setAgentAudience(db, actor, orgId, agentId, audience);
      if (appearance !== undefined) agent = await setAgentAppearance(db, actor, orgId, agentId, appearance);
      if (coordinator !== undefined)
        agent = await setCoordinator({ db, pubsub: adapters.pubsub }, actor, orgId, agentId, coordinator);
      if (!agent) {
        agent = await getAgent(db, orgId, agentId);
        if (!agent) throw new NotFoundError("Agent not found");
      }
      // Its computer shows its name and look (the desktop app, ADR 0036) and names its folder by its handle, and a new
      // owner may take its plan away.
      if (
        agent.machineId &&
        (input.name !== undefined ||
          input.handle !== undefined ||
          appearance !== undefined ||
          input.ownerUserId !== undefined)
      ) {
        await publishMachineAgentsChanged(adapters.pubsub, orgId);
      }
      const [seesCost, brains, talks, old] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBrainSummaries(db, actor, orgId, [agent]),
        talksToAgents(db, orgId, actor),
        oldHandlesByAgent(db, orgId),
      ]);
      return c.json(
        {
          ...toAgent(agent, actor, seesCost, undefined, brains.get(agent.id), talks),
          previousHandles: old.get(agent.id) ?? [],
        },
        200,
      );
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
                "Claude Code: `opus`, `sonnet`, `haiku`, a Claude model id or one of a coding plan's models by id (`@agenteschat/providers/plans`; another account runs `sonnet` for it); Codex: a model name; `auto` (each run picks the tier). Null = the brain's default; omitted = keep (reset when the brain changes).",
            }),
            fallback: z.boolean().optional(),
            extraUsage: z.boolean().optional().openapi({
              description:
                "Long work may go on into the plan's paid extra usage when the provider reports it on (ADR 0118; Claude's plans); false: it pauses at 95% of the plan like any other. Omitted = keep.",
            }),
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
            contextTokens: ContextLimit.nullable().optional().openapi({
              description:
                "The most context it reads, any brain (Claude Code and Codex compact there, the API brain drops old tool results); null = its model's window; omitted = keep.",
            }),
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

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-setup",
      tags,
      security,
      summary:
        'What a new agent starts thinking with (ADR 0094): the last "Quem pensa" someone saved or used on other agents, with its Autonomia, as it stands now. Whoever creates agents.',
      request: { params: OrgParams },
      responses: { 200: json(z.object({ setup: NewAgentSetup.nullable() })), ...errors },
    }),
    async (c) => {
      const setup = await getNewAgentSetup({ db }, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ setup }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-setup",
      tags,
      security,
      summary:
        'Use one agent\'s "Quem pensa" and its Autonomia on these agents (ADR 0094), each by its own rules: who may change it, whose plan thinks for it. Each change is audited as its own (`agent.brain`, `agent.mission_command_approval`, `via: setup`); `preview` says what each would do and keeps nothing. Applied, it is what new agents start with.',
      request: {
        params: OrgParams,
        body: body(
          z.object({
            setup: AgentSetup,
            agentIds: z.array(z.uuid()).min(1).max(SETUP_AGENTS_MAX),
            preview: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(z.object({ results: z.array(AgentSetupResult) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const results = await applyAgentSetup({ db }, c.get("user").id, orgId, input);
      // Their computers hear which account each agent thinks with now (system mode lends the folders by it).
      if (!input.preview && results.some((r) => r.status === "applied")) {
        await publishMachineAgentsChanged(adapters.pubsub, orgId);
      }
      return c.json({ results }, 200);
    },
  );

  return app;
}
